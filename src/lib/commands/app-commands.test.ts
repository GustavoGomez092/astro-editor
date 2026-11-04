import { afterEach, describe, expect, it } from 'vitest'
import type { CommandContext } from './types'
import { navigationCommands } from './app-commands'

const togglePanel = navigationCommands.find(
  c => c.id === 'toggle-frontmatter-panel'
)!
const context = {} as CommandContext

describe('Toggle Frontmatter Panel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is offered while the body editor shows', () => {
    document.body.innerHTML = '<div data-body-editor="shown"></div>'
    expect(togglePanel.isAvailable(context)).toBe(true)
  })

  it('is not offered while the form is in the main area', () => {
    document.body.innerHTML = '<div data-body-editor="hidden"></div>'
    expect(togglePanel.isAvailable(context)).toBe(false)
  })
})
