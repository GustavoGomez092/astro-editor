import { useIsMutating } from '@tanstack/react-query'
import { GIT_CHANGE_MUTATION_KEY } from '@/lib/git/repo-change'

/**
 * Whether a git operation that changes the repository is running (publish,
 * sync, checkout, bring in, merging a pull request). The panel disables its
 * actions, and the editor and frontmatter take no edits, until it's done.
 */
export const useGitBusy = (): boolean =>
  useIsMutating({ mutationKey: GIT_CHANGE_MUTATION_KEY }) > 0
