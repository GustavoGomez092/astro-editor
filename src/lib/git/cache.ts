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

/**
 * A background fetch moved remote branches: show its status, and reload what
 * depends on them (branches, the default-branch counts, conflicts, history,
 * pull requests).
 */
export function applyFetchedStatus(
  queryClient: QueryClient,
  projectPath: string,
  status: GitStatus
): void {
  queryClient.setQueryData(queryKeys.gitStatus(projectPath), status)
  // A load that started before the fetch finished could land after it; the
  // local status now reflects the fetch, so read it again (it won't refetch)
  for (const key of [
    queryKeys.gitStatus(projectPath),
    queryKeys.gitBranches(projectPath),
    queryKeys.gitBehindDefault(projectPath),
    queryKeys.gitAheadOfDefault(projectPath),
    queryKeys.gitConflicts(projectPath),
    [...queryKeys.git(projectPath), 'log'],
    queryKeys.pullRequests(projectPath),
  ]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}
