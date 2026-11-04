import React from 'react'
import {
  AlertTriangle,
  CircleCheck,
  CloudUpload,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitMerge,
  History,
  RefreshCw,
  X,
} from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { GitStatus, SyncOutcome } from '@/lib/bindings'
import {
  bringInBlocker,
  checkedLabel,
  publishBlocker,
  syncBlocker,
  syncSummary,
  waitingToPublish,
  type GitAction,
} from '@/lib/git/changes'
import { cn } from '@/lib/utils'
import { useNow } from '../../hooks/useNow'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { AutoExpandingTextarea } from '../ui/auto-expanding-textarea'
import { ChangedFileRow } from './ChangedFileRow'

/** A sync, publish or bring-in that needs the writer's attention. */
export interface GitNotice {
  /** Already presented for the writer (titles, "GitHub") */
  message: string
  outcome: SyncOutcome
  /** Where to sort it out: the repository on GitHub */
  url: string | null
  /** A conflict the Resolve view can sort out (one with GitHub's copy) */
  resolvable?: boolean
  /** A conflict with the default branch while there's local work to publish */
  publishFirst?: boolean
}

export interface ChangesViewProps {
  status: GitStatus | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
  /** When GitHub last answered, for "Checked 3 min ago" */
  checkedAt?: number | null
  /** "GitHub" when origin is on github.com */
  remoteName: string
  /** Origin is on GitHub and the writer isn't signed in */
  needsSignIn: boolean
  onSignIn: () => void
  /** The branch menu, built by the caller */
  branchMenu: React.ReactNode
  onShowHistory: () => void
  onSync: () => void
  syncing: boolean
  /** Show "Bring in changes from {defaultBranch}" */
  behindDefault: boolean
  onBringIn: () => void
  bringingIn: boolean
  /** The pull request card or Open pull request button, if it applies */
  pullRequest: React.ReactNode
  notice: GitNotice | null
  onDismissNotice: () => void
  /** Files that conflict with GitHub's copy; Resolve sorts them out */
  conflictCount?: number
  onResolve?: () => void
  /** A git operation that changes the repository is running */
  busy: boolean
  /** The action that last hit a conflict, while nothing has changed since */
  heldBack: GitAction | null
  selectedPath: string | null
  onSelectFile: (path: string) => void
  /** Asks to throw away one file's changes (the caller confirms) */
  onDiscardFile?: (path: string) => void
  /** Entry titles of changed content files, by repository-relative path */
  titles?: Map<string, string>
  message: string
  onMessageChange: (message: string) => void
  /** The open file has edits not saved yet; Publish saves them first */
  unsavedEdits?: boolean
  onPublish: () => void
  publishing: boolean
}

/**
 * The Changes tab: the branch, where it stands against GitHub, Sync, the
 * changed files (each opens its diff), a message and Publish. Presentational;
 * `ChangesPanel` supplies the data.
 */
export function ChangesView(props: ChangesViewProps) {
  const { status, loading, error } = props

  if (loading && !status) {
    return (
      <Centered>
        <Spinner /> Checking for changes…
      </Centered>
    )
  }
  if (error && !status) {
    return (
      <Centered>
        <p className="text-sm text-foreground">
          Couldn't read this project's changes.
        </p>
        <p className="text-xs">{error}</p>
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          Try again
        </Button>
      </Centered>
    )
  }
  if (!status) return null
  if (!status.isRepo) {
    return (
      <Centered>
        <FolderGit2 className="size-5 text-icon" />
        <p className="text-sm">This project isn't a git repository.</p>
      </Centered>
    )
  }
  return <RepoChanges {...props} status={status} />
}

/**
 * "Checked 3 min ago". Its own component, so the clock ticking every 30
 * seconds re-renders only this line.
 */
