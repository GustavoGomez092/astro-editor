import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { showSyncOutcome } from '@/lib/git/messages'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

/**
 * "Bring in changes from main": merge the default branch into the current
 * one, with the same conflict rules as Sync.
 */
export const useMergeDefaultBranchMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectPath }: { projectPath: string }) =>
      unwrap(commands.gitMergeDefaultBranch(projectPath)),
    onSuccess: (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      showSyncOutcome(result)
    },
    onError: error => {
      toast.error("Couldn't bring in the changes", {
        description: error.message,
      })
    },
  })
}
