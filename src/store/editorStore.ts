import { create } from 'zustand'
import { warn as logWarn } from '@tauri-apps/plugin-log'
import { useProjectStore } from './projectStore'
import { setNestedValue, deleteNestedValue } from '../lib/object-utils'
import type { FileEntry } from '@/types'

const MAX_AUTO_SAVE_DELAY_MS = 10000 // Maximum time between auto-saves (10 seconds)

interface EditorState {
  // File state
  currentFile: FileEntry | null

  // Content state
  editorContent: string // Content without frontmatter and imports
  frontmatter: Record<string, unknown> // Current frontmatter being edited
  rawFrontmatter: string // Original frontmatter string from disk
  imports: string // MDX imports (hidden from editor)

  // Status state
  isDirty: boolean // True if ANY changes need to be saved
  isFrontmatterDirty: boolean // True if frontmatter was modified (vs content-only edits)
  autoSaveTimeoutId: ReturnType<typeof setTimeout> | null // Auto-save timeout ID
  lastSaveTimestamp: number | null // Timestamp of last successful save
  autoSaveCallback:
    | ((showToast?: boolean, reportFields?: boolean) => Promise<void>)
    | null // Hook-provided save callback
  // Frontmatter fields whose validation message is shown: those the writer
  // has left, and those that needed attention at the last save
  shownFieldErrors: Record<string, true>
  // Saves that failed and said why (a toast with the reason and recovery),
  // so a caller can tell a reported failure from a silent one
  saveFailures: number

  // Actions
  openFile: (file: FileEntry) => void
  closeCurrentFile: () => void
  // reportFields: the writer asked to save (Cmd+S, File → Save, the toolbar),
  // so say which frontmatter fields need attention
  saveFile: (showToast?: boolean, reportFields?: boolean) => Promise<void>
  setEditorContent: (content: string) => void
  setImports: (imports: string) => void
  updateFrontmatter: (frontmatter: Record<string, unknown>) => void
  updateFrontmatterField: (key: string, value: unknown) => void
  scheduleAutoSave: () => void
  setAutoSaveCallback: (
    callback:
      | ((showToast?: boolean, reportFields?: boolean) => Promise<void>)
      | null
  ) => void
  updateCurrentFileAfterRename: (newPath: string) => void
  showFieldErrors: (names: string[]) => void
  noteSaveFailed: () => void
}

// Selects the opened file's collection in the sidebar. A custom event, so the
// editor store doesn't reach into the project store (Bridge Pattern)
const dispatchFileOpened = (file: FileEntry) => {
  window.dispatchEvent(
    new CustomEvent('file-opened', {
      detail: { collectionName: file.collection },
    })
  )
}

