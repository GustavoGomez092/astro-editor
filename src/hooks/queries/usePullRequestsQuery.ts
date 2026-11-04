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

/**
 * How long a pull request with no checks is still checked for them. GitHub
 * registers a new pull request's checks a little after it's opened (or
 * pushed to), so a first read often says `none` for checks that are coming.
 */
export const NEW_PULL_REQUEST_MS = 10 * 60 * 1000

/**
 * When the app first saw each pull request, by project and number. The
 * pull request type carries no created or updated time, so this stands in.
 */
const firstSeen = new Map<string, number>()
const seenKey = (projectPath: string, number: number) =>
  `${projectPath}#${number}`

function noteFirstSeen(projectPath: string, pullRequests: PullRequest[]) {
  const now = Date.now()
  for (const pr of pullRequests) {
    const key = seenKey(projectPath, pr.number)
    if (!firstSeen.has(key)) firstSeen.set(key, now)
  }
}

/**
 * Whether any open pull request's checks may still change: they're running,
 * or there are none yet on one seen less than ten minutes ago.
 */
function checksMayChange(
  projectPath: string,
  pullRequests: PullRequest[] | undefined,
  now: number
): boolean {
  return (
    pullRequests?.some(pr => {
      if (pr.state !== 'open') return false
      if (pr.checks === 'pending') return true
      if (pr.checks !== 'none') return false
      const seen = firstSeen.get(seenKey(projectPath, pr.number)) ?? now
      return now - seen < NEW_PULL_REQUEST_MS
    }) ?? false
  )
}

async function fetchPullRequests(projectPath: string) {
  const pullRequests = await unwrap(
    commands.githubListPullRequests(projectPath)
  )
  noteFirstSeen(projectPath, pullRequests)
  return pullRequests
}

/**
 * Open pull requests for the project's GitHub repository. Only runs when the
 * writer is signed in and `origin` is on github.com. While any open one's
 * checks may still change (`checksMayChange`), it's read again every 15
 * seconds while the window is focused, and as soon as the window comes back
 * to the front, so the card turns green (or red) by itself. Our own interval
 * rather than TanStack's `refetchInterval`, whose focus check follows page
 * visibility, and a Mac app's page stays visible in the background.
 */
export const usePullRequestsQuery = (projectPath: string | null) => {
  const toolsOn = useShowPublishingTools()
  const signedIn = useGitHubAuthQuery().data?.signedIn ?? false
  const repo = useGitHubRepoInfoQuery(projectPath).data
  const enabled = toolsOn && signedIn && !!repo && !!projectPath
  const query = useQuery({
    queryKey: queryKeys.pullRequests(projectPath || ''),
    queryFn: () => fetchPullRequests(projectPath!),
    enabled,
    staleTime: 60 * 1000,
  })

  // The cached list outlives signing out; polling doesn't
  const { data, refetch } = query
  useEffect(() => {
    if (!enabled || !projectPath) return
    if (!checksMayChange(projectPath, data, Date.now())) return
    // A pull request without checks ages out while the list stays the same
    const stillChanging = () => checksMayChange(projectPath, data, Date.now())
    const interval = setInterval(() => {
      if (!stillChanging()) clearInterval(interval)
      else if (document.hasFocus()) void refetch()
    }, PULL_REQUEST_POLL_MS)
    const onFocus = () => {
      if (stillChanging()) void refetch()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, projectPath, data, refetch])

  return query
}
