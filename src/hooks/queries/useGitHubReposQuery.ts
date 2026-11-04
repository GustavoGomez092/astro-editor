import { useQuery } from '@tanstack/react-query'
import { homeDir } from '@tauri-apps/api/path'
import { commands } from '@/lib/bindings'
import { sitesFolder } from '@/lib/git/clone'
import { unwrap } from '@/lib/git/unwrap'
import { queryKeys } from '@/lib/query-keys'

/** Repositories the signed-in writer can open, most recently updated first. */
export const useGitHubReposQuery = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.githubRepos,
    queryFn: () => unwrap(commands.githubListRepos()),
    enabled,
    staleTime: 60 * 1000,
  })

/** ~/Sites, where cloned projects go unless the writer picks another folder. */
export const useSitesFolderQuery = () =>
  useQuery({
    queryKey: ['sitesFolder'],
    queryFn: async () => sitesFolder(await homeDir()),
    staleTime: Infinity,
  })
