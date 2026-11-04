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
import { isGitBusy } from '../git/busy'
import { waitForSaves } from './pending-saves'
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

/** The file names in the open entry's folder, for finding a free name */
export async function siblingNames(file: FileEntry): Promise<string[]> {
  const directory = file.path.substring(0, file.path.lastIndexOf('/'))
  const scan = await commands.scanDirectory(
    directory,
    file.collection,
    directory
  )
  if (scan.status === 'error') throw new Error(scan.error)
  return scan.data.files.map(f =>
    f.extension ? `${f.name}.${f.extension}` : f.name
  )
}

/** Why nothing happens while git is changing the project's files */
export const GIT_BUSY_MESSAGE = 'Wait for the sync to finish'

let renaming = false

/**
 * Renames the open entry's file to match its title. Saves unsaved edits
 * first; when the frontmatter has a `slug` that is text, sets it to the new
 * name in that save. Says what happened in a toast, including when it did
 * nothing.
 */
export async function renameCurrentFileToTitle(): Promise<void> {
  if (isGitBusy()) {
    toast.warning(GIT_BUSY_MESSAGE)
    return
  }
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

const openFileState = (path: string) => {
  const { currentFile } = useEditorStore.getState()
  return currentFile?.path === path ? currentFile : null
}

async function run(): Promise<void> {
  const file = useEditorStore.getState().currentFile
  const { projectPath } = useProjectStore.getState()
  if (!file || !projectPath) return

  const currentName = fullName(file)
  const directory = file.path.substring(0, file.path.lastIndexOf('/'))
  const titleField = titleFieldName(file.collection)
  const stopped = (description: string) => {
    toast.warning('The file name was not changed', { description })
  }

  // A save that is running now would write the old path again after the rename
  await waitForSaves()
  const names = await siblingNames(file)

  // Save what's unsaved (the slug is left alone: nothing about it is written
  // until the file has its new name). The title may change while saving, so
  // the name is worked out again after each save until it holds still
  let newName: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!openFileState(file.path))
      return stopped('Another entry was opened first.')
    const { frontmatter, isDirty } = useEditorStore.getState()
    const target = renameTargetFor(frontmatter[titleField], currentName, names)
    if (!target) {
      if (newName) return stopped('The title changed back.')
      toast.info('The file name already matches the title')
      return
    }
    if (target === newName && !isDirty) break
    newName = target
    if (!isDirty) break

    const failuresBefore = useEditorStore.getState().saveFailures
    await useEditorStore.getState().saveFile(false)
    await waitForSaves()
    // A failed save has told the writer why; the file keeps its name
    if (useEditorStore.getState().saveFailures !== failuresBefore) return
  }
  if (!newName) return
  if (!openFileState(file.path))
    return stopped('Another entry was opened first.')
  if (isGitBusy()) return stopped(GIT_BUSY_MESSAGE)

  const newPath = `${directory}/${newName}`
  const result = await commands.renameFile(file.path, newPath, projectPath)
  if (result.status === 'error') throw new Error(result.error)

  useEditorStore.getState().updateCurrentFileAfterRename(newPath)
  // The old id has no entry any more; A to B and back to A must not show B's
  // content from the cache
  queryClient.removeQueries({
    queryKey: queryKeys.fileContent(projectPath, file.id),
  })
  void queryClient.invalidateQueries({
    queryKey: [...queryKeys.all, projectPath, file.collection, 'directory'],
  })
  void queryClient.invalidateQueries({
    queryKey: queryKeys.collectionFiles(projectPath, file.collection),
  })

  // Now the slug, saved at the new path. If that save fails the form keeps
  // the new slug unsaved, and auto-save tries again
  const { frontmatter } = useEditorStore.getState()
  const withSlug = withSlugField(frontmatter, newName)
  if (withSlug === frontmatter) {
    toast.success(`Renamed to ${newName}`)
    return
  }
  useEditorStore.getState().updateFrontmatterField('slug', withSlug.slug)
  const failuresBefore = useEditorStore.getState().saveFailures
  await useEditorStore.getState().saveFile(false)
  await waitForSaves()
  if (useEditorStore.getState().saveFailures !== failuresBefore) {
    toast.warning(`Renamed to ${newName}`, {
      description: 'The slug was not saved yet. It will be saved again soon.',
    })
  } else {
    toast.success(`Renamed to ${newName}`)
  }
}

/**
 * Opens `file` and renames it once its form has loaded. For the sidebar's
 * menu, which can be used on any entry in the list.
 */
export async function openAndRenameToTitle(file: FileEntry): Promise<void> {
  if (isGitBusy()) {
    toast.warning(GIT_BUSY_MESSAGE)
    return
  }
  useEditorStore.getState().openFile(file)
  const loaded = () => {
    const s = useEditorStore.getState()
    return s.currentFile?.path === file.path && s.frontmatterBaseline !== null
  }
  for (let i = 0; i < 40 && !loaded(); i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!loaded()) {
    toast.error('Couldn’t open the entry to rename it')
    return
  }
  await renameCurrentFileToTitle()
}
