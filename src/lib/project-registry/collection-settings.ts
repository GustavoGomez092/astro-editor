/**
 * Collection-scoped settings with three-tier fallback
 *
 * Fallback chain:
 * 1. Collection-specific setting (if set)
 * 2. Project-level setting (if set)
 * 3. Hard-coded default (from ASTRO_PATHS)
 */

import type {
  CollectionSettings,
  CollectionSort,
  CollectionSpecificSettings,
  ProjectSettings,
} from './types'
import { ASTRO_PATHS } from '../constants'
import { DEFAULT_PUBLISHED_DATE_FIELDS } from './defaults'

/**
 * Get effective settings for a specific collection with three-tier fallback
 *
 * @param projectSettings - Current project settings (may include collections array)
 * @param collectionName - Name of the collection to get settings for
 * @returns Fully resolved settings with all values populated including useRelativeAssetPaths
 */
export function getCollectionSettings(
  projectSettings: ProjectSettings | null | undefined,
  collectionName: string
): {
  pathOverrides: {
    contentDirectory: string
    assetsDirectory: string
    mdxComponentsDirectory: string
  }
  frontmatterMappings: {
    publishedDate: string | string[]
    title: string
    description: string
    draft: string
  }
  useRelativeAssetPaths: boolean
  urlPattern?: string
} {
  // Handle null/undefined projectSettings
  if (!projectSettings) {
    return {
      pathOverrides: {
        contentDirectory: ASTRO_PATHS.CONTENT_DIR,
        assetsDirectory: ASTRO_PATHS.ASSETS_DIR,
        mdxComponentsDirectory: ASTRO_PATHS.MDX_COMPONENTS_DIR,
      },
      frontmatterMappings: {
        publishedDate: DEFAULT_PUBLISHED_DATE_FIELDS,
        title: 'title',
        description: 'description',
        draft: 'draft',
      },
      useRelativeAssetPaths: true,
      urlPattern: undefined,
    }
  }
  // Find collection-specific settings
  const collectionSettings = projectSettings.collections?.find(
    c => c.name === collectionName
  )?.settings

  // Define hard-coded defaults
  const defaults = {
    pathOverrides: {
      contentDirectory: ASTRO_PATHS.CONTENT_DIR,
      assetsDirectory: ASTRO_PATHS.ASSETS_DIR,
      mdxComponentsDirectory: ASTRO_PATHS.MDX_COMPONENTS_DIR,
    },
    frontmatterMappings: {
      publishedDate: DEFAULT_PUBLISHED_DATE_FIELDS as string | string[],
      title: 'title',
      description: 'description',
      draft: 'draft',
    },
  }

  // Implement three-tier fallback for path overrides
  const effectivePathOverrides = {
    contentDirectory:
      collectionSettings?.pathOverrides?.contentDirectory ||
      projectSettings.pathOverrides?.contentDirectory ||
      defaults.pathOverrides.contentDirectory,
    assetsDirectory:
      collectionSettings?.pathOverrides?.assetsDirectory ||
      projectSettings.pathOverrides?.assetsDirectory ||
      defaults.pathOverrides.assetsDirectory,
    mdxComponentsDirectory:
      projectSettings.pathOverrides?.mdxComponentsDirectory ||
      defaults.pathOverrides.mdxComponentsDirectory,
  }

  // Implement three-tier fallback for frontmatter mappings
  const effectiveFrontmatterMappings = {
    publishedDate:
      collectionSettings?.frontmatterMappings?.publishedDate ||
      projectSettings.frontmatterMappings?.publishedDate ||
      defaults.frontmatterMappings.publishedDate,
    title:
      collectionSettings?.frontmatterMappings?.title ||
      projectSettings.frontmatterMappings?.title ||
      defaults.frontmatterMappings.title,
    description:
      collectionSettings?.frontmatterMappings?.description ||
      projectSettings.frontmatterMappings?.description ||
      defaults.frontmatterMappings.description,
    draft:
      collectionSettings?.frontmatterMappings?.draft ||
      projectSettings.frontmatterMappings?.draft ||
      defaults.frontmatterMappings.draft,
  }

  // Three-tier fallback for useAbsoluteAssetPaths (inverted to useRelativeAssetPaths)
  // undefined or false → use relative paths (true)
  // true → use absolute paths (false)
  const useAbsolutePaths =
    collectionSettings?.useAbsoluteAssetPaths ??
    projectSettings.useAbsoluteAssetPaths ??
    false // Default to false (use relative paths, Astro convention)

  return {
    pathOverrides: effectivePathOverrides,
    frontmatterMappings: effectiveFrontmatterMappings,
    useRelativeAssetPaths: !useAbsolutePaths, // Invert: absolute=false means relative=true
    urlPattern: collectionSettings?.urlPattern,
  }
}

