import { useQueries } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'
import { shortTitle } from '@/lib/git/messages'
import { getCollectionSettings } from '@/lib/project-registry'
import { queryKeys } from '@/lib/query-keys'
import { useProjectStore } from '../../store/projectStore'
import { fetchCollectionFiles } from './useCollectionFilesQuery'
import { useCollectionsQuery } from './useCollectionsQuery'

export interface EntryLookup {
  /**
   * The entry's title for a repository-relative path, when it's known,
   * shortened to 40 characters for lists and messages
   */
  titleFor: (path: string) => string | undefined
  /** The whole title, for the Publish message */
  fullTitleFor: (path: string) => string | undefined
  /** Whether a repository-relative path is a Markdown file in a collection */
  isEntry: (path: string) => boolean
}

/**
 * Entry titles for repository-relative paths (changed files, or files a git
 * message mentions), for the Publish message, the file list and messages.
 * Reads the same per-collection file lists as the entry pickers, and only for
 * collections those paths are in.
 */
export function useEntryLookup(
  projectPath: string | null,
  paths: string[]
): EntryLookup {
  const settings = useProjectStore(
    useShallow(state => state.currentProjectSettings)
  )
  const { data: collections = [] } = useCollectionsQuery(projectPath, settings)
  const root = (projectPath ?? '').replace(/\/+$/, '')
  const absolute = (path: string) => `${root}/${path}`
  const inCollection = (path: string) =>
    collections.find(collection =>
      absolute(path).startsWith(`${collection.path}/`)
    )
  const touched = collections.filter(collection =>
    paths.some(path => absolute(path).startsWith(`${collection.path}/`))
  )

  const results = useQueries({
    queries: touched.map(collection => ({
      queryKey: queryKeys.collectionFiles(
        projectPath ?? '',
        collection.name,
        collection.path
      ),
      queryFn: () => fetchCollectionFiles(collection.path, collection.name),
    })),
  })

  const titles = new Map<string, string>()
  touched.forEach((collection, index) => {
    const titleField = getCollectionSettings(settings, collection.name)
      .frontmatterMappings.title
    for (const entry of results[index]?.data ?? []) {
      // A real title only: never the file name in its place
      const title = entry.frontmatter?.[titleField]
      if (typeof title === 'string' && title.trim()) {
        titles.set(entry.path, title.trim())
      }
    }
  })

  return {
    titleFor: path => {
      const title = titles.get(absolute(path))
      return title === undefined ? undefined : shortTitle(title)
    },
    fullTitleFor: path => titles.get(absolute(path)),
    // Only Markdown files are entries: images kept next to them are assets
    isEntry: path => /\.mdx?$/i.test(path) && inCollection(path) !== undefined,
  }
}
