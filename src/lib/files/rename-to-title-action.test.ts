import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '@/types'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { queryClient } from '../query-client'
import { queryKeys } from '../query-keys'
import { GIT_CHANGE_MUTATION_KEY } from '../git/repo-change'

const { scanDirectory, renameFile, toast } = vi.hoisted(() => ({
  scanDirectory: vi.fn(),
  renameFile: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/bindings', () => ({
  commands: { scanDirectory, renameFile },
}))
vi.mock('../toast', () => ({ toast }))

import {
  canRenameToTitle,
  nameForTitle,
  renameCurrentFileToTitle,
} from './rename-to-title-action'

const file = (name: string): FileEntry => ({
  id: `blog/${name}`,
  name,
  path: `/site/blog/${name}.md`,
  extension: 'md',
  collection: 'blog',
  last_modified: null,
  frontmatter: null,
})

const siblings = (...names: string[]) => ({
  status: 'ok',
  data: {
    files: names.map(name => ({ name, extension: 'md' })),
    subdirectories: [],
  },
})

describe('canRenameToTitle', () => {
  it('is offered when the name no longer follows the title', () => {
    expect(canRenameToTitle(file('old-name'), 'A New Title')).toBe(true)
  })

  it('is not offered when the name already follows the title', () => {
    expect(canRenameToTitle(file('new-title'), 'New Title')).toBe(false)
  })

  it('is not offered without a title, or without an open entry', () => {
    expect(canRenameToTitle(file('old'), '')).toBe(false)
    expect(canRenameToTitle(file('old'), undefined)).toBe(false)
    expect(canRenameToTitle(file('old'), '   ')).toBe(false)
    expect(canRenameToTitle(file('old'), '!!!')).toBe(false)
    expect(canRenameToTitle(null, 'Title Here')).toBe(false)
  })
})

describe('nameForTitle', () => {
  it('keeps the extension', () => {
    expect(nameForTitle(file('old'), 'Fresh Title')).toBe('fresh-title.md')
  })
})

