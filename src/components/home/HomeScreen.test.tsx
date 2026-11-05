import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/test-utils'
import { projectRegistryManager } from '@/lib/project-registry'
import { useProjectStore } from '@/store/projectStore'

const { openSite, removeSite } = vi.hoisted(() => ({
  openSite: vi.fn(),
  removeSite: vi.fn(),
}))
vi.mock('@/lib/projects/actions', () => ({
  openSite,
  removeSite,
  openProjectViaDialog: vi.fn(),
  refreshSitePreview: vi.fn(),
  showSiteInFileManager: vi.fn(),
}))

import { HomeScreen } from './HomeScreen'

const project = (id: string, path: string, lastOpened: string) => ({
  id,
  name: id,
  path,
  lastOpened,
  created: lastOpened,
})

const MISSING = '/Volumes/Backup'

function setRegistry(projects: ReturnType<typeof project>[]) {
  // The registry is mocked globally (src/test/setup.ts)
  // oxlint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(projectRegistryManager.getRegistry).mockReturnValue({
    projects: Object.fromEntries(projects.map(p => [p.id, p])),
    lastOpenedProject: null,
    version: 2,
  })
}

const sites = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    project(
      `site-${i}`,
      `/Users/k/Sites/site-${i}`,
      `2026-10-${String(i + 10)}T10:00:00Z`
    )
  )

describe('HomeScreen', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.listen.mockResolvedValue(() => {})
    openSite.mockClear()
    removeSite.mockClear()
    globalThis.mockTauri.invoke.mockImplementation(
      (command: string, args?: unknown) => {
        if (command === 'folder_states') {
          return Promise.resolve(
            (args as { paths: string[] }).paths.map(path =>
              path.startsWith(MISSING) ? 'unavailable' : 'present'
            )
          )
        }
        if (command === 'github_auth_status') {
          return Promise.resolve({
            signedIn: true,
            login: 'gus',
            name: 'Gustavo Gomez',
            avatarUrl: null,
          })
        }
        return Promise.resolve(null)
      }
    )
    useProjectStore.setState({
      projectPath: null,
      globalSettings: {
        general: { showPublishingTools: true },
      } as never,
    })
  })

  it('greets by first name and lists sites newest first', async () => {
    setRegistry([
      project('old', '/Users/k/Sites/old', '2026-09-01T10:00:00Z'),
      project('new', '/Users/k/Sites/new', '2026-11-03T10:00:00Z'),
    ])
    renderWithProviders(<HomeScreen />)

    expect(
      await screen.findByRole('heading', {
        name: /^Good (morning|afternoon|evening), Gustavo$/,
      })
    ).toBeInTheDocument()
    expect(screen.getByText('Pick a site to keep editing.')).toBeInTheDocument()

    const cards = screen.getAllByRole('button', { name: /Sites\/(new|old)/ })
    expect(cards.map(card => card.textContent)).toEqual([
      expect.stringContaining('new'),
      expect.stringContaining('old'),
    ])
    expect(screen.getByText('Add a site')).toBeInTheDocument()
  })

  it('says Welcome back when no name is known', async () => {
    globalThis.mockTauri.invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === 'github_auth_status'
          ? { signedIn: false, login: null, name: null, avatarUrl: null }
          : command === 'folder_states'
            ? ['present']
            : null
      )
    )
    setRegistry(sites(1))
    renderWithProviders(<HomeScreen />)

    expect(
      await screen.findByRole('heading', { name: 'Welcome back' })
    ).toBeInTheDocument()
  })

  it('opens a site with one click on its card', async () => {
    setRegistry(sites(1))
    renderWithProviders(<HomeScreen />)

    await userEvent.click(
      await screen.findByRole('button', { name: /^site-0/ })
    )

    expect(openSite).toHaveBeenCalledWith('/Users/k/Sites/site-0')
  })

  it('shows the search box only with more than six sites', async () => {
    setRegistry(sites(6))
    const { unmount } = renderWithProviders(<HomeScreen />)
    await screen.findByText('Your sites')
    expect(screen.queryByLabelText('Search sites')).not.toBeInTheDocument()
    unmount()

    setRegistry(sites(7))
    renderWithProviders(<HomeScreen />)
    const search = await screen.findByLabelText('Search sites')

    await userEvent.type(search, 'site-3')
    expect(screen.getAllByRole('button', { name: /^site-/ })).toHaveLength(1)
  })

  it('dims a site whose folder is gone and does not open it', async () => {
    setRegistry([
      project('gone', `${MISSING}/old-portfolio`, '2026-09-01T10:00:00Z'),
    ])
    renderWithProviders(<HomeScreen />)

    const card = await screen.findByRole('button', { name: /^old-portfolio/ })
    expect(card).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText('Folder not found. Is its drive connected?')
    ).toBeInTheDocument()

    await userEvent.click(card)
    expect(openSite).not.toHaveBeenCalled()

    // Only Remove is offered
    await userEvent.click(
      screen.getByRole('button', { name: 'More actions for old-portfolio' })
    )
    expect(
      await screen.findByRole('menuitem', { name: 'Remove from list' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open' })).toBeNull()
  })

  it('has Open, Show in Finder and Remove in the card menu', async () => {
    setRegistry(sites(1))
    renderWithProviders(<HomeScreen />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions for site-0' })
    )
    for (const name of ['Open', 'Refresh preview', 'Remove from list']) {
      expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument()
    }

    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Remove from list' })
    )
    await waitFor(() => expect(removeSite).toHaveBeenCalledWith('site-0'))
  })

  it('moves between cards with the arrow keys', async () => {
    setRegistry(sites(3))
    renderWithProviders(<HomeScreen />)
    const cards = await screen.findAllByRole('button', { name: /Sites\/site-/ })

    cards[0]?.focus()
    await userEvent.keyboard('{ArrowRight}')

    expect(cards[1]).toHaveFocus()
  })

  it('shows the first-launch screen when no site was ever opened', async () => {
    setRegistry([])
    renderWithProviders(<HomeScreen />)

    expect(
      await screen.findByRole('heading', { name: 'Welcome to Astro Editor+' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Open from GitHub/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Open a folder/ })
    ).toBeInTheDocument()
    expect(screen.queryByText('Your sites')).not.toBeInTheDocument()
  })

  it('never shows the first-launch screen to someone with sites while the registry loads', async () => {
    useProjectStore.setState({ globalSettings: null })
    setRegistry([])
    renderWithProviders(<HomeScreen />)
    // Before the registry is read the list is empty: that isn't a first launch
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(
      screen.queryByRole('heading', { name: 'Welcome to Astro Editor+' })
    ).not.toBeInTheDocument()

    setRegistry(sites(2))
    act(() => {
      useProjectStore.setState({
        globalSettings: { general: { showPublishingTools: true } } as never,
      })
    })

    expect(await screen.findByText('Your sites')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Welcome to Astro Editor+' })
    ).not.toBeInTheDocument()
  })

  it('holds the greeting until the GitHub profile is known, so it does not change', async () => {
    globalThis.mockTauri.invoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === 'github_auth_status'
          ? new Promise(() => {})
          : command === 'folder_states'
            ? ['present']
            : null
      )
    )
    setRegistry(sites(1))
    renderWithProviders(<HomeScreen />)

    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading.parentElement).toHaveClass('invisible')
  })

  it('puts focus on the first card', async () => {
    setRegistry(sites(2))
    renderWithProviders(<HomeScreen />)

    const cards = await screen.findAllByRole('button', { name: /^site-/ })
    await waitFor(() => expect(cards[0]).toHaveFocus())
  })
})
