import { warn as logWarn } from '@tauri-apps/plugin-log'
import { commands, type GitStatus } from '@/lib/bindings'

/** How often the Git panel checks GitHub for new changes while focused. */
export const FETCH_INTERVAL_MS = 5 * 60 * 1000

let lastFetch: { projectPath: string; at: number } | null = null

/** Forget when the last fetch happened, so the next load fetches first. */
export function resetGitFetchTimes(): void {
  lastFetch = null
}

/**
 * The project's git status. When signed in, it fetches from the remote first
 * (so ahead/behind are current) if this project hasn't been fetched yet or the
 * last fetch was five minutes ago; otherwise it only reads the local status,
 * which is quick enough to run after every save. A failed fetch (offline,
 * GitHub unreachable) falls back to the local status rather than failing.
 */
export async function loadGitStatus(
  projectPath: string,
  { signedIn, now = Date.now() }: { signedIn: boolean; now?: number }
): Promise<GitStatus> {
  const due =
    lastFetch?.projectPath !== projectPath ||
    now - lastFetch.at >= FETCH_INTERVAL_MS
  if (signedIn && due) {
    lastFetch = { projectPath, at: now }
    const fetched = await commands.gitFetch(projectPath)
    if (fetched.status === 'ok') return fetched.data
    void logWarn(`Astro Editor [GIT] Fetch failed: ${fetched.error}`)
  }
  const result = await commands.gitStatus(projectPath)
  if (result.status === 'error') throw new Error(result.error)
  return result.data
}
