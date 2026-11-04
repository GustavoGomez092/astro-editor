import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { commands, type Collection } from '@/lib/bindings'
import { ASTRO_PATHS } from '@/lib/constants'
import { queryClient } from '@/lib/query-client'
import { reloadProjectFiles } from '@/lib/git/repo-change'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useCommandContext } from '../commands/useCommandContext'
import { useFileChangeHandler } from '../useFileChangeHandler'
import { useCollectionsQuery } from './useCollectionsQuery'
import { useCollectionFileCountsQuery } from './useCollectionFileCountsQuery'

vi.mock('@/lib/bindings', () => ({
  commands: {
    scanProject: vi.fn(),
    countCollectionFilesRecursive: vi.fn(),
    readFileContent: vi.fn(),
  },
}))

vi.mock('@/lib/project-registry', () => ({
  getEffectiveContentDirectory: () => ASTRO_PATHS.CONTENT_DIR,
}))

const ok = <T,>(data: T) => ({ status: 'ok' as const, data })
const POSTS: Collection = {
  name: 'posts',
  path: '/site/src/content/posts',
  complete_schema: null,
}

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

    act(() => {
      window.dispatchEvent(
        new CustomEvent('file-changed', {
          detail: { path: `${POSTS.path}/old.md`, kind: 'Remove(File)' },
        })
      )
    })

    await vi.waitFor(() => expect(result.current).toEqual({ posts: 27 }))
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
})
