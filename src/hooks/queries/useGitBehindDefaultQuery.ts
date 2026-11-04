import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/**
 * How many commits the default branch has that the current branch doesn't
 * (as last fetched): when it's above 0, the panel offers "Bring in changes".
 */
export const useGitBehindDefaultQuery = (
  projectPath: string | null,
  { enabled = true }: { enabled?: boolean } = {}
) => {
  const toolsOn = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.gitBehindDefault(projectPath || ''),
    queryFn: () => unwrap(commands.gitCommitsBehindDefault(projectPath!)),
    enabled: toolsOn && enabled && !!projectPath,
    staleTime: 0,
  })
}
