import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/** Local and remote branches, for the branch menu. */
export const useGitBranchesQuery = (
  projectPath: string | null,
  { enabled = true }: { enabled?: boolean } = {}
) => {
  const toolsOn = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.gitBranches(projectPath || ''),
    queryFn: () => unwrap(commands.gitBranches(projectPath!)),
    enabled: toolsOn && enabled && !!projectPath,
    staleTime: 0,
  })
}
