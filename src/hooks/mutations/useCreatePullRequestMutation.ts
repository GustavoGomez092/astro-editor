import { useMutation, useQueryClient } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

interface CreatePullRequestPayload {
  projectPath: string
  title: string
  body: string
  base: string
  head: string
}

/** Open a pull request from the current branch into the default branch. */
export const useCreatePullRequestMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      projectPath,
      title,
      body,
      base,
      head,
    }: CreatePullRequestPayload) =>
      unwrap(
        commands.githubCreatePullRequest(projectPath, title, body, base, head)
      ),
    onSuccess: (pr, { projectPath }) => {
      void refreshGit(queryClient, projectPath)
      toast.success('Pull request opened', {
        description: pr.title,
        action: {
          label: 'View on GitHub',
          onClick: () => void openUrl(pr.htmlUrl),
        },
      })
    },
    onError: error => {
      toast.error("Couldn't open the pull request", {
        description: error.message,
      })
    },
  })
}
