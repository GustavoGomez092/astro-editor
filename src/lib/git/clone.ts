import { listen } from '@tauri-apps/api/event'
import { commands, type CloneProgress, type RepoSummary } from '@/lib/bindings'
import { unwrap } from './unwrap'

/** Repositories whose "owner/name" contains the search, ignoring case. */
export function filterRepos(
  repos: RepoSummary[],
  search: string
): RepoSummary[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return repos
  return repos.filter(repo => repo.fullName.toLowerCase().includes(needle))
}

const GITHUB_URL =
  /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/

/**
 * An HTTPS clone URL from a pasted GitHub address (web page, clone URL or
 * SSH), or null. SSH becomes HTTPS so the GitHub sign-in is used.
 */
export function cloneUrlFromInput(input: string): string | null {
  const match = GITHUB_URL.exec(input.trim())
  if (!match) return null
  return `https://github.com/${match[1]}/${match[2]}.git`
}

/** Download progress in percent, or null while the size isn't known yet. */
export function cloneProgressPercent(progress: CloneProgress): number | null {
  if (progress.total <= 0) return null
  return Math.min(100, Math.floor((progress.received / progress.total) * 100))
}

/** Where new projects go by default: ~/Sites. */
export function sitesFolder(home: string): string {
  return `${home.replace(/\/+$/, '')}/Sites`
}

/**
 * Clones into a new folder inside `parentDir`, reporting progress, and
 * resolves to the new project's path.
 */
export async function cloneRepository(
  cloneUrl: string,
  parentDir: string,
  onProgress: (progress: CloneProgress) => void
): Promise<string> {
  const unlisten = await listen<CloneProgress>('git-clone-progress', event =>
    onProgress(event.payload)
  )
  return unwrap(commands.gitClone(cloneUrl, parentDir)).finally(unlisten)
}
