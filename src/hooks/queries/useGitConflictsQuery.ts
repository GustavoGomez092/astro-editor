import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/**
 * The files that conflict between the branch and its copy on GitHub (an
 * in-memory merge; nothing is written). Only worth asking when both have
 * commits the other lacks, so the caller enables it then. While it lists any,
 * Publish and Sync open the Resolve view instead of trying again.
 */
export const useGitConflictsQuery = (
  projectPath: string | null,
  { enabled = true }: { enabled?: boolean } = {}
) => {
  const toolsOn = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.gitConflicts(projectPath || ''),
    queryFn: () => unwrap(commands.gitConflicts(projectPath!)),
    enabled: toolsOn && enabled && !!projectPath,
    staleTime: 0,
  })
}
