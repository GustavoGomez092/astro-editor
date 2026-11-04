import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { error as logError } from '@tauri-apps/plugin-log'
import { commands } from '@/lib/bindings'
import { projectRegistryManager } from '../project-registry'
import { queryClient } from '../query-client'
import { queryKeys } from '../query-keys'
import { refreshProjectPreview } from './previews'
import { useProjectStore } from '../../store/projectStore'
import { saveUnsavedEdits } from '../quit'
import { toast } from '../toast'

/**
 * Opens a site's editor. Unsaved edits in the open site are saved first, and
 * if that fails the site stays open so nothing is lost
 */
export async function openSite(path: string): Promise<void> {
  if (!(await saveUnsavedEdits())) {
    toast.error("Couldn't save your changes, so the other site wasn't opened")
    return
  }
  useProjectStore.getState().setProject(path)
}

/**
 * Goes back to Home: saves unsaved edits first, then closes the open site
 * (its dev server stops, as when another site opens). If saving fails the site
 * stays open
 */
export async function goHome(): Promise<void> {
  if (!useProjectStore.getState().projectPath) return
  if (!(await saveUnsavedEdits())) {
    toast.error("Couldn't save your changes, so you're still in this site")
    return
  }
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
    await openSite(result.data)
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
