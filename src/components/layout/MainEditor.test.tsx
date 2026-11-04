import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/test-utils'
import { useProjectStore } from '@/store/projectStore'
import { useEditorStore } from '@/store/editorStore'
import { MainEditor } from './MainEditor'

vi.mock('../editor', () => ({ Editor: () => null }))
vi.mock('../git/GitMainView', () => ({ GitMainView: () => null }))
vi.mock('../../hooks/editor/useBodyEditorHidden', () => ({
  useBodyEditorHidden: () => false,
}))

describe('MainEditor welcome screen', () => {
  beforeEach(() => {
    useEditorStore.setState({ currentFile: null })
  })

  it('asks for a project when none is open', () => {
    useProjectStore.setState({ projectPath: null })
    renderWithProviders(<MainEditor />)
    expect(
      screen.getByText(
        'Select a project folder to get started, then choose a file to edit.'
      )
    ).toBeInTheDocument()
  })

  it('asks only for a file once a project is open', () => {
    useProjectStore.setState({ projectPath: '/site' })
    renderWithProviders(<MainEditor />)
    expect(screen.getByText('Choose a file to edit.')).toBeInTheDocument()
    expect(screen.queryByText(/Select a project folder/)).toBeNull()
  })
})
