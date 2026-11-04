import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { commands, type GitStatus } from '@/lib/bindings'
import { ASTRO_PATHS } from '@/lib/constants'
import { renderWithProviders } from '@/test/test-utils'
import { mockToast, resetToastMocks } from '@/test/mocks/toast'
import { useProjectStore } from '@/store/projectStore'
import { useEditorStore } from '@/store/editorStore'
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
})
