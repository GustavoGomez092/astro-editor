import { useQuery } from '@tanstack/react-query'
import { commands } from '@/types'
import { queryKeys } from '@/lib/query-keys'

const fetchCollectionHasBody = async (collectionPath: string) => {
  const result = await commands.collectionHasBodyText(collectionPath)
  if (result.status === 'error') {
    throw new Error(result.error)
  }
  return result.data
}

/** Whether any entry in a collection has body text below its frontmatter. */
export const useCollectionHasBodyQuery = (
  projectPath: string | null,
  collectionName: string | null,
  collectionPath: string | null
) => {
  return useQuery({
    queryKey: queryKeys.collectionHasBody(
      projectPath || '',
      collectionName || ''
    ),
    queryFn: () => fetchCollectionHasBody(collectionPath!),
    enabled: !!projectPath && !!collectionName && !!collectionPath,
  })
}
