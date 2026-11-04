import type {
  ChangedFile,
  FileChange,
  GitStatus,
  GraphCommit,
  PullRequest,
} from '@/lib/bindings'

const MAX_NAMED = 3
const IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i

/** One changed file, as the Publish message sees it. */
export interface MessageItem {
  change: FileChange
  /** A content entry (inside a collection), as opposed to an asset */
  entry: boolean
  /** The entry's title, when it's known */
  title?: string
  path: string
}

type Verb = 'Add' | 'Update' | 'Remove'

function verbFor(change: FileChange): Verb {
  if (change === 'added' || change === 'untracked') return 'Add'
  if (change === 'deleted') return 'Remove'
  return 'Update'
}

/** The verb when every item agrees, else "Update". */
function sharedVerb(items: MessageItem[]): Verb {
  const verbs = new Set(items.map(item => verbFor(item.change)))
  return verbs.size === 1 ? [...verbs][0]! : 'Update'
}

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1)

/**
 * A title as it reads inside the message: without its closing full stop (or
 * ?, !, …, ;, :, ,), which would otherwise run into the commas between titles
 */
const inMessage = (title: string) =>
  title.replace(/[\s.!?…;:,]+$/u, '') || title

/**
 * The pre-filled Publish message, in the writer's words: entry titles only
 * (never file names), with Add, Update or Remove as fits, at most three names
 * then "and N more". Images and other assets aren't named: they're mentioned
 * as "and images" (or "and other files"), or make up the whole message when
 * nothing else changed. Empty when nothing changed.
 */
export function publishMessage(items: MessageItem[]): string {
  const entries = items.filter(item => item.entry)
  const assets = items.filter(item => !item.entry)
  const assetWord =
    assets.length === 0
      ? null
      : assets.every(asset => IMAGE.test(asset.path))
        ? 'images'
        : 'other files'

  if (entries.length === 0) {
    if (!assetWord) return ''
    const what = assetWord === 'images' ? 'images' : 'site files'
    return `${sharedVerb(assets)} ${what}`
  }

  // Named entries, each title once, grouped by verb in a fixed order
  const seen = new Set<string>()
  const named: { verb: Verb; title: string }[] = []
  for (const entry of entries) {
    if (!entry.title) continue
    const title = inMessage(entry.title)
    if (seen.has(title)) continue
    seen.add(title)
    named.push({ verb: verbFor(entry.change), title })
  }
  const unnamed = entries.filter(entry => !entry.title)
  const shown = named.slice(0, MAX_NAMED)
  const overflow = named.length - shown.length

  const phrases = (['Add', 'Update', 'Remove'] as const)
    .map(verb => {
      const titles = shown.filter(n => n.verb === verb).map(n => n.title)
      return titles.length > 0
        ? `${verb.toLowerCase()} ${titles.join(', ')}`
        : ''
    })
    .filter(Boolean)
  // Entries without a title (a deleted one, usually) are counted, never named
  // by file: in their own phrase while there's room, else in "and N more"
  if (unnamed.length > 0 && overflow === 0) {
    const noun = unnamed.length === 1 ? 'entry' : 'entries'
    phrases.push(
      `${sharedVerb(unnamed).toLowerCase()} ${unnamed.length} ${noun}`
    )
  }
  const text = capitalize(phrases.join(', '))
  if (overflow > 0) return `${text} and ${overflow + unnamed.length} more`
  return assetWord ? `${text} and ${assetWord}` : text
}

/** A changed file's entry title, when it's a content entry the app knows. */
export function entryTitle(
  file: Pick<ChangedFile, 'path'>,
  projectPath: string,
  entryTitles: Map<string, string>
): string | undefined {
  return entryTitles.get(`${projectPath.replace(/\/+$/, '')}/${file.path}`)
}

/** The open pull request whose head is this branch, if there is one. */
export function pullRequestForBranch(
  pullRequests: PullRequest[],
  branch: string
): PullRequest | undefined {
  return pullRequests.find(pr => pr.head === branch && pr.state === 'open')
}

/**
 * A first guess at a pull request's title: the summary of the latest commit
 * on the branch that isn't a merge (Sync and Bring in make those), looking at
 * the `ahead` commits the default branch doesn't have; else "Changes from
 * {branch}".
 */
