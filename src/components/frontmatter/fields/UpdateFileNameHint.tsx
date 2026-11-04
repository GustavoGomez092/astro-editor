import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useGitBusy } from '../../../hooks/useGitBusy'
import { useShallow } from 'zustand/react/shallow'
import { useProjectStore } from '../../../store/projectStore'
import { queryKeys } from '../../../lib/query-keys'
import { renameTargetFor } from '../../../lib/files/rename-to-title'
import { useEditorStore } from '../../../store/editorStore'
import {
  canRenameToTitle,
  fullName,
  nameForTitle,
  GIT_BUSY_MESSAGE,
  renameCurrentFileToTitle,
  siblingNames,
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
  const gitBusy = useGitBusy()
  const show = file !== null && canRenameToTitle(file, title)
  const projectPath = useProjectStore(state => state.projectPath)
  const directory = file?.path.substring(0, file.path.lastIndexOf('/')) ?? ''
  // The other names in the folder, to show the name the rename will really
  // give (a clash adds a number). Under 'directory', so saves and renames
  // refresh it
  const { data: names } = useQuery({
    queryKey: [
      ...queryKeys.all,
      projectPath,
      file?.collection,
      'directory',
      'names',
      directory,
    ],
    queryFn: () => siblingNames(file!),
    enabled: show && Boolean(projectPath),
    staleTime: 0,
  })
  if (!file || !show) return null

  const newName =
    (names && renameTargetFor(title, fullName(file), names)) ||
    nameForTitle(file, title)
  return (
    <p className="text-xs text-muted-foreground">
      File name: <span className="font-mono">{fullName(file)}</span> ·{' '}
      <button
        type="button"
        disabled={gitBusy}
        title={gitBusy ? GIT_BUSY_MESSAGE : undefined}
        onClick={() => void renameCurrentFileToTitle()}
        className="text-foreground underline underline-offset-2 hover:text-primary disabled:no-underline disabled:opacity-50"
      >
        Update to <span className="font-mono">{newName}</span>
      </button>
    </p>
  )
}
