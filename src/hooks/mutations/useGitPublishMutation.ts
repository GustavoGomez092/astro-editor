import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

interface PublishPayload {
  projectPath: string
  message: string
}

const publish = ({ projectPath, message }: PublishPayload) =>
  unwrap(commands.gitPublish(projectPath, message))

/**
 * Publish: commit every change, bring in anything new on GitHub, push. When
 * the push can't happen (offline, a conflict), the commit is kept and the
 * message says what to do.
 */
export const useGitPublishMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: publish,
    onSuccess: (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      if (result.pushed) {
        toast.success(result.message || 'Published')
      } else {
        toast.warning(result.message, { duration: 8000 })
      }
    },
    onError: error => {
      toast.error("Couldn't publish", { description: error.message })
    },
  })
}
