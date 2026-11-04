// src/hooks/queries/useCollectionsQuery.ts

import { useQuery } from '@tanstack/react-query'
import { commands, type Collection } from '@/types'
import { queryKeys } from '@/lib/query-keys'
import {
  getCollectionFolderOverrides,
  getEffectiveContentDirectory,
} from '@/lib/project-registry/path-resolution'
import { ASTRO_PATHS } from '@/lib/constants'
import { ProjectSettings } from '@/lib/project-registry/types'

// This is our actual data-fetching function using typed Tauri commands.
const fetchCollections = async (
  projectPath: string,
  contentDirectory: string,
  collectionFolders: Record<string, string> | null
): Promise<Collection[]> => {
  if (!projectPath) {
    // TanStack Query handles errors, so we can throw
    throw new Error('Project path is required to fetch collections.')
  }

  const result =
    contentDirectory !== ASTRO_PATHS.CONTENT_DIR || collectionFolders
      ? await commands.scanProjectWithContentDir(
          projectPath,
          contentDirectory !== ASTRO_PATHS.CONTENT_DIR
            ? contentDirectory
            : null,
          collectionFolders
        )
      : await commands.scanProject(projectPath)

  if (result.status === 'error') {
    throw new Error(result.error)
  }
  return result.data
}

export const useCollectionsQuery = (
  projectPath: string | null,
  projectSettings?: ProjectSettings | null
) => {
  // Get effective content directory using centralized path resolution
  const contentDirectory = getEffectiveContentDirectory(projectSettings)
  const collectionFolders = getCollectionFolderOverrides(projectSettings)

  return useQuery({
    // The queryKey uniquely identifies this query.
    // If projectPath changes, TanStack Query will automatically refetch.
    queryKey: queryKeys.collections(projectPath || ''),

    // The queryFn is the function that fetches the data.
    // TanStack Query automatically provides the context, including the queryKey.
    queryFn: () =>
      fetchCollections(projectPath!, contentDirectory, collectionFolders),

    // We only want to run this query if a projectPath is available.
    enabled: !!projectPath,
  })
}
