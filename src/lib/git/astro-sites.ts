import type { AstroCheck, RepoSummary } from '@/lib/bindings'

/** What the list shows for a repository. */
export type SiteStatus = AstroCheck | 'checking'

/** Repositories per request, matching what Rust sends GitHub in one query. */
export const CHECK_CHUNK_SIZE = 50

const CACHE_KEY = 'astro-editor:astro-site-checks'
const SHOW_ALL_KEY = 'astro-editor:open-from-github-show-all'

/**
 * Cached answers for "is it an Astro site", by repository name. An answer is
 * only good for the push it was made at: a repository is looked at again after
 * someone pushes to it.
 */
type Cache = Record<string, { pushedAt: string; astro: boolean }>

/** The repository's last push, else its last update (a repository can lack a push). */
export function pushMarker(repo: RepoSummary): string {
  return repo.pushedAt ?? repo.updatedAt
}

function readCache(): Cache {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? (raw as Cache) : {}
  } catch {
    return {}
  }
}

/** The saved answer for this repository at its current push, or null. */
export function cachedCheck(repo: RepoSummary): AstroCheck | null {
  const hit = readCache()[repo.fullName]
  if (!hit || hit.pushedAt !== pushMarker(repo)) return null
  return hit.astro ? 'astro' : 'notAstro'
}

/** Saves the definite answers (`unknown` is never saved, so it's tried again). */
export function saveChecks(
  repos: RepoSummary[],
  answers: Map<string, AstroCheck>
): void {
  const cache = readCache()
  for (const repo of repos) {
    const answer = answers.get(repo.fullName)
    if (answer === 'astro' || answer === 'notAstro') {
      cache[repo.fullName] = {
        pushedAt: pushMarker(repo),
        astro: answer === 'astro',
      }
    }
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Not saving only means checking again next time
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/** Whether the writer chose to see every repository, not just Astro sites. */
export function loadShowAll(): boolean {
  try {
    return localStorage.getItem(SHOW_ALL_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveShowAll(value: boolean): void {
  try {
    localStorage.setItem(SHOW_ALL_KEY, String(value))
  } catch {
    // The choice just isn't remembered
  }
}

/**
 * The repositories to list. With the filter on, repositories known not to be
 * Astro sites are left out; ones still being checked, and ones that couldn't
 * be checked, stay.
 */
export function visibleRepos(
  repos: RepoSummary[],
  statusOf: (repo: RepoSummary) => SiteStatus,
  showAll: boolean
): RepoSummary[] {
  if (showAll) return repos
  return repos.filter(repo => statusOf(repo) !== 'notAstro')
}
