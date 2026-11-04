import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { queryClient } from '../lib/query-client'
import { queryKeys } from '../lib/query-keys'
import { debug, info } from '@tauri-apps/plugin-log'
import type { Collection } from '@/types'

interface FileChangeEvent {
  path: string
  kind: string
}

// Events for the open file this soon after our own save are probably that save
const OWN_SAVE_WINDOW_MS = 3000

// A Sync or checkout sends one event per file; the counts wait for the burst
// to end, then each affected collection is counted once
const COUNT_REFRESH_DELAY_MS = 400

/**
 * Whether a watcher event can change how many files a collection holds: a
 * file created or removed, or renamed (moved in or out, or to a hidden `_`
 * name). Not an edit. `kind` is notify's `EventKind` in Rust's debug format,
 * like `Create(File)`, `Remove(File)`, `Modify(Name(Any))`.
 */
function changesFileCount(kind: string): boolean {
  return (
    kind.startsWith('Create') ||
    kind.startsWith('Remove') ||
    kind.startsWith('Modify(Name')
  )
}

/** The collections a file is in: its own and any it's nested inside. */
function collectionsHolding(path: string, collections: Collection[]) {
  return collections.filter(collection =>
    path.startsWith(`${collection.path.replace(/\/+$/, '')}/`)
  )
}

/**
 * Handles file-changed events from the Rust watcher
 *
 * Responsibilities:
 * 1. Refresh the sidebar and entry pickers when any content file is added,
 *    removed, renamed or edited outside the app, and the sidebar's counts,
 *    once a burst of events ends, when files are added, removed or renamed
 * 2. Reload the open file when it changes on disk
 * 3. Respect isDirty state (don't reload user's unsaved work)
 * 4. Ignore events that occur immediately after our own save (race condition protection)
 */
export function useFileChangeHandler() {
  useEffect(() => {
    // Counts to refresh when the current burst of events ends
    const pendingCounts = new Map<string, readonly unknown[]>()
    let countTimer: ReturnType<typeof setTimeout> | undefined

    const refreshCountsLater = (projectPath: string, path: string) => {
      const collections =
        queryClient.getQueryData<Collection[]>(
          queryKeys.collections(projectPath)
        ) ?? []
      const holding = collectionsHolding(path, collections)
      if (holding.length === 0) return
      for (const collection of holding) {
        const key = queryKeys.collectionFileCount(projectPath, collection.name)
        pendingCounts.set(JSON.stringify(key), key)
      }
      clearTimeout(countTimer)
      countTimer = setTimeout(() => {
        const keys = [...pendingCounts.values()]
        pendingCounts.clear()
        for (const queryKey of keys) {
          void queryClient.invalidateQueries({ queryKey, exact: true })
        }
      }, COUNT_REFRESH_DELAY_MS)
    }

    const handleFileChanged = (event: Event) => {
      const customEvent = event as CustomEvent<FileChangeEvent>
      const { path, kind } = customEvent.detail

      const { currentFile, isDirty, lastSaveTimestamp } =
        useEditorStore.getState()
      const { projectPath } = useProjectStore.getState()
      if (!projectPath) return

      const isOpenFile = currentFile?.path === path
      const timeSinceLastSave =
        lastSaveTimestamp === null ? Infinity : Date.now() - lastSaveTimestamp
      const isOwnSave = isOpenFile && timeSinceLastSave < OWN_SAVE_WINDOW_MS

      // Our own saves already refresh the file list (useEditorActions). Only
      // queries on screen refetch, and scans don't write, so this can't loop
      if (!isOwnSave) {
        void queryClient.invalidateQueries({
          predicate: ({ queryKey }) =>
            queryKey[0] === queryKeys.all[0] &&
            queryKey[1] === projectPath &&
            // Not a count, whose collection could be called "directory"
            queryKey[2] !== 'fileCount' &&
            // directoryContents and collectionFiles
            (queryKey[3] === 'directory' || queryKey[4] === 'files'),
        })
        // Counting walks the collection's folder, so only when it can change
        if (changesFileCount(kind)) refreshCountsLater(projectPath, path)
      }

      // The rest only concerns the open file
      if (!currentFile || !isOpenFile) {
        return
      }

      // User is editing - their version is authoritative. The "ignoring" logs
      // are dev-only: our own saves trigger them every few seconds while typing
      if (isDirty) {
        if (import.meta.env.DEV) {
          void debug(
            `Ignoring external change to ${path} - file has unsaved edits`
          )
        }
        return
      }

      // The watcher can emit several events for one save, and some arrive after
      // isDirty is cleared
      if (isOwnSave) {
        if (import.meta.env.DEV) {
          void debug(
            `Ignoring external change to ${path} - file was recently saved (${timeSinceLastSave}ms ago)`
          )
        }
        return
      }

      // File is saved and not recently modified by us - safe to reload from disk
      void info(`External change detected on ${path} - reloading`)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.fileContent(projectPath, currentFile.id),
      })
    }

    window.addEventListener('file-changed', handleFileChanged)
    return () => {
      window.removeEventListener('file-changed', handleFileChanged)
      clearTimeout(countTimer)
    }
  }, [])
}
