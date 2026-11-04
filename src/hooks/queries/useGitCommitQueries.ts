import { useQuery } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'

/** One commit's message, author and files, for History's details panel. */
export const useGitCommitDetailsQuery = (
  projectPath: string | null,
  id: string | null
) =>
  useQuery({
    queryKey: queryKeys.gitCommitDetails(projectPath || '', id || ''),
    queryFn: () => unwrap(commands.gitCommitDetails(projectPath!, id!)),
    enabled: !!projectPath && !!id,
    // A commit never changes
    staleTime: Infinity,
  })

/** What one commit changed in one file (vs its first parent). */
export const useGitCommitFileDiffQuery = (
  projectPath: string | null,
  id: string | null,
  path: string | null
) =>
  useQuery({
    queryKey: queryKeys.gitCommitFileDiff(
      projectPath || '',
      id || '',
      path || ''
    ),
    queryFn: () => unwrap(commands.gitCommitFileDiff(projectPath!, id!, path!)),
    enabled: !!projectPath && !!id && !!path,
    staleTime: Infinity,
  })

/** What's changed in one file since the last commit. */
export const useGitFileDiffQuery = (
  projectPath: string | null,
  path: string | null
) =>
  useQuery({
    queryKey: queryKeys.gitFileDiff(projectPath || '', path || ''),
    queryFn: () => unwrap(commands.gitFileDiff(projectPath!, path!)),
    enabled: !!projectPath && !!path,
    staleTime: 0,
  })
