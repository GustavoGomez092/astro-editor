import { useCallback } from 'react'
import {
  info,
  error as logError,
  warn as logWarn,
} from '@tauri-apps/plugin-log'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { commands, type Collection, type JsonValue } from '@/types'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { saveRecoveryData, saveCrashReport } from '../../lib/recovery'
import { toast } from '../../lib/toast'
import { queryKeys } from '../../lib/query-keys'
import { deserializeCompleteSchema, type SchemaField } from '../../lib/schema'
import { validateFrontmatter } from '../../lib/frontmatter-validation'
import { frontmatterToWrite } from '../../lib/frontmatter-save'
import { projectRegistryManager } from '../../lib/project-registry'
import {
  getCollectionFolderOverrides,
  getEffectiveContentDirectory,
} from '../../lib/project-registry/path-resolution'
import { findOwningProjectPath } from '../../lib/deep-link'
import { ASTRO_PATHS } from '../../lib/constants'

/**
 * Waits until the project store reflects `targetPath` as the active project with
 * its settings loaded. Resolves `false` if that doesn't happen within `timeoutMs`.
 *
 * `setProject` is fire-and-forget, so deep-link handling must wait for the switch
 * to complete before resolving/opening a file in the new project.
 */
function waitForProjectReady(
  targetPath: string,
  timeoutMs = 8000
): Promise<boolean> {
  const state = useProjectStore.getState()
  if (state.projectPath === targetPath && state.currentProjectSettings) {
    return Promise.resolve(true)
  }

  return new Promise<boolean>(resolve => {
    const handles: {
      unsubscribe?: () => void
      timer?: ReturnType<typeof setTimeout>
    } = {}

    handles.timer = setTimeout(() => {
      handles.unsubscribe?.()
      resolve(false)
    }, timeoutMs)

    handles.unsubscribe = useProjectStore.subscribe(current => {
      if (
        current.projectPath === targetPath &&
        current.currentProjectSettings
      ) {
        clearTimeout(handles.timer)
        handles.unsubscribe?.()
        resolve(true)
      }
    })
  })
}

/** The open file's schema fields, from the collections in the query cache. */
function getSchemaFields(
  queryClient: QueryClient,
  projectPath: string,
  collectionName: string
): SchemaField[] | null {
  try {
    const collections = queryClient.getQueryData<Collection[]>(
      queryKeys.collections(projectPath)
    )
    const collection = collections?.find(c => c.name === collectionName)
    const schema = collection?.complete_schema
      ? deserializeCompleteSchema(collection.complete_schema)
      : null
    return schema ? schema.fields : null
  } catch (error) {
    void logWarn(`Could not get the schema fields: ${String(error)}`)
    return null
  }
}

/**
 * After an explicit save, shows the message under every field that needs
 * attention and says how many there are. Returns false when every field is
 * fine. It never blocks the save.
 */
function reportFieldsNeedingAttention(
  fields: SchemaField[] | null,
  frontmatter: Record<string, unknown>,
  fileId: string
): boolean {
  const names = Object.keys(validateFrontmatter(fields ?? [], frontmatter))
  if (names.length === 0) return false

  if (useEditorStore.getState().currentFile?.id === fileId) {
    useEditorStore.getState().showFieldErrors(names)
  }
  toast.warning(
    names.length === 1
      ? 'Saved, but 1 field needs attention'
      : `Saved, but ${names.length} fields need attention`
  )
  return true
}

/**
 * Saves the open file: writes its body, imports and frontmatter (in the
 * schema's field order), marks it clean if nothing changed meanwhile, and
 * refreshes the queries that show it. On failure, writes recovery data and a
 * crash report and keeps the file dirty. When the writer asked to save
 * (`reportFields`: Cmd+S, File → Save, the toolbar) it also reports the fields
 * that need attention, even when there's nothing to write, because auto-save
 * has usually saved the file by then. Other saves (auto-save, leaving the
 * editor, before a path change) don't, so fields the writer hasn't reached
 * yet don't light up. Plain function rather than inline in the hook so the
 * React Compiler can compile the hook (it can't handle `throw` inside `try`).
 */
