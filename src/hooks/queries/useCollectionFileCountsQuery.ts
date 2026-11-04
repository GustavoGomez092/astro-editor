import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { commands, type Collection } from '@/types'
import { queryKeys } from '@/lib/query-keys'

interface FileCount {
  collection: string
  count: number
}

const countFiles = async (collection: Collection): Promise<FileCount> => {
  const result = await commands.countCollectionFilesRecursive(collection.path)
  if (result.status === 'error') throw new Error(result.error)
  return { collection: collection.name, count: result.data }
}

// Hoisted so TanStack doesn't combine again on every render
const byCollection = (
  results: UseQueryResult<FileCount>[]
): Record<string, number> =>
  Object.fromEntries(
    results.flatMap(({ data }) => (data ? [[data.collection, data.count]] : []))
  )

/**
 * How many files each collection holds, counting its subfolders, by
 * collection name; missing until counted, or when counting fails. One query
 * per collection (`collectionFileCount`), refreshed by the file watcher when
 * files are added or removed, by Reload Collections, by a git change and by
 * creating an entry. Deriving the counts from the collections list instead
 * left them stale: a refetched list that hasn't changed keeps its identity.
 */
export const useCollectionFileCountsQuery = (
  projectPath: string | null,
  collections: Collection[]
): Record<string, number> =>
  useQueries({
    queries: collections.map(collection => ({
      queryKey: queryKeys.collectionFileCount(
        projectPath || '',
        collection.name,
        collection.path
      ),
      queryFn: () => countFiles(collection),
      enabled: !!projectPath,
      // Each try walks the whole folder; a failure shows no count
      retry: false,
    })),
    combine: byCollection,
  })
