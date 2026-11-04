import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitHubAuthStatus } from '@/lib/bindings'
import { applyFetchedStatus } from '@/lib/git/cache'
import { loadGitStatus } from '@/lib/git/status'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

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
        onFetched: status =>
          applyFetchedStatus(queryClient, projectPath!, status),
      }),
    enabled: enabled && !!projectPath,
    staleTime: 0,
  })
}
