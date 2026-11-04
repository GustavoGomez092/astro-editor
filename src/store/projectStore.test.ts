import { describe, it, expect, beforeEach, vi } from 'vitest'
import { commands } from '@/lib/bindings'
import { projectRegistryManager } from '../lib/project-registry'
import { useProjectStore } from './projectStore'

vi.mock('../lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}))

const stopped = {
  status: 'ok' as const,
  data: {
    status: 'stopped' as const,
    url: null,
    command: null,
    pid: null,
    error: null,
  },
}

describe('projectStore.setProject', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockResolvedValue(undefined)
    vi.restoreAllMocks()
    useProjectStore.setState({ projectPath: '/sites/old' })
  })

  it("stops the previous project's dev server", async () => {
    const stop = vi.spyOn(commands, 'devServerStop').mockResolvedValue(stopped)
    useProjectStore.getState().setProject('/sites/new')
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('/sites/old'))
    expect(stop).not.toHaveBeenCalledWith('/sites/new')
  })

  it('leaves the server running when the same project opens again', async () => {
    const stop = vi.spyOn(commands, 'devServerStop').mockResolvedValue(stopped)
    useProjectStore.getState().setProject('/sites/old')
    await vi.waitFor(() =>
      expect(useProjectStore.getState().projectPath).toBe('/sites/old')
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stop).not.toHaveBeenCalled()
  })

  it('keeps the server running when the switch fails', async () => {
    const stop = vi.spyOn(commands, 'devServerStop').mockResolvedValue(stopped)
    vi.spyOn(projectRegistryManager, 'registerProject').mockRejectedValueOnce(
      new Error('no package.json')
    )
    useProjectStore.getState().setProject('/sites/broken')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stop).not.toHaveBeenCalled()
    expect(useProjectStore.getState().projectPath).toBe('/sites/old')
  })
})

describe('projectStore.updateGlobalSettings', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    vi.restoreAllMocks()
    useProjectStore.setState({ projectPath: '/sites/old' })
  })

  it('stops the dev server when the preview tools are turned off', async () => {
    const stop = vi.spyOn(commands, 'devServerStop').mockResolvedValue(stopped)
    await useProjectStore
      .getState()
      .updateGlobalSettings({ general: { showPublishingTools: false } })
    expect(stop).toHaveBeenCalledWith('/sites/old')
  })

  it('leaves it alone for other settings', async () => {
    const stop = vi.spyOn(commands, 'devServerStop').mockResolvedValue(stopped)
    await useProjectStore
      .getState()
      .updateGlobalSettings({ general: { showPublishingTools: true } })
    await useProjectStore
      .getState()
      .updateGlobalSettings({ general: { theme: 'dark' } })
    expect(stop).not.toHaveBeenCalled()
  })
})
