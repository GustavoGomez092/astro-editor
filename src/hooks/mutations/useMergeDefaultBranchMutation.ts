import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { showSyncOutcome } from '@/lib/git/messages'
import {
  asIs,
  GIT_CHANGE_MUTATION_KEY,
  gitErrorToast,
  needsAttention,
  reloadProjectFiles,
  saveBeforeGitChange,
  type GitMutationOptions,
} from '@/lib/git/repo-change'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

const mergeDefault = async ({ projectPath }: { projectPath: string }) => {
  await saveBeforeGitChange()
  return unwrap(commands.gitMergeDefaultBranch(projectPath))
}

/**
 * "Bring in changes from main": merge the default branch into the current
 * one, with the same conflict rules as Sync.
 */
export const useMergeDefaultBranchMutation = ({
  present = asIs,
  onNeedsAttention,
}: GitMutationOptions = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: mergeDefault,
    onSuccess: async (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      // Awaited: editing stays blocked until the open file shows the result
      await reloadProjectFiles(queryClient, projectPath)
      if (needsAttention(result.outcome) && onNeedsAttention) {
        onNeedsAttention(result)
      } else {
        showSyncOutcome(result, present)
      }
    },
    onError: error => {
      gitErrorToast(
        "Couldn't bring in the changes",
        error,
        present,
        (title, description) => toast.error(title, { description })
      )
    },
  })
}
