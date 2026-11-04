import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore } from '../../../store/editorStore'
import {
  canRenameToTitle,
  fullName,
  nameForTitle,
  renameCurrentFileToTitle,
  titleOf,
} from '../../../lib/files/rename-to-title-action'

/**
 * Under the title field, once the file's name no longer follows the title:
 * "File name: old-name.md · Update to new-name.md". The writer decides when to
 * rename; nothing renames by itself. Hidden while the title is empty.
 */
export const UpdateFileNameHint: React.FC = () => {
  const file = useEditorStore(useShallow(state => state.currentFile))
  const title = useEditorStore(state =>
    state.currentFile ? titleOf(state.currentFile, state.frontmatter) : ''
  )
  if (!file || !canRenameToTitle(file, title)) return null

  const newName = nameForTitle(file, title)
  return (
    <p className="text-xs text-muted-foreground">
      File name: <span className="font-mono">{fullName(file)}</span> ·{' '}
      <button
        type="button"
        onClick={() => void renameCurrentFileToTitle()}
        className="text-foreground underline underline-offset-2 hover:text-primary"
      >
        Update to <span className="font-mono">{newName}</span>
      </button>
    </p>
  )
}
