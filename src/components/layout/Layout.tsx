import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../../store/uiStore'
import { useTheme } from '../../lib/theme-provider'
import { useColourThemes } from '../../hooks/useColourThemes'
import { useProjectStore } from '../../store/projectStore'
import { UnifiedTitleBar } from './unified-title-bar'
import { LeftSidebar } from './LeftSidebar'
import { MainEditor } from './MainEditor'
import { RightSidebar } from './RightSidebar'
import { FrontmatterPanel } from '../frontmatter'
import { CommandPalette } from '../command-palette'
import { ComponentBuilderDialog } from '../component-builder'
import { NewFileDialog } from '../new-file'
import { ContentLinkerDialog } from '../content-linker'
import { Toaster } from '../ui/sonner'
import { PreferencesDialog } from '../preferences'
import { AgentBridge } from '../agent-bridge'
import { useProjectInitialization } from '../../hooks/useProjectInitialization'
import { useRustToastBridge } from '../../hooks/useRustToastBridge'
import { useEditorFocusTracking } from '../../hooks/useEditorFocusTracking'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useMenuEvents } from '../../hooks/useMenuEvents'
import { useDOMEventListeners } from '../../hooks/useDOMEventListeners'
import { useEditorFileContent } from '../../hooks/useEditorFileContent'
import { useFileChangeHandler } from '../../hooks/useFileChangeHandler'
import { useSaveOnQuit } from '../../hooks/useSaveOnQuit'
import { useEditorActions } from '../../hooks/editor/useEditorActions'
import { useCreateFile } from '../../hooks/useCreateFile'
import { useDeepLink } from '../../hooks/useDeepLink'
import { useSquareCornersEffect } from '../../hooks/useSquareCornersEffect'
import { useExternalLinkHandler } from '../../hooks/useExternalLinkHandler'
import { useGitStatusRefresh } from '../../hooks/useGitStatusRefresh'
import { useSitePreparation } from '../../hooks/useSitePreparation'
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'
import { useGitStore } from '../../store/gitStore'
import { SignInSheet } from '../git/SignInSheet'
import { OpenFromGitHubDialog } from '../git/OpenFromGitHubDialog'
import { ProjectsDialog } from '../projects/ProjectsDialog'
import { HomeScreen } from '../home'
import { useEditorStore } from '../../store/editorStore'
import { useBodyEditorHidden } from '../../hooks/editor/useBodyEditorHidden'
import { focusEditor } from '../../lib/focus-utils'
import { commands } from '../../lib/bindings'
import { getPlatform } from '../../hooks/usePlatform'
import { LAYOUT_SIZES } from '../../lib/layout-constants'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  type PanelImperativeHandle,
} from '../ui/resizable'

