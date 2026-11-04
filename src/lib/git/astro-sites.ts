import type { AstroCheck, RepoSummary } from '@/lib/bindings'

/** What the list shows for a repository. */
export type SiteStatus = AstroCheck | 'checking'

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

// The saved answers are parsed once per change, not once per row per render
let parsedFrom: string | null = null
let parsed: Cache = {}

function readCache(): Cache {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(CACHE_KEY)
  } catch {
    return {}
  }
  if (raw === parsedFrom) return parsed
  try {
    const value: unknown = JSON.parse(raw ?? '{}')
    parsed = value && typeof value === 'object' ? (value as Cache) : {}
  } catch {
    parsed = {}
  }
  parsedFrom = raw
  return parsed
}

/** The saved answer for this repository at its current push, or null. */
export function cachedCheck(repo: RepoSummary): AstroCheck | null {
  const hit = readCache()[repo.fullName]
  if (!hit || hit.pushedAt !== pushMarker(repo)) return null
  return hit.astro ? 'astro' : 'notAstro'
}

/**
 * Saves the definite answers (`unknown` is never saved, so it's tried again).
 * With `keep` (the names in a fully loaded list), answers for repositories that
 * are no longer in it are dropped.
 */
export function saveChecks(
  repos: RepoSummary[],
  answers: Map<string, AstroCheck>,
  keep?: Set<string>
): void {
  const cache = { ...readCache() }
  if (keep) {
    for (const name of Object.keys(cache)) {
      if (!keep.has(name)) delete cache[name]
    }
  }
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
 * be checked, stay. The repository picked (by clone URL) always stays, so what
 * will be downloaded never disappears from the list.
 */
export function visibleRepos(
  repos: RepoSummary[],
  statusOf: (repo: RepoSummary) => SiteStatus,
  showAll: boolean,
  pickedCloneUrl: string | null = null
): RepoSummary[] {
  if (showAll) return repos
  return repos.filter(
    repo => repo.cloneUrl === pickedCloneUrl || statusOf(repo) !== 'notAstro'
  )
}
