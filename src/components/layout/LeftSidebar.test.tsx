import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@/test/test-utils'
import { useProjectStore } from '@/store/projectStore'
import { useEditorStore } from '@/store/editorStore'
import type { Collection, FileEntry } from '@/types'
import { LeftSidebar } from './LeftSidebar'
import { fetchCollectionFiles } from '../../hooks/queries/useCollectionFilesQuery'

const collections: Collection[] = [
  { name: 'hero', path: '/site/src/content/hero', complete_schema: null },
  {
    name: 'projects',
    path: '/site/src/content/projects',
    complete_schema: null,
  },
]
const entry = (collection: string, name: string): FileEntry => ({
  id: `${collection}/${name}`,
  path: `/site/src/content/${collection}/${name}.md`,
  name,
  extension: 'md',
  collection,
  last_modified: null,
  frontmatter: { title: name },
})
const files: Record<string, FileEntry[]> = {
  hero: [entry('hero', 'index')],
  projects: [entry('projects', 'one'), entry('projects', 'two')],
}

vi.mock('../../hooks/queries/useCollectionsQuery', () => ({
  useCollectionsQuery: () => ({ data: collections }),
}))
vi.mock('../../hooks/queries/useCollectionFileCountsQuery', () => ({
  useCollectionFileCountsQuery: () => ({ hero: 1, projects: 2 }),
}))
vi.mock('../../hooks/queries/useDirectoryScanQuery', () => ({
  useDirectoryScanQuery: (_: unknown, collection: string | null) => ({
    data: { files: collection ? files[collection] : [], subdirectories: [] },
    refetch: vi.fn(),
    isLoading: false,
    isError: false,
    error: null,
  }),
}))
vi.mock('../../hooks/queries/useCollectionFilesQuery', () => ({
  fetchCollectionFiles: vi.fn((_: string, collection: string) =>
    Promise.resolve(files[collection] ?? [])
  ),
}))
vi.mock('../../hooks/queries/useGitStatusQuery', () => ({
  useGitStatusQuery: () => ({ data: undefined }),
}))
vi.mock('../../hooks/settings/useShowPublishingTools', () => ({
  useShowPublishingTools: () => false,
}))

describe('LeftSidebar collections', () => {
  const openFile = vi.fn()

  beforeEach(() => {
    openFile.mockReset()
    vi.mocked(fetchCollectionFiles).mockClear()
    useProjectStore.setState({
      projectPath: '/site',
      selectedCollection: null,
      currentSubdirectory: null,
    })
    useEditorStore.setState({ currentFile: null, openFile })
  })

  it('opens the entry of a collection with exactly one', async () => {
    renderWithProviders(<LeftSidebar />)

    fireEvent.click(screen.getByText('Hero'))

    await waitFor(() => expect(openFile).toHaveBeenCalledWith(files.hero![0]))
    expect(useProjectStore.getState().selectedCollection).toBe('hero')
  })

  it('shows the list of a collection with more than one entry', async () => {
    renderWithProviders(<LeftSidebar />)

    fireEvent.click(screen.getByText('Projects'))

    expect(useProjectStore.getState().selectedCollection).toBe('projects')
    expect(await screen.findByText('one')).toBeInTheDocument()
    expect(fetchCollectionFiles).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('goes back to the collections list from a one-entry collection', async () => {
    renderWithProviders(<LeftSidebar />)
    fireEvent.click(screen.getByText('Hero'))
    await waitFor(() => expect(openFile).toHaveBeenCalled())

    fireEvent.click(screen.getByTitle('Back'))

    expect(useProjectStore.getState().selectedCollection).toBeNull()
    expect(screen.getByText('Projects')).toBeInTheDocument()
  })
})
