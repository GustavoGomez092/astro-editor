import { commands } from '@/lib/bindings'
import { projectRegistryManager } from '../project-registry'
import {
  getCollectionFolderOverrides,
  getEffectiveContentDirectory,
} from '../project-registry/path-resolution'
import { ASTRO_PATHS } from '../constants'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'

/** Forward slashes and no trailing one, so Windows and Unix paths compare */
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

/** The file's path inside the project folder, or null if it's outside it */
export function relativeToProject(
  projectPath: string,
  filePath: string
): string | null {
  const root = `${normalize(projectPath)}/`
  const file = normalize(filePath)
  return file.startsWith(root) ? file.slice(root.length) : null
}

export const absoluteInProject = (projectPath: string, relative: string) =>
  `${normalize(projectPath)}/${relative}`

function registeredProject(projectPath: string) {
  try {
    const wanted = normalize(projectPath)
    return Object.values(projectRegistryManager.getRegistry().projects).find(
      project => normalize(project.path) === wanted
    )
  } catch {
    return undefined
  }
}

/**
 * The file's path inside the project. Files are found by their real path, so
 * a project opened through a link is compared by its real path too
 */
async function entryPathInProject(
  projectPath: string,
  filePath: string
): Promise<string | null> {
  const direct = relativeToProject(projectPath, filePath)
  if (direct) return direct
  const real = await commands.canonicalPath(projectPath).catch(() => null)
  return real?.status === 'ok' ? relativeToProject(real.data, filePath) : null
}

/** Remembers the entry open in a site, so opening the site again returns to it */
export async function rememberLastEntry(
  projectPath: string,
  filePath: string
): Promise<void> {
  const project = registeredProject(projectPath)
  if (!project) return
  const relative = await entryPathInProject(projectPath, filePath)
  if (relative) projectRegistryManager.setLastOpenFile(project.id, relative)
}

/**
 * Opens the entry the site had open last, if its file is still there. The
 * site must already be open. True when an entry was opened
 */
export async function reopenLastEntry(projectPath: string): Promise<boolean> {
  const project = registeredProject(projectPath)
  const relative = project && projectRegistryManager.getLastOpenFile(project.id)
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
    // The site may have been left while the file was looked up
    if (useProjectStore.getState().projectPath !== projectPath) return false
    useEditorStore.getState().openFile(result.data)
    return true
  } catch {
    return false
  }
}
