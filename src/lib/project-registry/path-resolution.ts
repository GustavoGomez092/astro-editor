/**
 * Centralized path resolution with collection-scoped settings support
 *
 * The content and assets directories a project or collection uses, with
 * three-tier fallback (collection → project → defaults)
 */

import { ProjectSettings } from './types'
import { ASTRO_PATHS } from '../constants'

/**
 * Get effective content directory path for a collection
 *
 * Implements three-tier fallback:
 * 1. Collection-specific contentDirectory override
 * 2. Project-level contentDirectory override
 * 3. Hard-coded default (ASTRO_PATHS.CONTENT_DIR)
 *
 * @param projectSettings - Current project settings
 * @param collectionName - Optional collection name for collection-scoped override
 * @returns Effective content directory path (relative to project root)
 */
export function getEffectiveContentDirectory(
  projectSettings?: ProjectSettings | null,
  collectionName?: string | null
): string {
  // If collection is specified, check for collection-specific override
  if (collectionName && projectSettings?.collections) {
    const collectionSettings = projectSettings.collections.find(
      c => c.name === collectionName
    )
    if (collectionSettings?.settings.pathOverrides?.contentDirectory) {
      return collectionSettings.settings.pathOverrides.contentDirectory
    }
  }

  // Fall back to project-level override
  if (projectSettings?.pathOverrides?.contentDirectory) {
    return projectSettings.pathOverrides.contentDirectory
  }

  // Fall back to default
  return ASTRO_PATHS.CONTENT_DIR
}

/**
 * Get effective assets directory path for a collection
 *
 * Implements three-tier fallback:
 * 1. Collection-specific assetsDirectory override
 * 2. Project-level assetsDirectory override
 * 3. Hard-coded default (ASTRO_PATHS.ASSETS_DIR)
 *
 * @param projectSettings - Current project settings
 * @param collectionName - Optional collection name for collection-scoped override
 * @returns Effective assets directory path (relative to project root)
 */
export function getEffectiveAssetsDirectory(
  projectSettings?: ProjectSettings | null,
  collectionName?: string | null
): string {
  // If collection is specified, check for collection-specific override
  if (collectionName && projectSettings?.collections) {
    const collectionSettings = projectSettings.collections.find(
      c => c.name === collectionName
    )
    if (collectionSettings?.settings.pathOverrides?.assetsDirectory) {
      return collectionSettings.settings.pathOverrides.assetsDirectory
    }
  }

  // Fall back to project-level override
  if (projectSettings?.pathOverrides?.assetsDirectory) {
    return projectSettings.pathOverrides.assetsDirectory
  }

  // Fall back to default
  return ASTRO_PATHS.ASSETS_DIR
}

/** `./src/blog/` → `src/blog` */
export function tidyFolder(folder: string): string {
  return folder
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/[/\\]+$/, '')
}

/**
 * Why a collection's content folder can't be used, or null when it can. It
 * must be inside the project, given relative to it, and not the project or
 * the content folder itself (that holds every collection). Rust checks the
 * same again, and refuses a folder that leads out through a link
 */
export function checkCollectionFolder(
  folder: string,
  /** Null to allow the content folder (for an assets folder) */
  contentDirectory: string | null
): string | null {
  const tidy = tidyFolder(folder)
  if (tidy === '' || tidy === '.') {
    return `"${folder.trim()}" is the project folder itself. Choose the folder that holds this collection's entries.`
  }
  const absolute = /^([/\\]|[A-Za-z]:)/.test(tidy)
  const climbs = tidy.split(/[/\\]/).includes('..')
  if (absolute || climbs) {
    return `"${folder.trim()}" isn't inside the project folder. Give a folder inside it, like src/content/blog.`
  }
  if (contentDirectory !== null && tidy === tidyFolder(contentDirectory)) {
    return `"${folder.trim()}" is the content folder itself, which holds every collection. Choose this collection's own folder inside it.`
  }
  return null
}

/**
 * The content folder set for each collection that has one, by collection
 * name, relative to the project root. Rust uses these as the collections'
 * folders when it scans, resolves links and watches. A folder that can't be
 * used is left out, so its collection is found automatically (Collection
 * Settings says why). Null when there are none
 */
export function getCollectionFolderOverrides(
  projectSettings?: ProjectSettings | null
): Record<string, string> | null {
  const contentDirectory = getEffectiveContentDirectory(projectSettings)
  const entries = (projectSettings?.collections ?? []).flatMap(c => {
    const folder = c.settings.pathOverrides?.contentDirectory
    return folder && !checkCollectionFolder(folder, contentDirectory)
      ? [[c.name, folder] as const]
      : []
  })
  return entries.length > 0 ? Object.fromEntries(entries) : null
}
