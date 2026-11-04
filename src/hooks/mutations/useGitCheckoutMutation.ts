import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

interface CheckoutPayload {
  projectPath: string
  name: string
  /** Create the branch from the current one first */
  create: boolean
}

/**
 * Switch to a branch, or create one. Refused, with the reason, when it would
 * overwrite uncommitted edits; nothing changes then.
 */
export const useGitCheckoutMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectPath, name, create }: CheckoutPayload) =>
      unwrap(commands.gitCheckout(projectPath, name, create)),
    onSuccess: (status, { projectPath, name, create }) => {
      void refreshGit(queryClient, projectPath, status)
      // Files the checkout rewrote reach the sidebar and editor through the
      // file watcher, which keeps unsaved edits safe
      toast.success(create ? `Created ${name}` : `Switched to ${name}`)
    },
    onError: (error, { name }) => {
      toast.error(`Couldn't switch to ${name}`, {
        description: error.message,
      })
    },
  })
}
