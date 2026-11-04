import React from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useUIStore } from '../../store/uiStore'
import { Editor } from '../editor'
import { openProjectViaDialog } from '../../lib/projects/actions'
import { Button } from '../ui/button'
import { useProjectStore } from '@/store/projectStore'
import { GitMainView } from '../git/GitMainView'
import { useGitBusy } from '../../hooks/useGitBusy'
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'
import { useGitStore } from '../../store/gitStore'

// Welcome screen component for better organization
const WelcomeScreen: React.FC = () => {
  const projectPath = useProjectStore(state => state.projectPath)
  const publishingTools = useShowPublishingTools()
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col gap-4 text-center text-muted-foreground">
        <h2 className="m-0 text-2xl font-light">Welcome to Astro Editor</h2>
        <p className="m-0 text-sm">
          Select a project folder to get started, then choose a file to edit.
        </p>
        {projectPath == null && (
          <div className="flex justify-center gap-2">
            <Button
              onClick={() => void openProjectViaDialog()}
              variant="outline"
              size="sm"
              title="Open Project"
            >
              Open Project
            </Button>
            {publishingTools && (
              <Button
                onClick={() =>
                  useGitStore.getState().setOpenFromGitHubOpen(true)
                }
                variant="outline"
                size="sm"
              >
                Open from GitHub
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const MainEditor: React.FC = () => {
  // PERFORMANCE FIX: Use specific selector instead of currentFile object to avoid cascade
  const hasCurrentFile = useEditorStore(state => !!state.currentFile)
  const typewriterModeEnabled = useUIStore(state => state.typewriterModeEnabled)
  // No edits while git rewrites files: they'd be saved over what came in
  const gitBusy = useGitBusy()

  return (
    <div className="relative flex h-full flex-col">
      <div
        className={`flex-1 overflow-x-hidden overflow-y-auto bg-editor-background${typewriterModeEnabled ? ' no-scrollbar' : ''}`}
        inert={gitBusy || undefined}
        aria-busy={gitBusy || undefined}
      >
        {hasCurrentFile ? <Editor /> : <WelcomeScreen />}
      </div>
      <GitMainView />
    </div>
  )
}
