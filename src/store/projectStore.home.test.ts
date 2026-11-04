import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectRegistryManager } from '@/lib/project-registry'
import { useProjectStore } from './projectStore'

describe('starting on Home', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockResolvedValue(null)
    useProjectStore.setState({ projectPath: null, globalSettings: null })
  })

  it('loads the registry but never reopens the last project', async () => {
    // oxlint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(projectRegistryManager.getLastOpenedProjectId).mockReturnValue(
      'blog'
    )

    await useProjectStore.getState().loadPersistedProject()

    // oxlint-disable-next-line @typescript-eslint/unbound-method
    expect(projectRegistryManager.initialize).toHaveBeenCalled()
    expect(useProjectStore.getState().projectPath).toBeNull()
    expect(useProjectStore.getState().globalSettings).not.toBeNull()
  })
})

describe('closeProject', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockResolvedValue(null)
    useProjectStore.setState({
      projectPath: '/Users/k/site',
      currentProjectId: 'site',
      selectedCollection: 'blog',
    })
  })

  it('forgets the open site and stops its watcher and dev server', async () => {
    await useProjectStore.getState().closeProject()

    const state = useProjectStore.getState()
    expect(state.projectPath).toBeNull()
    expect(state.currentProjectId).toBeNull()
    expect(state.selectedCollection).toBeNull()
    const commandsCalled = globalThis.mockTauri.invoke.mock.calls.map(
      call => call[0]
    )
    expect(commandsCalled).toContain('stop_watching_project')
    expect(commandsCalled).toContain('dev_server_stop')
  })
})
