import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { CollectionSettingsPane } from './CollectionSettingsPane'
import { useProjectStore } from '../../../store/projectStore'
import { renderWithProviders } from '../../../test/test-utils'
import type { CollectionSettings } from '../../../lib/project-registry/types'

// The global project-registry mock lacks what the real query needs
vi.mock('../../../hooks/queries/useCollectionsQuery', () => ({
  useCollectionsQuery: () => ({
    data: [{ name: 'work', path: '/project/src/content/work' }],
  }),
}))

const renderWith = (collections: CollectionSettings[]) => {
  useProjectStore.setState({
    projectPath: '/project',
    currentProjectId: 'project',
    currentProjectSettings: {
      pathOverrides: {},
      frontmatterMappings: {},
      collections,
    },
  })
  renderWithProviders(<CollectionSettingsPane />)
}

describe('CollectionSettingsPane', () => {
  it('marks a collection whose only override is its sort as custom', async () => {
    renderWith([
      { name: 'work', settings: { sort: { mode: 'order', direction: 'asc' } } },
    ])

    expect(await screen.findByText('Custom')).toBeInTheDocument()
  })

  it("doesn't mark a collection without overrides", async () => {
    renderWith([])

    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('Custom')).not.toBeInTheDocument()
  })
})
