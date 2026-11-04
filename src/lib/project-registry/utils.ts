/**
 * Project registry utilities for identification and path management
 */

import { commands, type FolderState } from '@/lib/bindings'
import { ProjectMetadata } from './types'
import { debug, error as logError, info } from '@tauri-apps/plugin-log'

/**
 * Simple hash function for generating project IDs
 */
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).slice(0, 6)
}

/**
 * Generate a unique project ID from package.json name and path
 */
export function generateProjectId(
  name: string,
  path: string,
  existingIds: Set<string>
): string {
  // Clean the name to be filesystem-safe
  const cleanName = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()

  // If the clean name is unique, use it
  if (!existingIds.has(cleanName)) {
    return cleanName
  }

  // If there's a conflict, add a hash suffix
  const pathHash = simpleHash(path)
  const uniqueId = `${cleanName}-${pathHash}`

  return uniqueId
}

/**
 * Discover project information from a given path
 */
export async function discoverProject(
  projectPath: string,
  existingIds: Set<string>
): Promise<ProjectMetadata> {
  try {
    // Try to read package.json
    const packageJsonPath = `${projectPath}/package.json`
    await debug(
      `Astro Editor [PROJECT_DISCOVERY] Reading package.json: ${packageJsonPath}`
    )

    const result = await commands.readFileContent(packageJsonPath, projectPath)
    if (result.status === 'error') {
      throw new Error(result.error)
    }
    const packageJsonContent = result.data

    const packageJson = JSON.parse(packageJsonContent) as { name?: string }
    const name =
      packageJson.name || projectPath.split('/').pop() || 'unknown-project'

    await info(`Astro Editor [PROJECT_DISCOVERY] Project name found: ${name}`)
    const projectId = generateProjectId(name, projectPath, existingIds)
    await debug(
      `Astro Editor [PROJECT_DISCOVERY] Generated project ID: ${projectId}`
    )

    return {
      id: projectId,
      name,
      path: projectPath,
      lastOpened: new Date().toISOString(),
      created: new Date().toISOString(),
    }
  } catch (error) {
    // Fallback if package.json doesn't exist or is invalid
    await logError(
      `Astro Editor [PROJECT_DISCOVERY] Package.json read failed for ${projectPath}: ${String(error)}`
    )
    await info(
      `Astro Editor [PROJECT_DISCOVERY] Using fallback discovery for: ${projectPath}`
    )

    const name = projectPath.split('/').pop() || 'unknown-project'
    const projectId = generateProjectId(name, projectPath, existingIds)
    await debug(
      `Astro Editor [PROJECT_DISCOVERY] Fallback project ID: ${projectId}`
    )

    return {
      id: projectId,
      name,
      path: projectPath,
      lastOpened: new Date().toISOString(),
      created: new Date().toISOString(),
    }
  }
}

/**
 * Whether the folder at `newPath` is `projectMetadata`'s project, moved there.
 * Only a package.json name counts: a folder name alone is too common to say
 * two folders hold the same project. The caller checks the old folder is gone
 */
export async function isSameProject(
  projectMetadata: ProjectMetadata,
  newPath: string
): Promise<boolean> {
  try {
    const result = await commands.readFileContent(
      `${newPath}/package.json`,
      newPath
    )
    if (result.status === 'error') return false
    const packageJson = JSON.parse(result.data) as { name?: string }
    return !!packageJson.name && packageJson.name === projectMetadata.name
  } catch {
    // No readable package.json
    return false
  }
}

/**
 * Whether each of these folders is there, in the same order: `present`,
 * `missing` (gone from a place that's there), or `unavailable` (its drive
 * isn't connected, or it can't be checked)
 */
export async function folderStates(paths: string[]): Promise<FolderState[]> {
  if (paths.length === 0) return []
  return commands.folderStates(paths)
}
