import { error as logError } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  commands,
  type DevServerState,
  type DevServerStatus,
} from '@/lib/bindings'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * Starts the project's dev server. Progress arrives as `dev-server-state`
 * events, which `useDevServer` follows.
 */
export async function startDevServer(projectPath: string): Promise<void> {
  const result = await commands.devServerStart(projectPath)
  if (result.status === 'error') {
    toast.error("Couldn't start the dev server", { description: result.error })
  }
  await queryClient.invalidateQueries({
    queryKey: queryKeys.devServer(projectPath),
  })
}

/**
 * Stops a project's dev server. Stopping can take a few seconds while the
 * server shuts down; callers that switch away needn't wait. Does nothing if
 * none is running.
 */
export async function stopDevServer(projectPath: string): Promise<void> {
  const result = await commands.devServerStop(projectPath)
  if (result.status === 'error') {
    await logError(
      `Astro Editor [DEV_SERVER] Couldn't stop the dev server for ${projectPath}: ${result.error}`
    )
  }
  await queryClient.invalidateQueries({
    queryKey: queryKeys.devServer(projectPath),
  })
}

/**
 * Keeps a server that was started for a site preview: it becomes an ordinary
 * one, which the preview won't stop.
 */
export async function claimDevServer(projectPath: string): Promise<void> {
  await commands.devServerClaim(projectPath)
  await queryClient.invalidateQueries({
    queryKey: queryKeys.devServer(projectPath),
  })
}

/**
 * Opens the site in the browser. The writer is using the server now, so a
 * server started for a site preview is handed over first and keeps running.
 */
export async function openSiteInBrowser(
  projectPath: string,
  url: string
): Promise<void> {
  await claimDevServer(projectPath)
  openInBrowser(url)
}

/** Opens a URL in the default browser */
export function openInBrowser(url: string): void {
  void openUrl(url).catch((error: unknown) => {
    toast.error("Couldn't open the browser", { description: String(error) })
  })
}

/** Copies the server's output for a bug report or a question */
export async function copyServerOutput(lines: string[]): Promise<void> {
  const result = await commands.copyTextToClipboard(lines.join('\n'))
  if (result.status === 'error') {
    toast.error("Couldn't copy the output", { description: result.error })
  } else {
    toast.success('Server output copied')
  }
}

/** An output line that says what went wrong */
const ERROR_LINE = /\b(error|failed|cannot|not found)\b|\bERR!/i

/**
 * The error in one line, for the status dot's tooltip. Rust's errors are a
 * plain-words summary, then the server's last output lines; the first of those
 * that reads as an error usually says more than the summary, except when Node
 * is missing, where the summary says what to do.
 */
export function firstErrorLine(error: string | null): string | null {
  const lines = (error ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const [summary, ...output] = lines
  if (!summary) return null
  if (needsNode(error)) return summary
  // npm echoes the script it runs as `> <script>`
  return (
    output.find(line => !line.startsWith('>') && ERROR_LINE.test(line)) ??
    summary
  )
}

/** For the status dot's tooltip */
export function statusLabel(state: DevServerState): string {
  switch (state.status) {
    case 'installing':
      return 'Installing dependencies…'
    case 'starting':
      return 'Starting the dev server…'
    case 'running':
      return `Running at ${state.url ?? ''}`
    case 'external':
      return `${EXTERNAL_LABEL}: ${state.url ?? ''}`
    case 'error':
      return firstErrorLine(state.error) ?? 'The dev server stopped'
    case 'stopped':
      return 'Stopped'
  }
}

export const EXTERNAL_LABEL = 'Running in another window or terminal'

/** The Preview button's tooltip */
export function previewTitle(state: DevServerState): string {
  return state.command
    ? `Preview the site (${state.command})`
    : 'Preview the site'
}

/** Installing or starting: on its way, not ready yet */
export function isBusy(status: DevServerStatus): boolean {
  return status === 'installing' || status === 'starting'
}

/** The error says Node (or its package manager) couldn't be found */
export function needsNode(error: string | null): boolean {
  return error?.includes(NODE_DOWNLOAD_URL) ?? false
}

export const NODE_DOWNLOAD_URL = 'https://nodejs.org'

export const STOPPED_STATE: DevServerState = {
  status: 'stopped',
  url: null,
  command: null,
  pid: null,
  error: null,
}
