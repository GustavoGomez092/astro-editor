import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { TitleBarToolbar } from './TitleBarToolbar'
import { useProjectStore } from '../../../store/projectStore'
import { renderWithProviders } from '../../../test/test-utils'

vi.mock('../../../hooks/useCreateFile', () => ({
  useCreateFile: () => ({ createNewFile: vi.fn() }),
}))

describe('TitleBarToolbar', () => {
  it('names the collection as words in the New File button, keeping all-caps words', () => {
    useProjectStore.setState({
      projectPath: '/project',
      selectedCollection: 'faq-UK',
    })

    renderWithProviders(<TitleBarToolbar />)

    expect(screen.getByTitle('New Faq UK file')).toBeInTheDocument()
  })
})
