import { queryClient } from '@/lib/query-client'
import { GIT_CHANGE_MUTATION_KEY } from './repo-change'

/**
 * Whether a git change is running (publish, sync, checkout, bring in, merge),
 * for code outside React: `useGitBusy` is the hook. File drops and the editor's
 * component builder and content linker shortcuts are ignored meanwhile, like
 * typing: they'd change the open file while git rewrites it.
 */
export const isGitBusy = (): boolean =>
  queryClient.isMutating({ mutationKey: GIT_CHANGE_MUTATION_KEY }) > 0
