import React from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useUIStore } from '../../store/uiStore'
import { Editor } from '../editor'
import { openProjectViaDialog } from '../../lib/projects/actions'
import { Button } from '../ui/button'
import { useProjectStore } from '@/store/projectStore'
import { useBodyEditorHidden } from '../../hooks/editor/useBodyEditorHidden'
import { GitMainView } from '../git/GitMainView'
import { useGitEditGuard } from '../../hooks/useGitEditGuard'
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'
import { useGitStore } from '../../store/gitStore'
import { FrontmatterPanel } from '../frontmatter'
import { FolderOpen } from 'lucide-react'
import { useProjectsListQuery } from '../../hooks/queries/useProjectsListQuery'
import { useProjectsScreenStore } from '../../store/projectsScreenStore'

// Welcome screen component for better organization
const WelcomeScreen: React.FC = () => {
  const projectPath = useProjectStore(state => state.projectPath)
  const publishingTools = useShowPublishingTools()
  const projects = useProjectsListQuery(projectPath == null)
  const hasProjects = (projects.data?.length ?? 0) > 0
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col gap-4 text-center text-muted-foreground">
        <h2 className="m-0 text-2xl font-light">Welcome to Astro Editor</h2>
        <p className="m-0 text-sm">
          {projectPath == null
            ? 'Select a project folder to get started, then choose a file to edit.'
            : 'Choose a file to edit.'}
        </p>
        {projectPath == null && (
          <div className="flex justify-center gap-2">
            <Button onClick={() => void openProjectViaDialog()} size="sm">
              <FolderOpen /> Open Project…
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
            {hasProjects && (
              <Button
                onClick={() => useProjectsScreenStore.getState().open()}
                variant="outline"
                size="sm"
              >
                Recent Projects
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
          <WelcomeScreen />
        )}
      </div>
      <GitMainView />
    </div>
  )
}
