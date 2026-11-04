import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'
import { useGitHubAuthQuery } from './useGitHubAuthQuery'
import { useGitHubRepoInfoQuery } from './useGitHubRepoInfoQuery'

/**
 * Open pull requests for the project's GitHub repository. Only runs when the
 * writer is signed in and `origin` is on github.com.
 */
export const usePullRequestsQuery = (projectPath: string | null) => {
  const toolsOn = useShowPublishingTools()
  const signedIn = useGitHubAuthQuery().data?.signedIn ?? false
  const repo = useGitHubRepoInfoQuery(projectPath).data
  return useQuery({
    queryKey: queryKeys.pullRequests(projectPath || ''),
    queryFn: () => unwrap(commands.githubListPullRequests(projectPath!)),
    enabled: toolsOn && signedIn && !!repo && !!projectPath,
    staleTime: 60 * 1000,
  })
}
