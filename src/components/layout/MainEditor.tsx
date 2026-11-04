import React from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useUIStore } from '../../store/uiStore'
import { Editor } from '../editor'
import { openProjectViaDialog } from '../../lib/projects/actions'
import { Button } from '../ui/button'
import { useProjectStore } from '@/store/projectStore'
import { useBodyEditorHidden } from '../../hooks/editor/useBodyEditorHidden'

// Welcome screen component for better organization
const WelcomeScreen: React.FC = () => {
  const projectPath = useProjectStore(state => state.projectPath)
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col gap-4 text-center text-muted-foreground">
        <h2 className="m-0 text-2xl font-light">Welcome to Astro Editor</h2>
        <p className="m-0 text-sm">
          Select a project folder to get started, then choose a file to edit.
        </p>
        {projectPath == null && (
          <Button
            onClick={() => void openProjectViaDialog()}
            className="self-center"
            variant="outline"
            size="sm"
            title="Open Project"
          >
            Open Project
          </Button>
        )}
      </div>
    </div>
  )
}

// Shown instead of the editor in a collection without body text
const NoBodyText: React.FC = () => (
  <div className="flex h-full items-center justify-center p-8">
    <div className="flex max-w-sm flex-col gap-2 text-center text-muted-foreground">
      <h2 className="m-0 text-lg font-normal">No body text</h2>
      <p className="m-0 text-sm">
        Entries in this collection are only frontmatter, so they're edited in
        the panel on the right. To write body text here, set Body Text in this
        collection's settings.
      </p>
    </div>
  </div>
)

export const MainEditor: React.FC = () => {
  // PERFORMANCE FIX: Use specific selector instead of currentFile object to avoid cascade
  const hasCurrentFile = useEditorStore(state => !!state.currentFile)
  const typewriterModeEnabled = useUIStore(state => state.typewriterModeEnabled)
  const bodyHidden = useBodyEditorHidden()

  return (
    <div className="flex h-full flex-col">
      <div
        className={`flex-1 overflow-x-hidden overflow-y-auto bg-editor-background${typewriterModeEnabled ? ' no-scrollbar' : ''}`}
      >
        {hasCurrentFile ? (
          <>
            {/* Hidden rather than unmounted, to keep the editor's state */}
            <div className={bodyHidden ? 'hidden' : 'h-full'}>
              <Editor />
            </div>
            {bodyHidden && <NoBodyText />}
          </>
        ) : (
          <WelcomeScreen />
        )}
      </div>
    </div>
  )
}