export function pullRequestTitle(
  log: GraphCommit[],
  branch: string,
  ahead: number
): string {
  const byId = new Map(log.map(commit => [commit.id, commit]))
  let commit = log.find(c => c.refs.some(ref => ref.kind === 'head'))
  for (let step = 0; commit && step < ahead; step++) {
    if (commit.parents.length <= 1 && commit.summary.trim()) {
      return commit.summary.trim()
    }
    commit = byId.get(commit.parents[0] ?? '')
  }
  return `Changes from ${branch}`
}

/**
 * Where the branch stands against its copy online, in words:
 * "2 updates not on GitHub yet · 3 new on GitHub".
 */
export function syncSummary(
  status: Pick<GitStatus, 'ahead' | 'behind' | 'upstream'>,
  remoteName: string
): string {
  if (!status.upstream)
    return `Not on ${remoteName} yet. Publish puts it there.`
  const parts: string[] = []
  if (status.ahead > 0) {
    const noun = status.ahead === 1 ? 'update' : 'updates'
    parts.push(`${status.ahead} ${noun} not on ${remoteName} yet`)
  }
  if (status.behind > 0) parts.push(`${status.behind} new on ${remoteName}`)
  return parts.length > 0 ? parts.join(' · ') : `Up to date with ${remoteName}`
}

/** "Checked just now", "Checked 3 min ago": when GitHub last answered. */
export function checkedLabel(checkedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000)
  if (minutes < 1) return 'Checked just now'
  if (minutes < 60) return `Checked ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `Checked ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `Checked ${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** "Everything is saved. 2 updates waiting to be published." */
export function waitingToPublish(ahead: number): string {
  const noun = ahead === 1 ? 'update' : 'updates'
  return `Everything is saved. ${ahead} ${noun} waiting to be published.`
}

/** "Spring copy!" → "spring-copy": branch names can't have spaces. */
export function branchNameFrom(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
}

/** The panel actions that can be held back after a conflict. */
export type GitAction = 'publish' | 'sync' | 'bringIn'

/**
 * What the repository looks like, as far as a retry is concerned: a new fetch
 * (behind), new commits (ahead), other edits or another branch change it. An
 * action that just hit a conflict stays disabled while this stays the same,
 * because trying again would only hit it again.
 */
export function gitStateSignature(
  status: GitStatus,
  behindDefault: number
): string {
  const files = status.files
    .map(file => `${file.change}:${file.path}`)
    .join(',')
  return [
    status.branch,
    status.ahead,
    status.behind,
    behindDefault,
    files,
  ].join('|')
}

export const BUSY = 'Still finishing the last change. Try again in a moment.'
// The notice above it already says what to do next
export const REPEAT =
  'Nothing has changed since the last try, so it would stop the same way.'

interface GuardInput {
  status: GitStatus | undefined
  busy: boolean
  /** The action that last stopped on a conflict, while nothing has changed */
  heldBack: GitAction | null
}

function common(
  { status, busy, heldBack }: GuardInput,
  action: GitAction
): string | null {
  if (busy) return BUSY
  if (!status?.isRepo) return "This project isn't a git repository."
  if (status.detached) {
    return "You're looking at an older version, not a branch. Switch to a branch first."
  }
  if (heldBack === action) return REPEAT
  return null
}

/**
 * Why Publish can't run right now, or null when it can. With unsaved edits in
 * the editor there's always something to publish: Publish saves them first.
 */
export function publishBlocker(
  input: GuardInput & { message: string; unsavedEdits?: boolean }
): string | null {
  const reason = common(input, 'publish')
  if (reason) return reason
  const status = input.status!
  if (input.unsavedEdits && status.files.length === 0) return null
  if (status.files.length === 0 && status.ahead === 0 && status.upstream) {
    return 'Nothing new to publish.'
  }
  if (status.files.length > 0 && input.message.trim() === '') {
    return 'Write a short message describing your changes.'
  }
  return null
}

/** Why Sync can't run right now, or null when it can. */
export function syncBlocker(input: GuardInput): string | null {
  return common(input, 'sync')
}

/** Why "Bring in changes" can't run right now, or null when it can. */
export function bringInBlocker(input: GuardInput): string | null {
  return common(input, 'bringIn')
}
