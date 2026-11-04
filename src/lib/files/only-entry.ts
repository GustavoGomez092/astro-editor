import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import type { FileEntry } from '@/types'

interface OnlyEntryOptions {
  collectionName: string
  /** The collection's file count, counting subfolders; undefined until counted */
  count: number | undefined
  /** Every file in the collection, subfolders included */
  loadFiles: () => Promise<FileEntry[]>
}

/**
 * Opens a collection's entry when it has exactly one, so choosing a
 * collection like a site's hero section goes straight to the entry instead of
 * a one-item list. The files are loaded only when the count says one, and
 * have the last word, since the count can lag behind a file just added. If
 * the writer has left the collection by the time they load, nothing opens.
 * Returns whether it opened the entry.
 */
export async function openOnlyEntry({
  collectionName,
  count,
  loadFiles,
}: OnlyEntryOptions): Promise<boolean> {
  if (count !== 1) return false
  const files = await loadFiles()
  const [only] = files
  if (files.length !== 1 || !only) return false
  if (useProjectStore.getState().selectedCollection !== collectionName) {
    return false
  }
  useEditorStore.getState().openFile(only)
  return true
}
