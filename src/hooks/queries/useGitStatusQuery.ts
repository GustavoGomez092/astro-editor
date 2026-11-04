import { useQuery } from '@tanstack/react-query'
import { loadGitStatus } from '@/lib/git/status'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'
import { useGitHubAuthQuery } from './useGitHubAuthQuery'

/**
 * The project's git status: branch, ahead/behind and changed files. It waits
 * for the sign-in check, so that on project open it fetches first when signed
 * in (see `loadGitStatus`). `useGitStatusRefresh`, mounted once, keeps it
 * current.
 */
export const useGitStatusQuery = (projectPath: string | null) => {
  const enabled = useShowPublishingTools()
  const auth = useGitHubAuthQuery()
  const authSettled = auth.isSuccess || auth.isError
  const signedIn = auth.data?.signedIn ?? false

  return useQuery({
    queryKey: queryKeys.gitStatus(projectPath || ''),
    queryFn: () => loadGitStatus(projectPath!, { signedIn }),
    enabled: enabled && !!projectPath && authSettled,
    staleTime: 0,
  })
}
