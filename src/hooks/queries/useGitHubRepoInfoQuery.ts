import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/**
 * The GitHub repository behind `origin`, or null when it isn't on github.com
 * (then git still works, but pull requests are hidden).
 */
export const useGitHubRepoInfoQuery = (projectPath: string | null) => {
  const toolsOn = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.githubRepoInfo(projectPath || ''),
    queryFn: () => unwrap(commands.githubRepoInfo(projectPath!)),
    enabled: toolsOn && !!projectPath,
  })
}
