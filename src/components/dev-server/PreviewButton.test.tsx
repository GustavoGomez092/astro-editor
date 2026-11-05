import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { commands, type DevServerState } from '@/lib/bindings'
import { renderWithProviders } from '../../test/test-utils'
import { useProjectStore } from '../../store/projectStore'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/project-registry/defaults'
import { PreviewButton } from './PreviewButton'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}))

vi.unmock('../../lib/project-registry/defaults')

const state = (status: DevServerState['status'], forPreview = false) => ({
  status: 'ok' as const,
  data: {
    status,
    url: status === 'running' ? 'http://localhost:4321/' : null,
    command: 'npm run dev',
    pid: null,
    error: null,
    forPreview,
  },
})

/** Sends `dev-server-state`, as Rust does on each change */
async function emitStateChange() {
  const handlers = globalThis.mockTauri.listen.mock.calls
    .filter(([event]) => event === 'dev-server-state')
    .map(([, handler]) => handler as () => void)
  await act(async () => {
    handlers.forEach(handler => handler())
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

describe('PreviewButton', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.listen.mockResolvedValue(() => {})
    vi.restoreAllMocks()
    vi.spyOn(commands, 'devServerLogs').mockResolvedValue({
      status: 'ok',
      data: ['ready'],
    })
    useProjectStore.setState({
      projectPath: '/sites/kr',
      globalSettings: {
        ...DEFAULT_GLOBAL_SETTINGS,
        general: {
          ...DEFAULT_GLOBAL_SETTINGS.general,
          showPublishingTools: true,
        },
      },
    })
  })

  it('closes the output when the server stops, and keeps it closed on the next start', async () => {
    const serverState = vi
      .spyOn(commands, 'devServerState')
      .mockResolvedValue(state('running'))
    renderWithProviders(<PreviewButton />)

    fireEvent.click(await screen.findByLabelText(/^Server output/))
    expect(await screen.findByText('Server output')).toBeTruthy()

    serverState.mockResolvedValue(state('stopped'))
    await emitStateChange()
    await waitFor(() => expect(screen.queryByText('Server output')).toBeNull())

    serverState.mockResolvedValue(state('starting'))
    await emitStateChange()
    await screen.findByText('Starting…')
    expect(screen.queryByText('Server output')).toBeNull()
  })

  it('says a preview is being taken while its own server runs, without Open site or Stop', async () => {
    vi.spyOn(commands, 'devServerState').mockResolvedValue(
      state('running', true)
    )
    renderWithProviders(<PreviewButton />)
    expect(await screen.findByText('Taking a preview…')).toBeTruthy()
    expect(screen.queryByText('Open site')).toBeNull()
    expect(screen.queryByText('Stop')).toBeNull()
  })

  it('claims the server when the site is opened, so a preview never stops it', async () => {
    vi.spyOn(commands, 'devServerState').mockResolvedValue(state('running'))
    const claim = vi
      .spyOn(commands, 'devServerClaim')
      .mockResolvedValue(state('running'))
    renderWithProviders(<PreviewButton />)
    fireEvent.click(await screen.findByText('Open site'))
    await waitFor(() => expect(claim).toHaveBeenCalledWith('/sites/kr'))
  })

  it('is hidden while the preview tools are off', () => {
    useProjectStore.setState({
      globalSettings: {
        ...DEFAULT_GLOBAL_SETTINGS,
        general: {
          ...DEFAULT_GLOBAL_SETTINGS.general,
          showPublishingTools: false,
        },
      },
    })
    renderWithProviders(<PreviewButton />)
    expect(screen.queryByText('Preview')).toBeNull()
  })
})
