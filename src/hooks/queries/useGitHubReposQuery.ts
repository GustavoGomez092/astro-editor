import { useQueries, useQuery } from '@tanstack/react-query'
import { homeDir } from '@tauri-apps/api/path'
import { commands, type AstroCheck, type RepoSummary } from '@/lib/bindings'
import {
  CHECK_CHUNK_SIZE,
  cachedCheck,
  chunk,
  pushMarker,
  saveChecks,
  type SiteStatus,
} from '@/lib/git/astro-sites'
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

/** The query for one group of repositories (the styleguide seeds it by this key). */
export const astroSitesKey = (group: RepoSummary[]) =>
  ['astroSites', ...group.map(r => `${r.fullName}@${pushMarker(r)}`)] as const

/**
 * Whether each repository is an Astro site. Saved answers are used at once; the
 * rest are asked of GitHub 50 at a time, newest first, and saved for next time.
 * Until a repository is answered it is 'checking'; one that can't be checked
 * (or whose request failed) is 'unknown'.
 */
export function useAstroSiteStatus(
  repos: RepoSummary[],
  enabled: boolean
): (repo: RepoSummary) => SiteStatus {
  const chunks = chunk(repos, CHECK_CHUNK_SIZE)
  const results = useQueries({
    queries: chunks.map(group => ({
      queryKey: astroSitesKey(group),
      queryFn: async () => {
        const todo = group.filter(r => cachedCheck(r) === null)
        const answers = new Map<string, AstroCheck>()
        if (todo.length > 0) {
          const checked = await unwrap(
            commands.githubCheckAstroRepos(todo.map(r => r.fullName))
          ).catch(() => [])
          for (const c of checked) answers.set(c.fullName, c.check)
          saveChecks(todo, answers)
        }
        return answers
      },
      enabled: enabled && group.some(r => cachedCheck(r) === null),
      staleTime: Infinity,
      retry: false,
    })),
  })
  const answered = new Map<string, AstroCheck>()
  chunks.forEach((group, i) => {
    const data = results[i]?.data
    if (data)
      for (const r of group)
        answered.set(r.fullName, data.get(r.fullName) ?? 'unknown')
  })
  return repo => cachedCheck(repo) ?? answered.get(repo.fullName) ?? 'checking'
}
