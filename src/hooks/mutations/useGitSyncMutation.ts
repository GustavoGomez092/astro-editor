import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { showSyncOutcome } from '@/lib/git/messages'
import {
  asIs,
  GIT_CHANGE_MUTATION_KEY,
  needsAttention,
  reloadProjectFiles,
  saveBeforeGitChange,
  type GitMutationOptions,
} from '@/lib/git/repo-change'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

const sync = async ({ projectPath }: { projectPath: string }) => {
  await saveBeforeGitChange()
  return unwrap(commands.gitSync(projectPath))
}

/** Sync: fetch, and bring in new changes from GitHub when that's safe. */
export const useGitSyncMutation = ({
  present = asIs,
  onNeedsAttention,
}: GitMutationOptions = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: sync,
    onSuccess: (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      void reloadProjectFiles(queryClient, projectPath)
      if (needsAttention(result.outcome) && onNeedsAttention) {
        onNeedsAttention(result)
      } else {
        showSyncOutcome(result, present)
      }
    },
    onError: error => {
      toast.error("Couldn't sync", { description: present(error.message) })
    },
  })
}