function CheckedLabel({ checkedAt }: { checkedAt: number }) {
  const now = useNow(30 * 1000)
  return (
    <p className="px-2 text-xs text-muted-foreground">
      {checkedLabel(checkedAt, now)}
    </p>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function RepoChanges({
  status,
  checkedAt,
  remoteName,
  needsSignIn,
  onSignIn,
  branchMenu,
  onShowHistory,
  onSync,
  syncing,
  behindDefault,
  onBringIn,
  bringingIn,
  pullRequest,
  notice,
  onDismissNotice,
  conflictCount = 0,
  onResolve,
  busy,
  heldBack,
  selectedPath,
  onSelectFile,
  onDiscardFile,
  titles,
  message,
  onMessageChange,
  unsavedEdits,
  onPublish,
  publishing,
}: ChangesViewProps & { status: GitStatus }) {
  const fileCount = status.files.length
  const guard = { status, busy, heldBack }
  const publishReason = publishBlocker({ ...guard, message, unsavedEdits })
  const syncReason = syncBlocker(guard)
  const bringInReason = bringInBlocker(guard)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b bg-muted/30 px-2 pt-2 pb-2.5">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">{branchMenu}</div>
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
            title="History"
            aria-label="History"
            onClick={onShowHistory}
          >
            <History className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-icon"
            disabled={syncing || (!needsSignIn && syncReason !== null)}
            onClick={needsSignIn ? onSignIn : onSync}
            title={syncReason ?? `Check ${remoteName} for new changes`}
          >
            <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />
            Sync
          </Button>
        </div>
        {!needsSignIn && !status.detached && (
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            {syncSummary(status, remoteName)}
          </p>
        )}
        {!needsSignIn && checkedAt != null && (
          <CheckedLabel checkedAt={checkedAt} />
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {notice && (
          <Callout tone="warning" onDismiss={onDismissNotice}>
            <p>{notice.message}</p>
            {notice.outcome === 'conflict' && notice.resolvable && (
              <>
                <p className="text-muted-foreground">
                  Choose which version to keep, and it's published.
                </p>
                <Button size="sm" onClick={onResolve} disabled={busy}>
                  Choose which to keep
                </Button>
              </>
            )}
            {notice.outcome === 'conflict' && !notice.resolvable && (
              <p className="text-muted-foreground">
                {notice.publishFirst
                  ? "Publish your edits first, so they're safe. "
                  : ''}
                {notice.url
                  ? 'Open it on GitHub, or ask whoever manages the site.'
                  : 'Ask whoever manages the site to sort it out.'}
              </p>
            )}
            {notice.url && !notice.resolvable && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2"
                onClick={() => void openUrl(notice.url!)}
              >
                Open on GitHub <ExternalLink className="size-3" />
              </button>
            )}
          </Callout>
        )}

        {!notice && conflictCount > 0 && (
          <Callout tone="warning">
            <p>
              Your changes and the changes on {remoteName} both changed the same{' '}
              {conflictCount === 1 ? 'file' : 'files'}, so they can't be
              published together yet.
            </p>
            <Button size="sm" onClick={onResolve} disabled={busy}>
              Choose which to keep
            </Button>
          </Callout>
        )}

        {needsSignIn && (
          <Callout>
            <p>Sign in with GitHub to sync and publish.</p>
            <Button size="sm" onClick={onSignIn}>
              Sign in with GitHub
            </Button>
          </Callout>
        )}

        {status.detached && (
          <Callout tone="warning">
            <p>
              You're looking at an older version, not a branch. Switch to a
              branch to publish.
            </p>
          </Callout>
        )}

        {behindDefault && status.defaultBranch && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={bringingIn || bringInReason !== null}
            title={bringInReason ?? undefined}
            onClick={onBringIn}
          >
            {bringingIn ? <Spinner /> : <GitMerge />}
            Bring in changes from {status.defaultBranch}
          </Button>
        )}

        {pullRequest}

        <div className="space-y-1">
          <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
            <span>Changed files</span>
            {fileCount > 0 && <span>{fileCount}</span>}
          </div>
          {fileCount === 0 ? (
            <p className="flex items-start gap-2 px-1 py-2 text-sm text-muted-foreground">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-git-add" />
              {status.ahead > 0
                ? waitingToPublish(status.ahead)
                : 'No changes since the last publish.'}
            </p>
          ) : (
            <div className="-mx-1">
              {status.files.map(file => (
                <ChangedFileRow
                  key={file.path}
                  file={file}
                  title={titles?.get(file.path)}
                  selected={file.path === selectedPath}
                  onSelect={onSelectFile}
                  onDiscard={onDiscardFile}
                  discardDisabled={busy}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t p-3">
        {fileCount > 0 && (
          <AutoExpandingTextarea
            aria-label="Describe your changes"
            placeholder="Describe your changes"
            value={message}
            onChange={event => onMessageChange(event.target.value)}
            disabled={busy}
            minRows={2}
            maxRows={6}
            className="bg-background text-sm"
          />
        )}
        <Button
          className="w-full"
          disabled={publishing || (!needsSignIn && publishReason !== null)}
          title={publishReason ?? undefined}
          onClick={needsSignIn ? onSignIn : onPublish}
        >
          {publishing ? <Spinner /> : <CloudUpload />}
          {publishing ? 'Publishing…' : 'Publish'}
        </Button>
        {status.branch && (
          <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
            <GitBranch className="size-3" />
            {status.branch}
          </p>
        )}
      </div>
    </div>
  )
}

function Callout({
  tone = 'neutral',
  onDismiss,
  children,
}: {
  tone?: 'neutral' | 'warning'
  onDismiss?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      role={tone === 'warning' ? 'alert' : undefined}
      className={cn(
        'relative flex gap-2 rounded-lg border p-3 text-sm',
        tone === 'warning'
          ? 'border-draft/30 bg-draft-bg text-foreground'
          : 'bg-muted/40 text-foreground'
      )}
    >
      {tone === 'warning' && (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-draft" />
      )}
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
      {onDismiss && (
        <button
          type="button"
          className="-mt-1 -mr-1 size-6 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="mx-auto size-3.5" />
        </button>
      )}
    </div>
  )
}
