import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore } from '../../../store/editorStore'
import { useProjectStore } from '../../../store/projectStore'
import { useUIStore } from '../../../store/uiStore'
import { useCreateFile } from '../../../hooks/useCreateFile'
import { useAppVersionQuery } from '../../../hooks/queries/useAppVersionQuery'
import { useBodyEditorHidden } from '../../../hooks/editor/useBodyEditorHidden'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import {
  Save,
  PanelRight,
  PanelLeft,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Eye,
  Pilcrow,
} from 'lucide-react'
import { cn } from '../../../lib/utils'
import { PreviewButton } from '../../dev-server'
import { collectionDisplayName } from '../../../lib/collection-name'
import { PublishButton } from '../../git/PublishButton'
import { SiteSwitcher } from './SiteSwitcher'

interface TitleBarToolbarProps {
  /** Window controls for the left side (e.g., macOS traffic lights) */
  leftSlot?: React.ReactNode
  /** Window controls for the right side (e.g., Windows minimize/maximize/close) */
  rightSlot?: React.ReactNode
}

/**
 * Shared toolbar for the unified title bar.
 * Platform-specific window controls are passed via slots.
 */
export const TitleBarToolbar: React.FC<TitleBarToolbarProps> = ({
  leftSlot,
  rightSlot,
}) => {
  const currentFile = useEditorStore(useShallow(state => state.currentFile))
  const saveFile = useEditorStore(state => state.saveFile)
  const isDirty = useEditorStore(state => state.isDirty)

  const projectPath = useProjectStore(state => state.projectPath)
  const selectedCollection = useProjectStore(state => state.selectedCollection)

  const toggleFrontmatterPanel = useUIStore(
    state => state.toggleFrontmatterPanel
  )
  const frontmatterPanelVisible = useUIStore(
    state => state.frontmatterPanelVisible
  )
  // A collection without body text has its form in the main area, and the
  // frontmatter panel stays collapsed (Layout)
  const formInMain = useBodyEditorHidden()
  const toggleSidebar = useUIStore(state => state.toggleSidebar)
  const sidebarVisible = useUIStore(state => state.sidebarVisible)
  const focusModeEnabled = useUIStore(state => state.focusModeEnabled)
  const toggleFocusMode = useUIStore(state => state.toggleFocusMode)
  const typewriterModeEnabled = useUIStore(state => state.typewriterModeEnabled)
  const toggleTypewriterMode = useUIStore(state => state.toggleTypewriterMode)
  const distractionFreeBarsHidden = useUIStore(
    state => state.distractionFreeBarsHidden
  )
  const showBars = useUIStore(state => state.showBars)

  const { createNewFile } = useCreateFile()

  // Test builds are the only versions with a prerelease part (`1.0.21-test.3`)
  const { data: appVersion } = useAppVersionQuery()
  const isTestBuild = appVersion?.includes('-') ?? false

  const handleSave = () => {
    if (currentFile && isDirty) {
      void saveFile(true, true)
    }
  }

  // Home: no site is open, so the bar holds just the app name and Settings
  const home = projectPath == null
  const bothPanelsHidden = !home && !sidebarVisible && !frontmatterPanelVisible

  return (
    <div
      className={cn(
        // transform-gpu gives the toolbar its own compositing layer. Without it,
        // WebKit doesn't fade the children with the opacity transition: they stay
        // visible, then vanish at once
        'w-full flex items-center justify-between px-3 py-1.5 select-none border-b transition-opacity duration-300 transform-gpu',
        bothPanelsHidden
          ? 'bg-editor-background border-transparent'
          : 'bg-background border-border',
        distractionFreeBarsHidden && bothPanelsHidden && 'opacity-0'
      )}
      data-tauri-drag-region
      onMouseEnter={showBars}
    >
      <div className="flex flex-1 items-center gap-2" data-tauri-drag-region>
        {leftSlot}

        {isTestBuild && (
          <Badge
            variant="outline"
            className="text-muted-foreground"
            data-tauri-drag-region
          >
            Test build {appVersion}
          </Badge>
        )}

        {home ? (
          <span
            className="text-sm font-medium text-muted-foreground"
            data-tauri-drag-region
          >
            Astro Editor+
          </span>
        ) : (
          <>
            <Button
              onClick={toggleSidebar}
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
              title={sidebarVisible ? 'Close Sidebar' : 'Open Sidebar'}
            >
              {sidebarVisible ? (
                <PanelLeftClose className="size-4" />
              ) : (
                <PanelLeft className="size-4" />
              )}
            </Button>

            <SiteSwitcher projectPath={projectPath} />
          </>
        )}
      </div>

      <div className="flex items-center gap-2" data-tauri-drag-region>
        {home ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs font-normal text-muted-foreground"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('open-preferences'))
            }
          >
            Settings
          </Button>
        ) : (
          <>
            <PreviewButton />
            <PublishButton />

            {selectedCollection && (
              <Button
                onClick={() => void createNewFile()}
                variant="ghost"
                size="sm"
                className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
                title={`New ${collectionDisplayName(selectedCollection)} file`}
              >
                <Plus className="size-4" />
              </Button>
            )}

            <Button
              onClick={toggleFocusMode}
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
              title={
                focusModeEnabled ? 'Disable Focus Mode' : 'Enable Focus Mode'
              }
              aria-label={
                focusModeEnabled ? 'Disable Focus Mode' : 'Enable Focus Mode'
              }
            >
              <Eye
                className={cn('size-4', focusModeEnabled && 'text-active')}
              />
            </Button>

            <Button
              onClick={toggleTypewriterMode}
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
              title={
                typewriterModeEnabled
                  ? 'Disable Typewriter Mode'
                  : 'Enable Typewriter Mode'
              }
              aria-label={
                typewriterModeEnabled
                  ? 'Disable Typewriter Mode'
                  : 'Enable Typewriter Mode'
              }
            >
              <Pilcrow
                className={cn('size-4', typewriterModeEnabled && 'text-active')}
              />
            </Button>

            <Button
              onClick={handleSave}
              variant="ghost"
              size="sm"
              disabled={!currentFile || !isDirty}
              title={`Save${isDirty ? ' (unsaved changes)' : ''}`}
              className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
            >
              <Save className="size-4" />
            </Button>

            <Button
              onClick={toggleFrontmatterPanel}
              variant="ghost"
              size="sm"
              disabled={formInMain}
              className="size-7 p-0 text-icon [&_svg]:scale-100 [&_svg]:transform-gpu"
              title={
                formInMain
                  ? "This collection's fields are in the main area"
                  : frontmatterPanelVisible
                    ? 'Close Frontmatter Panel'
                    : 'Open Frontmatter Panel'
              }
            >
              {frontmatterPanelVisible && !formInMain ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelRight className="size-4" />
              )}
            </Button>
          </>
        )}
        {rightSlot}
      </div>
    </div>
  )
}
