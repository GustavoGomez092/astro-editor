import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/**
 * How many commits the current branch has that the default branch doesn't
 * (as last fetched): Open pull request is offered only when it's above 0, as
 * GitHub refuses a pull request with nothing in it.
 */
export const useGitAheadOfDefaultQuery = (
  projectPath: string | null,
  { enabled = true }: { enabled?: boolean } = {}
) => {
  const toolsOn = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.gitAheadOfDefault(projectPath || ''),
    queryFn: () => unwrap(commands.gitCommitsAheadOfDefault(projectPath!)),
    enabled: toolsOn && enabled && !!projectPath,
    staleTime: 0,
  })
}
