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

/** Titles in lists and messages are at most this long, with the "…". */
export const MAX_TITLE_LENGTH = 40

/**
 * A title short enough for a list or a message: anything longer than 40
 * characters is cut, at a word when there's one past the middle, and ends
 * with "…". The full title stays in tooltips.
 */
export function shortTitle(title: string): string {
  if (title.length <= MAX_TITLE_LENGTH) return title
  let cut = title.slice(0, MAX_TITLE_LENGTH - 1)
  const space = cut.lastIndexOf(' ')
  if (space > MAX_TITLE_LENGTH / 2) cut = cut.slice(0, space)
  return `${cut.trimEnd()}…`
}

/** The toast after a publish that reached the remote. */
export function publishedMessage(
  branch: string | null,
  defaultBranch: string | null
): string {
  if (branch && branch === defaultBranch) {
    return 'Published. Your site will update in a few minutes.'
  }
  return branch ? `Published to ${branch}.` : 'Published.'
}

/**
 * The toast after "Bring in changes": how many came in (when known) and that
 * they still need publishing. "the remote" becomes "GitHub" when presented.
 */
export function broughtInMessage(count: number, defaultBranch: string): string {
  const what =
    count > 0 ? `${count} ${count === 1 ? 'change' : 'changes'}` : 'the changes'
  return `Brought in ${what} from ${defaultBranch}. Publish to send them to the remote.`
}
