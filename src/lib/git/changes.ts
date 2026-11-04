import type {
  ChangedFile,
  GitStatus,
  GraphCommit,
  PullRequest,
} from '@/lib/bindings'

const MAX_NAMED = 3

/**
 * The pre-filled Publish message: "Update About, Contact, Home and 2 more".
 * Titles are de-duplicated; empty when nothing changed.
 */
export function defaultCommitMessage(titles: string[]): string {
  const unique = [...new Set(titles)]
  if (unique.length === 0) return ''
  const named = unique.slice(0, MAX_NAMED).join(', ')
  const rest = unique.length - MAX_NAMED
  return rest > 0 ? `Update ${named} and ${rest} more` : `Update ${named}`
}

/** A changed file's entry title, when it's a content entry the app knows. */
export function entryTitle(
  file: ChangedFile,
  projectPath: string,
  entryTitles: Map<string, string>
): string | undefined {
  return entryTitles.get(`${projectPath.replace(/\/+$/, '')}/${file.path}`)
}

/**
 * A changed file's title for the Publish message: its entry title (keyed by
 * absolute path), else its file name without the extension.
 */
export function changedFileTitle(
  file: ChangedFile,
  projectPath: string,
  entryTitles: Map<string, string>
): string {
  const title = entryTitle(file, projectPath, entryTitles)
  if (title) return title
  const name = file.path.split('/').pop() || file.path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Titles for the Publish message: entries first, then other files. */
export function changeTitles(
  files: ChangedFile[],
  projectPath: string,
  entryTitles: Map<string, string>
): string[] {
  const isEntry = (file: ChangedFile) =>
    entryTitle(file, projectPath, entryTitles) !== undefined
  return [...files.filter(isEntry), ...files.filter(f => !isEntry(f))].map(
    file => changedFileTitle(file, projectPath, entryTitles)
  )
}

function tipOf(
  commits: GraphCommit[],
  matches: (ref: GraphCommit['refs'][number]) => boolean
): string | undefined {
  return commits.find(commit => commit.refs.some(matches))?.id
}

/**
 * Whether `defaultBranch` (preferring `origin/<default>`) has commits that the
 * current branch doesn't, judged from the loaded history. Null when either tip
 * isn't in it, so the caller can decide.
 */
export function isBehindBranch(
  commits: GraphCommit[],
  currentBranch: string,
  defaultBranch: string
): boolean | null {
  const head =
    tipOf(commits, ref => ref.kind === 'head') ??
    tipOf(
      commits,
      ref => ref.kind === 'localBranch' && ref.name === currentBranch
    )
  const base =
    tipOf(
      commits,
      ref =>
        ref.kind === 'remoteBranch' && ref.name === `origin/${defaultBranch}`
    ) ??
    tipOf(
      commits,
      ref => ref.kind === 'localBranch' && ref.name === defaultBranch
    )
  if (!head || !base) return null

  const byId = new Map(commits.map(commit => [commit.id, commit]))
  const seen = new Set<string>()
  const stack = [head]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === base) return false
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(byId.get(id)?.parents ?? []))
  }
  return true
}

/** The open pull request whose head is this branch, if there is one. */
export function pullRequestForBranch(
  pullRequests: PullRequest[],
  branch: string
): PullRequest | undefined {
  return pullRequests.find(pr => pr.head === branch && pr.state === 'open')
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

/** "Spring copy!" → "spring-copy": branch names can't have spaces. */
export function branchNameFrom(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
}
