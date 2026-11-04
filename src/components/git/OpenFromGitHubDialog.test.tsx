import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/test-utils'
import { useGitStore } from '@/store/gitStore'
import { useProjectStore } from '@/store/projectStore'
import { commands } from '@/lib/bindings'
import { OpenFromGitHubDialog } from './OpenFromGitHubDialog'

vi.mock('@/lib/bindings', () => ({
  commands: {
    githubAuthStatus: vi.fn(() => new Promise(() => {})),
    githubListRepos: vi.fn(() => new Promise(() => {})),
    githubCheckAstroRepos: vi.fn(() => new Promise(() => {})),
    gitClone: vi.fn(),
    devServerPrepare: vi.fn(),
    devServerStop: vi.fn(),
    projectDependencies: vi.fn(),
  },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: () => Promise.resolve('/Users/k'),
}))

describe('OpenFromGitHubDialog', () => {
  beforeEach(() => {
    localStorage.clear()
    useGitStore.setState({ openFromGitHubOpen: true, cloneInProgress: false })
  })

  it('closes with Escape when nothing is downloading', async () => {
    renderWithProviders(<OpenFromGitHubDialog />)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(useGitStore.getState().openFromGitHubOpen).toBe(false)
  })

  it("can't be closed while a site is downloading, so the result isn't lost", async () => {
    useGitStore.setState({ cloneInProgress: true })
    renderWithProviders(<OpenFromGitHubDialog />)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useGitStore.getState().openFromGitHubOpen).toBe(true)
  })

  describe('signed in', () => {
    const ok = <T,>(data: T) => ({ status: 'ok' as const, data })
    beforeEach(() => {
      vi.mocked(commands.projectDependencies).mockResolvedValue(ok(['astro']))
      vi.mocked(commands.githubAuthStatus).mockResolvedValue(
        ok({ signedIn: true, login: 'kr', name: null, avatarUrl: null })
      )
      vi.mocked(commands.githubListRepos).mockResolvedValue(
        ok([
          {
            fullName: 'kr/kr-site',
            owner: 'kr',
            name: 'kr-site',
            private: true,
            defaultBranch: 'main',
            cloneUrl: 'https://github.com/kr/kr-site.git',
            updatedAt: '2026-11-01T00:00:00Z',
            pushedAt: '2026-10-30T00:00:00Z',
          },
        ])
      )
    })

    it('prepares the site after downloading it, then opens it', async () => {
      let finishPrepare: (value: unknown) => void = () => {}
      vi.mocked(commands.gitClone).mockResolvedValue(
        ok('/Users/k/Sites/kr-site')
      )
      vi.mocked(commands.devServerPrepare).mockReturnValue(
        new Promise(resolve => (finishPrepare = resolve)) as never
      )
      const setProject = vi.fn()
      useProjectStore.setState({ setProject })
      renderWithProviders(<OpenFromGitHubDialog />)
      await userEvent.click(
        await screen.findByRole('option', { name: /kr-site/ })
      )
      await userEvent.click(
        screen.getByRole('button', { name: /Download and open/ })
      )
      expect(
        await screen.findByText('Preparing your site…')
      ).toBeInTheDocument()
      expect(commands.devServerPrepare).toHaveBeenCalledWith(
        '/Users/k/Sites/kr-site'
      )
      expect(setProject).not.toHaveBeenCalled()
      finishPrepare(
        ok({
          status: 'stopped',
          url: null,
          command: null,
          pid: null,
          error: null,
        })
      )
      await vi.waitFor(() =>
        expect(setProject).toHaveBeenCalledWith('/Users/k/Sites/kr-site')
      )
    })

    it('lets the writer skip a preparation that hangs, then opens the site', async () => {
      vi.mocked(commands.gitClone).mockResolvedValue(
        ok('/Users/k/Sites/kr-site')
      )
      let finishPrepare: (value: unknown) => void = () => {}
      vi.mocked(commands.devServerPrepare).mockReturnValue(
        new Promise(resolve => (finishPrepare = resolve)) as never
      )
      vi.mocked(commands.devServerStop).mockImplementation(() => {
        finishPrepare(
          ok({
            status: 'stopped',
            url: null,
            command: null,
            pid: null,
            error: null,
          })
        )
        return Promise.resolve(ok(null)) as never
      })
      const setProject = vi.fn()
      useProjectStore.setState({ setProject })
      renderWithProviders(<OpenFromGitHubDialog />)
      await userEvent.click(
        await screen.findByRole('option', { name: /kr-site/ })
      )
      await userEvent.click(
        screen.getByRole('button', { name: /Download and open/ })
      )
      await userEvent.click(await screen.findByRole('button', { name: 'Skip' }))
      expect(commands.devServerStop).toHaveBeenCalledWith(
        '/Users/k/Sites/kr-site'
      )
      await vi.waitFor(() =>
        expect(setProject).toHaveBeenCalledWith('/Users/k/Sites/kr-site')
      )
    })

    it("doesn't prepare a project that isn't an Astro site", async () => {
      vi.mocked(commands.projectDependencies).mockResolvedValue(ok(['vite']))
      vi.mocked(commands.gitClone).mockResolvedValue(ok('/Users/k/Sites/notes'))
      const setProject = vi.fn()
      useProjectStore.setState({ setProject })
      renderWithProviders(<OpenFromGitHubDialog />)
      await userEvent.click(
        await screen.findByRole('option', { name: /kr-site/ })
      )
      await userEvent.click(
        screen.getByRole('button', { name: /Download and open/ })
      )
      await vi.waitFor(() => expect(setProject).toHaveBeenCalled())
      expect(commands.devServerPrepare).not.toHaveBeenCalled()
    })

    it('shortens a long Save in folder in the middle, with the full path in its tooltip', async () => {
      renderWithProviders(<OpenFromGitHubDialog />)
      await screen.findByRole('option', { name: /kr-site/ })
      const label = screen.getByTitle('/Users/k/Sites')
      expect(label).toHaveTextContent('~/Sites')
    })

    describe('Astro sites only', () => {
      const repo = (name: string) => ({
        fullName: `kr/${name}`,
        owner: 'kr',
        name,
        private: false,
        defaultBranch: 'main',
        cloneUrl: `https://github.com/kr/${name}.git`,
        updatedAt: '2026-11-01T00:00:00Z',
        pushedAt: '2026-10-30T00:00:00Z',
      })
      beforeEach(() => {
        vi.mocked(commands.githubListRepos).mockResolvedValue(
          ok([repo('site'), repo('notes'), repo('empty')])
        )
      })

      it('lists repositories as Checking… and then drops the ones that are not Astro', async () => {
        let answer: (value: unknown) => void = () => {}
        vi.mocked(commands.githubCheckAstroRepos).mockReturnValue(
          new Promise(resolve => (answer = resolve)) as never
        )
        renderWithProviders(<OpenFromGitHubDialog />)
        const notes = await screen.findByRole('option', { name: /notes/ })
        expect(notes).toHaveTextContent('Checking…')
        answer(
          ok([
            { fullName: 'kr/site', check: 'astro' },
            { fullName: 'kr/notes', check: 'notAstro' },
            { fullName: 'kr/empty', check: 'unknown' },
          ])
        )
        await vi.waitFor(() =>
          expect(
            screen.queryByRole('option', { name: /notes/ })
          ).not.toBeInTheDocument()
        )
        expect(screen.getByRole('option', { name: /site/ })).toBeVisible()
        expect(screen.getByRole('option', { name: /empty/ })).toHaveTextContent(
          "Couldn't check"
        )
      })

      it('uses saved answers without asking again, and asks again after a push', async () => {
        localStorage.setItem(
          'astro-editor:astro-site-checks',
          JSON.stringify({
            'kr/site': { pushedAt: '2026-10-30T00:00:00Z', astro: true },
            'kr/notes': { pushedAt: '2026-10-30T00:00:00Z', astro: false },
            'kr/empty': { pushedAt: 'older', astro: true },
          })
        )
        vi.mocked(commands.githubCheckAstroRepos).mockResolvedValue(
          ok([{ fullName: 'kr/empty', check: 'astro' }])
        )
        renderWithProviders(<OpenFromGitHubDialog />)
        await screen.findByRole('option', { name: /site/ })
        expect(
          screen.queryByRole('option', { name: /notes/ })
        ).not.toBeInTheDocument()
        await vi.waitFor(() =>
          expect(commands.githubCheckAstroRepos).toHaveBeenCalledWith([
            'kr/empty',
          ])
        )
      })

      it('says so when nothing is an Astro site, and shows everything on request', async () => {
        vi.mocked(commands.githubCheckAstroRepos).mockResolvedValue(
          ok(
            ['site', 'notes', 'empty'].map(n => ({
              fullName: `kr/${n}`,
              check: 'notAstro' as const,
            }))
          )
        )
        renderWithProviders(<OpenFromGitHubDialog />)
        expect(
          await screen.findByText(/None of your repositories look like Astro/)
        ).toBeInTheDocument()
        await userEvent.click(
          screen.getByRole('button', { name: 'Show all repositories' })
        )
        expect(await screen.findAllByRole('option')).toHaveLength(3)
        expect(
          localStorage.getItem('astro-editor:open-from-github-show-all')
        ).toBe('true')
      })
    })
  })
})
