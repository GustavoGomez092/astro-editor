import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { showSyncOutcome } from '@/lib/git/messages'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

/** Sync: fetch, and bring in new changes from GitHub when that's safe. */
export const useGitSyncMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectPath }: { projectPath: string }) =>
      unwrap(commands.gitSync(projectPath)),
    onSuccess: (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      showSyncOutcome(result)
    },
    onError: error => {
      toast.error("Couldn't sync", { description: error.message })
    },
  })
}
