import { useCallback, useRef, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { commands, type Collection, type DirectoryScanResult } from '@/types'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useCollectionsQuery } from './queries/useCollectionsQuery'
import {
  useCreateFileMutation,
  type CreateFilePayload,
} from './mutations/useCreateFileMutation'
import { deserializeCompleteSchema } from '../lib/schema'
import { toast } from '../lib/toast'
import { todayIsoDate } from '../lib/dates'
import { getDefaultFileType } from '../lib/project-registry/default-file-type'
import {
  buildNewFileFrontmatter,
  newFileContent,
  newFileName,
  newFileTitlePlaceholder,
} from '../lib/files/new-file'
import { focusNewFile } from '../lib/files/focus-new-file'

/**
 * Creates a file named after `title` (or today's date when there's none) in
 * the folder open in the sidebar, with frontmatter from the collection's
 * schema (see `lib/files/new-file.ts`), then opens it and focuses the editor,
 * the title field when no title was given, or the first field when the
 * collection hides the body editor (`focusNewFile`). Plain function rather than
 * inline in the hook so the React Compiler can compile the hook (it can't
 * handle `throw` inside `try`).
 */
async function createFileInCurrentFolder(
  collections: Collection[],
  createFile: (payload: CreateFilePayload) => Promise<unknown>,
  title: string
): Promise<void> {
  // Get current values from store state
  const { selectedCollection, currentSubdirectory } = useProjectStore.getState()
  const currentProjectPath = useProjectStore.getState().projectPath

  if (!selectedCollection || !currentProjectPath) {
    toast.error('No collection selected')
    return
  }

  const collection = collections.find(c => c.name === selectedCollection)
  if (!collection) {
    toast.error('Collection not found')
    return
  }

  // Calculate target directory (collection root or subdirectory)
  const targetDirectory = currentSubdirectory
    ? `${collection.path}/${currentSubdirectory}`
    : collection.path

  // Get the default file extension based on settings
  const { globalSettings, currentProjectSettings } = useProjectStore.getState()
  const fileExtension = getDefaultFileType(
    globalSettings,
    currentProjectSettings,
    selectedCollection
  )

  const existingResult = await commands.scanDirectory(
    targetDirectory,
    selectedCollection,
    collection.path
  )
  if (existingResult.status === 'error') {
    throw new Error(existingResult.error)
  }
  const existingDirContents: DirectoryScanResult = existingResult.data

  const existingNames = new Set(
    existingDirContents.files.map(f =>
      f.extension ? `${f.name}.${f.extension}` : f.name
    )
  )

  const today = todayIsoDate()
  const filename = newFileName(title, fileExtension, existingNames, today)

  const fields = collection.complete_schema
    ? (deserializeCompleteSchema(collection.complete_schema)?.fields ?? [])
    : []
  const hasTitleField = fields.some(f => f.name.toLowerCase() === 'title')
  const frontmatter = buildNewFileFrontmatter(
    fields,
    title || newFileTitlePlaceholder(selectedCollection),
    today
  )
  const frontmatterYaml = newFileContent(frontmatter, fields)

  // Create the file in target directory (respects current subdirectory)
  await createFile({
    directory: targetDirectory,
    filename,
    content: frontmatterYaml,
    projectPath: currentProjectPath,
    collectionName: selectedCollection,
  })

  // Find and open the newly created file
  const updatedResult = await commands.scanDirectory(
    targetDirectory,
    selectedCollection,
    collection.path
  )
  if (updatedResult.status === 'error') {
    throw new Error(updatedResult.error)
  }
  const updatedDirContents: DirectoryScanResult = updatedResult.data

  const newFile = updatedDirContents.files.find(
    f => (f.extension ? `${f.name}.${f.extension}` : f.name) === filename
  )

  if (newFile) {
    // Get current functions from store state
    const { openFile } = useEditorStore.getState()
    const { frontmatterPanelVisible, toggleFrontmatterPanel } =
      useUIStore.getState()

    openFile(newFile)

    // Open frontmatter panel if we have a title field
    if (hasTitleField && !frontmatterPanelVisible) {
      toggleFrontmatterPanel()
    }

    // Focus where the writer types next, once the entry and its form show.
    // A collection without body text has its form in the main area
    setTimeout(() => focusNewFile({ titleGiven: !!title }), 200)
  }
}

export const useCreateFile = () => {
  // PERFORMANCE FIX: Use selector syntax to avoid entire store subscriptions
  const projectPath = useProjectStore(state => state.projectPath)
  const currentProjectSettings = useProjectStore(
    useShallow(state => state.currentProjectSettings)
  )

  const { data: collections = [] } = useCollectionsQuery(
    projectPath,
    currentProjectSettings
  )

  const createFileMutation = useCreateFileMutation()

  // Use ref to avoid recreating callback on every query update
  const collectionsRef = useRef(collections)
  useEffect(() => {
    collectionsRef.current = collections
  }, [collections])

  // React ref for concurrency guard (doesn't trigger re-renders)
  const isCreatingRef = useRef(false)

  // Asks for the title first; the dialog then calls createNamedFile
  const createNewFile = useCallback(() => {
    if (!useProjectStore.getState().selectedCollection) {
      toast.error('No collection selected')
    } else {
      useUIStore.getState().setNewFileDialogOpen(true)
    }
    return Promise.resolve()
  }, [])

  const createNamedFile = useCallback(
    async (title: string) => {
      if (isCreatingRef.current) {
        return // Silently ignore concurrent calls
      }

      isCreatingRef.current = true
      await createFileInCurrentFolder(
        collectionsRef.current,
        createFileMutation.mutateAsync,
        title.trim()
      ).catch(error =>
        toast.error('Failed to create new file', {
          description:
            error instanceof Error ? error.message : 'Unknown error occurred',
        })
      )
      isCreatingRef.current = false
    },
    [createFileMutation]
  ) // PERFORMANCE FIX: Use ref for collections, stable dependency array

  return { createNewFile, createNamedFile }
}
