import { useEffect, useRef, useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import type { GitStatus, PullRequest, SyncOutcome } from '@/lib/bindings'
import {
  bringInBlocker,
  gitStateSignature,
  publishBlocker,
  publishMessage,
  pullRequestForBranch,
  syncBlocker,
  type GitAction,
} from '@/lib/git/changes'
import { pathsIn, presentGitMessage } from '@/lib/git/messages'
import { needsAttention } from '@/lib/git/repo-change'
import { startGitHubSignIn } from '@/lib/git/sign-in'
import { toast } from '@/lib/toast'
import { useProjectStore } from '../../store/projectStore'
import { useGitStore } from '../../store/gitStore'
import { useUIStore } from '../../store/uiStore'
import { useGitBusy } from '../../hooks/useGitBusy'
import { useGitStatusQuery } from '../../hooks/queries/useGitStatusQuery'
import { useGitHubAuthQuery } from '../../hooks/queries/useGitHubAuthQuery'
import { useGitHubRepoInfoQuery } from '../../hooks/queries/useGitHubRepoInfoQuery'
import { useGitBranchesQuery } from '../../hooks/queries/useGitBranchesQuery'
import { useGitBehindDefaultQuery } from '../../hooks/queries/useGitBehindDefaultQuery'
import { usePullRequestsQuery } from '../../hooks/queries/usePullRequestsQuery'
import { useEntryLookup } from '../../hooks/queries/useEntryLookup'
import { useGitPublishMutation } from '../../hooks/mutations/useGitPublishMutation'
import { useGitSyncMutation } from '../../hooks/mutations/useGitSyncMutation'
import { useGitCheckoutMutation } from '../../hooks/mutations/useGitCheckoutMutation'
import { useCreatePullRequestMutation } from '../../hooks/mutations/useCreatePullRequestMutation'
import { useMergePullRequestMutation } from '../../hooks/mutations/useMergePullRequestMutation'
import { useMergeDefaultBranchMutation } from '../../hooks/mutations/useMergeDefaultBranchMutation'
import { Button } from '../ui/button'
import { BranchMenu, NewBranchDialog } from './BranchMenu'
import { ChangesView } from './ChangesView'
import { OpenPullRequestDialog } from './OpenPullRequestDialog'
import { PullRequestCard } from './PullRequestCard'

/** A conflict or blocked attempt, kept on screen until it's dismissed. */
interface StoredNotice {
  /** The engine's message; presented at render, when titles are known */
  raw: string
  outcome: SyncOutcome
  action: GitAction
  /** The branch it happened on: switching hides it */
  branch: string | null
  /** The repository just after it: while this holds, retrying is pointless */
  signature: string
}

/** Shows the Changes tab, opening the sidebar if it's closed. */
function showChanges() {
  useUIStore.getState().setSidebarVisible(true)
  useGitStore.getState().setPanelTab('changes')
}

/**
 * The Changes tab of the left sidebar: wires git status, branches and pull
 * requests to `ChangesView`, and handles the palette's Publish and Sync.
 * Stays mounted while the Files tab is shown; LeftSidebar remounts it for each
 * project, so a draft message or notice never follows you to another project.
 */
export function ChangesPanel() {
  const projectPath = useProjectStore(state => state.projectPath)
  const statusQuery = useGitStatusQuery(projectPath)
  const status = statusQuery.data
  const isRepo = status?.isRepo ?? false
  const branch = status?.branch ?? null
  const defaultBranch = status?.defaultBranch ?? null
  const onFeatureBranch =
    !!branch && !!defaultBranch && branch !== defaultBranch

  const auth = useGitHubAuthQuery().data
  const repo = useGitHubRepoInfoQuery(isRepo ? projectPath : null).data
  const onGitHub = !!repo
  const signedIn = auth?.signedIn ?? false
  const needsSignIn = onGitHub && !signedIn
  const remoteName = onGitHub ? 'GitHub' : 'the remote'

  const branches = useGitBranchesQuery(projectPath, { enabled: isRepo }).data
  const pullRequests = usePullRequestsQuery(isRepo ? projectPath : null).data
  const behindDefaultCount =
    useGitBehindDefaultQuery(projectPath, {
      enabled: isRepo && onFeatureBranch,
    }).data ?? 0
  const behindDefault = onFeatureBranch && behindDefaultCount > 0
  const busy = useGitBusy()

  const [stored, setStored] = useState<StoredNotice | null>(null)
  const notice = stored && stored.branch === branch ? stored : null
  const signature = status ? gitStateSignature(status, behindDefaultCount) : ''
  // Only a conflict repeats for sure. A blocked attempt can be cleared by
  // something git doesn't see (moving an ignored file), so it stays enabled
  const heldBack =
    notice && notice.outcome === 'conflict' && notice.signature === signature
      ? notice.action
      : null

  // Titles for the changed files, and for files a notice mentions (a
  // conflicting file is often committed already, so not among the changes)
  const files = status?.files ?? []
  const lookup = useEntryLookup(projectPath, [
    ...files.map(file => file.path),
    ...(notice ? pathsIn(notice.raw) : []),
  ])
  const titles = new Map<string, string>()
  for (const file of files) {
    const title = lookup.titleFor(file.path)
    if (title) titles.set(file.path, title)
  }
  const present = (message: string) =>
    presentGitMessage(message, { onGitHub, titleFor: lookup.titleFor })

  const [draft, setDraft] = useState<string | null>(null)
  const message =
    draft ??
    publishMessage(
      files.map(file => ({
        change: file.change,
        path: file.path,
        entry: lookup.isEntry(file.path),
        title: lookup.titleFor(file.path),
      }))
    )

  const [openingPullRequest, setOpeningPullRequest] = useState(false)
  const selectedDiffPath = useGitStore(state => state.selectedDiffPath)
  const newBranchOpen = useGitStore(state => state.newBranchOpen)

  /** Keeps a conflict or blocked outcome on screen, instead of a toast. */
  const keepNotice =
    (action: GitAction) =>
    (result: { outcome: SyncOutcome; message: string; status: GitStatus }) => {
      setStored({
        raw: result.message,
        outcome: result.outcome,
        action,
        branch: result.status.branch,
        signature: gitStateSignature(result.status, behindDefaultCount),
      })
      // From the palette the panel may be out of sight
      showChanges()
    }

  const publish = useGitPublishMutation({
    present,
    onNeedsAttention: keepNotice('publish'),
  })
  const sync = useGitSyncMutation({
    present,
    onNeedsAttention: keepNotice('sync'),
  })
  const mergeDefault = useMergeDefaultBranchMutation({
    present,
    onNeedsAttention: keepNotice('bringIn'),
  })
  const checkout = useGitCheckoutMutation({ present })
  const createPullRequest = useCreatePullRequestMutation()
  const mergePullRequest = useMergePullRequestMutation()

  const guard = { status, busy, heldBack }

  /** Clears a notice once the same action has gone through. */
  const settled = (outcome: SyncOutcome) => {
    if (!needsAttention(outcome)) setStored(null)
  }

  const handleSync = () => {
    if (!projectPath) return
    if (needsSignIn) {
      void startGitHubSignIn()
      return
    }
    const reason = syncBlocker(guard)
    if (reason) {
      toast.info(reason)
      return
    }
    void sync
      .mutateAsync({ projectPath })
      .then(result => settled(result.outcome))
      .catch(() => {})
  }

  const handlePublish = () => {
    if (!projectPath) return
    if (needsSignIn && isRepo) {
      void startGitHubSignIn()
      return
    }
    const reason = publishBlocker({ ...guard, message })
    if (reason) {
      toast.info(reason)
      return
    }
    void publish
      .mutateAsync({
        projectPath,
        // With no changed files there's nothing to commit, only earlier
        // commits to push, but the engine still asks for a message
        message: files.length > 0 ? message.trim() : 'Publish',
      })
      .then(result => {
        setDraft(null)
        settled(result.outcome)
        // The diff on screen is of a change that's now committed
        if (useGitStore.getState().selectedDiffPath) {
          useGitStore.getState().closeMainView()
        }
      })
      .catch(() => {})
  }

  const handleBringIn = () => {
    if (!projectPath) return
    const reason = bringInBlocker(guard)
    if (reason) {
      toast.info(reason)
      return
    }
    void mergeDefault
      .mutateAsync({ projectPath })
      .then(result => settled(result.outcome))
      .catch(() => {})
  }

  const handleSwitch = (name: string) => {
    if (projectPath && !busy) {
      checkout.mutate({ projectPath, name, create: false })
    }
  }

  const handleCreateBranch = (name: string) => {
    if (!projectPath || busy) return
    void checkout
      .mutateAsync({ projectPath, name, create: true })
      .then(() => useGitStore.getState().setNewBranchOpen(false))
      .catch(() => {})
  }

  const handleOpenPullRequest = (title: string, body: string) => {
    if (!projectPath || !branch || !defaultBranch) return
    void createPullRequest
      .mutateAsync({
        projectPath,
        title,
        body,
        base: defaultBranch,
        head: branch,
      })
      .then(() => setOpeningPullRequest(false))
      .catch(() => {})
  }

  const handleMerge = (pr: PullRequest) => {
    if (projectPath && !busy) {
      mergePullRequest.mutate({ projectPath, number: pr.number })
    }
  }

  // The palette's Publish and Sync run the same handlers as the buttons
  const latest = useRef({ handlePublish, handleSync })
  useEffect(() => {
    latest.current = { handlePublish, handleSync }
  })
  useEffect(() => {
    const onPublish = () => latest.current.handlePublish()
    const onSync = () => latest.current.handleSync()
    window.addEventListener('git-publish', onPublish)
    window.addEventListener('git-sync', onSync)
    return () => {
      window.removeEventListener('git-publish', onPublish)
      window.removeEventListener('git-sync', onSync)
    }
  }, [])

  const currentPullRequest =
    branch && pullRequests
      ? pullRequestForBranch(pullRequests, branch)
      : undefined
  const unpublished = (status?.ahead ?? 0) > 0 || files.length > 0

  let pullRequestArea: React.ReactNode = null
  if (onFeatureBranch && onGitHub && signedIn) {
    pullRequestArea = currentPullRequest ? (
      <PullRequestCard
        pr={currentPullRequest}
        merging={mergePullRequest.isPending}
        disabled={busy}
        unpublished={unpublished}
        onMerge={() => handleMerge(currentPullRequest)}
      />
    ) : (
      <div className="space-y-1">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!status?.upstream || busy}
          onClick={() => setOpeningPullRequest(true)}
        >
          <GitPullRequest /> Open pull request
        </Button>
        {!status?.upstream && (
          <p className="text-center text-xs text-muted-foreground">
            Publish this branch first.
          </p>
        )}
      </div>
    )
  }

  // Remote-only branches are labelled by the remote's name ("origin"), or
  // GitHub when that's where it is
  const remoteBranch = branches?.find(b => b.isRemote)
  const remoteLabel = onGitHub
    ? 'GitHub'
    : (remoteBranch?.name.split('/')[0] ?? 'the remote')

  return (
    <>
      <ChangesView
        status={status}
        loading={statusQuery.isPending}
        error={statusQuery.error?.message ?? null}
        onRetry={() => void statusQuery.refetch()}
        remoteName={remoteName}
        needsSignIn={needsSignIn}
        onSignIn={() => void startGitHubSignIn()}
        branchMenu={
          <BranchMenu
            current={branch}
            branches={branches ?? []}
            pullRequests={pullRequests ?? []}
            remoteLabel={remoteLabel}
            onSwitch={handleSwitch}
            onNewBranch={() => useGitStore.getState().setNewBranchOpen(true)}
            disabled={busy}
          />
        }
        onShowHistory={() => useGitStore.getState().openHistory()}
        onSync={handleSync}
        syncing={sync.isPending}
        behindDefault={behindDefault}
        onBringIn={handleBringIn}
        bringingIn={mergeDefault.isPending}
        pullRequest={pullRequestArea}
        notice={
          notice
            ? {
                message: present(notice.raw),
                outcome: notice.outcome,
                url: repo?.htmlUrl ?? null,
              }
            : null
        }
        onDismissNotice={() => setStored(null)}
        busy={busy}
        heldBack={heldBack}
        selectedPath={selectedDiffPath}
        onSelectFile={path => useGitStore.getState().openDiff(path)}
        titles={titles}
        message={message}
        onMessageChange={setDraft}
        onPublish={handlePublish}
        publishing={publish.isPending}
      />
      <NewBranchDialog
        open={newBranchOpen}
        onOpenChange={open => useGitStore.getState().setNewBranchOpen(open)}
        from={branch}
        onCreate={handleCreateBranch}
      />
      {branch && defaultBranch && (
        <OpenPullRequestDialog
          open={openingPullRequest}
          onOpenChange={setOpeningPullRequest}
          branch={branch}
          defaultBranch={defaultBranch}
          onSubmit={handleOpenPullRequest}
          pending={createPullRequest.isPending}
        />
      )}
    </>
  )
}
