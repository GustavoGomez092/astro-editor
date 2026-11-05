import { getCurrentWindow } from '@tauri-apps/api/window'
import { ask } from '@tauri-apps/plugin-dialog'
import { commands } from './bindings'
import { useEditorStore } from '../store/editorStore'
import { projectRegistryManager } from './project-registry'

/**
 * Saves the open file if it has unsaved edits, without waiting for auto-save.
 * Resolves `true` when nothing is left unsaved. Call before anything that ends
 * the app, like quitting or restarting to install an update.
 */
export async function saveUnsavedEdits(): Promise<boolean> {
  const { isDirty, saveFile } = useEditorStore.getState()
  if (isDirty) await saveFile(false)
  // A failed save keeps the file dirty (and has shown an error)
  return !useEditorStore.getState().isDirty
}

/**
 * Writes the entries remembered for each site, but never waits long: a stuck
 * write must not stop the app from quitting
 */
export async function flushRememberedEntries(timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([projectRegistryManager.flushLastFiles(), deadline])
  } catch {
    // Remembering an entry is a convenience; quitting comes first
  } finally {
    clearTimeout(timer)
  }
}

let askingToQuit = false

/**
 * Answers Rust's `quit-requested` event (see `src-tauri/src/commands/quit.rs`):
 * saves, then quits. If the save fails, asks whether to quit anyway.
 */
export async function answerQuitRequest(): Promise<void> {
  // A dialog from an earlier request is already asking
  if (askingToQuit) {
    await commands.cancelQuit()
    return
  }

  if (await saveUnsavedEdits()) {
    await flushRememberedEntries()
    await commands.quitApp()
    return
  }

  // Rust quits by itself if it doesn't hear back soon, so answer before asking
  await commands.cancelQuit()

  // Reset even if the dialog fails, or every later quit would be turned down
  askingToQuit = true
  let quitAnyway = false
  try {
    const fileName = useEditorStore.getState().currentFile?.name ?? 'this file'
    // The window may be hidden (Cmd+W on macOS)
    await getCurrentWindow().show()
    quitAnyway = await ask(
      `Your latest changes to “${fileName}” couldn't be saved. If you quit now, they'll be lost.`,
      {
        title: 'Quit Without Saving?',
        kind: 'warning',
        okLabel: 'Quit Anyway',
        cancelLabel: "Don't Quit",
      }
    )
  } finally {
    askingToQuit = false
  }

  if (quitAnyway) {
    await flushRememberedEntries()
    await commands.quitApp()
  }
}
