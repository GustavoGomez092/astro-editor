import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { refreshGit } from '@/lib/git/cache'
import {
  asIs,
  GIT_CHANGE_MUTATION_KEY,
  gitErrorToast,
  reloadProjectFiles,
  saveBeforeGitChange,
} from '@/lib/git/repo-change'
import { unwrap } from '@/lib/git/unwrap'
import { toast } from '@/lib/toast'

interface DiscardPayload {
  projectPath: string
  /** Repository-relative */
  path: string
}

const discard = async ({ projectPath, path }: DiscardPayload) => {
  // Saved first, or the editor's unsaved edits would be written back over
  // the restored file by the next auto-save
  await saveBeforeGitChange()
  return unwrap(commands.gitDiscardFile(projectPath, path))
}

/**
 * Throws away the changes to one file: a changed file goes back to its last
 * published version, a new one is deleted. The caller confirms first. The
 * open file is reloaded (or closed, if it was new) before editing resumes.
 */
export const useGitDiscardFileMutation = ({
  present = asIs,
}: { present?: (message: string) => string } = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: discard,
    onSuccess: async (status, { projectPath }) => {
      void refreshGit(queryClient, projectPath, status)
      // Awaited: editing stays blocked until the open file shows the result
      await reloadProjectFiles(queryClient, projectPath)
    },
    onError: error => {
      gitErrorToast(
        "Couldn't discard the changes",
        error,
        present,
        (title, description) => toast.error(title, { description })
      )
    },
  })
}
