import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import {
  GIT_CHANGE_MUTATION_KEY,
  saveBeforeGitChange,
} from '@/lib/git/repo-change'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

interface MergePayload {
  projectPath: string
  number: number
}

/** Merge a pull request on GitHub, then fetch so the app sees the result. */
const mergeAndFetch = async ({ projectPath, number }: MergePayload) => {
  await saveBeforeGitChange()
  const pr = await unwrap(commands.githubMergePullRequest(projectPath, number))
  // The merge happened on GitHub; a failed fetch only delays seeing it
  const fetched = await commands.gitFetch(projectPath)
  return { pr, status: fetched.status === 'ok' ? fetched.data : undefined }
}

/** Merge (with a merge commit); the app stays on the current branch. */
export const useMergePullRequestMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: mergeAndFetch,
    onSuccess: ({ pr, status }, { projectPath }) => {
      void refreshGit(queryClient, projectPath, status)
      toast.success('Merged', { description: pr.title })
    },
    onError: error => {
      toast.error("Couldn't merge", { description: error.message })
    },
  })
}
