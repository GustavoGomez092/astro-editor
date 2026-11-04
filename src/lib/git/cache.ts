import type { QueryClient } from '@tanstack/react-query'
import type { GitStatus } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'

/**
 * After anything that changes the repository: show the status the command
 * returned straight away, and reload everything else git-related (branches,
 * history, diffs, pull requests).
 */
export function refreshGit(
  queryClient: QueryClient,
  projectPath: string,
  status?: GitStatus
): Promise<void> {
  if (status) queryClient.setQueryData(queryKeys.gitStatus(projectPath), status)
  return queryClient.invalidateQueries({ queryKey: queryKeys.git(projectPath) })
}
