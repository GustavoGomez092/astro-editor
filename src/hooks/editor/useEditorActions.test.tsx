import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEditorActions } from './useEditorActions'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { queryKeys } from '../../lib/query-keys'
import { toast } from '../../lib/toast'
import type { Collection, FileEntry } from '@/types'

vi.mock('../../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const fileEntry = (id: string): FileEntry => ({
  id,
  name: `${id}.md`,
  path: `/test/content/blog/${id}.md`,
  extension: 'md',
  collection: 'blog',
  last_modified: null,
  frontmatter: null,
})

function renderActions() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useEditorActions(), { wrapper }).result.current
}

/** Makes save_markdown_content wait until the returned function is called. */
function holdSave(outcome: 'resolve' | 'reject') {
  let release = () => {}
  globalThis.mockTauri.invoke.mockImplementation((cmd: string) => {
    if (cmd !== 'save_markdown_content') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      release = () =>
        outcome === 'resolve' ? resolve(null) : reject(new Error('disk full'))
    })
  })
  return () => release()
}

/** Opens another file the way openFile leaves the store, without saving. */
function switchToSecondFile() {
  useEditorStore.setState({
    currentFile: fileEntry('second'),
    editorContent: 'Second file',
    frontmatter: {},
    isDirty: false,
  })
}

describe('useEditorActions.saveFile when the file changes mid-save', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    useProjectStore.setState({ projectPath: '/test' })
    useEditorStore.setState({
      currentFile: fileEntry('first'),
      editorContent: 'First file edit',
      frontmatter: { title: 'First' },
      rawFrontmatter: 'title: First',
      imports: '',
      isDirty: true,
      isFrontmatterDirty: false,
      autoSaveTimeoutId: null,
    })
  })

  it("leaves the newly opened file's state alone", async () => {
    const release = holdSave('resolve')
    const { saveFile } = renderActions()

    const saving = saveFile(false)
    switchToSecondFile()
    release()
    await saving

    expect(useEditorStore.getState().currentFile?.id).toBe('second')
    expect(useEditorStore.getState().isDirty).toBe(false)
  })

  it('keeps recovery data for the file that failed, not the open one', async () => {
    const release = holdSave('reject')
    const { saveFile } = renderActions()

    const saving = saveFile(false)
    switchToSecondFile()
    release()
    await saving

    const recoveryCall = globalThis.mockTauri.invoke.mock.calls.find(
      ([cmd]) => cmd === 'save_recovery_data'
    )
    expect(recoveryCall).toBeDefined()
    const { data: recovery } = recoveryCall![1] as {
      data: { originalFilePath: string; editorContent: string }
    }
    expect(recovery.originalFilePath).toBe('/test/content/blog/first.md')
    expect(recovery.editorContent).toBe('First file edit')
    expect(useEditorStore.getState().isDirty).toBe(false)
  })
})

describe('useEditorActions.saveFile when the same file changes mid-save', () => {
  beforeEach(() => {
    globalThis.mockTauri.reset()
    useProjectStore.setState({ projectPath: '/test' })
    useEditorStore.setState({
      currentFile: fileEntry('first'),
      editorContent: 'Body',
      frontmatter: {},
      rawFrontmatter: '',
      imports: '',
      isDirty: true,
      isFrontmatterDirty: false,
      autoSaveTimeoutId: null,
    })
  })

  it('stays dirty when an import is added during the save', async () => {
    const release = holdSave('resolve')
    const { saveFile } = renderActions()

    const saving = saveFile(false)
    useEditorStore.getState().setImports("import A from './a'")
    release()
    await saving

    // Marked clean, the reload from disk would put back the old imports
    expect(useEditorStore.getState().isDirty).toBe(true)
  })
})

describe('useEditorActions.saveFile with fields that need attention', () => {
  const collection = {
    name: 'blog',
    path: '/test/content/blog',
    complete_schema: JSON.stringify({
      collectionName: 'blog',
      fields: [
        { name: 'title', label: 'Title', fieldType: 'string', required: true },
        { name: 'email', label: 'Email', fieldType: 'email', required: true },
        { name: 'note', label: 'Note', fieldType: 'string', required: false },
      ],
    }),
  } as Collection

  function renderWithSchema() {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.collections('/test'), [collection])
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return renderHook(() => useEditorActions(), { wrapper }).result.current
  }

  beforeEach(() => {
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.warning).mockClear()
    globalThis.mockTauri.reset()
    globalThis.mockTauri.invoke.mockResolvedValue(null)
    useProjectStore.setState({ projectPath: '/test' })
    useEditorStore.setState({
      currentFile: fileEntry('first'),
      editorContent: 'Body',
      frontmatter: { email: 'nope' },
      rawFrontmatter: 'email: nope',
      imports: '',
      isDirty: true,
      isFrontmatterDirty: true,
      autoSaveTimeoutId: null,
      shownFieldErrors: {},
    })
  })

  it('saves, warns how many fields need attention and shows their messages', async () => {
    const { saveFile } = renderWithSchema()

    await saveFile(true)

    const saved = globalThis.mockTauri.invoke.mock.calls.some(
      ([cmd]) => cmd === 'save_markdown_content'
    )
    expect(saved).toBe(true)
    expect(toast.warning).toHaveBeenCalledWith(
      'Saved, but 2 fields need attention'
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(useEditorStore.getState().shownFieldErrors).toEqual({
      title: true,
      email: true,
    })
  })

  it("says nothing on an auto-save, so fields the writer hasn't reached stay quiet", async () => {
    const { saveFile } = renderWithSchema()

    await saveFile(false)

    expect(toast.warning).not.toHaveBeenCalled()
    expect(useEditorStore.getState().shownFieldErrors).toEqual({})
  })

  it('shows the usual toast when every field is fine', async () => {
    useEditorStore.setState({
      frontmatter: { title: 'Hello', email: 'kevin@example.com' },
    })
    const { saveFile } = renderWithSchema()

    await saveFile(true)

    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('File saved successfully')
  })

  // Auto-save usually gets there first, so Cmd+S often finds the file saved
  it('reports the fields on an explicit save of a saved file, without rewriting it', async () => {
    useEditorStore.setState({ isDirty: false, isFrontmatterDirty: false })
    const { saveFile } = renderWithSchema()

    await saveFile(true)

    const wrote = globalThis.mockTauri.invoke.mock.calls.some(
      ([cmd]) => cmd === 'save_markdown_content'
    )
    expect(wrote).toBe(false)
    expect(toast.warning).toHaveBeenCalledWith(
      'Saved, but 2 fields need attention'
    )
    expect(useEditorStore.getState().shownFieldErrors).toEqual({
      title: true,
      email: true,
    })
  })

  it('says nothing on an explicit save of a saved file that is fine', async () => {
    useEditorStore.setState({
      isDirty: false,
      frontmatter: { title: 'Hello', email: 'kevin@example.com' },
    })
    const { saveFile } = renderWithSchema()

    await saveFile(true)

    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
