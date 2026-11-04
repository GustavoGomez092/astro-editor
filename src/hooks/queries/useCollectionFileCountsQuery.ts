import { useQueries } from '@tanstack/react-query'
import { commands, type Collection } from '@/types'
import { queryKeys } from '@/lib/query-keys'

const countFiles = async (collectionPath: string): Promise<number> => {
  const result = await commands.countCollectionFilesRecursive(collectionPath)
  if (result.status === 'error') throw new Error(result.error)
  return result.data
}

/**
 * How many files each collection holds, counting its subfolders, by
 * collection name; 0 until counted or when counting fails. One query per
 * collection under its `collectionFiles` key, so whatever refreshes a
 * collection's files (the file watcher, Reload Collections, a git change)
 * counts it again. Deriving the counts from the collections list instead
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
        collection.name
      ),
      queryFn: () => countFiles(collection.path),
      enabled: !!projectPath,
    })),
    combine: results =>
      Object.fromEntries(
        collections.map((collection, i) => [
          collection.name,
          results[i]?.data ?? 0,
        ])
      ),
  })
