import { useQueries } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'
import type { ChangedFile } from '@/lib/bindings'
import { getTitle } from '@/lib/files/sorting'
import { getCollectionSettings } from '@/lib/project-registry'
import { queryKeys } from '@/lib/query-keys'
import { useProjectStore } from '../../store/projectStore'
import { fetchCollectionFiles } from './useCollectionFilesQuery'
import { useCollectionsQuery } from './useCollectionsQuery'

/**
 * Titles of the content entries among the changed files, keyed by absolute
 * path, for the pre-filled Publish message. Reads the same per-collection file
 * lists as the entry pickers, and only for collections with changes.
 */
export function useChangedEntryTitles(
  projectPath: string | null,
  files: ChangedFile[]
): Map<string, string> {
  const settings = useProjectStore(
    useShallow(state => state.currentProjectSettings)
  )
  const { data: collections = [] } = useCollectionsQuery(projectPath, settings)
  const root = (projectPath ?? '').replace(/\/+$/, '')
  const changed = files.map(file => `${root}/${file.path}`)
  const touched = collections.filter(collection =>
    changed.some(path => path.startsWith(`${collection.path}/`))
  )

  const results = useQueries({
    queries: touched.map(collection => ({
      queryKey: queryKeys.collectionFiles(projectPath ?? '', collection.name),
      queryFn: () => fetchCollectionFiles(collection.path, collection.name),
    })),
  })

  const titles = new Map<string, string>()
  touched.forEach((collection, index) => {
    const titleField = getCollectionSettings(settings, collection.name)
      .frontmatterMappings.title
    for (const entry of results[index]?.data ?? []) {
      titles.set(entry.path, getTitle(entry, titleField))
    }
  })
  return titles
}
