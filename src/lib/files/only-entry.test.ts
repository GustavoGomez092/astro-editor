import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import type { FileEntry } from '@/types'
import { openOnlyEntry } from './only-entry'

const entry = (name: string): FileEntry => ({
  id: `hero/${name}`,
  path: `/site/src/content/hero/${name}.md`,
  name,
  extension: 'md',
  collection: 'hero',
  last_modified: null,
  frontmatter: null,
})

describe('openOnlyEntry', () => {
  const openFile = vi.fn()

  beforeEach(() => {
    openFile.mockReset()
    useEditorStore.setState({ openFile })
    useProjectStore.setState({ selectedCollection: 'hero' })
  })

  it('opens the entry of a collection that has exactly one', async () => {
    const only = entry('index')
    const opened = await openOnlyEntry({
      collectionName: 'hero',
      count: 1,
      loadFiles: () => Promise.resolve([only]),
    })

    expect(opened).toBe(true)
    expect(openFile).toHaveBeenCalledWith(only)
  })

  it('leaves a collection with none or several entries as a list', async () => {
    for (const [count, files] of [
      [0, []],
      [2, [entry('a'), entry('b')]],
    ] as const) {
      const loadFiles = vi.fn(() => Promise.resolve([...files]))
      expect(
        await openOnlyEntry({ collectionName: 'hero', count, loadFiles })
      ).toBe(false)
      expect(loadFiles).not.toHaveBeenCalled()
    }
    expect(openFile).not.toHaveBeenCalled()
  })

  it("doesn't open anything while the count is unknown", async () => {
    const loadFiles = vi.fn(() => Promise.resolve([entry('index')]))
    await openOnlyEntry({ collectionName: 'hero', count: undefined, loadFiles })
    expect(loadFiles).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('trusts the files over a stale count', async () => {
    const opened = await openOnlyEntry({
      collectionName: 'hero',
      count: 1,
      loadFiles: () => Promise.resolve([entry('a'), entry('b')]),
    })
    expect(opened).toBe(false)
    expect(openFile).not.toHaveBeenCalled()
  })

  it("doesn't open it once the writer has moved to another collection", async () => {
    const opened = await openOnlyEntry({
      collectionName: 'hero',
      count: 1,
      loadFiles: () => {
        useProjectStore.setState({ selectedCollection: null })
        return Promise.resolve([entry('index')])
      },
    })
    expect(opened).toBe(false)
    expect(openFile).not.toHaveBeenCalled()
  })
})
