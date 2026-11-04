import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { NewFileDialog } from './NewFileDialog'
import { useUIStore } from '../../store/uiStore'
import { useProjectStore } from '../../store/projectStore'
import { renderWithProviders } from '../../test/test-utils'

const createNamedFile = vi.fn((_title: string) => Promise.resolve())
vi.mock('../../hooks/useCreateFile', () => ({
  useCreateFile: () => ({ createNewFile: vi.fn(), createNamedFile }),
}))

describe('NewFileDialog', () => {
  beforeEach(() => {
    createNamedFile.mockClear()
    useProjectStore.setState({
      selectedCollection: 'testimonials',
      globalSettings: null,
      currentProjectSettings: null,
    })
    useUIStore.setState({ newFileDialogOpen: true })
    renderWithProviders(<NewFileDialog />)
  })

  it('shows the file name the title will give', () => {
    expect(screen.getByText('New Testimonial')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Andrew Dyk' },
    })

    expect(screen.getByText('andrew-dyk.md')).toBeInTheDocument()
  })

  it('creates the file with the title and closes', () => {
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Andrew Dyk' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(createNamedFile).toHaveBeenCalledWith('Andrew Dyk')
    expect(useUIStore.getState().newFileDialogOpen).toBe(false)
  })
})