describe('renameCurrentFileToTitle', () => {
  const save = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projectPath: '/site',
      currentProjectSettings: null,
    })
    save.mockImplementation(() => {
      useEditorStore.setState({ isDirty: false })
      return Promise.resolve()
    })
    renameFile.mockResolvedValue({ status: 'ok', data: null })
    useEditorStore.setState({
      currentFile: file('old-name'),
      frontmatter: { title: 'Fresh Title' },
      isDirty: false,
      autoSaveCallback: save,
      saveFailures: 0,
    })
  })

  it('renames the file, updates the open entry and says so', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name', 'other'))

    await renameCurrentFileToTitle()

    expect(renameFile).toHaveBeenCalledWith(
      '/site/blog/old-name.md',
      '/site/blog/fresh-title.md',
      '/site'
    )
    const current = useEditorStore.getState().currentFile
    expect(current?.path).toBe('/site/blog/fresh-title.md')
    expect(current?.id).toBe('blog/fresh-title')
    expect(toast.success).toHaveBeenCalledWith('Renamed to fresh-title.md')
    expect(save).not.toHaveBeenCalled()
  })

  it('adds a number when the name is taken', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name', 'fresh-title'))

    await renameCurrentFileToTitle()

    expect(renameFile).toHaveBeenCalledWith(
      '/site/blog/old-name.md',
      '/site/blog/fresh-title-1.md',
      '/site'
    )
  })

  it('saves unsaved edits without the slug, renames, then saves the slug at the new path', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({
      frontmatter: { title: 'Fresh Title', slug: 'old-name' },
      isDirty: true,
    })
    const order: string[] = []
    save.mockImplementation(() => {
      const { frontmatter, currentFile } = useEditorStore.getState()
      order.push(`save:${String(frontmatter.slug)}@${currentFile?.name}`)
      useEditorStore.setState({ isDirty: false })
      return Promise.resolve()
    })
    renameFile.mockImplementation(() => {
      order.push('rename')
      return Promise.resolve({ status: 'ok', data: null })
    })

    await renameCurrentFileToTitle()

    expect(order).toEqual([
      'save:old-name@old-name',
      'rename',
      'save:fresh-title@fresh-title',
    ])
    expect(toast.success).toHaveBeenCalledWith('Renamed to fresh-title.md')
  })

  it('keeps the new slug unsaved, and says so, when its save fails', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({
      frontmatter: { title: 'Fresh Title', slug: 'old-name' },
    })
    save.mockImplementation(() => {
      useEditorStore.setState({ saveFailures: 1 })
      return Promise.resolve()
    })

    await renameCurrentFileToTitle()

    expect(renameFile).toHaveBeenCalled()
    expect(useEditorStore.getState().currentFile?.name).toBe('fresh-title')
    expect(useEditorStore.getState().frontmatter.slug).toBe('fresh-title')
    expect(toast.warning).toHaveBeenCalledWith(
      'Renamed to fresh-title.md',
      expect.objectContaining({
        description: expect.stringContaining('slug'),
      })
    )
  })

  it('leaves the slug alone when the rename fails', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({
      frontmatter: { title: 'Fresh Title', slug: 'old-name' },
    })
    renameFile.mockResolvedValue({ status: 'error', error: 'exists' })

    await renameCurrentFileToTitle()

    expect(useEditorStore.getState().frontmatter.slug).toBe('old-name')
    expect(save).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it('does not add a slug to an entry that has none', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))

    await renameCurrentFileToTitle()

    expect(useEditorStore.getState().frontmatter).toEqual({
      title: 'Fresh Title',
    })
  })

  it('does nothing when the title is empty', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({ frontmatter: {} })

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('keeps the name when the save fails', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({ isDirty: true })
    save.mockImplementation(() => {
      useEditorStore.setState({ saveFailures: 1 })
      return Promise.resolve()
    })

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
  })

  it('tells the writer when the rename fails', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    renameFile.mockResolvedValue({ status: 'error', error: 'nope' })

    await renameCurrentFileToTitle()

    expect(toast.error).toHaveBeenCalled()
    expect(useEditorStore.getState().currentFile?.path).toBe(
      '/site/blog/old-name.md'
    )
  })

  it('says so when the name already matches', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({ frontmatter: { title: 'Old Name' } })

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalled()
  })

  it('does nothing, and says why, while git is changing files', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: GIT_CHANGE_MUTATION_KEY,
      mutationFn: () => new Promise(() => {}),
    })
    void mutation.execute(undefined).catch(() => {})
    await Promise.resolve()

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('Wait for the sync to finish')
    queryClient.getMutationCache().clear()
  })

  it('uses the title as it is after the save, not before', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({
      frontmatter: { title: 'Fresh Title', slug: 'old-name' },
      isDirty: true,
    })
    save.mockImplementationOnce(() => {
      // a keystroke lands while the save runs
      useEditorStore.setState({
        frontmatter: { title: 'Fresher Title', slug: 'fresh-title' },
        isDirty: false,
      })
      return Promise.resolve()
    })

    await renameCurrentFileToTitle()

    expect(renameFile.mock.calls[0]![1]).toBe('/site/blog/fresher-title.md')
  })

  it('says so when another entry is opened before the rename', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({ isDirty: true })
    save.mockImplementation(() => {
      useEditorStore.setState({
        currentFile: file('elsewhere'),
        isDirty: false,
      })
      return Promise.resolve()
    })

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalled()
  })

  it('leaves the slug alone when it stops before renaming', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({
      frontmatter: { title: 'Fresh Title', slug: 'old-name' },
      isDirty: true,
    })
    save.mockImplementation(() => {
      useEditorStore.setState({ saveFailures: 1 })
      return Promise.resolve()
    })

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().frontmatter.slug).toBe('old-name')
  })

  it('stops when git becomes busy during the save, before renaming', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    useEditorStore.setState({ isDirty: true })
    save.mockImplementation(() => {
      const mutation = queryClient.getMutationCache().build(queryClient, {
        mutationKey: GIT_CHANGE_MUTATION_KEY,
        mutationFn: () => new Promise(() => {}),
      })
      void mutation.execute(undefined).catch(() => {})
      useEditorStore.setState({ isDirty: false })
      return Promise.resolve()
    })

    await renameCurrentFileToTitle()

    expect(renameFile).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalled()
    queryClient.getMutationCache().clear()
  })

  it('forgets the old id’s cached content after the rename', async () => {
    scanDirectory.mockResolvedValue(siblings('old-name'))
    const key = queryKeys.fileContent('/site', 'blog/old-name')
    queryClient.setQueryData(key, { content: 'old' })

    await renameCurrentFileToTitle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
  })
})
