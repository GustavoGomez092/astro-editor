import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { TitleBarToolbar } from './TitleBarToolbar'
import { useProjectStore } from '../../../store/projectStore'
import { renderWithProviders } from '../../../test/test-utils'
import { DEFAULT_GLOBAL_SETTINGS } from '../../../lib/project-registry/defaults'

vi.mock('../../../hooks/useCreateFile', () => ({
  useCreateFile: () => ({ createNewFile: vi.fn() }),
}))

describe('TitleBarToolbar', () => {
  it('names the collection as words in the New File button, keeping all-caps words', () => {
    useProjectStore.setState({
      projectPath: '/project',
      selectedCollection: 'faq-UK',
      // Preview and Publish need Tauri; this test is only about New File
      globalSettings: {
        ...DEFAULT_GLOBAL_SETTINGS,
        general: {
          ...DEFAULT_GLOBAL_SETTINGS.general,
          showPublishingTools: false,
        },
      },
    })

    renderWithProviders(<TitleBarToolbar />)

    expect(screen.getByTitle('New Faq UK file')).toBeInTheDocument()
  })
})
