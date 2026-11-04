import type { SyncOutcome } from '@/lib/bindings'
import { toast } from '@/lib/toast'

/** How a sync's outcome is shown: done, nothing to do, or needs attention. */
export function syncToastKind(
  outcome: SyncOutcome
): 'success' | 'info' | 'warning' {
  switch (outcome) {
    case 'fastForwarded':
    case 'merged':
      return 'success'
    case 'upToDate':
    case 'noUpstream':
      return 'info'
    case 'blockedByLocalChanges':
    case 'conflict':
      return 'warning'
  }
}

/** Shows a sync's or merge's plain-language message as the right kind of toast. */
export function showSyncOutcome(
  result: { outcome: SyncOutcome; message: string },
  present: (message: string) => string = message => message
): void {
  toast[syncToastKind(result.outcome)](present(result.message))
}

/** Repository paths in a message: words with a slash or an extension. */
const PATH =
  /(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]+(?=[\s,;:)]|\.(?:\s|$)|$)/g

/** The file paths an engine message mentions, in order. */
export function pathsIn(message: string): string[] {
  return message.match(PATH) ?? []
}

/**
 * An engine message as the writer should read it: entries named by their
 * titles rather than their paths, and "GitHub" rather than "the remote" when
 * the remote is GitHub.
 */
export function presentGitMessage(
  message: string,
  {
    onGitHub,
    titleFor,
  }: { onGitHub: boolean; titleFor: (path: string) => string | undefined }
): string {
  let text = message.replace(PATH, path => {
    const title = titleFor(path)
    return title ? `“${title}”` : path
  })
  if (onGitHub) {
    text = text
      .replace(/\bThe remote\b/g, 'GitHub')
      .replace(/\bthe remote\b/g, 'GitHub')
  }
  return text
}
