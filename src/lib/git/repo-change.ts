import type { QueryClient } from '@tanstack/react-query'
import { commands, type GitStatus, type SyncOutcome } from '@/lib/bindings'
import { saveUnsavedEdits } from '@/lib/quit'
import { queryKeys } from '@/lib/query-keys'
import { useEditorStore } from '@/store/editorStore'
import { useProjectStore } from '@/store/projectStore'

/**
 * The key every mutation that changes the repository shares (publish, sync,
 * checkout, bring in, merge a pull request), so the UI can tell while one is
 * running: `useGitBusy`.
 */
export const GIT_CHANGE_MUTATION_KEY = ['git', 'change'] as const

export const SAVE_FAILED = "Couldn't save your edits, so nothing was changed."

/**
 * Saves the open file before git touches the working tree. Unsaved edits
 * would otherwise be saved after a checkout or sync and silently undo the
 * incoming changes. Throws, so the git command never runs, if the save fails.
 */
export async function saveBeforeGitChange(): Promise<void> {
  // Before anything awaits, so before React makes the areas inert
  rememberFocus()
  if (!(await saveUnsavedEdits())) throw new Error(SAVE_FAILED)
}

/** Marks the areas that take no edits while git works (editor, frontmatter). */
export const GIT_GUARDED_ATTRIBUTE = 'data-git-guarded'

let focusBeforeGitChange: HTMLElement | null = null

function rememberFocus() {
  const active = document.activeElement
  focusBeforeGitChange =
    active instanceof HTMLElement &&
    active.closest(`[${GIT_GUARDED_ATTRIBUTE}]`)
      ? active
      : null
}

/**
 * After a git change: put focus back in the editor or frontmatter field the
 * writer was in before the areas went inert, unless they've since gone
 * somewhere else.
 */
export function restoreFocusAfterGitChange(): void {
  const target = focusBeforeGitChange
  focusBeforeGitChange = null
  const nowhere =
    document.activeElement === null || document.activeElement === document.body
  if (target?.isConnected && nowhere) target.focus()
}

/**
 * After git rewrote files (checkout, sync, bring in, a publish that merged or
 * fast-forwarded): reload the open file first, then collections and folder
 * listings. Callers await it in `onSuccess`, so the mutation (and with it the
 * block on editing, `useGitBusy`) only ends once the editor holds the new
 * text. The watcher can't be relied on here: it ignores the open file for a
 * few seconds after our own save, which `saveBeforeGitChange` just did.
 *
 * Does nothing if another project has opened meanwhile. A file that's gone
 * (it doesn't exist on the branch) is closed, but only if it has no unsaved
 * edits: those are never dropped.
 */
export async function reloadProjectFiles(
  queryClient: QueryClient,
  projectPath: string
): Promise<void> {
  if (useProjectStore.getState().projectPath !== projectPath) return

  const { currentFile } = useEditorStore.getState()
  if (currentFile) {
    const stillThere = await commands.readFileContent(
      currentFile.path,
      projectPath
    )
    const editor = useEditorStore.getState()
    const sameFile = editor.currentFile?.id === currentFile.id
    if (stillThere.status === 'error') {
      if (sameFile && !editor.isDirty) editor.closeCurrentFile()
    } else {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.fileContent(projectPath, currentFile.id),
      })
    }
  }

  if (useProjectStore.getState().projectPath !== projectPath) return
  void queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === queryKeys.all[0] &&
      queryKey[1] === projectPath &&
      // collections and collectionFiles, and directoryContents
      (queryKey[2] === 'collections' || queryKey[3] === 'directory'),
  })
}

/**
 * The error toast for a git mutation, unless the save before it failed: the
 * editor has already said so (with the reason and any recovery), and nothing
 * else happened.
 */
export function gitErrorToast(
  title: string,
  error: Error,
  present: (message: string) => string,
  showError: (title: string, description: string) => void
): void {
  if (error.message === SAVE_FAILED) return
  showError(title, present(error.message))
}

const ATTENTION: SyncOutcome[] = ['conflict', 'blockedByLocalChanges']

/** Outcomes that leave something for the writer to sort out. */
export function needsAttention(outcome: SyncOutcome): boolean {
  return ATTENTION.includes(outcome)
}

/** What a caller can tell a git mutation about showing its results. */
export interface GitMutationOptions {
  /** Rewrites an engine message for the writer (entry titles, "GitHub") */
  present?: (message: string) => string
  /**
   * Shows a conflict or blocked outcome itself (the panel's notice). Without
   * it, the outcome is a toast.
   */
  onNeedsAttention?: (result: {
    outcome: SyncOutcome
    message: string
    /** The repository after the attempt */
    status: GitStatus
  }) => void
}

/** The default `present`: the engine's message as it is. */
export const asIs = (message: string): string => message