export const useEditorStore = create<EditorState>((set, get) => ({
  // Initial state
  currentFile: null,
  editorContent: '',
  frontmatter: {},
  rawFrontmatter: '',
  imports: '',
  isDirty: false,
  isFrontmatterDirty: false,
  autoSaveTimeoutId: null,
  lastSaveTimestamp: null,
  autoSaveCallback: null,
  shownFieldErrors: {},
  saveFailures: 0,

  // Actions
  openFile: (file: FileEntry) => {
    const { autoSaveTimeoutId, autoSaveCallback, currentFile, isDirty } = get()

    // Opening the open file again only selects its collection. Clearing the
    // store here would wipe unsaved edits, and a saved file would stay blank:
    // its content query is cached, so nothing loads it back, and the next
    // edit would save the blank form over the file. Compared by path, which
    // a rename updates (the id isn't)
    if (currentFile?.path === file.path) {
      dispatchFileOpened(file)
      return
    }

    // Clear auto-save timeout if it exists to prevent race condition
    // where previous file's auto-save could fire after opening new file
    if (autoSaveTimeoutId) {
      clearTimeout(autoSaveTimeoutId)
    }

    // Save unsaved edits before switching, or they're lost. saveFile reads the
    // store synchronously when it starts, so it captures the outgoing file
    // before the set() below replaces it
    if (isDirty && autoSaveCallback) {
      void autoSaveCallback(false)
    }

    // CRITICAL: Clear content FIRST, then set currentFile
    // This prevents Editor.tsx from reading stale content via getState()
    set({
      editorContent: '',
      frontmatter: {},
      rawFrontmatter: '',
      imports: '',
      currentFile: file,
      isDirty: false,
      isFrontmatterDirty: false,
      autoSaveTimeoutId: null,
      lastSaveTimestamp: Date.now(),
      shownFieldErrors: {},
    })

    dispatchFileOpened(file)

    // Content will be loaded by useFileContentQuery hook
  },

  closeCurrentFile: () => {
    // Clear auto-save timeout if it exists
    const { autoSaveTimeoutId } = get()
    if (autoSaveTimeoutId) {
      clearTimeout(autoSaveTimeoutId)
    }

    // Clear all file-related state
    set({
      currentFile: null,
      editorContent: '',
      frontmatter: {},
      rawFrontmatter: '',
      imports: '',
      isDirty: false,
      isFrontmatterDirty: false,
      autoSaveTimeoutId: null,
      lastSaveTimestamp: null,
      shownFieldErrors: {},
    })
  },

  saveFile: async (showToast = true, reportFields = false) => {
    // Delegate to hook-provided callback (Hybrid Action Hooks pattern)
    // This allows stores to trigger saves without having direct access to React hooks
    const { autoSaveCallback } = get()
    if (autoSaveCallback) {
      await autoSaveCallback(showToast, reportFields)
    } else {
      void logWarn('saveFile called but no callback registered')
    }
  },

  setEditorContent: (content: string) => {
    set({ editorContent: content, isDirty: true })
    get().scheduleAutoSave()
  },

  // Marks the file dirty in the same update: until then, useEditorFileContent
  // would put back the imports from disk
  setImports: (imports: string) => {
    set({ imports, isDirty: true })
    get().scheduleAutoSave()
  },

  updateFrontmatter: (frontmatter: Record<string, unknown>) => {
    set({ frontmatter, isDirty: true, isFrontmatterDirty: true })
    get().scheduleAutoSave()
  },

  updateFrontmatterField: (key: string, value: unknown) => {
    const { frontmatter } = get()

    // Clearing a field removes its key (and any parent objects left empty)
    // rather than writing `title: ''` or `tags: []` into the file
    const isEmpty =
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)

    // Keys are dot paths for nested objects (`coverImage.alt`), matching the
    // flattened field names in the schema
    const newFrontmatter = isEmpty
      ? deleteNestedValue(frontmatter, key)
      : setNestedValue(frontmatter, key, value)

    set({
      frontmatter: newFrontmatter,
      isDirty: true,
      isFrontmatterDirty: true,
    })
    get().scheduleAutoSave()
  },

  scheduleAutoSave: () => {
    const store = get()
    const now = Date.now()

    // Check if we should force save due to max delay
    if (store.isDirty && store.lastSaveTimestamp) {
      const timeSinceLastSave = now - store.lastSaveTimestamp
      if (timeSinceLastSave >= MAX_AUTO_SAVE_DELAY_MS) {
        const { autoSaveCallback } = store
        if (autoSaveCallback) {
          void autoSaveCallback(false) // Auto-save without toast
        }
        return
      }
    }

    // Clear existing timeout
    if (store.autoSaveTimeoutId) {
      clearTimeout(store.autoSaveTimeoutId)
    }

    // Get auto-save delay from global settings (default to 2 seconds)
    const globalSettings = useProjectStore.getState().globalSettings
    const autoSaveDelay = globalSettings?.general?.autoSaveDelay || 2

    // Schedule new auto-save (without toast)
    const timeoutId = setTimeout(() => {
      const { autoSaveCallback } = get()
      if (autoSaveCallback) {
        void autoSaveCallback(false) // Auto-save without toast
      }
    }, autoSaveDelay * 1000) // Convert from seconds to milliseconds

    set({ autoSaveTimeoutId: timeoutId })
  },

  setAutoSaveCallback: (
    callback:
      | ((showToast?: boolean, reportFields?: boolean) => Promise<void>)
      | null
  ) => {
    set({ autoSaveCallback: callback })
  },

  updateCurrentFileAfterRename: (newPath: string) => {
    const { currentFile } = get()
    if (currentFile) {
      set({
        currentFile: {
          ...currentFile,
          path: newPath,
          name: newPath
            .substring(newPath.lastIndexOf('/') + 1)
            .replace(/\.[^.]+$/, ''),
        },
      })
    }
  },

  showFieldErrors: (names: string[]) => {
    const { shownFieldErrors } = get()
    if (names.every(name => shownFieldErrors[name])) return
    const shown = { ...shownFieldErrors }
    for (const name of names) shown[name] = true
    set({ shownFieldErrors: shown })
  },

  noteSaveFailed: () => {
    set(state => ({ saveFailures: state.saveFailures + 1 }))
  },
}))