export const Layout: React.FC = () => {
  // UI state - use selector syntax for consistency
  const sidebarVisible = useUIStore(state => state.sidebarVisible)
  const frontmatterPanelVisible = useUIStore(
    state => state.frontmatterPanelVisible
  )

  const { setTheme } = useTheme()
  useColourThemes()

  // Extract specific nested values for useEffect dependencies
  const theme = useProjectStore(state => state.globalSettings?.general?.theme)
  const headingColor = useProjectStore(
    useShallow(state => state.globalSettings?.appearance?.headingColor) // headingColor is an object with .light and .dark
  )
  const editorBaseFontSize = useProjectStore(
    state => state.globalSettings?.appearance?.editorBaseFontSize
  )

  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const projectPath = useProjectStore(state => state.projectPath)
  const publishingTools = useShowPublishingTools()

  // Panel refs for imperative collapse/expand control
  const leftPanelRef = useRef<PanelImperativeHandle>(null)
  const rightPanelRef = useRef<PanelImperativeHandle>(null)

  // Sync sidebar visibility with panel collapse state
  useEffect(() => {
    if (sidebarVisible) {
      leftPanelRef.current?.expand()
    } else {
      leftPanelRef.current?.collapse()
    }
  }, [sidebarVisible])

  // A collection without body text has its form in the main area
  // (MainEditor), so the frontmatter panel collapses for it. That isn't the
  // writer closing the panel: their setting is left alone, and the panel comes
  // back with the next file that has body text
  const formInMain = useBodyEditorHidden()
  const rightPanelShown = frontmatterPanelVisible && !formInMain
  const formInMainRef = useRef(formInMain)
  useEffect(() => {
    formInMainRef.current = formInMain
    if (rightPanelShown) {
      rightPanelRef.current?.expand()
    } else {
      rightPanelRef.current?.collapse()
    }
  }, [rightPanelShown, formInMain])

  // Sync drag-to-collapse back to the store
  const handleLeftPanelResize = useCallback(
    (size: { asPercentage: number }) => {
      const isCollapsed = size.asPercentage === 0
      const { sidebarVisible: current, setSidebarVisible } =
        useUIStore.getState()
      if (isCollapsed && current) setSidebarVisible(false)
      if (!isCollapsed && !current) setSidebarVisible(true)
    },
    []
  )

  const handleRightPanelResize = useCallback(
    (size: { asPercentage: number }) => {
      // Collapsed for a form in the main area, not by the writer
      if (formInMainRef.current) return
      const isCollapsed = size.asPercentage === 0
      const { frontmatterPanelVisible: current, setFrontmatterPanelVisible } =
        useUIStore.getState()
      if (isCollapsed && current) setFrontmatterPanelVisible(false)
      if (!isCollapsed && !current) setFrontmatterPanelVisible(true)
    },
    []
  )

  const handleSetPreferencesOpen = useCallback((open: boolean) => {
    setPreferencesOpen(open)
    if (!open) {
      setTimeout(() => {
        focusEditor()
      }, 100)
    }
  }, [])

  // Get editor actions (Hybrid Action Hooks pattern)
  const { saveFile, openFileByPath } = useEditorActions()
  const { createNewFile: createNewFileWithQuery } = useCreateFile()

  // Register auto-save callback with store
  useEffect(() => {
    useEditorStore.getState().setAutoSaveCallback(saveFile)
    return () => {
      useEditorStore.getState().setAutoSaveCallback(null)
    }
  }, [saveFile])
  useSaveOnQuit()

  // Compose all decomposed hooks
  useProjectInitialization()
  useRustToastBridge()
  useEditorFocusTracking()
  useKeyboardShortcuts(handleSetPreferencesOpen)
  useMenuEvents(createNewFileWithQuery, handleSetPreferencesOpen)
  useSquareCornersEffect()
  useDOMEventListeners(createNewFileWithQuery, handleSetPreferencesOpen)
  useDeepLink(openFileByPath)
  useExternalLinkHandler()

  // Enable query-based file loading
  useEditorFileContent()

  // Enable file change detection
  useFileChangeHandler()

  // Git panel: keep the status current; a new project starts on Files
  useGitStatusRefresh(projectPath)
  // A fresh clone has no collection schemas until `astro sync` runs
  useSitePreparation(projectPath)
  useEffect(() => {
    useGitStore.getState().reset()
  }, [projectPath])

  // Sync stored theme preference with theme provider on app load
  useEffect(() => {
    if (theme) {
      setTheme(theme)
    }
  }, [theme, setTheme])

  // Heading colours from appearance settings. --editor-color-heading picks
  // between them with light-dark(), so theme changes need nothing here
  useEffect(() => {
    if (!headingColor) return
    const root = window.document.documentElement
    root.style.setProperty('--heading-color-light', headingColor.light)
    root.style.setProperty('--heading-color-dark', headingColor.dark)
  }, [headingColor])

  // Apply editor base font size CSS variable
  useEffect(() => {
    const root = window.document.documentElement
    const size = editorBaseFontSize ?? 18
    root.style.setProperty('--editor-base-font-size', `${size}px`)
  }, [editorBaseFontSize])

  // On Linux, detect the DE's configured UI font and apply it via CSS variable
  useEffect(() => {
    let cancelled = false
    try {
      if (getPlatform() !== 'linux') return
    } catch {
      return
    }

    void commands
      .getLinuxUiFont()
      .then(result => {
        if (cancelled) return
        if (result.status === 'ok' && result.data) {
          window.document.documentElement.style.setProperty(
            '--font-ui',
            `'${result.data}', -apple-system, 'Segoe UI', 'Ubuntu', 'Cantarell', 'Noto Sans', 'DejaVu Sans', sans-serif`
          )
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-editor-background">
      <UnifiedTitleBar />

      {/* Home covers the editor while no site is open. The panels stay
          mounted underneath (their sizes and state survive), but out of reach */}
      <div className="relative min-h-0 flex-1">
        {projectPath == null && (
          <div className="absolute inset-0 z-10">
            <HomeScreen />
          </div>
        )}
        <div className="h-full" inert={projectPath == null}>
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full"
            autoSaveId="astro-editor-layout"
          >
            <ResizablePanel
              id="left-sidebar"
              panelRef={leftPanelRef}
              collapsible
              collapsedSize={0}
              defaultSize={LAYOUT_SIZES.leftSidebar.default}
              minSize={LAYOUT_SIZES.leftSidebar.min}
              maxSize={LAYOUT_SIZES.leftSidebar.max}
              style={{
                minWidth: sidebarVisible
                  ? LAYOUT_SIZES.leftSidebar.minWidth
                  : undefined,
              }}
              onResize={handleLeftPanelResize}
            >
              <LeftSidebar />
            </ResizablePanel>
            <ResizableHandle
              className={`!cursor-col-resize ${sidebarVisible ? '' : 'hidden'}`}
            />

            <ResizablePanel
              id="main-editor"
              defaultSize={LAYOUT_SIZES.mainEditor.default}
              minSize={LAYOUT_SIZES.mainEditor.min}
            >
              <MainEditor />
            </ResizablePanel>

            <ResizableHandle
              className={`!cursor-col-resize ${rightPanelShown ? '' : 'hidden'}`}
            />
            <ResizablePanel
              id="right-sidebar"
              panelRef={rightPanelRef}
              collapsible
              collapsedSize={0}
              defaultSize={LAYOUT_SIZES.rightSidebar.default}
              minSize={LAYOUT_SIZES.rightSidebar.min}
              maxSize={LAYOUT_SIZES.rightSidebar.max}
              onResize={handleRightPanelResize}
            >
              <RightSidebar>
                <FrontmatterPanel />
              </RightSidebar>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      {/* Floating components */}
      <CommandPalette />
      <ComponentBuilderDialog />
      <ContentLinkerDialog />
      <NewFileDialog />
      <ProjectsDialog />
      <PreferencesDialog
        open={preferencesOpen}
        onOpenChange={handleSetPreferencesOpen}
      />
      {publishingTools && <OpenFromGitHubDialog />}
      {publishingTools && <SignInSheet />}
      <Toaster />
      {import.meta.env.DEV && <AgentBridge />}
    </div>
  )
}
