import { describe, it, expect, beforeEach, vi } from 'vitest'
import { commands } from '@/lib/bindings'
import { useProjectStore } from './projectStore'
import {
  getCollectionSort,
  withCollectionSort,
} from '../lib/project-registry/collection-settings'
import { projectRegistryManager } from '../lib/project-registry'
import { queryClient } from '../lib/query-client'
import { useEditorStore } from './editorStore'
import type { ProjectSettings } from '../lib/project-registry/types'

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

const settings: ProjectSettings = {
  pathOverrides: {},
  frontmatterMappings: {},
  collections: [
    { name: 'work', settings: { sort: { mode: 'order', direction: 'asc' } } },
  ],
}

// The registry is mocked globally (src/test/setup.ts)
// oxlint-disable-next-line @typescript-eslint/unbound-method
const writeSettings = vi.mocked(projectRegistryManager.updateProjectSettings)

/** Flips the sort the way the sidebar's arrow does, from the store's state */
function toggleSortDirection() {
  const { currentProjectSettings, updateProjectSettings } =
    useProjectStore.getState()
  const current = getCollectionSort(currentProjectSettings, 'work')
  return updateProjectSettings({
    collections: withCollectionSort(currentProjectSettings, 'work', {
      ...current,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    }),
  })
}

describe('projectStore.updateProjectSettings', () => {
  beforeEach(() => {
    writeSettings.mockClear()
    useProjectStore.setState({
      currentProjectId: 'project',
      projectPath: '/project',
      currentProjectSettings: settings,
    })
  })

  it('shows new collection settings before they are written', () => {
    void toggleSortDirection()

    expect(
      getCollectionSort(
        useProjectStore.getState().currentProjectSettings,
        'work'
      ).direction
    ).toBe('desc')
  })

  // Each click reads the settings the last one left, so none is lost
  it('keeps both of two quick changes', () => {
    void toggleSortDirection()
    void toggleSortDirection()

    expect(
      getCollectionSort(
        useProjectStore.getState().currentProjectSettings,
        'work'
      ).direction
    ).toBe('asc')
    const writes = writeSettings.mock.calls
    expect(writes.at(-1)?.[1]).toEqual({
      collections: [
        {
          name: 'work',
          settings: { sort: { mode: 'order', direction: 'asc' } },
        },
      ],
    })
  })

  it('puts the settings back when the write fails', async () => {
    writeSettings.mockRejectedValueOnce(new Error('disk full'))

    await toggleSortDirection()

    expect(useProjectStore.getState().currentProjectSettings).toBe(settings)
  })
})

describe('projectStore.updateProjectSettings with collection folders', () => {
  const okNull = { status: 'ok' as const, data: null }
  beforeEach(() => {
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockResolvedValue(undefined)
    globalThis.mockTauri.listen.mockResolvedValue(() => {})
    vi.restoreAllMocks()
    vi.mocked(queryClient.invalidateQueries).mockClear()
    useProjectStore.setState({
      currentProjectId: 'project',
      projectPath: '/project',
      currentProjectSettings: settings,
    })
  })

  const setWorkFolder = (contentDirectory: string) =>
    useProjectStore.getState().updateProjectSettings({
      collections: [
        {
          name: 'work',
          settings: {
            sort: { mode: 'order', direction: 'asc' },
            pathOverrides: { contentDirectory },
          },
        },
      ],
    })

  it("restarts the watcher and reloads collections when a collection's folder changes", async () => {
    const stop = vi
      .spyOn(commands, 'stopWatchingProject')
      .mockResolvedValue(okNull)
    const start = vi
      .spyOn(commands, 'startWatchingProjectWithContentDir')
      .mockResolvedValue(okNull)

    await setWorkFolder('writing/work')

    expect(stop).toHaveBeenCalledWith('/project')
    expect(start).toHaveBeenCalled()
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['project', '/project', 'collections'],
    })
  })

  it('saves and closes the open file when a collection folder changes', async () => {
    vi.spyOn(commands, 'stopWatchingProject').mockResolvedValue(okNull)
    vi.spyOn(commands, 'startWatchingProjectWithContentDir').mockResolvedValue(
      okNull
    )
    const save = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    useEditorStore.setState({
      currentFile: { id: 'work/a', path: '/project/src/content/work/a.md' },
      saveFile: save,
      closeCurrentFile: close,
    } as never)

    await setWorkFolder('writing/work')

    expect(save).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    useEditorStore.setState({ currentFile: null } as never)
  })

  it('leaves the watcher alone when only the sort changes', async () => {
    const stop = vi
      .spyOn(commands, 'stopWatchingProject')
      .mockResolvedValue(okNull)

    await toggleSortDirection()

    expect(stop).not.toHaveBeenCalled()
  })
})