async function saveCurrentFile(
  queryClient: QueryClient,
  showToast: boolean,
  reportFields: boolean
): Promise<void> {
  const {
    currentFile,
    editorContent,
    frontmatter,
    rawFrontmatter,
    frontmatterBaseline,
    isDirty,
    isFrontmatterDirty,
    imports,
  } = useEditorStore.getState()
  if (!currentFile) return

  // Get project path using direct store access pattern
  const { projectPath } = useProjectStore.getState()

  if (!projectPath) {
    throw new Error('No project path available')
  }

  // The schema gives the field order and what to validate
  const schemaFields = getSchemaFields(
    queryClient,
    projectPath,
    currentFile.collection
  )

  if (!isDirty && reportFields) {
    reportFieldsNeedingAttention(schemaFields, frontmatter, currentFile.id)
    return
  }

  try {
    // The values only when they changed; otherwise the text, to keep its
    // formatting (also when edits ended where they started)
    const toWrite = frontmatterToWrite({
      frontmatter,
      isFrontmatterDirty,
      rawFrontmatter,
      frontmatterBaseline,
      fields: schemaFields ?? [],
    })
    const result = await commands.saveMarkdownContent(
      currentFile.path,
      toWrite.frontmatter as Record<string, JsonValue> | null,
      toWrite.rawFrontmatter,
      editorContent,
      imports,
      schemaFields ? schemaFields.map(f => f.name) : null,
      projectPath
    )
    if (result.status === 'error') {
      throw new Error(result.error)
    }

    // If another file was opened during the save (openFile saves the
    // outgoing file), the store now holds that file's state: leave it alone
    const currentState = useEditorStore.getState()
    if (currentState.currentFile?.id === currentFile.id) {
      // Clear auto-save timeout since we just saved
      if (currentState.autoSaveTimeoutId) {
        clearTimeout(currentState.autoSaveTimeoutId)
      }

      // Only mark as clean if content hasn't changed during save (race condition protection)
      // Check the body, imports and frontmatter to avoid dropping unsaved edits
      const contentUnchanged =
        currentState.editorContent === editorContent &&
        currentState.imports === imports
      const frontmatterUnchanged =
        JSON.stringify(currentState.frontmatter) === JSON.stringify(frontmatter)

      useEditorStore.setState({
        // So the reload of this save isn't taken for a change from outside
        ...(toWrite.frontmatter && { lastWrittenFrontmatter: frontmatter }),
        autoSaveTimeoutId: null,
        isDirty: !contentUnchanged || !frontmatterUnchanged,
        isFrontmatterDirty:
          currentState.isFrontmatterDirty || !frontmatterUnchanged,
        lastSaveTimestamp: Date.now(),
      })
    }

    // Invalidate queries to update UI
    if (projectPath) {
      // Invalidate file content query to refresh cached content
      void queryClient.invalidateQueries({
        queryKey: queryKeys.fileContent(projectPath, currentFile.id),
      })

      // Invalidate directory scans for this collection (root + all subdirectories)
      if (currentFile.collection) {
        void queryClient.invalidateQueries({
          queryKey: [
            ...queryKeys.all,
            projectPath,
            currentFile.collection,
            'directory',
          ],
        })
      }

      // Entry pickers show titles and ids, which come from the frontmatter
      // (a `slug` is the id)
      if (isFrontmatterDirty) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.collectionFiles(
            projectPath,
            currentFile.collection
          ),
        })
      }
    }

    const reported =
      reportFields &&
      reportFieldsNeedingAttention(schemaFields, frontmatter, currentFile.id)
    if (showToast && !reported) {
      toast.success('File saved successfully')
    }
  } catch (error) {
    void logError(`Save failed: ${String(error)}`)
    void info('Attempting to save recovery data...')

    // Save recovery data for the file that failed: the store's latest edits
    // if it's still open, otherwise what this save tried to write
    const state = useEditorStore.getState()
    const stillOpen = state.currentFile?.id === currentFile.id
    const recovered = await saveRecoveryData(
      stillOpen
        ? {
            currentFile: state.currentFile,
            projectPath,
            editorContent: state.editorContent,
            frontmatter: state.frontmatter,
          }
        : { currentFile, projectPath, editorContent, frontmatter }
    )

    const reason =
      error instanceof Error ? error.message : 'Unknown error occurred'
    toast.error('Save failed', {
      description: `Could not save file: ${reason}.${recovered ? ' Recovery data has been saved.' : ''}`,
    })
    useEditorStore.getState().noteSaveFailed()

    // Save crash report
    await saveCrashReport(error as Error, {
      currentFile: currentFile.path,
      projectPath: projectPath || undefined,
      action: 'save',
    })

    // Keep the file marked as dirty since save failed
    if (stillOpen) {
      useEditorStore.setState({ isDirty: true })
    }
  }
}

