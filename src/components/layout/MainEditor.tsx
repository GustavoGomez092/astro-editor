import React from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useUIStore } from '../../store/uiStore'
import { Editor } from '../editor'
import { useBodyEditorHidden } from '../../hooks/editor/useBodyEditorHidden'
import { GitMainView } from '../git/GitMainView'
import { useGitEditGuard } from '../../hooks/useGitEditGuard'
import { FrontmatterPanel } from '../frontmatter'

// Shown when a site is open and no file is
const ChooseFile: React.FC = () => (
  <div className="flex h-full items-center justify-center">
    <p className="m-0 text-sm text-muted-foreground">Choose a file to edit.</p>
  </div>
)

export const MainEditor: React.FC = () => {
  // PERFORMANCE FIX: Use specific selector instead of currentFile object to avoid cascade
  const hasCurrentFile = useEditorStore(state => !!state.currentFile)
  const typewriterModeEnabled = useUIStore(state => state.typewriterModeEnabled)
  const bodyHidden = useBodyEditorHidden()
  // No edits while git rewrites files: they'd be saved over what came in
  const gitGuard = useGitEditGuard()

  return (
    <div className="relative flex h-full flex-col">
      <div
        className={`flex-1 overflow-x-hidden overflow-y-auto bg-editor-background${typewriterModeEnabled ? ' no-scrollbar' : ''}`}
        {...gitGuard}
      >
        {hasCurrentFile ? (
          <>
            {/* Hidden rather than unmounted, to keep the editor's state */}
            <div
              className={bodyHidden ? 'hidden' : 'h-full'}
              // Read by focusNewFile (lib/files/focus-new-file.ts)
              data-body-editor={bodyHidden ? 'hidden' : 'shown'}
            >
              <Editor />
            </div>
            {/* A collection without body text is edited here, in a form
                where the editor would be; the sidebar's form steps aside */}
            <div
              className={bodyHidden ? 'h-full' : 'hidden'}
              data-main-form={bodyHidden ? 'shown' : 'hidden'}
            >
              <FrontmatterPanel placement="main" />
            </div>
          </>
        ) : (
          <ChooseFile />
        )}
      </div>
      <GitMainView />
    </div>
  )
}
