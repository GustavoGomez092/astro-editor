import { error as logError } from '@tauri-apps/plugin-log'
import { commands } from '@/lib/bindings'
import { projectRegistryManager } from '../project-registry'
import {
  getCollectionFolderOverrides,
  getEffectiveContentDirectory,
} from '../project-registry/path-resolution'
import { ASTRO_PATHS } from '../constants'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'

const trimEnd = (path: string) => path.replace(/\/+$/, '')

/** The file's path inside the project folder, or null if it's outside it */
export function relativeToProject(
  projectPath: string,
  filePath: string
): string | null {
  const root = `${trimEnd(projectPath)}/`
  return filePath.startsWith(root) ? filePath.slice(root.length) : null
}

export const absoluteInProject = (projectPath: string, relative: string) =>
  `${trimEnd(projectPath)}/${relative}`

function registeredProject(projectPath: string) {
  try {
    return Object.values(projectRegistryManager.getRegistry().projects).find(
      project => project.path === projectPath
    )
  } catch {
    return undefined
  }
}

/** Remembers the entry open in a site, so opening the site again returns to it */
export async function rememberLastEntry(
  projectPath: string,
  filePath: string
): Promise<void> {
  const relative = relativeToProject(projectPath, filePath)
  const project = registeredProject(projectPath)
  if (!relative || !project) return
  try {
    await projectRegistryManager.setLastOpenFile(project.id, relative)
  } catch (reason) {
    void logError(
      `Astro Editor [HOME] Remembering the open entry failed: ${String(reason)}`
    )
  }
}

/**
 * Opens the entry the site had open last, if its file is still there. The
 * site must already be open. True when an entry was opened
 */
export async function reopenLastEntry(projectPath: string): Promise<boolean> {
  const relative = registeredProject(projectPath)?.lastFile
  if (!relative) return false
  try {
    const settings = useProjectStore.getState().currentProjectSettings
    const contentDirectory = getEffectiveContentDirectory(settings)
    const result = await commands.resolveFileEntry(
      absoluteInProject(projectPath, relative),
      projectPath,
      contentDirectory !== ASTRO_PATHS.CONTENT_DIR ? contentDirectory : null,
      getCollectionFolderOverrides(settings)
    )
    if (result.status !== 'ok' || !result.data) return false
    useEditorStore.getState().openFile(result.data)
    return true
  } catch {
    return false
  }
}
