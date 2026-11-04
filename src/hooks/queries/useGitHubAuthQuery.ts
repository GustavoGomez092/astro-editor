import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '../settings/useShowPublishingTools'

const fetchAuthStatus = async () => {
  const result = await commands.githubAuthStatus()
  if (result.status === 'error') throw new Error(result.error)
  return result.data
}

/**
 * Whether the writer is signed in to GitHub, and as whom. It only changes when
 * they sign in or out, which update it directly, so it never goes stale.
 */
export const useGitHubAuthQuery = () => {
  const enabled = useShowPublishingTools()
  return useQuery({
    queryKey: queryKeys.githubAuth,
    queryFn: fetchAuthStatus,
    enabled,
    staleTime: Infinity,
  })
}