/**
 * Editor action hooks following the Hybrid Action Hooks pattern.
 *
 * User-triggered actions (like save, delete) live in hooks, which have natural
 * access to both Zustand stores (via getState()) and TanStack Query data.
 * State-triggered actions (like auto-save) live in stores and call these hooks
 * via registered callbacks.
 *
 * This pattern eliminates the event bridge polling pattern and provides:
 * - Direct synchronous access to query data (no polling)
 * - Full type safety
 * - Clear data flow and dependencies
 * - Standard React patterns
 */
export function useEditorActions() {
  const queryClient = useQueryClient()

  const saveFile = useCallback(
    (showToast = true, reportFields = false) =>
      saveCurrentFile(queryClient, showToast, reportFields),
    [queryClient]
  )

  /**
   * Opens a file by absolute path. Used by `astro-editor://open?path=...` deep
   * links (which focus the window first) and the dev-only agent bridge.
   *
   * Resolves the file against the *known* projects (the registry), switching
   * projects if needed, then reuses `openFile` — the same path the sidebar uses.
   */
  const openFileByPath = useCallback(async (filePath: string) => {
    // Only Markdown/MDX files are openable.
    const lower = filePath.toLowerCase()
    if (!lower.endsWith('.md') && !lower.endsWith('.mdx')) {
      toast.error('Astro Editor can only open .md or .mdx files')
      return
    }

    // Find the known project that owns this file (initializing the registry if
    // this is a cold start that raced ahead of normal initialization).
    let knownProjectPaths: string[]
    try {
      knownProjectPaths = Object.values(
        projectRegistryManager.getRegistry().projects
      ).map(p => p.path)
    } catch {
      await projectRegistryManager.initialize()
      knownProjectPaths = Object.values(
        projectRegistryManager.getRegistry().projects
      ).map(p => p.path)
    }

    const owningProjectPath = findOwningProjectPath(knownProjectPaths, filePath)
    if (!owningProjectPath) {
      toast.error("That file isn't in a project Astro Editor knows about", {
        description:
          'Open the project once, then links to its files will work.',
      })
      return
    }

    // Switch to the owning project if it isn't already active, then wait for it.
    const isCurrentProject =
      useProjectStore.getState().projectPath === owningProjectPath
    if (!isCurrentProject) {
      useProjectStore.getState().setProject(owningProjectPath)
      const ready = await waitForProjectReady(owningProjectPath)
      if (!ready) {
        toast.error('Failed to open the project for that link')
        return
      }
    }

    // Resolve the file to a FileEntry within the project (reuses the Rust scan).
    const { currentProjectSettings } = useProjectStore.getState()
    const contentDirectory = getEffectiveContentDirectory(
      currentProjectSettings
    )
    const result = await commands.resolveFileEntry(
      filePath,
      owningProjectPath,
      contentDirectory !== ASTRO_PATHS.CONTENT_DIR ? contentDirectory : null,
      getCollectionFolderOverrides(currentProjectSettings)
    )

    if (result.status === 'error') {
      toast.error("Couldn't open that file", { description: result.error })
      await logError(`Deep link resolve failed: ${result.error}`)
      return
    }

    if (!result.data) {
      // Project is now open, but the file isn't part of a loadable collection.
      toast.warning("Couldn't find that file in the project", {
        description: 'It may not be part of a content collection.',
      })
      return
    }

    useEditorStore.getState().openFile(result.data)
    await info(`Deep link opened file: ${result.data.id}`)
  }, [])

  return { saveFile, openFileByPath }
}
