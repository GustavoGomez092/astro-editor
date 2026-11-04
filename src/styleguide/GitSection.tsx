import React, { useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import photo from '../../test/dummy-astro-project/src/assets/articles/styleguide-image.jpg'
import { CommitGraph } from '../components/git/CommitGraph'
import { CommitDetails } from '../components/git/CommitDetails'
import { DiffView } from '../components/git/DiffView'
import {
  ChangesView,
  type ChangesViewProps,
} from '../components/git/ChangesView'
import { BranchMenu } from '../components/git/BranchMenu'
import { PullRequestCard } from '../components/git/PullRequestCard'
import { SignInDialog } from '../components/git/SignInSheet'
import { OpenPullRequestDialog } from '../components/git/OpenPullRequestDialog'
import { Button } from '../components/ui/button'
import { OpenFromGitHubDialog } from '../components/git/OpenFromGitHubDialog'
import { queryClient } from '../lib/query-client'
import { queryKeys } from '../lib/query-keys'
import { useGitStore } from '../store/gitStore'
import type {
  BranchInfo,
  CommitDetails as Details,
  FileDiff,
  GitStatus,
  GraphCommit,
  PullRequest,
  RepoSummary,
} from '../lib/bindings'

/** Fixed, so relative dates don't change between shots. */
const NOW = new Date(2026, 10, 3, 12, 0, 0)
const HOUR = 3600

function commit(
  id: string,
  parents: string[],
  summary: string,
  hoursAgo: number,
  refs: GraphCommit['refs'] = [],
  authorName = 'Kevin Robinson'
): GraphCommit {
  return {
    id,
    shortId: id.slice(0, 7),
    parents,
    summary,
    authorName,
    time: NOW.getTime() / 1000 - hoursAgo * HOUR,
    refs,
  }
}

/** A site with a long-lived staging branch, merged pull requests and a tag. */
const COMMITS: GraphCommit[] = [
  commit('c14aaaa', ['c13aaaa'], 'Fix typo in the Contact page', 0.2, [
    { name: 'HEAD', kind: 'head' },
    { name: 'staging', kind: 'localBranch' },
  ]),
  commit('c13aaaa', ['c12aaaa', 'c11aaaa'], 'Bring in changes from main', 2, [
    { name: 'origin/staging', kind: 'remoteBranch' },
  ]),
  commit(
    'c11aaaa',
    ['c09aaaa', 'c10aaaa'],
    'Merge pull request #12 from portfolio-refresh',
    5,
    [
      { name: 'main', kind: 'localBranch' },
      { name: 'origin/main', kind: 'remoteBranch' },
    ]
  ),
  commit('c12aaaa', ['c08aaaa'], 'Try a darker hero on Home', 20),
  commit('c10aaaa', ['c07aaaa'], 'Add three new portfolio pieces', 26),
  commit('c09aaaa', ['c06aaaa'], 'Update About page', 30),
  commit('c08aaaa', ['c06aaaa'], 'New project: Harbour identity', 48),
  commit('c07aaaa', ['c06aaaa'], 'Reorder the portfolio', 52),
  commit(
    'c06aaaa',
    ['c04aaaa', 'c05aaaa'],
    'Merge pull request #11 from spring-copy',
    100,
    [{ name: 'v1.1', kind: 'tag' }]
  ),
  commit('c05aaaa', ['c03aaaa'], 'Spring copy for the services page', 130),
  commit('c04aaaa', ['c03aaaa'], 'Fix broken link in footer', 150, [], 'Gus'),
  commit('c03aaaa', ['c02aaaa'], 'Add case study template', 400, [], 'Gus'),
  commit('c02aaaa', ['c01aaaa'], 'Write the first case study', 800),
  commit('c01aaaa', [], 'Initial site', 1500, [{ name: 'v1.0', kind: 'tag' }]),
]

const DETAILS: Details = {
  ...(COMMITS[5] as GraphCommit),
  message:
    'Update About page\n\nNew portrait, a shorter bio and the studio address.',
  authorEmail: 'kevin@example.com',
  files: [
    { path: 'src/content/pages/about.md', oldPath: null, change: 'modified' },
    { path: 'src/assets/portrait.jpg', oldPath: null, change: 'added' },
    { path: 'src/assets/old-portrait.jpg', oldPath: null, change: 'deleted' },
    {
      path: 'src/content/pages/studio.md',
      oldPath: 'src/content/pages/contact.md',
      change: 'renamed',
    },
  ],
}

const TEXT_DIFF: FileDiff = {
  path: 'src/content/pages/about.md',
  binary: false,
  isImage: false,
  hunks: [
    {
      header: '@@ -1,6 +1,6 @@',
      lines: [
        { kind: 'ctx', text: '---', oldNo: 1, newNo: 1 },
        { kind: 'ctx', text: 'title: About', oldNo: 2, newNo: 2 },
        {
          kind: 'del',
          text: 'description: Kevin Robinson is a designer based in Leeds.',
          oldNo: 3,
          newNo: null,
        },
        {
          kind: 'add',
          text: 'description: Kevin Robinson is an independent designer.',
          oldNo: null,
          newNo: 3,
        },
        {
          kind: 'ctx',
          text: 'image: ../../assets/portrait.jpg',
          oldNo: 4,
          newNo: 4,
        },
        { kind: 'ctx', text: '---', oldNo: 5, newNo: 5 },
      ],
    },
    {
      header: '@@ -14,3 +14,4 @@',
      lines: [
        {
          kind: 'ctx',
          text: 'I work with small studios and independent brands on identity, editorial and web projects.',
          oldNo: 14,
          newNo: 14,
        },
        { kind: 'ctx', text: '', oldNo: 15, newNo: 15 },
        {
          kind: 'add',
          text: 'The studio is at 12 Mill Street. Visitors are welcome by appointment, and the kettle is usually on, so do get in touch first if you would like to drop by and see some work in progress.',
          oldNo: null,
          newNo: 16,
        },
        { kind: 'ctx', text: '## Clients', oldNo: 16, newNo: 17 },
      ],
    },
  ],
}

const IMAGE_DIFF: FileDiff = {
  path: 'src/assets/portrait.jpg',
  binary: true,
  isImage: true,
  hunks: [],
}

/** The History view: the commit graph beside the selected commit's details. */
export function GitHistorySection() {
  const [selected, setSelected] = useState<string | null>('c09aaaa')
  return (
    <div className="flex h-[620px] overflow-hidden rounded-lg border bg-editor-background">
      <div className="min-w-0 flex-1 overflow-y-auto py-1">
        <CommitGraph
          commits={COMMITS}
          selectedId={selected}
          onSelect={setSelected}
          currentBranch="staging"
          now={NOW}
        />
      </div>
      <div className="w-80 shrink-0 overflow-y-auto border-l bg-background">
        <CommitDetails details={DETAILS} selectedPath={TEXT_DIFF.path} />
      </div>
    </div>
  )
}

/** A text diff and an image diff, as opened from a changed file. */
export function GitDiffSection() {
  return (
    <div className="grid grid-cols-[3fr_2fr] gap-6">
      <div className="overflow-hidden rounded-lg border bg-editor-background">
        <DiffView diff={TEXT_DIFF} />
      </div>
      <div className="space-y-6">
        <div className="overflow-hidden rounded-lg border bg-editor-background">
          <DiffView diff={IMAGE_DIFF} beforeSrc={photo} afterSrc={photo} />
        </div>
        <div className="overflow-hidden rounded-lg border bg-editor-background">
          <DiffView
            diff={{
              path: 'public/fonts/display.woff2',
              binary: true,
              isImage: false,
              hunks: [],
            }}
          />
        </div>
      </div>
    </div>
  )
}

const noop = () => {}

const STATUS: GitStatus = {
  isRepo: true,
  branch: 'staging',
  defaultBranch: 'main',
  upstream: 'origin/staging',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/content/pages/about.md', oldPath: null, change: 'modified' },
    { path: 'src/content/work/harbour.md', oldPath: null, change: 'added' },
    {
      path: 'src/assets/harbour-cover.jpg',
      oldPath: null,
      change: 'untracked',
    },
    { path: 'src/content/work/old-site.md', oldPath: null, change: 'deleted' },
  ],
  detached: false,
}

