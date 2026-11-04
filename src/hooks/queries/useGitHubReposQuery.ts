import { useQuery } from '@tanstack/react-query'
import { homeDir } from '@tauri-apps/api/path'
import { commands, type AstroCheck, type RepoSummary } from '@/lib/bindings'
import {
  cachedCheck,
  pushMarker,
  saveChecks,
  type SiteStatus,
} from '@/lib/git/astro-sites'
import { sitesFolder } from '@/lib/git/clone'
import { error as logError } from '@tauri-apps/plugin-log'
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

/** The list is cut off at this many repositories (10 pages of 100), so it may be incomplete. */
const LIST_LIMIT = 1000

/** The query for a list of repositories (the styleguide seeds it by this key). */
export const astroSitesKey = (repos: RepoSummary[]) =>
  [
    'astroSites',
    repos.map(r => `${r.fullName}@${pushMarker(r)}`).join('|'),
  ] as const

async function fetchChecks(
  fullNames: string[]
): Promise<Map<string, AstroCheck>> {
  try {
    const checked = await unwrap(commands.githubCheckAstroRepos(fullNames))
    return new Map(checked.map(c => [c.fullName, c.check]))
  } catch (reason) {
    void logError(
      `Astro Editor [GITHUB] Checking for Astro sites failed: ${String(reason)}`
    )
    throw reason
  }
}

/**
 * Whether each repository is an Astro site. Saved answers are used at once; the
 * rest are asked of GitHub in one call (Rust runs the queries, three at a time)
 * and saved for next time. Until the answer arrives a repository is 'checking';
 * one that can't be checked, or whose check failed, is 'unknown' and is tried
 * again the next time the dialog opens.
 */
export function useAstroSiteStatus(
  repos: RepoSummary[],
  enabled: boolean
): (repo: RepoSummary) => SiteStatus {
  const todo = repos.filter(r => cachedCheck(r) === null)
  const query = useQuery({
    queryKey: astroSitesKey(repos),
    queryFn: async () => {
      const answers = await fetchChecks(todo.map(r => r.fullName))
      saveChecks(
        todo,
        answers,
        repos.length < LIST_LIMIT
          ? new Set(repos.map(r => r.fullName))
          : undefined
      )
      return answers
    },
    enabled: enabled && todo.length > 0,
    // Anything not settled is asked again soon (when the dialog reopens)
    staleTime: q =>
      [...(q.state.data?.values() ?? [])].includes('unknown')
        ? 10_000
        : Infinity,
    retry: false,
  })
  const answered = query.data
  return repo =>
    cachedCheck(repo) ??
    (answered ? (answered.get(repo.fullName) ?? 'unknown') : null) ??
    (query.isError ? 'unknown' : 'checking')
}