/**
 * Whether the component builder imports images picked for a collection's
 * image props: when the project adds imports, and the collection's images
 * don't go in `public/`, whose files Vite serves as they are rather than
 * importing them. Otherwise image props take the name of an image the writer
 * imports.
 */
export function canImportImages(
  projectSettings: ProjectSettings | null | undefined,
  collectionName: string | undefined
): boolean {
  if (!projectSettings?.addComponentImports || !collectionName) return false
  const { assetsDirectory } = getCollectionSettings(
    projectSettings,
    collectionName
  ).pathOverrides
  return !/^(\.?\/)?public(\/|$)/.test(assetsDirectory)
}

const DEFAULT_SORT: CollectionSort = { mode: 'default', direction: 'desc' }

/** The sidebar sort saved for a collection, or the Default sort. */
export function getCollectionSort(
  projectSettings: ProjectSettings | null | undefined,
  collectionName: string
): CollectionSort {
  return (
    projectSettings?.collections?.find(c => c.name === collectionName)?.settings
      .sort ?? DEFAULT_SORT
  )
}

/** Whether a collection's settings override anything, so its entry is kept. */
export function hasCollectionSettings(
  settings: CollectionSpecificSettings
): boolean {
  const hasValues = (group?: object) =>
    !!group && Object.values(group).some(value => value !== undefined)

  return (
    hasValues(settings.pathOverrides) ||
    hasValues(settings.frontmatterMappings) ||
    settings.defaultFileType !== undefined ||
    settings.urlPattern !== undefined ||
    settings.useAbsoluteAssetPaths !== undefined ||
    settings.bodyText !== undefined ||
    settings.sort !== undefined
  )
}

/**
 * The project's collection settings with `sort` saved for one collection. The
 * Default sort isn't stored, and an entry left with no settings is dropped.
 */
export function withCollectionSort(
  projectSettings: ProjectSettings | null | undefined,
  collectionName: string,
  sort: CollectionSort
): CollectionSettings[] {
  const collections = projectSettings?.collections ?? []
  const existing = collections.find(c => c.name === collectionName)
  const settings: CollectionSpecificSettings = { ...existing?.settings }
  if (sort.mode === DEFAULT_SORT.mode) {
    delete settings.sort
  } else {
    settings.sort = sort
  }

  const updated = existing
    ? collections.map(c =>
        c.name === collectionName ? { name: collectionName, settings } : c
      )
    : [...collections, { name: collectionName, settings }]

  return updated.filter(c => hasCollectionSettings(c.settings))
}

/**
 * Whether any collection's content or assets folder differs between two
 * versions of the collection settings. Changing one moves files out from
 * under the open file and the watcher, like a project path override does
 */
export function collectionPathsChanged(
  before: CollectionSettings[] | undefined,
  after: CollectionSettings[] | undefined
): boolean {
  const paths = (collections: CollectionSettings[] | undefined) =>
    new Map(
      (collections ?? []).map(c => [
        c.name,
        `${c.settings.pathOverrides?.contentDirectory ?? ''}\n${
          c.settings.pathOverrides?.assetsDirectory ?? ''
        }`,
      ])
    )
  const a = paths(before)
  const b = paths(after)
  const empty = '\n'
  return [...new Set([...a.keys(), ...b.keys()])].some(
    name => (a.get(name) ?? empty) !== (b.get(name) ?? empty)
  )
}