const BRANCHES: BranchInfo[] = [
  {
    name: 'staging',
    isRemote: false,
    isHead: true,
    upstream: 'origin/staging',
    ahead: 0,
    behind: 0,
    lastCommitTime: 2,
  },
  {
    name: 'main',
    isRemote: false,
    isHead: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    lastCommitTime: 1,
  },
]

const PULL_REQUEST: PullRequest = {
  number: 14,
  title: 'Harbour case study',
  head: 'staging',
  base: 'main',
  state: 'open',
  draft: false,
  htmlUrl: 'https://github.com/kevinrobinson/site/pull/14',
  mergeable: true,
  checks: 'success',
}

function Panel({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="h-[640px] w-[300px] overflow-hidden rounded-lg border bg-background">
        {children}
      </div>
    </div>
  )
}

function View(props: Partial<ChangesViewProps> & { status: GitStatus }) {
  return (
    <ChangesView
      loading={false}
      error={null}
      onRetry={noop}
      remoteName="GitHub"
      needsSignIn={false}
      onSignIn={noop}
      branchMenu={
        <BranchMenu
          current={props.status.branch}
          branches={BRANCHES}
          pullRequests={[PULL_REQUEST]}
          onSwitch={noop}
          onNewBranch={noop}
        />
      }
      onShowHistory={noop}
      onSync={noop}
      syncing={false}
      behindDefault={false}
      onBringIn={noop}
      bringingIn={false}
      pullRequest={null}
      notice={null}
      onDismissNotice={noop}
      busy={false}
      heldBack={null}
      selectedPath={null}
      onSelectFile={noop}
      message=""
      onMessageChange={noop}
      onPublish={noop}
      publishing={false}
      {...props}
    />
  )
}

