import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
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

interface PublishPayload {
  projectPath: string
  message: string
}

const publish = async ({ projectPath, message }: PublishPayload) => {
  await saveBeforeGitChange()
  return unwrap(commands.gitPublish(projectPath, message))
}

/**
 * Publish: commit every change, bring in anything new on GitHub, push. When
 * the push can't happen (offline, a conflict), the commit is kept and the
 * message says what to do.
 */
export const useGitPublishMutation = ({
  present = asIs,
  onNeedsAttention,
}: GitMutationOptions = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: publish,
    onSuccess: async (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      // Bringing in changes from GitHub rewrote files. Awaited: editing stays
      // blocked until the open file shows the result
      if (result.outcome === 'merged' || result.outcome === 'fastForwarded') {
        await reloadProjectFiles(queryClient, projectPath)
      }
      if (needsAttention(result.outcome) && onNeedsAttention) {
        onNeedsAttention(result)
      } else if (result.pushed) {
        toast.success(present(result.message) || 'Published')
      } else {
        toast.warning(present(result.message), { duration: 8000 })
      }
    },
    onError: error => {
      gitErrorToast("Couldn't publish", error, present, (title, description) =>
        toast.error(title, { description })
      )
    },
  })
}
