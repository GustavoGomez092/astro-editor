import { useEffect, useRef, useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import type { PullRequest, SyncOutcome } from '@/lib/bindings'
import {
  changeTitles,
  defaultCommitMessage,
  entryTitle,
  isBehindBranch,
  pullRequestForBranch,
} from '@/lib/git/changes'
import { startGitHubSignIn } from '@/lib/git/sign-in'
import { toast } from '@/lib/toast'
import { useProjectStore } from '../../store/projectStore'
import { useGitStore } from '../../store/gitStore'
import { useGitStatusQuery } from '../../hooks/queries/useGitStatusQuery'
import { useGitHubAuthQuery } from '../../hooks/queries/useGitHubAuthQuery'
import { useGitHubRepoInfoQuery } from '../../hooks/queries/useGitHubRepoInfoQuery'
import { useGitBranchesQuery } from '../../hooks/queries/useGitBranchesQuery'
import { usePullRequestsQuery } from '../../hooks/queries/usePullRequestsQuery'
import { useGitLogQuery } from '../../hooks/queries/useGitLogQuery'
import { useChangedEntryTitles } from '../../hooks/queries/useChangedEntryTitles'
import { useGitPublishMutation } from '../../hooks/mutations/useGitPublishMutation'
import { useGitSyncMutation } from '../../hooks/mutations/useGitSyncMutation'
import { useGitCheckoutMutation } from '../../hooks/mutations/useGitCheckoutMutation'
import { useCreatePullRequestMutation } from '../../hooks/mutations/useCreatePullRequestMutation'
import { useMergePullRequestMutation } from '../../hooks/mutations/useMergePullRequestMutation'
import { useMergeDefaultBranchMutation } from '../../hooks/mutations/useMergeDefaultBranchMutation'
import { Button } from '../ui/button'
import { BranchMenu, NewBranchDialog } from './BranchMenu'
import { ChangesView, type GitNotice } from './ChangesView'
import { OpenPullRequestDialog } from './OpenPullRequestDialog'
import { PullRequestCard } from './PullRequestCard'

/** Outcomes that leave something for the writer to sort out. */
const NEEDS_ATTENTION: SyncOutcome[] = ['conflict', 'blockedByLocalChanges']

/**
 * The Changes tab of the left sidebar: wires git status, branches and pull
 * requests to `ChangesView`, and handles the palette's Publish and Sync.
 * Stays mounted while the Files tab is shown.
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

  const branches = useGitBranchesQuery(projectPath, { enabled: isRepo }).data
  const pullRequests = usePullRequestsQuery(isRepo ? projectPath : null).data
  const log = useGitLogQuery(projectPath, { enabled: onFeatureBranch }).data
  const behindDefault =
    onFeatureBranch &&
    isBehindBranch(log ?? [], branch, defaultBranch) !== false

  const files = status?.files ?? []
  const entryTitles = useChangedEntryTitles(projectPath, files)
  const [draft, setDraft] = useState<string | null>(null)
  const message =
    draft ??
    defaultCommitMessage(changeTitles(files, projectPath ?? '', entryTitles))
  const titles = new Map<string, string>()
  for (const file of files) {
    const title = entryTitle(file, projectPath ?? '', entryTitles)
    if (title) titles.set(file.path, title)
  }

  // A notice belongs to the branch it happened on, so switching hides it
  const [notice, setNotice] = useState<
    (GitNotice & { branch: string | null }) | null
  >(null)
  const [openingPullRequest, setOpeningPullRequest] = useState(false)
  const selectedDiffPath = useGitStore(state => state.selectedDiffPath)
  const newBranchOpen = useGitStore(state => state.newBranchOpen)

  const publish = useGitPublishMutation()
  const sync = useGitSyncMutation()
  const checkout = useGitCheckoutMutation()
  const createPullRequest = useCreatePullRequestMutation()
  const mergePullRequest = useMergePullRequestMutation()
  const mergeDefault = useMergeDefaultBranchMutation()

  const noticeFor = (outcome: SyncOutcome, text: string) =>
    NEEDS_ATTENTION.includes(outcome)
      ? { message: text, url: repo?.htmlUrl ?? null, branch }
      : null

  const handleSync = () => {
    if (!projectPath) return
    if (needsSignIn) {
      void startGitHubSignIn()
      return
    }
    void sync
      .mutateAsync({ projectPath })
      .then(result => setNotice(noticeFor(result.outcome, result.message)))
      .catch(() => {})
  }

  const handlePublish = () => {
    if (!projectPath) return
    if (!isRepo) {
      toast.info("This project isn't a git repository.")
      return
    }
    if (needsSignIn) {
      void startGitHubSignIn()
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
        setNotice(noticeFor(result.outcome, result.message))
        // The diff on screen is of a change that's now committed
        if (useGitStore.getState().selectedDiffPath) {
          useGitStore.getState().closeMainView()
        }
      })
      .catch(() => {})
  }

  const handleBringIn = () => {
    if (!projectPath) return
    void mergeDefault
      .mutateAsync({ projectPath })
      .then(result => setNotice(noticeFor(result.outcome, result.message)))
      .catch(() => {})
  }

  const handleSwitch = (name: string) => {
    if (projectPath) checkout.mutate({ projectPath, name, create: false })
  }

  const handleCreateBranch = (name: string) => {
    if (!projectPath) return
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
    if (projectPath) mergePullRequest.mutate({ projectPath, number: pr.number })
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

  let pullRequestArea: React.ReactNode = null
  if (onFeatureBranch && onGitHub && signedIn) {
    pullRequestArea = currentPullRequest ? (
      <PullRequestCard
        pr={currentPullRequest}
        merging={mergePullRequest.isPending}
        onMerge={() => handleMerge(currentPullRequest)}
      />
    ) : (
      <div className="space-y-1">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!status?.upstream}
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

  return (
    <>
      <ChangesView
        status={status}
        loading={statusQuery.isPending}
        error={statusQuery.error?.message ?? null}
        onRetry={() => void statusQuery.refetch()}
        remoteName={onGitHub ? 'GitHub' : 'the remote'}
        needsSignIn={needsSignIn}
        onSignIn={() => void startGitHubSignIn()}
        branchMenu={
          <BranchMenu
            current={branch}
            branches={branches ?? []}
            pullRequests={pullRequests ?? []}
            onSwitch={handleSwitch}
            onNewBranch={() => useGitStore.getState().setNewBranchOpen(true)}
            disabled={checkout.isPending}
          />
        }
        onShowHistory={() => useGitStore.getState().openHistory()}
        onSync={handleSync}
        syncing={sync.isPending}
        behindDefault={behindDefault}
        onBringIn={handleBringIn}
        bringingIn={mergeDefault.isPending}
        pullRequest={pullRequestArea}
        notice={notice?.branch === branch ? notice : null}
        onDismissNotice={() => setNotice(null)}
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
