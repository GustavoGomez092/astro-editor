import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { FileEntry } from '@/types'
import { useEditorStore } from '../../../store/editorStore'
import { useProjectStore } from '../../../store/projectStore'
import { renderWithProviders } from '../../../test/test-utils'
import { fileCommands } from '../../../lib/commands/app-commands'
import type { CommandContext } from '../../../lib/commands/types'

const { scanDirectory, renameFile } = vi.hoisted(() => ({
  scanDirectory: vi.fn(),
  renameFile: vi.fn(),
}))
vi.mock('@/lib/bindings', () => ({
  commands: { scanDirectory, renameFile },
}))

import { UpdateFileNameHint } from './UpdateFileNameHint'
import { renameCurrentFileToTitle } from '../../../lib/files/rename-to-title-action'

const file = (name: string): FileEntry => ({
  id: `blog/${name}`,
  name,
  path: `/site/blog/${name}.md`,
  extension: 'md',
  collection: 'blog',
  last_modified: null,
  frontmatter: null,
})

// The file as loaded: `loadedTitle` is on disk, `title` is in the form now
const open = (name: string, loadedTitle: string, title = loadedTitle) =>
  useEditorStore.setState({
    currentFile: file(name),
    frontmatter: { title },
    frontmatterBaseline: { values: { title: loadedTitle }, raw: '' },
    titleBaseline: null,
    isDirty: false,
    autoSaveCallback: () => Promise.resolve(),
  })

const hint = () => screen.queryByRole('button', { name: /Update to/ })

describe('the file name hint under the title', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projectPath: '/site',
      currentProjectSettings: null,
    })
    scanDirectory.mockResolvedValue({
      status: 'ok',
      data: { files: [], subdirectories: [] },
    })
    renameFile.mockResolvedValue({ status: 'ok', data: null })
  })

  it('stays hidden on a file that was never named after its title, edited or not', () => {
    open('colorkraft', 'ColorKraft Auto Refinishers')
    renderWithProviders(<UpdateFileNameHint />)
    expect(hint()).toBeNull()

    useEditorStore.setState({ frontmatter: { title: 'Something Else' } })
    renderWithProviders(<UpdateFileNameHint />)
    expect(hint()).toBeNull()
  })

  it('shows on a file named after its title once the title is edited', async () => {
    open('old-heading', 'Old Heading', 'Fresh Heading')
    renderWithProviders(<UpdateFileNameHint />)
    expect(
      await screen.findByRole('button', { name: /Update to/ })
    ).not.toBeNull()
  })

  it('stays hidden on a file named after its title until the title is edited', () => {
    open('old-heading', 'Old Heading')
    renderWithProviders(<UpdateFileNameHint />)
    expect(hint()).toBeNull()
  })

  it('goes away after the rename, and the new title becomes the starting point', async () => {
    open('old-heading', 'Old Heading', 'Fresh Heading')
    const { unmount } = renderWithProviders(<UpdateFileNameHint />)
    await screen.findByRole('button', { name: /Update to/ })
    unmount()

    await renameCurrentFileToTitle()

    renderWithProviders(<UpdateFileNameHint />)
    expect(hint()).toBeNull()

    // editing the title again points out the new name
    useEditorStore.setState({ frontmatter: { title: 'Fresher Heading' } })
    expect(
      await screen.findByRole('button', { name: /fresher-heading\.md/ })
    ).not.toBeNull()
  })
})

describe('Rename File to Match Title in the palette', () => {
  it('is still offered on a file never named after its title, without edits', () => {
    open('colorkraft', 'ColorKraft Auto Refinishers')
    const command = fileCommands.find(c => c.id === 'rename-to-title')!
    expect(
      command.isAvailable({
        currentFile: file('colorkraft'),
      } as CommandContext)
    ).toBe(true)
  })
})
