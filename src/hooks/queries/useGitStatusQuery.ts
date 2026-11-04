import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import type { GitHubAuthStatus, GitStatus } from '@/lib/bindings'
import { loadGitStatus } from '@/lib/git/status'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

/** A background fetch moved remote branches: show its status, reload the rest. */
function applyFetched(
  queryClient: QueryClient,
  projectPath: string,
  status: GitStatus
) {
  queryClient.setQueryData(queryKeys.gitStatus(projectPath), status)
  // A load that started before the fetch finished could land after it; the
  // local status now reflects the fetch, so read it again (it won't refetch)
  for (const key of [
    queryKeys.gitStatus(projectPath),
    queryKeys.gitBranches(projectPath),
    queryKeys.gitBehindDefault(projectPath),
    [...queryKeys.git(projectPath), 'log'],
    queryKeys.pullRequests(projectPath),
  ]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}

/**
 * The project's git status: branch, ahead/behind and changed files. It's read
 * locally, so the panel and the title bar's Publish appear at once; when the
 * writer is signed in, a fetch runs in the background and updates it (see
 * `loadGitStatus`). `useGitStatusRefresh`, mounted once, keeps it current.
 */
export const useGitStatusQuery = (projectPath: string | null) => {
  const enabled = useShowPublishingTools()
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: queryKeys.gitStatus(projectPath || ''),
    queryFn: () =>
      loadGitStatus(projectPath!, {
        // Read when it runs: sign-in may settle after the first load
        signedIn:
          queryClient.getQueryData<GitHubAuthStatus>(queryKeys.githubAuth)
            ?.signedIn ?? false,
        onFetched: status => applyFetched(queryClient, projectPath!, status),
      }),
    enabled: enabled && !!projectPath,
    staleTime: 0,
  })
}
