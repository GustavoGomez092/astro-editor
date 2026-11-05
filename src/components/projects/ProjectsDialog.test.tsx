import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/test-utils'
import { projectRegistryManager } from '@/lib/project-registry'
import { useProjectStore } from '@/store/projectStore'
import { useProjectsScreenStore } from '@/store/projectsScreenStore'
import { ProjectsDialog } from './ProjectsDialog'

const { openSite } = vi.hoisted(() => ({ openSite: vi.fn() }))
// Opening a site saves first and reopens its last entry (actions.test.ts)
vi.mock('@/lib/projects/actions', () => ({
  openSite,
  openProjectViaDialog: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }))

const project = (id: string, path: string, lastOpened: string) => ({
  id,
  name: id,
  path,
  lastOpened,
  created: lastOpened,
})

const registry = {
  projects: {
    blog: project('blog', '/Users/kevin/Sites/blog', '2026-11-03T10:00:00Z'),
    old: project('old', '/Users/kevin/Old/site', '2026-10-01T10:00:00Z'),
  },
  lastOpenedProject: 'blog',
  version: 2,
}

describe('ProjectsDialog', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockImplementation(
      (command: string, args?: unknown) =>
        Promise.resolve(
          command === 'folder_states'
            ? (args as { paths: string[] }).paths.map(path =>
                path.startsWith('/Users/kevin/Old') ? 'missing' : 'present'
              )
            : null
        )
    )
    // The registry is mocked globally (src/test/setup.ts)
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.getRegistry).mockReturnValue(registry)
    useProjectStore.setState({ projectPath: null })
    useProjectsScreenStore.setState({ isOpen: true })
  })

  it('lists every project, and says when a folder is gone', async () => {
    renderWithProviders(<ProjectsDialog />)

    expect(await screen.findByText('blog')).toBeInTheDocument()
    expect(screen.getByText('~/Sites/blog')).toBeInTheDocument()
    expect(screen.getByText('site')).toBeInTheDocument()
    expect(
      await screen.findByText('Folder not found — is its drive connected?')
    ).toBeInTheDocument()
  })

  it('filters by name or folder', async () => {
    renderWithProviders(<ProjectsDialog />)
    await screen.findByText('blog')

    await userEvent.type(screen.getByLabelText('Search projects'), 'old')

    expect(screen.queryByText('blog')).not.toBeInTheDocument()
    expect(screen.getByText('site')).toBeInTheDocument()
  })

  it('opens the highlighted project with Enter', async () => {
    openSite.mockClear()
    renderWithProviders(<ProjectsDialog />)
    await screen.findByText('blog')

    await userEvent.type(screen.getByLabelText('Search projects'), '{Enter}')

    await waitFor(() =>
      expect(openSite).toHaveBeenCalledWith('/Users/kevin/Sites/blog')
    )
    expect(useProjectsScreenStore.getState().isOpen).toBe(false)
  })
})
