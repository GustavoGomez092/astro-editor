import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { commands, type Collection } from '@/lib/bindings'
import { ASTRO_PATHS } from '@/lib/constants'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { reloadProjectFiles } from '@/lib/git/repo-change'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useCommandContext } from '../commands/useCommandContext'
import { useFileChangeHandler } from '../useFileChangeHandler'
import { useCollectionsQuery } from './useCollectionsQuery'
import { useCollectionFileCountsQuery } from './useCollectionFileCountsQuery'
import { useCreateFileMutation } from '../mutations/useCreateFileMutation'

vi.mock('@/lib/bindings', () => ({
  commands: {
    scanProject: vi.fn(),
    scanProjectWithContentDir: vi.fn(),
    countCollectionFilesRecursive: vi.fn(),
    readFileContent: vi.fn(),
    createFile: vi.fn(),
  },
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/project-registry', () => ({
  getEffectiveContentDirectory: () => ASTRO_PATHS.CONTENT_DIR,
}))

const ok = <T,>(data: T) => ({ status: 'ok' as const, data })
const collection = (name: string): Collection => ({
  name,
  path: `/site/src/content/${name}`,
  complete_schema: null,
})
const POSTS = collection('posts')
const NOTES = collection('notes')
const PAGES = collection('pages')

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

/** The sidebar's counts, from the collections as the sidebar reads them. */
function renderCounts() {
  return renderHook(
    () => {
      const collections = useCollectionsQuery('/site', null).data ?? []
      return useCollectionFileCountsQuery('/site', collections)
    },
    { wrapper }
  )
}

describe('useCollectionFileCountsQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient.clear()
    useProjectStore.setState({
      projectPath: '/site',
      currentProjectSettings: null,
      globalSettings: { general: { showPublishingTools: false } } as never,
    })
    useEditorStore.setState({ currentFile: null, isDirty: false })
    vi.mocked(commands.scanProject).mockResolvedValue(ok([POSTS]))
    vi.mocked(commands.countCollectionFilesRecursive).mockResolvedValue(ok(28))
  })
  afterEach(() => {
    queryClient.clear()
  })

  /** How many times a collection's folder has been walked. */
  const walks = (c: Collection) =>
    vi
      .mocked(commands.countCollectionFilesRecursive)
      .mock.calls.filter(([path]) => path === c.path).length

  function fileChanged(path: string, kind: string) {
    window.dispatchEvent(
      new CustomEvent('file-changed', { detail: { path, kind } })
    )
  }

  /** Past the watcher's wait for more events in a burst. */
  const settle = () =>
    act(() => new Promise(resolve => setTimeout(resolve, 600)))

  /** Renders the counts, then deletes a file outside the app. */
  async function countThenDelete() {
    const counts = renderCounts()
    await vi.waitFor(() => expect(counts.result.current).toEqual({ posts: 28 }))
    vi.mocked(commands.countCollectionFilesRecursive).mockResolvedValue(ok(27))
    return counts
  }

  it('counts again when the watcher sees a file go', async () => {
    renderHook(() => useFileChangeHandler())
    const { result } = await countThenDelete()

    act(() => fileChanged(`${POSTS.path}/old.md`, 'Remove(File)'))

    await vi.waitFor(() => expect(result.current).toEqual({ posts: 27 }))
  })

  it("doesn't count again when the watcher only sees files edited", async () => {
    renderHook(() => useFileChangeHandler())
    await countThenDelete()
    expect(walks(POSTS)).toBe(1)

    act(() => {
      for (let i = 0; i < 20; i++) {
        fileChanged(`${POSTS.path}/entry-${i}.md`, 'Modify(Data(Content))')
      }
    })
    await settle()

    expect(walks(POSTS)).toBe(1)
  })

  it('counts each affected collection once after a burst of deletions', async () => {
    vi.mocked(commands.scanProject).mockResolvedValue(ok([POSTS, NOTES, PAGES]))
    renderHook(() => useFileChangeHandler())
    const { result } = renderCounts()
    await vi.waitFor(() =>
      expect(result.current).toEqual({ posts: 28, notes: 28, pages: 28 })
    )

    act(() => {
      for (let i = 0; i < 20; i++) {
        fileChanged(`${POSTS.path}/2024/entry-${i}.md`, 'Remove(File)')
      }
      fileChanged(`${NOTES.path}/note.md`, 'Remove(File)')
    })
    await settle()

    expect([walks(POSTS), walks(NOTES), walks(PAGES)]).toEqual([2, 2, 1])
  })

  it('counts again after creating an entry in the app', async () => {
    const create = renderHook(() => useCreateFileMutation(), { wrapper })
    const { result } = renderCounts()
    await vi.waitFor(() => expect(result.current).toEqual({ posts: 28 }))
    vi.mocked(commands.createFile).mockResolvedValue(ok('new.md'))
    vi.mocked(commands.countCollectionFilesRecursive).mockResolvedValue(ok(29))

    await act(() =>
      create.result.current.mutateAsync({
        directory: POSTS.path,
        filename: 'new.md',
        content: '',
        projectPath: '/site',
        collectionName: 'posts',
      })
    )

    await vi.waitFor(() => expect(result.current).toEqual({ posts: 29 }))
  })

  it('counts again on Reload Collections', async () => {
    const context = renderHook(() => useCommandContext(), { wrapper })
    const { result } = await countThenDelete()

    await act(() => context.result.current.reloadCollections())

    await vi.waitFor(() => expect(result.current).toEqual({ posts: 27 }))
  })

  it('counts again after git rewrites the files (a Sync bringing in a deletion)', async () => {
    const { result } = await countThenDelete()

    await act(() => reloadProjectFiles(queryClient, '/site'))

    await vi.waitFor(() => expect(result.current).toEqual({ posts: 27 }))
  })

  it("counts the new folder when a collection's folder changes", async () => {
    const { result } = renderCounts()
    await vi.waitFor(() => expect(result.current).toEqual({ posts: 28 }))

    // The collection's folder is set elsewhere; the collections come back
    // with the new folder, and nothing else is refreshed
    const moved = { ...POSTS, path: '/site/writing/posts' }
    vi.mocked(commands.scanProject).mockResolvedValue(ok([moved]))
    vi.mocked(commands.countCollectionFilesRecursive).mockImplementation(path =>
      Promise.resolve(ok(path === moved.path ? 3 : 28))
    )
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections('/site'),
        exact: true,
      })
    )

    await vi.waitFor(() => expect(result.current).toEqual({ posts: 3 }))
  })

  it('reads the collection folders set when it scans, not when it rendered', async () => {
    const { result } = renderCounts()
    await vi.waitFor(() => expect(result.current).toEqual({ posts: 28 }))
    vi.mocked(commands.scanProjectWithContentDir).mockResolvedValue(ok([POSTS]))

    useProjectStore.setState({
      currentProjectSettings: {
        pathOverrides: {},
        frontmatterMappings: {},
        collections: [
          {
            name: 'posts',
            settings: { pathOverrides: { contentDirectory: 'writing/posts' } },
          },
        ],
      },
    })
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections('/site'),
      })
    )

    expect(commands.scanProjectWithContentDir).toHaveBeenCalledWith(
      '/site',
      null,
      { posts: 'writing/posts' }
    )
  })
})
