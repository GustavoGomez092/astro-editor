// "Rename to match title": renames the open entry's file to follow its title.
// A plain async function, so the form, the command palette and the sidebar's
// menu share it. It never runs by itself: the writer asks for it.

import { commands } from '@/lib/bindings'
import { queryKeys } from '../query-keys'
import { queryClient } from '../query-client'
import { toast } from '../toast'
import { getEffectiveSettings } from '../project-registry/effective-settings'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import type { FileEntry } from '@/types'
import { slugFromTitle } from '../slug'
import {
  fileNameMatchesTitle,
  renameTargetFor,
  titleText,
  withSlugField,
} from './rename-to-title'

export const fullName = (file: FileEntry) =>
  file.extension ? `${file.name}.${file.extension}` : file.name

/** The name of the frontmatter field that holds the title (usually `title`) */
function titleFieldName(collection: string): string {
  return getEffectiveSettings(
    useProjectStore.getState().currentProjectSettings,
    collection
  ).frontmatterMappings.title
}

/** The open entry's title as it is now in the form */
export function titleOf(
  file: FileEntry,
  frontmatter: Record<string, unknown>
): unknown {
  return frontmatter[titleFieldName(file.collection)]
}

/**
 * Whether the file's name no longer follows its title: there is a title with
 * letters or digits in it, and the name isn't its slug.
 */
export function canRenameToTitle(file: FileEntry | null, title: unknown) {
  return (
    file !== null &&
    titleText(title) !== '' &&
    !fileNameMatchesTitle(title, fullName(file))
  )
}

/** The name the file will get, before a clash adds a number */
export function nameForTitle(file: FileEntry, title: unknown): string {
  const slug = slugFromTitle(titleText(title))
  return file.extension ? `${slug}.${file.extension}` : slug
}

let renaming = false

/**
 * Renames the open entry's file to match its title. Saves unsaved edits
 * first; when the frontmatter has a `slug` that is text, sets it to the new
 * name in that save. Says what happened in a toast.
 */
export async function renameCurrentFileToTitle(): Promise<void> {
  if (renaming) return
  renaming = true
  try {
    await run()
  } catch (error) {
    toast.error('Couldn’t rename the file', {
      description: error instanceof Error ? error.message : String(error),
    })
  } finally {
    renaming = false
  }
}

async function run(): Promise<void> {
  const editor = useEditorStore.getState()
  const file = editor.currentFile
  const { projectPath } = useProjectStore.getState()
  if (!file || !projectPath) return

  const currentName = fullName(file)
  const directory = file.path.substring(0, file.path.lastIndexOf('/'))
  const title = editor.frontmatter[titleFieldName(file.collection)]

  const scan = await commands.scanDirectory(
    directory,
    file.collection,
    directory
  )
  if (scan.status === 'error') throw new Error(scan.error)
  const siblings = scan.data.files.map(f =>
    f.extension ? `${f.name}.${f.extension}` : f.name
  )

  const newName = renameTargetFor(title, currentName, siblings)
  if (!newName) return

  // The slug goes in the same save as any other unsaved edit
  const withSlug = withSlugField(editor.frontmatter, newName)
  if (withSlug !== editor.frontmatter) {
    useEditorStore.getState().updateFrontmatterField('slug', withSlug.slug)
  }
  if (useEditorStore.getState().isDirty) {
    const failuresBefore = useEditorStore.getState().saveFailures
    await useEditorStore.getState().saveFile(false)
    // A failed save has told the writer why; the file keeps its name
    if (useEditorStore.getState().saveFailures !== failuresBefore) return
  }

  // The writer may have opened another entry while this was saving
  if (useEditorStore.getState().currentFile?.path !== file.path) return

  const newPath = `${directory}/${newName}`
  const result = await commands.renameFile(file.path, newPath, projectPath)
  if (result.status === 'error') throw new Error(result.error)

  useEditorStore.getState().updateCurrentFileAfterRename(newPath)
  void queryClient.invalidateQueries({
    queryKey: [...queryKeys.all, projectPath, file.collection, 'directory'],
  })
  void queryClient.invalidateQueries({
    queryKey: queryKeys.collectionFiles(projectPath, file.collection),
  })
  toast.success(`Renamed to ${newName}`)
}

/**
 * Opens `file` and renames it once its form has loaded. For the sidebar's
 * menu, which can be used on any entry in the list.
 */
export async function openAndRenameToTitle(file: FileEntry): Promise<void> {
  useEditorStore.getState().openFile(file)
  const loaded = () => {
    const s = useEditorStore.getState()
    return s.currentFile?.path === file.path && s.frontmatterBaseline !== null
  }
  for (let i = 0; i < 40 && !loaded(); i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!loaded()) return
  await renameCurrentFileToTitle()
}