/** The Changes tab in the states a writer meets. */
export function GitChangesSection() {
  return (
    <div className="flex gap-5">
      <Panel label="Changes, with an open pull request">
        <View
          status={{ ...STATUS, ahead: 1 }}
          selectedPath="src/content/pages/about.md"
          titles={
            new Map([
              ['src/content/pages/about.md', 'About'],
              ['src/content/work/harbour.md', 'Harbour identity'],
            ])
          }
          message="Add Harbour identity, update About, remove 1 entry and images"
          pullRequest={
            <PullRequestCard pr={PULL_REQUEST} onMerge={noop} unpublished />
          }
        />
      </Panel>
      <Panel label="Clean">
        <View
          status={{
            ...STATUS,
            branch: 'main',
            upstream: 'origin/main',
            files: [],
          }}
        />
      </Panel>
      <Panel label="After a publish conflict">
        <View
          status={{ ...STATUS, ahead: 1, behind: 1, files: [] }}
          behindDefault
          notice={{
            message:
              "Your changes are saved on this computer, but weren't published: the same lines of “About” were also changed on GitHub. Publish isn't possible until that's sorted out.",
            outcome: 'conflict',
            url: 'https://github.com/kevinrobinson/site',
          }}
          heldBack="publish"
        />
      </Panel>
      <Panel label="Not signed in">
        <View
          status={{ ...STATUS, files: STATUS.files.slice(0, 2) }}
          needsSignIn
          message="Add Harbour identity, update About"
        />
      </Panel>
    </div>
  )
}

/** Not a repository, and the Open pull request button. */
export function GitChangesMoreSection() {
  return (
    <div className="flex gap-5">
      <Panel label="Not a git repository">
        <View status={{ ...STATUS, isRepo: false, files: [] }} />
      </Panel>
      <Panel label="Feature branch, no pull request yet">
        <View
          status={{ ...STATUS, files: [], ahead: 0 }}
          pullRequest={
            <Button variant="outline" size="sm" className="w-full">
              <GitPullRequest /> Open pull request
            </Button>
          }
        />
      </Panel>
      <Panel label="Pull request, latest changes not published">
        <div className="p-3">
          <PullRequestCard pr={PULL_REQUEST} onMerge={noop} unpublished />
        </div>
      </Panel>
      <Panel label="Draft that can't merge, checks running">
        <div className="p-3">
          <PullRequestCard
            pr={{
              ...PULL_REQUEST,
              draft: true,
              mergeable: false,
              checks: 'pending',
            }}
            onMerge={noop}
          />
        </div>
      </Panel>
    </div>
  )
}

/** The sign-in sheet while it waits for approval on GitHub. */
export function GitSignInSection() {
  return (
    <SignInDialog
      signIn={{
        open: true,
        step: 'waiting',
        code: {
          userCode: 'WDJB-MJHT',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 900,
          interval: 5,
        },
        error: null,
      }}
    />
  )
}

/** Opening a pull request from staging into main. */
export function GitOpenPullRequestSection() {
  return (
    <OpenPullRequestDialog
      open
      onOpenChange={noop}
      branch="harbour-case-study"
      defaultBranch="main"
      defaultTitle="Add the Harbour case study"
      onSubmit={noop}
    />
  )
}

const REPOS: RepoSummary[] = [
  ['kevinrobinson', 'site', false, 1],
  ['kevinrobinson', 'portfolio-2025', true, 30],
  ['harbour-studio', 'harbour-site', true, 200],
  ['kevinrobinson', 'type-specimens', false, 900],
].map(([owner, name, isPrivate, hoursAgo]) => ({
  fullName: `${owner}/${name}`,
  owner: owner as string,
  name: name as string,
  private: isPrivate as boolean,
  defaultBranch: 'main',
  cloneUrl: `https://github.com/${owner}/${name}.git`,
  updatedAt: new Date(
    Date.now() - (hoursAgo as number) * HOUR * 1000
  ).toISOString(),
}))

// The dialog reads these from the query cache and the store, as in the app.
// Module level, like ComponentBuilderSection's store setup
queryClient.setQueryData(queryKeys.githubAuth, {
  signedIn: true,
  login: 'kevinrobinson',
  name: 'Kevin Robinson',
  avatarUrl: null,
})
queryClient.setQueryData(queryKeys.githubRepos, REPOS)
queryClient.setQueryData(['sitesFolder'], '/Users/kevin/Sites')
if (
  new URLSearchParams(window.location.search).get('section') ===
  'git-open-from-github'
) {
  useGitStore.setState({ openFromGitHubOpen: true })
}

/** Open from GitHub, signed in, with a few repositories. */
export function GitOpenFromGitHubSection() {
  return <OpenFromGitHubDialog />
}
