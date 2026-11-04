import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { GrammarSettings } from './GrammarSettings'
import { useProjectStore } from '../../../store/projectStore'
import { DEFAULT_GLOBAL_SETTINGS } from '../../../lib/project-registry/defaults'
import { renderWithProviders } from '../../../test/test-utils'

const updateGlobalSettings = vi.fn(() => Promise.resolve())

const renderWith = (grammar?: object) => {
  useProjectStore.setState({
    globalSettings: { ...DEFAULT_GLOBAL_SETTINGS, grammar },
    updateGlobalSettings,
  })
  renderWithProviders(<GrammarSettings />)
}

describe('GrammarSettings', () => {
  beforeEach(() => updateGlobalSettings.mockClear())

  it('is on by default and says the dictionary is empty', () => {
    renderWith()
    expect(
      screen.getByRole('switch', { name: 'Check spelling and grammar' })
    ).toBeChecked()
    expect(screen.getByText(/No words yet/)).toBeInTheDocument()
  })

  it('switching off keeps the dialect and words', () => {
    renderWith({ dialect: 'british', dictionary: ['Kevin'] })
    fireEvent.click(
      screen.getByRole('switch', { name: 'Check spelling and grammar' })
    )
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      grammar: { enabled: false, dialect: 'british', dictionary: ['Kevin'] },
    })
  })

  it('lists the words and removes one', () => {
    renderWith({ dictionary: ['Astro', 'Kevin'] })
    expect(screen.getByText('Astro')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Astro' }))
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      grammar: { enabled: true, dialect: 'american', dictionary: ['Kevin'] },
    })
  })
})
