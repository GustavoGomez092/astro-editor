import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { TitleBarToolbar } from './TitleBarToolbar'
import { useProjectStore } from '../../../store/projectStore'
import { renderWithProviders } from '../../../test/test-utils'
import { DEFAULT_GLOBAL_SETTINGS } from '../../../lib/project-registry/defaults'

import { useUIStore } from '../../../store/uiStore'
import { useBodyEditorHidden } from '../../../hooks/editor/useBodyEditorHidden'

vi.mock('../../../hooks/useCreateFile', () => ({
  useCreateFile: () => ({ createNewFile: vi.fn() }),
}))
vi.mock('../../../hooks/editor/useBodyEditorHidden', () => ({
  useBodyEditorHidden: vi.fn(() => false),
}))

// Preview and Publish need Tauri; these tests don't
const withoutPublishingTools = {
  ...DEFAULT_GLOBAL_SETTINGS,
  general: { ...DEFAULT_GLOBAL_SETTINGS.general, showPublishingTools: false },
}

describe('TitleBarToolbar', () => {
  beforeEach(() => {
    vi.mocked(useBodyEditorHidden).mockReturnValue(false)
  })

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

  describe('frontmatter panel button', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projectPath: '/project',
        globalSettings: withoutPublishingTools,
      })
      useUIStore.setState({ frontmatterPanelVisible: true })
    })

    it('toggles the panel when the body editor shows', () => {
      renderWithProviders(<TitleBarToolbar />)

      const button = screen.getByTitle('Close Frontmatter Panel')
      expect(button).toBeEnabled()
      button.click()
      expect(useUIStore.getState().frontmatterPanelVisible).toBe(false)
    })

    it('is disabled while the form is in the main area', () => {
      vi.mocked(useBodyEditorHidden).mockReturnValue(true)
      renderWithProviders(<TitleBarToolbar />)

      const button = screen.getByTitle(
        "This collection's fields are in the main area"
      )
      expect(button).toBeDisabled()
    })
  })
})
