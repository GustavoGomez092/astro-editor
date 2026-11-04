import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/** How many commits History shows. */
export const HISTORY_LIMIT = 300

/** The latest commits across local and remote branches, for History. */
export const useGitLogQuery = (
  projectPath: string | null,
  { enabled = true, limit = HISTORY_LIMIT } = {}
) => {
  const toolsOn = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.gitLog(projectPath || '', limit),
    queryFn: () => unwrap(commands.gitLogGraph(projectPath!, limit)),
    enabled: toolsOn && enabled && !!projectPath,
    staleTime: 0,
  })
}
