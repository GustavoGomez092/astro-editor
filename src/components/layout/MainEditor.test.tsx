import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/test-utils'
import { useProjectStore } from '@/store/projectStore'
import { useEditorStore } from '@/store/editorStore'
import type { FileEntry } from '@/types'
import { MainEditor } from './MainEditor'
import { useBodyEditorHidden } from '../../hooks/editor/useBodyEditorHidden'

// Counts mounts, so a test can tell hiding from unmounting
const editorMounts = vi.hoisted(() => ({ count: 0 }))
vi.mock('../editor', async () => {
  const { useEffect } = await import('react')
  return {
    Editor: () => {
      useEffect(() => {
        editorMounts.count++
      }, [])
      return <div data-testid="body-editor" />
    },
  }
})
vi.mock('../frontmatter', () => ({
  FrontmatterPanel: ({ placement }: { placement?: string }) => (
    <div data-testid={`frontmatter-${placement ?? 'sidebar'}`} />
  ),
}))
vi.mock('../git/GitMainView', () => ({ GitMainView: () => null }))
vi.mock('../../hooks/editor/useBodyEditorHidden', () => ({
  useBodyEditorHidden: vi.fn(() => false),
}))

const file: FileEntry = {
  id: 'hero/index',
  path: '/site/src/content/hero/index.md',
  name: 'index',
  extension: 'md',
  collection: 'hero',
  last_modified: null,
  frontmatter: null,
}

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

describe('MainEditor in a collection without body text', () => {
  const bodyEditor = () =>
    screen.getByTestId('body-editor').closest('[data-body-editor]')!
  const mainForm = () =>
    screen.getByTestId('frontmatter-main').closest('[data-main-form]')!

  beforeEach(() => {
    editorMounts.count = 0
    useProjectStore.setState({ projectPath: '/site' })
    useEditorStore.setState({ currentFile: file })
  })

  it('shows the body editor and hides the form when the body editor shows', () => {
    vi.mocked(useBodyEditorHidden).mockReturnValue(false)
    renderWithProviders(<MainEditor />)

    expect(bodyEditor()).not.toHaveClass('hidden')
    expect(mainForm()).toHaveClass('hidden')
  })

  it('shows the form instead of the body editor when the body is hidden', () => {
    vi.mocked(useBodyEditorHidden).mockReturnValue(true)
    renderWithProviders(<MainEditor />)

    expect(bodyEditor()).toHaveClass('hidden')
    expect(bodyEditor()).toHaveAttribute('data-body-editor', 'hidden')
    expect(mainForm()).not.toHaveClass('hidden')
    expect(screen.queryByText('No text to write here')).toBeNull()
  })

  it('switches both ways without unmounting the editor or the form', () => {
    vi.mocked(useBodyEditorHidden).mockReturnValue(false)
    const { rerender } = renderWithProviders(<MainEditor />)
    const form = screen.getByTestId('frontmatter-main')

    vi.mocked(useBodyEditorHidden).mockReturnValue(true)
    rerender(<MainEditor />)
    expect(bodyEditor()).toHaveClass('hidden')
    expect(mainForm()).not.toHaveClass('hidden')

    vi.mocked(useBodyEditorHidden).mockReturnValue(false)
    rerender(<MainEditor />)
    expect(bodyEditor()).not.toHaveClass('hidden')
    expect(mainForm()).toHaveClass('hidden')

    expect(editorMounts.count).toBe(1)
    expect(screen.getByTestId('frontmatter-main')).toBe(form)
  })
})
