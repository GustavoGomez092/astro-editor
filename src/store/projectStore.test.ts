import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useProjectStore } from './projectStore'
import {
  getCollectionSort,
  withCollectionSort,
} from '../lib/project-registry/collection-settings'
import { projectRegistryManager } from '../lib/project-registry'
import type { ProjectSettings } from '../lib/project-registry/types'

vi.mock('../lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}))

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
