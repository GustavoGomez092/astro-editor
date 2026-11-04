import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands, type SyncOutcome } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { broughtInMessage, showSyncOutcome } from '@/lib/git/messages'
import { queryKeys } from '@/lib/query-keys'
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

/** Whether the merge brought anything in (rather than stopping or no-op). */
const broughtIn = (outcome: SyncOutcome) =>
  outcome === 'merged' || outcome === 'fastForwarded'

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
    // How many commits were coming in, for the message: the count shown before
    onMutate: ({ projectPath }) => ({
      count:
        queryClient.getQueryData<number>(
          queryKeys.gitBehindDefault(projectPath)
        ) ?? 0,
    }),
    onSuccess: async (result, { projectPath }, context) => {
      void refreshGit(queryClient, projectPath, result.status)
      // Awaited: editing stays blocked until the open file shows the result
      await reloadProjectFiles(queryClient, projectPath)
      if (needsAttention(result.outcome) && onNeedsAttention) {
        onNeedsAttention(result)
      } else if (broughtIn(result.outcome) && result.status.defaultBranch) {
        toast.success(
          present(
            broughtInMessage(context?.count ?? 0, result.status.defaultBranch)
          )
        )
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
