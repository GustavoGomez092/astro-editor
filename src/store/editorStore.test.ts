import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEditorStore } from './editorStore'
import type { FileEntry } from '@/types'

const fileEntry = (id: string): FileEntry => ({
  id,
  name: `${id}.md`,
  path: `/test/content/blog/${id}.md`,
  extension: 'md',
  collection: 'blog',
  last_modified: null,
  frontmatter: null,
})

describe('editorStore.openFile', () => {
  beforeEach(() => {
    useEditorStore.setState({
      currentFile: fileEntry('first'),
      editorContent: 'Unsaved edit',
      frontmatter: { title: 'First' },
      isDirty: true,
      autoSaveTimeoutId: null,
      autoSaveCallback: null,
    })
  })

  it('saves unsaved edits to the outgoing file before switching', () => {
    let seen: { id?: string; content: string } | null = null
    const save = vi.fn(() => {
      const state = useEditorStore.getState()
      seen = { id: state.currentFile?.id, content: state.editorContent }
      return Promise.resolve()
    })
    useEditorStore.setState({ autoSaveCallback: save })

    useEditorStore.getState().openFile(fileEntry('second'))

    expect(save).toHaveBeenCalledWith(false)
    expect(seen).toEqual({ id: 'first', content: 'Unsaved edit' })
    expect(useEditorStore.getState().currentFile?.id).toBe('second')
  })

  it("doesn't save when there are no unsaved edits", () => {
    const save = vi.fn(() => Promise.resolve())
    useEditorStore.setState({ autoSaveCallback: save, isDirty: false })

    useEditorStore.getState().openFile(fileEntry('second'))

    expect(save).not.toHaveBeenCalled()
  })

  it('keeps unsaved edits when the open file is opened again', () => {
    const save = vi.fn(() => Promise.resolve())
    useEditorStore.setState({ autoSaveCallback: save })

    useEditorStore.getState().openFile(fileEntry('first'))

    expect(save).not.toHaveBeenCalled()
    expect(useEditorStore.getState().editorContent).toBe('Unsaved edit')
    expect(useEditorStore.getState().isDirty).toBe(true)
  })

  // The file content query is cached and the loader only re-runs when the
  // file changes, so clearing the store here would leave the form blank and
  // the next edit would save the blank form over the file
  it('keeps the content when the open, saved file is opened again', () => {
    const save = vi.fn(() => Promise.resolve())
    useEditorStore.setState({
      autoSaveCallback: save,
      editorContent: 'Saved body',
      frontmatter: { title: 'First' },
      rawFrontmatter: 'title: First',
      imports: "import X from './x'",
      isDirty: false,
      isFrontmatterDirty: false,
    })

    useEditorStore.getState().openFile(fileEntry('first'))

    const state = useEditorStore.getState()
    expect(save).not.toHaveBeenCalled()
    expect(state.currentFile?.id).toBe('first')
    expect(state.editorContent).toBe('Saved body')
    expect(state.frontmatter).toEqual({ title: 'First' })
    expect(state.rawFrontmatter).toBe('title: First')
    expect(state.imports).toBe("import X from './x'")
    expect(state.isDirty).toBe(false)
    expect(state.isFrontmatterDirty).toBe(false)
  })

  // A new file can arrive with the renamed file's old name
  it("opens a different file that has the renamed open file's old id", () => {
    useEditorStore.setState({ isDirty: false })
    useEditorStore
      .getState()
      .updateCurrentFileAfterRename('/test/content/blog/renamed.md')

    useEditorStore.getState().openFile(fileEntry('first'))

    const state = useEditorStore.getState()
    expect(state.currentFile?.path).toBe('/test/content/blog/first.md')
    expect(state.editorContent).toBe('')
  })

  it('updates the path, name and id of the open file after a rename', () => {
    useEditorStore.setState({
      currentFile: {
        ...fileEntry('blog/2024/first'),
        path: '/test/content/blog/2024/first.md',
        name: 'first',
      },
    })
    useEditorStore
      .getState()
      .updateCurrentFileAfterRename('/test/content/blog/2024/renamed.md')

    const file = useEditorStore.getState().currentFile
    expect(file?.path).toBe('/test/content/blog/2024/renamed.md')
    expect(file?.name).toBe('renamed')
    expect(file?.id).toBe('blog/2024/renamed')
  })

  it("still selects the file's collection when the open file is opened again", () => {
    const opened = vi.fn()
    window.addEventListener('file-opened', opened)

    useEditorStore.getState().openFile(fileEntry('first'))

    window.removeEventListener('file-opened', opened)
    expect(opened).toHaveBeenCalledTimes(1)
    const event = opened.mock.calls[0]![0] as CustomEvent
    expect(event.detail).toEqual({
      collectionName: 'blog',
    })
  })
})

describe('editorStore field validation messages', () => {
  it('forgets which messages were shown when another file opens', () => {
    useEditorStore.setState({
      currentFile: fileEntry('first'),
      isDirty: false,
      shownFieldErrors: { email: true },
    })

    useEditorStore.getState().openFile(fileEntry('second'))

    expect(useEditorStore.getState().shownFieldErrors).toEqual({})
  })

  it('adds fields to the shown messages', () => {
    useEditorStore.setState({ shownFieldErrors: { email: true } })

    useEditorStore.getState().showFieldErrors(['title', 'email'])

    expect(useEditorStore.getState().shownFieldErrors).toEqual({
      email: true,
      title: true,
    })
  })
})

describe('editorStore.saveFile', () => {
  it('passes on whether the writer asked to save', async () => {
    const save = vi.fn((_showToast?: boolean, _reportFields?: boolean) =>
      Promise.resolve()
    )
    useEditorStore.setState({ autoSaveCallback: save })

    await useEditorStore.getState().saveFile()
    await useEditorStore.getState().saveFile(true, true)

    expect(save).toHaveBeenNthCalledWith(1, true, false)
    expect(save).toHaveBeenNthCalledWith(2, true, true)
  })
})
