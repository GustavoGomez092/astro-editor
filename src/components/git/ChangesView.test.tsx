import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitStatus, PullRequest } from '@/lib/bindings'
import { ChangesView, type ChangesViewProps } from './ChangesView'
import { PullRequestCard } from './PullRequestCard'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const STATUS: GitStatus = {
  isRepo: true,
  branch: 'staging',
  defaultBranch: 'main',
  upstream: 'origin/staging',
  ahead: 0,
  behind: 0,
  files: [
    { path: 'src/content/pages/about.md', oldPath: null, change: 'modified' },
  ],
  detached: false,
}

function renderView(props: Partial<ChangesViewProps> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onSignIn: vi.fn(),
    onShowHistory: vi.fn(),
    onSync: vi.fn(),
    onBringIn: vi.fn(),
    onDismissNotice: vi.fn(),
    onSelectFile: vi.fn(),
    onMessageChange: vi.fn(),
    onPublish: vi.fn(),
  }
  render(
    <ChangesView
      status={STATUS}
      loading={false}
      error={null}
      remoteName="GitHub"
      needsSignIn={false}
      branchMenu={<span>branch menu</span>}
      syncing={false}
      behindDefault={false}
      bringingIn={false}
      pullRequest={null}
      notice={null}
      selectedPath={null}
      message="Update About"
      publishing={false}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe('ChangesView', () => {
  it('says so when the project is not a git repository, and offers nothing else', () => {
    renderView({ status: { ...STATUS, isRepo: false, files: [] } })
    expect(
      screen.getByText("This project isn't a git repository.")
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Sync/ })).toBeNull()
  })

  it('shows Publish with the branch name beneath it', async () => {
    const { onPublish } = renderView()
    const publish = screen.getByRole('button', { name: 'Publish' })
    expect(publish.nextElementSibling).toHaveTextContent('staging')
    await userEvent.click(publish)
    expect(onPublish).toHaveBeenCalled()
  })

  it('pre-fills the message box and lists the changed files', async () => {
    const { onSelectFile } = renderView()
    expect(screen.getByLabelText('Describe your changes')).toHaveValue(
      'Update About'
    )
    await userEvent.click(screen.getByText('about.md'))
    expect(onSelectFile).toHaveBeenCalledWith('src/content/pages/about.md')
  })

  it('syncs', async () => {
    const { onSync } = renderView()
    await userEvent.click(screen.getByRole('button', { name: /Sync/ }))
    expect(onSync).toHaveBeenCalled()
  })

  it('asks to sign in with GitHub instead of failing', async () => {
    const { onSignIn, onSync, onPublish } = renderView({ needsSignIn: true })
    await userEvent.click(
      screen.getByRole('button', { name: 'Sign in with GitHub' })
    )
    await userEvent.click(screen.getByRole('button', { name: /Sync/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(onSignIn).toHaveBeenCalledTimes(3)
    expect(onSync).not.toHaveBeenCalled()
    expect(onPublish).not.toHaveBeenCalled()
  })

  it('offers to bring in changes from the default branch', async () => {
    const { onBringIn } = renderView({ behindDefault: true })
    await userEvent.click(
      screen.getByRole('button', { name: 'Bring in changes from main' })
    )
    expect(onBringIn).toHaveBeenCalled()
  })

  it('keeps a conflict message on screen with a link to GitHub', () => {
    renderView({
      notice: {
        message: 'Your changes and the changes on GitHub both edited about.md.',
        url: 'https://github.com/kr/site',
      },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('both edited about.md')
    expect(
      screen.getByRole('button', { name: /Open on GitHub/ })
    ).toBeInTheDocument()
  })

  it("can't publish when there's nothing new", () => {
    renderView({ status: { ...STATUS, files: [] } })
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(
      screen.getByText('No changes since the last publish.')
    ).toBeInTheDocument()
  })

  it('can publish commits that never reached GitHub', () => {
    renderView({ status: { ...STATUS, files: [], ahead: 2 } })
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled()
  })
})

const PR: PullRequest = {
  number: 14,
  title: 'Harbour case study',
  head: 'staging',
  base: 'main',
  state: 'open',
  draft: false,
  htmlUrl: 'https://github.com/kr/site/pull/14',
  mergeable: true,
  checks: 'success',
}

describe('PullRequestCard', () => {
  it('merges after confirming, and links to GitHub', async () => {
    const onMerge = vi.fn()
    render(<PullRequestCard pr={PR} onMerge={onMerge} />)
    expect(
      screen.getByRole('button', { name: /View on GitHub/ })
    ).toBeInTheDocument()
    expect(screen.getByText('Checks passed')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(onMerge).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Merge into main?')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))
    expect(onMerge).toHaveBeenCalledTimes(1)
  })

  it("can't merge a pull request GitHub can't merge automatically", () => {
    render(
      <PullRequestCard pr={{ ...PR, mergeable: false }} onMerge={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
  })
})
