import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/test-utils'
import { projectRegistryManager } from '@/lib/project-registry'
import { useProjectStore } from '@/store/projectStore'

const { goHome, openSite } = vi.hoisted(() => ({
  goHome: vi.fn(),
  openSite: vi.fn(),
}))
vi.mock('@/lib/projects/actions', () => ({
  goHome,
  openSite,
  openProjectViaDialog: vi.fn(),
}))

const { platform } = vi.hoisted(() => ({ platform: { current: 'macos' } }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => platform.current }))

import { SiteSwitcher } from './SiteSwitcher'

const sites = Array.from({ length: 7 }, (_, i) => ({
  id: `site-${i}`,
  name: `site-${i}`,
  path: `/Users/k/Sites/site-${i}`,
  lastOpened: `2026-10-${String(i + 10)}T10:00:00Z`,
  created: '2026-01-01T00:00:00Z',
}))

describe('SiteSwitcher', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockImplementation(
      (command: string, args?: unknown) =>
        Promise.resolve(
          command === 'folder_states'
            ? (args as { paths: string[] }).paths.map(() => 'present')
            : null
        )
    )
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.getRegistry).mockReturnValue({
      projects: Object.fromEntries(sites.map(s => [s.id, s])),
      lastOpenedProject: null,
      version: 2,
    })
    useProjectStore.setState({
      globalSettings: { general: { showPublishingTools: true } } as never,
    })
    platform.current = 'macos'
    goHome.mockClear()
    openSite.mockClear()
  })

  it('is a button with the site name', () => {
    renderWithProviders(<SiteSwitcher projectPath="/Users/k/Sites/site-6" />)
    expect(
      screen.getByRole('button', { name: 'site-6, switch site' })
    ).toBeInTheDocument()
  })

  it('lists five recent sites, then Home and the two ways to add one', async () => {
    renderWithProviders(<SiteSwitcher projectPath="/Users/k/Sites/site-6" />)
    await userEvent.click(screen.getByRole('button', { name: /switch site/ }))

    await screen.findByRole('menuitem', { name: /site-2/ })
    const items = screen.getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual([
      expect.stringContaining('site-6'),
      expect.stringContaining('site-5'),
      expect.stringContaining('site-4'),
      expect.stringContaining('site-3'),
      expect.stringContaining('site-2'),
      expect.stringContaining('All sites (Home)'),
      'Open a folder…',
      'Open from GitHub…',
    ])
    expect(items[0]).toHaveTextContent('Open now')
    expect(items[1]).toHaveTextContent(/Edited/)
    expect(items[5]).toHaveTextContent('⇧⌘H')
  })

  it('shows the Home shortcut for the platform', async () => {
    platform.current = 'windows'
    renderWithProviders(<SiteSwitcher projectPath="/Users/k/Sites/site-6" />)
    await userEvent.click(screen.getByRole('button', { name: /switch site/ }))

    expect(
      await screen.findByRole('menuitem', { name: /All sites \(Home\)/ })
    ).toHaveTextContent('Ctrl+Shift+H')
  })

  it('goes Home, and opens another site', async () => {
    renderWithProviders(<SiteSwitcher projectPath="/Users/k/Sites/site-6" />)
    await userEvent.click(screen.getByRole('button', { name: /switch site/ }))
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /All sites \(Home\)/ })
    )
    expect(goHome).toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /switch site/ }))
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /site-5/ })
    )
    await waitFor(() =>
      expect(openSite).toHaveBeenCalledWith('/Users/k/Sites/site-5')
    )
  })
})
