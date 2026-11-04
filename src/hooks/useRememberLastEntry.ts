import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { rememberLastEntry } from '../lib/projects/last-entry'

/** Remembers the open entry per site, so opening the site returns to it */
export function useRememberLastEntry() {
  const filePath = useEditorStore(state => state.currentFile?.path)
  useEffect(() => {
    const { projectPath } = useProjectStore.getState()
    if (filePath && projectPath) void rememberLastEntry(projectPath, filePath)
  }, [filePath])
}
