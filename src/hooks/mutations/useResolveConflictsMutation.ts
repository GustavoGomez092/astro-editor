import { useMutation, useQueryClient } from '@tanstack/react-query'
import { commands, type ConflictResolution } from '@/lib/bindings'
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

interface ResolvePayload {
  projectPath: string
  choices: ConflictResolution[]
}

const resolve = async ({ projectPath, choices }: ResolvePayload) => {
  await saveBeforeGitChange()
  return unwrap(commands.gitResolveConflicts(projectPath, choices))
}

/**
 * Combines the branch with GitHub's changes, keeping the chosen whole version
 * of each conflicting file, and commits that. Nothing is pushed: the caller
 * publishes straight after. The chosen versions are reloaded into the editor
 * before editing resumes.
 */
export const useResolveConflictsMutation = ({
  present = asIs,
}: { present?: (message: string) => string } = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: resolve,
    onSuccess: async (result, { projectPath }) => {
      void refreshGit(queryClient, projectPath, result.status)
      // Awaited: editing stays blocked until the open file shows the result
      await reloadProjectFiles(queryClient, projectPath)
    },
    onError: error => {
      gitErrorToast(
        "Couldn't combine the changes",
        error,
        present,
        (title, description) => toast.error(title, { description })
      )
    },
  })
}
