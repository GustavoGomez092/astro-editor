import { warn as logWarn } from '@tauri-apps/plugin-log'
import { commands, type GitStatus } from '@/lib/bindings'

/** How often the Git panel checks GitHub for new changes while focused. */
export const FETCH_INTERVAL_MS = 5 * 60 * 1000

/** A five-minute timer may fire a little early; that still counts. */
export const FETCH_SLACK_MS = 30 * 1000

const lastFetch = new Map<string, number>()

/** Forget when each project was last fetched, so the next load fetches. */
export function resetGitFetchTimes(): void {
  lastFetch.clear()
}

interface LoadOptions {
  signedIn: boolean
  now?: number
  /** Called with the status after a background fetch succeeds */
  onFetched?: (status: GitStatus) => void
}

/**
 * The project's git status, read locally so it's quick. When signed in and the
 * project hasn't been fetched in the last five minutes, it also starts a fetch
 * in the background and hands its status (with fresh ahead/behind) to
 * `onFetched`. The fetch never delays the status: git commands on one
 * repository run one at a time, so the local read goes first. A failed fetch
 * (offline, GitHub unreachable) only logs a warning.
 */
export async function loadGitStatus(
  projectPath: string,
  { signedIn, now = Date.now(), onFetched }: LoadOptions
): Promise<GitStatus> {
  const result = await commands.gitStatus(projectPath)
  if (result.status === 'error') throw new Error(result.error)

  const last = lastFetch.get(projectPath)
  const due =
    last === undefined || now - last >= FETCH_INTERVAL_MS - FETCH_SLACK_MS
  if (signedIn && result.data.isRepo && due) {
    lastFetch.set(projectPath, now)
    void commands.gitFetch(projectPath).then(fetched => {
      if (fetched.status === 'ok') onFetched?.(fetched.data)
      else void logWarn(`Astro Editor [GIT] Fetch failed: ${fetched.error}`)
    })
  }
  return result.data
}
