import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import type { FileEntry } from '@/types'
import { useBodyEditorHidden } from './useBodyEditorHidden'

vi.mock('../queries/useCollectionsQuery', () => ({
  useCollectionsQuery: () => ({
    data: [
      { name: 'notes', path: '/site/src/content/notes', complete_schema: null },
      { name: 'posts', path: '/site/src/content/posts', complete_schema: null },
    ],
  }),
}))
// Some notes have body text, so the file decides whether "hide" hides it
vi.mock('../queries/useCollectionHasBodyQuery', () => ({
  useCollectionHasBodyQuery: () => ({ data: true }),
}))

const entry = (collection: string, name: string): FileEntry => ({
  id: `${collection}/${name}`,
  path: `/site/src/content/${collection}/${name}.md`,
  name,
  extension: 'md',
  collection,
  last_modified: null,
  frontmatter: null,
})

/** What useEditorFileContent does once the file's content arrives */
const load = (content: string) =>
  act(() => {
    useEditorStore.setState({
      editorContent: content,
      frontmatter: { title: 'T' },
      rawFrontmatter: 'title: T',
      frontmatterBaseline: { values: { title: 'T' }, raw: 'title: T' },
    })
  })

describe('useBodyEditorHidden', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projectPath: '/site',
      currentProjectSettings: {
        pathOverrides: {},
        frontmatterMappings: {},
        collections: [{ name: 'notes', settings: { bodyText: 'hide' } }],
      },
    })
    useEditorStore.setState({ currentFile: null, editorContent: '' })
  })

  it("doesn't flash the form while a file with body text loads", () => {
    const seen: boolean[] = []
    renderHook(() => {
      const hidden = useBodyEditorHidden()
      seen.push(hidden)
      return hidden
    })

    act(() => useEditorStore.getState().openFile(entry('posts', 'a')))
    load('Some text.')
    act(() => useEditorStore.getState().openFile(entry('notes', 'with-text')))
    load('A note with text.')

    expect(seen).not.toContain(true)
  })

  it('hides the editor once a file without body text has loaded', () => {
    const { result } = renderHook(() => useBodyEditorHidden())

    act(() => useEditorStore.getState().openFile(entry('notes', 'empty')))
    load('')

    expect(result.current).toBe(true)
  })
})
