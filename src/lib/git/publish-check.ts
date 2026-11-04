import type { QueryClient } from '@tanstack/react-query'
import type { ChangedFile } from '@/lib/bindings'
import { commands, type Collection, type FileEntry } from '@/types'
import { validateFrontmatter } from '@/lib/frontmatter-validation'
import { getCollectionSettings } from '@/lib/project-registry'
import { queryKeys } from '@/lib/query-keys'
import { deserializeCompleteSchema } from '@/lib/schema'
import { useEditorStore } from '@/store/editorStore'
import { useProjectStore } from '@/store/projectStore'
import { shortTitle } from './messages'
import { unwrap } from './unwrap'

/** A changed entry with fields its schema rejects. */
export interface EntryNeedingAttention {
  /** Repository-relative */
  path: string
  /** The entry, to open it for review (null if it isn't listed yet) */
  entry: FileEntry | null
  /** Its title, shortened for messages */
  title: string | null
  /** The fields that need attention, by name */
  fields: string[]
}

/**
 * The changed entries whose frontmatter fails the collection's schema, as the
 * form's own validation sees it (`validateFrontmatter`). The open file is
 * checked as it is in the editor; others as their collection's file list has
 * them. Deleted files, assets and entries of collections without a schema are
 * skipped. Publish asks before going ahead, but never refuses.
 */
export async function entriesNeedingAttention(
  queryClient: QueryClient,
  projectPath: string,
  files: ChangedFile[]
): Promise<EntryNeedingAttention[]> {
  const collections =
    queryClient.getQueryData<Collection[]>(
      queryKeys.collections(projectPath)
    ) ?? []
  const root = projectPath.replace(/\/+$/, '')
  const settings = useProjectStore.getState().currentProjectSettings
  const editor = useEditorStore.getState()
  const found: EntryNeedingAttention[] = []

  for (const file of files) {
    if (file.change === 'deleted' || !/\.mdx?$/i.test(file.path)) continue
    const absolute = `${root}/${file.path}`
    // The innermost collection holding the file, when one's folder is inside
    // another's
    const collection = collections
      .filter(c => absolute.startsWith(`${c.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const fields = collection?.complete_schema
      ? deserializeCompleteSchema(collection.complete_schema)?.fields
      : undefined
    if (!collection || !fields) continue

    const entries = await queryClient.ensureQueryData({
      queryKey: queryKeys.collectionFiles(projectPath, collection.name),
      // The same query as useCollectionFilesQuery, usually cached already
      queryFn: () =>
        unwrap(
          commands.scanCollectionFilesRecursive(
            collection.path,
            collection.name
          )
        ),
    })
    const entry = entries.find(e => e.path === absolute) ?? null
    const frontmatter =
      editor.currentFile?.path === absolute
        ? editor.frontmatter
        : (entry?.frontmatter ?? {})
    const names = Object.keys(validateFrontmatter(fields, frontmatter))
    if (names.length === 0) continue

    const titleField = getCollectionSettings(settings, collection.name)
      .frontmatterMappings.title
    const title = frontmatter[titleField]
    found.push({
      path: file.path,
      entry,
      title:
        typeof title === 'string' && title.trim()
          ? shortTitle(title.trim())
          : null,
      fields: names,
    })
  }
  return found
}

/**
 * "2 fields in “Jordan Ellis” need attention. Publish anyway?", or for
 * several entries "4 fields in 2 entries need attention. Publish anyway?"
 */
export function publishCheckMessage(problems: EntryNeedingAttention[]): string {
  const count = problems.reduce((sum, p) => sum + p.fields.length, 0)
  const fields = count === 1 ? '1 field' : `${count} fields`
  const verb = count === 1 ? 'needs' : 'need'
  const where =
    problems.length === 1
      ? problems[0]!.title
        ? `“${problems[0]!.title}”`
        : 'an entry'
      : `${problems.length} entries`
  return `${fields} in ${where} ${verb} attention. Publish anyway?`
}
