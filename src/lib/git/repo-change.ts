import type { QueryClient } from '@tanstack/react-query'
import { commands, type GitStatus, type SyncOutcome } from '@/lib/bindings'
import { saveUnsavedEdits } from '@/lib/quit'
import { queryKeys } from '@/lib/query-keys'
import { useEditorStore } from '@/store/editorStore'

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
  if (!(await saveUnsavedEdits())) throw new Error(SAVE_FAILED)
}

/**
 * After git rewrote files (checkout, sync, bring in, a publish that merged):
 * reload the open file, collections and folder listings straight away. The
 * watcher can't be relied on, because it ignores the open file for a few
 * seconds after our own save, which `saveBeforeGitChange` just did. Closes the
 * open file if it's gone.
 */
export async function reloadProjectFiles(
  queryClient: QueryClient,
  projectPath: string
): Promise<void> {
  const { currentFile } = useEditorStore.getState()
  await queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === queryKeys.all[0] &&
      queryKey[1] === projectPath &&
      // collections and collectionFiles, and directoryContents
      (queryKey[2] === 'collections' || queryKey[3] === 'directory'),
  })
  if (!currentFile) return
  const stillThere = await commands.readFileContent(
    currentFile.path,
    projectPath
  )
  if (stillThere.status === 'error') {
    if (useEditorStore.getState().currentFile?.id === currentFile.id) {
      useEditorStore.getState().closeCurrentFile()
    }
    return
  }
  await queryClient.invalidateQueries({
    queryKey: queryKeys.fileContent(projectPath, currentFile.id),
  })
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
