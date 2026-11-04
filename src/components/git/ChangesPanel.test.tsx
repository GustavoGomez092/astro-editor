import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { commands, type GitStatus } from '@/lib/bindings'
import { ASTRO_PATHS } from '@/lib/constants'
import { renderWithProviders } from '@/test/test-utils'
import { mockToast, resetToastMocks } from '@/test/mocks/toast'
import { useProjectStore } from '@/store/projectStore'
import { useEditorStore } from '@/store/editorStore'
import { useGitStore } from '@/store/gitStore'
import { useUIStore } from '@/store/uiStore'
import { resetGitFetchTimes } from '@/lib/git/status'
import { ChangesPanel } from './ChangesPanel'

vi.mock('@/lib/bindings', () => ({
  commands: {
    gitStatus: vi.fn(),
    gitFetch: vi.fn(),
    githubAuthStatus: vi.fn(),
    githubRepoInfo: vi.fn(),
    gitBranches: vi.fn(),
    githubListPullRequests: vi.fn(),
    gitCommitsBehindDefault: vi.fn(),
    gitCommitsAheadOfDefault: vi.fn(),
    gitLogGraph: vi.fn(),
    gitConflicts: vi.fn(),
    gitDiscardFile: vi.fn(),
    gitResolveConflicts: vi.fn(),
    gitPublish: vi.fn(),
    gitSync: vi.fn(),
    scanProject: vi.fn(),
    scanCollectionFilesRecursive: vi.fn(),
    readFileContent: vi.fn(),
  },
}))
vi.mock('@/lib/project-registry', () => ({
  getEffectiveContentDirectory: () => ASTRO_PATHS.CONTENT_DIR,
  getCollectionSettings: () => ({ frontmatterMappings: { title: 'title' } }),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const ok = <T,>(data: T) => ({ status: 'ok' as const, data })
const SITE = '/site'
const ABOUT = 'src/content/pages/about.md'

const CLEAN: GitStatus = {
  isRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  files: [],
  detached: false,
}

function withStatus(status: GitStatus) {
  vi.mocked(commands.gitStatus).mockResolvedValue(ok(status))
}

describe('ChangesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetToastMocks()
    useProjectStore.setState({
      projectPath: SITE,
      currentProjectSettings: null,
      globalSettings: { general: { showPublishingTools: true } } as never,
    })
    useEditorStore.setState({ currentFile: null, isDirty: false })
    useGitStore.setState({ panelTab: 'files', checkedAt: {} })
    vi.mocked(commands.githubAuthStatus).mockResolvedValue(
      ok({ signedIn: true, login: 'kr', name: null, avatarUrl: null })
    )
    vi.mocked(commands.githubRepoInfo).mockResolvedValue(
      ok({
        owner: 'kr',
        repo: 'site',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/kr/site',
      })
    )
    vi.mocked(commands.gitFetch).mockResolvedValue(ok(CLEAN))
    vi.mocked(commands.gitBranches).mockResolvedValue(ok([]))
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([]))
    vi.mocked(commands.gitCommitsBehindDefault).mockResolvedValue(ok(0))
    vi.mocked(commands.gitCommitsAheadOfDefault).mockResolvedValue(ok(0))
    vi.mocked(commands.gitLogGraph).mockResolvedValue(ok([]))
    vi.mocked(commands.gitConflicts).mockResolvedValue(ok([]))
    vi.mocked(commands.readFileContent).mockResolvedValue(ok(''))
    vi.mocked(commands.scanProject).mockResolvedValue(
      ok([{ name: 'pages', path: '/site/src/content/pages' }] as never)
    )
    vi.mocked(commands.scanCollectionFilesRecursive).mockResolvedValue(
      ok([
        {
          id: 'pages/about',
          path: `${SITE}/${ABOUT}`,
          name: 'about',
          extension: 'md',
          collection: 'pages',
          last_modified: null,
          frontmatter: { title: 'About me' },
        },
      ])
    )
  })

  it("the palette's Publish says why when there's nothing to publish", async () => {
    withStatus(CLEAN)
    renderWithProviders(<ChangesPanel />)
    await screen.findByText('No changes since the last publish.')
    act(() => {
      window.dispatchEvent(new CustomEvent('git-publish'))
    })
    expect(mockToast.info).toHaveBeenCalledWith('Nothing new to publish.')
    expect(commands.gitPublish).not.toHaveBeenCalled()
  })

  it('pre-fills the message with entry titles only', async () => {
    withStatus({
      ...CLEAN,
      files: [
        { path: ABOUT, oldPath: null, change: 'modified' },
        { path: 'src/assets/cover.jpg', oldPath: null, change: 'untracked' },
      ],
    })
    renderWithProviders(<ChangesPanel />)
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Describe your changes')).toHaveValue(
        'Update About me and images'
      )
    )
  })

  it('treats an image next to the entries as an image, not an entry', async () => {
    withStatus({
      ...CLEAN,
      files: [
        { path: ABOUT, oldPath: null, change: 'modified' },
        {
          path: 'src/content/pages/about-photo.jpg',
          oldPath: null,
          change: 'untracked',
        },
      ],
    })
    renderWithProviders(<ChangesPanel />)
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Describe your changes')).toHaveValue(
        'Update About me and images'
      )
    )
  })

  it('shows a conflict once, in the panel, with titles and "GitHub"', async () => {
    withStatus({ ...CLEAN, behind: 1 })
    vi.mocked(commands.gitSync).mockResolvedValue(
      ok({
        outcome: 'conflict',
        message: `Your changes and the changes on the remote both edited ${ABOUT}.`,
        status: { ...CLEAN, behind: 1 },
      })
    )
    renderWithProviders(<ChangesPanel />)
    await screen.findByText(/1 new on GitHub/)
    await userEvent.click(screen.getByRole('button', { name: /Sync/ }))

    const notice = await screen.findByRole('alert')
    await vi.waitFor(() =>
      expect(notice).toHaveTextContent(
        'Your changes and the changes on GitHub both edited “About me”.'
      )
    )
    expect(notice).toHaveTextContent(
      'Open it on GitHub, or ask whoever manages the site.'
    )
    expect(mockToast.warning).not.toHaveBeenCalled()
    // Trying again would hit the same conflict
    expect(screen.getByRole('button', { name: /Sync/ })).toBeDisabled()
  })

  it('keeps Sync available after a blocked sync, which the writer can clear outside git', async () => {
    withStatus({ ...CLEAN, behind: 1 })
    vi.mocked(commands.gitSync).mockResolvedValue(
      ok({
        outcome: 'blockedByLocalChanges',
        message:
          "Bringing in the changes from GitHub would overwrite .env, a file on this computer that isn't part of the site, so nothing was changed. Move or rename it, then try again.",
        status: { ...CLEAN, behind: 1 },
      })
    )
    renderWithProviders(<ChangesPanel />)
    await screen.findByText(/1 new on GitHub/)
    await userEvent.click(screen.getByRole('button', { name: /Sync/ }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: /Sync/ })).toBeEnabled()
  })

  it('shortens long entry titles in the list', async () => {
    vi.mocked(commands.scanCollectionFilesRecursive).mockResolvedValue(
      ok([
        {
          id: 'pages/about',
          path: `${SITE}/${ABOUT}`,
          name: 'about',
          extension: 'md',
          collection: 'pages',
          last_modified: null,
          frontmatter: {
            title: 'How we rebuilt the studio website from the ground up',
          },
        },
      ])
    )
    withStatus({
      ...CLEAN,
      files: [{ path: ABOUT, oldPath: null, change: 'modified' }],
    })
    renderWithProviders(<ChangesPanel />)
    expect(
      await screen.findByText('How we rebuilt the studio website from…')
    ).toBeInTheDocument()
  })

  describe('checking fields before publishing', () => {
    const SCHEMA = JSON.stringify({
      collectionName: 'pages',
      fields: [
        { name: 'title', label: 'Title', fieldType: 'string', required: true },
        { name: 'email', label: 'Email', fieldType: 'email', required: true },
        { name: 'quote', label: 'Quote', fieldType: 'string', required: true },
      ],
    })

    beforeEach(() => {
      vi.mocked(commands.scanProject).mockResolvedValue(
        ok([
          {
            name: 'pages',
            path: '/site/src/content/pages',
            complete_schema: SCHEMA,
          },
        ] as never)
      )
      vi.mocked(commands.scanCollectionFilesRecursive).mockResolvedValue(
        ok([
          {
            id: 'pages/about',
            path: `${SITE}/${ABOUT}`,
            name: 'about',
            extension: 'md',
            collection: 'pages',
            last_modified: null,
            frontmatter: { title: 'Jordan Ellis', email: 'nope' },
          },
        ])
      )
      const changed = {
        ...CLEAN,
        files: [{ path: ABOUT, oldPath: null, change: 'modified' as const }],
      }
      withStatus(changed)
      vi.mocked(commands.gitPublish).mockResolvedValue(
        ok({
          commitId: 'abc',
          pushed: true,
          outcome: 'upToDate',
          message: 'Published to main.',
          status: CLEAN,
        })
      )
    })

    async function publishWithProblems() {
      renderWithProviders(<ChangesPanel />)
      await vi.waitFor(() =>
        expect(screen.getByLabelText('Describe your changes')).toHaveValue(
          'Update Jordan Ellis'
        )
      )
      await userEvent.click(screen.getByRole('button', { name: /^Publish$/ }))
      return screen.findByRole('alertdialog')
    }

    it('asks before publishing an entry whose fields need attention', async () => {
      const dialog = await publishWithProblems()
      expect(dialog).toHaveTextContent(
        '2 fields in “Jordan Ellis” need attention. Publish anyway?'
      )
      expect(commands.gitPublish).not.toHaveBeenCalled()
      await userEvent.click(
        screen.getByRole('button', { name: 'Publish anyway' })
      )
      await vi.waitFor(() =>
        expect(commands.gitPublish).toHaveBeenCalledWith(
          SITE,
          'Update Jordan Ellis'
        )
      )
    })

    it('Review opens the entry with its fields marked, and publishes nothing', async () => {
      await publishWithProblems()
      await userEvent.click(screen.getByRole('button', { name: 'Review' }))
      expect(useEditorStore.getState().currentFile?.path).toBe(
        `${SITE}/${ABOUT}`
      )
      expect(useEditorStore.getState().shownFieldErrors).toEqual({
        email: true,
        quote: true,
      })
      expect(commands.gitPublish).not.toHaveBeenCalled()
    })
  })

  describe('pull requests', () => {
    const SPRING: GitStatus = {
      ...CLEAN,
      branch: 'spring',
      upstream: 'origin/spring',
    }

    it('offers Open pull request only when the branch has commits main lacks', async () => {
      withStatus(SPRING)
      renderWithProviders(<ChangesPanel />)
      await screen.findByText('No changes since the last publish.')
      await vi.waitFor(() =>
        expect(commands.gitCommitsAheadOfDefault).toHaveBeenCalled()
      )
      expect(
        screen.queryByRole('button', { name: /Open pull request/ })
      ).toBeNull()
    })

    it('suggests the latest commit as the title', async () => {
      withStatus(SPRING)
      vi.mocked(commands.gitCommitsAheadOfDefault).mockResolvedValue(ok(1))
      vi.mocked(commands.gitLogGraph).mockResolvedValue(
        ok([
          {
            id: 'c',
            shortId: 'c',
            parents: ['a'],
            summary: 'Add Jordan Ellis',
            authorName: 'Kevin',
            time: 0,
            refs: [{ name: 'HEAD', kind: 'head' }],
          },
        ])
      )
      renderWithProviders(<ChangesPanel />)
      await userEvent.click(
        await screen.findByRole('button', { name: /Open pull request/ })
      )
      expect(await screen.findByLabelText('Title')).toHaveValue(
        'Add Jordan Ellis'
      )
    })
  })

  describe('freshness', () => {
    it('fetches when the Changes tab comes into view, at most every 30 seconds', async () => {
      resetGitFetchTimes()
      let clock = 1_000_000
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      useGitStore.setState({ panelTab: 'changes', checkedAt: {} })
      useUIStore.setState({ sidebarVisible: true })
      withStatus(CLEAN)
      renderWithProviders(<ChangesPanel />)
      // Shown once signed in
      await vi.waitFor(() => expect(commands.gitFetch).toHaveBeenCalledTimes(1))

      act(() => useGitStore.getState().setPanelTab('files'))
      clock += 10_000
      act(() => useGitStore.getState().setPanelTab('changes'))
      expect(commands.gitFetch).toHaveBeenCalledTimes(1)

      act(() => useGitStore.getState().setPanelTab('files'))
      clock += 30_000
      act(() => useGitStore.getState().setPanelTab('changes'))
      expect(commands.gitFetch).toHaveBeenCalledTimes(2)
      expect(await screen.findByText('Checked just now')).toBeInTheDocument()
      now.mockRestore()
    })
  })

  it('discards a file after confirming, naming the entry', async () => {
    const changed = {
      ...CLEAN,
      files: [{ path: ABOUT, oldPath: null, change: 'modified' as const }],
    }
    withStatus(changed)
    vi.mocked(commands.gitDiscardFile).mockResolvedValue(ok(CLEAN))
    renderWithProviders(<ChangesPanel />)
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Discard changes to About me',
      })
    )
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Throw away your changes to “About me”?')
    expect(dialog).toHaveTextContent("This can't be undone.")
    expect(commands.gitDiscardFile).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard changes' })
    )
    await vi.waitFor(() =>
      expect(commands.gitDiscardFile).toHaveBeenCalledWith(SITE, ABOUT)
    )
  })

  describe('resolving a conflict', () => {
    const DIVERGED: GitStatus = { ...CLEAN, ahead: 1, behind: 1 }
    const CONFLICT = {
      path: ABOUT,
      mine: '---\ntitle: About me\n---\nMine',
      theirs: '---\ntitle: About me\n---\nTheirs',
      binary: false,
    }

    beforeEach(() => {
      withStatus(DIVERGED)
      vi.mocked(commands.gitConflicts).mockResolvedValue(ok([CONFLICT]))
      vi.mocked(commands.gitResolveConflicts).mockResolvedValue(
        ok({
          outcome: 'merged',
          message: 'Combined',
          status: { ...CLEAN, ahead: 2 },
        })
      )
    })

    it('after a conflict, lets the writer pick versions, then combines and publishes', async () => {
      vi.mocked(commands.gitPublish)
        .mockResolvedValueOnce(
          ok({
            commitId: 'abc',
            pushed: false,
            outcome: 'conflict',
            message: `Your changes and the changes on the remote both edited ${ABOUT}.`,
            status: DIVERGED,
          })
        )
        .mockResolvedValueOnce(
          ok({
            commitId: 'def',
            pushed: true,
            outcome: 'upToDate',
            message: 'Published to main.',
            status: CLEAN,
          })
        )
      vi.mocked(commands.gitConflicts).mockResolvedValue(ok([]))
      renderWithProviders(<ChangesPanel />)
      await screen.findByText(/1 new on GitHub/)
      vi.mocked(commands.gitConflicts).mockResolvedValue(ok([CONFLICT]))
      await userEvent.click(screen.getByRole('button', { name: /^Publish$/ }))

      const entry = await screen.findByRole('group', { name: 'About me' })
      await userEvent.click(
        within(entry).getByRole('button', { name: "Use GitHub's" })
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Combine and publish' })
      )
      await vi.waitFor(() =>
        expect(commands.gitResolveConflicts).toHaveBeenCalledWith(SITE, [
          { path: ABOUT, choice: 'theirs' },
        ])
      )
      await vi.waitFor(() =>
        expect(commands.gitPublish).toHaveBeenCalledTimes(2)
      )
    })

    it('while a conflict stands, Publish and Sync open the Resolve view instead of trying again', async () => {
      renderWithProviders(<ChangesPanel />)
      await screen.findByText(/Choose which version to keep|both changed/)
      await userEvent.click(screen.getByRole('button', { name: /^Publish$/ }))
      expect(
        await screen.findByRole('group', { name: 'About me' })
      ).toBeInTheDocument()
      expect(commands.gitPublish).not.toHaveBeenCalled()
      expect(commands.gitSync).not.toHaveBeenCalled()
    })
  })
})
