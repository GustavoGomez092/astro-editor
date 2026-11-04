import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import {
  asIs,
  GIT_CHANGE_MUTATION_KEY,
  gitErrorToast,
  reloadProjectFiles,
  saveBeforeGitChange,
  type GitMutationOptions,
} from '@/lib/git/repo-change'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

interface CheckoutPayload {
  projectPath: string
  name: string
  /** Create the branch from the current one first */
  create: boolean
}

const checkout = async ({ projectPath, name, create }: CheckoutPayload) => {
  await saveBeforeGitChange()
  return unwrap(commands.gitCheckout(projectPath, name, create))
}

/**
 * Switch to a branch, or create one. Refused, with the reason, when it would
 * overwrite uncommitted edits; nothing changes then.
 */
export const useGitCheckoutMutation = ({
  present = asIs,
}: Pick<GitMutationOptions, 'present'> = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: checkout,
    onSuccess: async (status, { projectPath, name, create }) => {
      void refreshGit(queryClient, projectPath, status)
      // Awaited: editing stays blocked until the open file shows the branch
      await reloadProjectFiles(queryClient, projectPath)
      toast.success(create ? `Created ${name}` : `Switched to ${name}`)
    },
    onError: (error, { name }) => {
      gitErrorToast(
        `Couldn't switch to ${name}`,
        error,
        present,
        (title, description) => toast.error(title, { description })
      )
    },
  })
}
