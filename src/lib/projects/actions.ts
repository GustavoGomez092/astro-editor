import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { error as logError } from '@tauri-apps/plugin-log'
import { commands } from '@/lib/bindings'
import { projectRegistryManager } from '../project-registry'
import { queryClient } from '../query-client'
import { queryKeys } from '../query-keys'
import { refreshProjectPreview } from './previews'
import { reopenLastEntry } from './last-entry'
import { waitForProjectReady } from './ready'
import { getOpenGeneration, useProjectStore } from '../../store/projectStore'
import { ask } from '@tauri-apps/plugin-dialog'
import { flushRememberedEntries, saveUnsavedEdits } from '../quit'
import { waitForSaves } from '../files/pending-saves'
import { useEditorStore } from '../../store/editorStore'
import { usePreviewRefreshStore } from '../../store/previewRefreshStore'
import { focusSidebar } from '../focus-utils'
import { toast } from '../toast'

let openingSite = false

/**
 * Gets the open site ready to be left: lets running saves finish, then saves
 * unsaved edits. If that keeps failing (the edits are kept in the recovery
 * folder) the writer chooses whether to leave anyway. True when it's fine to go
 */
async function readyToLeaveSite(): Promise<boolean> {
  await waitForSaves()
  if (await saveUnsavedEdits()) {
    await flushRememberedEntries()
    return true
  }
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
  // Go Home (or another open) changes this, which cancels this open
  const generation = getOpenGeneration()
  try {
    if (useProjectStore.getState().projectPath === path) {
      await reopenLastEntry(path)
      return true
    }
    if (!(await readyToLeaveSite())) return false
    if (generation !== getOpenGeneration()) return false
    useProjectStore.getState().setProject(path)
    // setProject finishes on its own; the entry opens once the site is ready
    if (!(await waitForProjectReady(path))) {
      toast.error("Couldn't open the site")
      return false
    }
    // Home may have been pressed just as it finished loading
    if (useProjectStore.getState().projectPath !== path) return false
    await reopenLastEntry(path)
    // Home is gone and the editor is in view: put focus in it
    setTimeout(focusSidebar, 100)
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
  if (!useProjectStore.getState().projectPath) {
    // Nothing open yet, but a site may be on its way: cancel it
    if (openingSite) await useProjectStore.getState().closeProject()
    return
  }
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

/**
 * Takes a new screenshot of the site, showing progress on its card meanwhile.
 * Nothing to show or a failure is a quiet toast; the raw reason goes to the log
 */
export async function refreshSitePreview(path: string): Promise<void> {
  const store = usePreviewRefreshStore.getState()
  if (store.refreshing[path]) return
  store.setRefreshing(path, true)
  try {
    const preview = await refreshProjectPreview(path)
    if (!preview) toast.info("Couldn't take a picture of this site")
    await queryClient.invalidateQueries({
      queryKey: queryKeys.projectPreview(path),
    })
  } catch (reason) {
    void logError(
      `Astro Editor [HOME] Refreshing the preview of ${path} failed: ${String(reason)}`
    )
    toast.info("Couldn't refresh the preview", {
      description:
        "The site didn't start or didn't answer in time. Try again in a moment.",
    })
  } finally {
    usePreviewRefreshStore.getState().setRefreshing(path, false)
  }
}
