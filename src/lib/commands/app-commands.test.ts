import { afterEach, describe, expect, it } from 'vitest'
import type { CommandContext } from './types'
import { fileCommands, navigationCommands } from './app-commands'
import { useEditorStore } from '@/store/editorStore'
import type { FileEntry } from '@/types'

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

describe('Rename File to Match Title', () => {
  const rename = fileCommands.find(c => c.id === 'rename-to-title')!
  const file = {
    id: 'blog/old-name',
    name: 'old-name',
    path: '/site/blog/old-name.md',
    extension: 'md',
    collection: 'blog',
    last_modified: null,
    frontmatter: null,
  } as FileEntry
  const open = { currentFile: file } as CommandContext

  it('is offered once the title no longer matches the file name', () => {
    useEditorStore.setState({ frontmatter: { title: 'Fresh Heading' } })
    expect(rename.isAvailable(open)).toBe(true)
  })

  it('is not offered when the name matches, the title is empty, or nothing is open', () => {
    useEditorStore.setState({ frontmatter: { title: 'Old Name' } })
    expect(rename.isAvailable(open)).toBe(false)
    useEditorStore.setState({ frontmatter: {} })
    expect(rename.isAvailable(open)).toBe(false)
    useEditorStore.setState({ frontmatter: { title: 'Fresh Heading' } })
    expect(rename.isAvailable({ currentFile: null } as CommandContext)).toBe(
      false
    )
  })
})
