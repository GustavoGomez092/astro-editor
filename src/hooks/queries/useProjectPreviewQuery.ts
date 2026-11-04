import { useQuery } from '@tanstack/react-query'
import { getProjectPreview } from '@/lib/projects/previews'
import { queryKeys } from '@/lib/query-keys'

/**
 * A site's picture for its card. Reading it is quick (a stored screenshot or
 * the site's share image), so it's fetched whenever a card shows. A failure
 * just means the card shows the site's initial
 */
export const useProjectPreviewQuery = (projectPath: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.projectPreview(projectPath),
    queryFn: () => getProjectPreview(projectPath),
    enabled,
    staleTime: 60 * 1000,
    retry: false,
  })
