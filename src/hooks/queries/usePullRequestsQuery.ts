import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { commands, type PullRequest } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'
import { useGitHubAuthQuery } from './useGitHubAuthQuery'
import { useGitHubRepoInfoQuery } from './useGitHubRepoInfoQuery'

/** How often pull requests are checked again while their checks run. */
export const PULL_REQUEST_POLL_MS = 15 * 1000

const checksRunning = (pullRequests: PullRequest[] | undefined) =>
  pullRequests?.some(pr => pr.state === 'open' && pr.checks === 'pending') ??
  false

/**
 * Open pull requests for the project's GitHub repository. Only runs when the
 * writer is signed in and `origin` is on github.com. While any has checks
 * running, it's read again every 15 seconds while the window is focused, so
 * the card turns green (or red) by itself. Our own interval rather than
 * TanStack's `refetchInterval`, whose focus check follows page visibility,
 * and a Mac app's page stays visible in the background.
 */
export const usePullRequestsQuery = (projectPath: string | null) => {
  const toolsOn = useShowPublishingTools()
  const signedIn = useGitHubAuthQuery().data?.signedIn ?? false
  const repo = useGitHubRepoInfoQuery(projectPath).data
  const query = useQuery({
    queryKey: queryKeys.pullRequests(projectPath || ''),
    queryFn: () => unwrap(commands.githubListPullRequests(projectPath!)),
    enabled: toolsOn && signedIn && !!repo && !!projectPath,
    staleTime: 60 * 1000,
  })

  const polling = checksRunning(query.data)
  const { refetch } = query
  useEffect(() => {
    if (!polling) return
    const interval = setInterval(() => {
      if (document.hasFocus()) void refetch()
    }, PULL_REQUEST_POLL_MS)
    return () => clearInterval(interval)
  }, [polling, refetch])

  return query
}
