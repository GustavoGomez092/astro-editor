import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { error as logError } from '@tauri-apps/plugin-log'
import { commands } from '@/lib/bindings'
import { projectRegistryManager } from '../project-registry'
import { queryClient } from '../query-client'
import { queryKeys } from '../query-keys'
import { refreshProjectPreview } from './previews'
import { reopenLastEntry } from './last-entry'
import { waitForProjectReady } from './ready'
import { useProjectStore } from '../../store/projectStore'
import { ask } from '@tauri-apps/plugin-dialog'
import { saveUnsavedEdits } from '../quit'
import { waitForSaves } from '../files/pending-saves'
import { useEditorStore } from '../../store/editorStore'
import { toast } from '../toast'

let openingSite = false

/**
 * Gets the open site ready to be left: lets running saves finish, then saves
 * unsaved edits. If that keeps failing (the edits are kept in the recovery
 * folder) the writer chooses whether to leave anyway. True when it's fine to go
 */
async function readyToLeaveSite(): Promise<boolean> {
  await waitForSaves()
  if (await saveUnsavedEdits()) return true
  const fileName = useEditorStore.getState().currentFile?.name ?? 'this file'
  try {
    return await ask(
      `Your latest changes to “${fileName}” couldn't be saved. If you leave now, they'll be lost.`,
      {
        title: 'Leave Without Saving?',
        kind: 'warning',
        okLabel: 'Leave Anyway',
        cancelLabel: 'Stay',
      }
    )
  } catch {
    return false
  }
}

/**
 * Opens a site's editor, back at the entry it had open last (if that file is
 * still there). The open site's unsaved edits are saved first. Ignored while
 * another site is opening, so a double click opens it once. True when the site
 * is open
 */
export async function openSite(path: string): Promise<boolean> {
  if (openingSite) return false
  openingSite = true
  try {
    if (useProjectStore.getState().projectPath === path) {
      await reopenLastEntry(path)
      return true
    }
    if (!(await readyToLeaveSite())) return false
    useProjectStore.getState().setProject(path)
    // setProject finishes on its own; the entry opens once the site is ready
    if (!(await waitForProjectReady(path))) {
      toast.error("Couldn't open the site")
      return false
    }
    await reopenLastEntry(path)
    return true
  } finally {
    openingSite = false
  }
}

/**
 * Goes back to Home: saves unsaved edits first, then closes the open site
 * (its dev server stops, as when another site opens). If saving fails the
 * writer can stay, or leave anyway
 */
export async function goHome(): Promise<void> {
  if (!useProjectStore.getState().projectPath) return
  if (!(await readyToLeaveSite())) return
  await useProjectStore.getState().closeProject()
}

export async function openProjectViaDialog(): Promise<void> {
  const result = await commands.selectProjectFolder()
  if (result.status === 'error') {
    toast.error('Failed to open project', {
      description: result.error,
    })
    return
  }
  if (result.data) {
    if (await openSite(result.data))
      toast.success('Project opened successfully')
  }
}

/** Takes a site off the Home list. Its files are left alone */
export async function removeSite(id: string): Promise<void> {
  try {
    await projectRegistryManager.removeProject(id)
  } catch (reason) {
    toast.error("Couldn't remove the site from the list")
    void logError(
      `Astro Editor [HOME] Removing ${id} failed: ${String(reason)}`
    )
  }
  await queryClient.invalidateQueries({ queryKey: queryKeys.projectsList })
}

/** Shows the site's folder in Finder (or the platform's file manager) */
export async function showSiteInFileManager(path: string): Promise<void> {
  try {
    await revealItemInDir(path)
  } catch (reason) {
    void logError(
      `Astro Editor [HOME] Revealing ${path} failed: ${String(reason)}`
    )
  }
}

/** Takes a new screenshot of the site. A failure is a quiet toast */
export async function refreshSitePreview(path: string): Promise<void> {
  try {
    await refreshProjectPreview(path)
    await queryClient.invalidateQueries({
      queryKey: queryKeys.projectPreview(path),
    })
  } catch (reason) {
    toast.info("Couldn't refresh the preview", {
      description: reason instanceof Error ? reason.message : String(reason),
    })
  }
}
