// Temporary copy of the git types from the spec, used until the generated
// bindings exist. Deleted once `src/lib/bindings.ts` exports them.

export type FileChange =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

export interface ChangedFile {
  path: string
  oldPath: string | null
  change: FileChange
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  binary: boolean
  isImage: boolean
  hunks: DiffHunk[]
}

export type RefKind = 'head' | 'localBranch' | 'remoteBranch' | 'tag'

export interface GraphCommit {
  id: string
  shortId: string
  parents: string[]
  summary: string
  authorName: string
  time: number
  refs: { name: string; kind: RefKind }[]
}

export interface CommitDetails extends GraphCommit {
  message: string
  authorEmail: string
  files: ChangedFile[]
}
