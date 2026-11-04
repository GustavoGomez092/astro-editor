import React, { useState } from 'react'
import { Settings, Folder, Layers, Wrench, CloudUpload } from 'lucide-react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { GeneralPane } from './panes/GeneralPane'
import { ProjectSettingsPane } from './panes/ProjectSettingsPane'
import { CollectionSettingsPane } from './panes/CollectionSettingsPane'
import { DebugPane } from './panes/DebugPane'
import { GitHubPane } from './panes/GitHubPane'
import { usePreferences } from '../../hooks/usePreferences'
import { useShowPublishingTools } from '../../hooks/settings/useShowPublishingTools'

interface PreferencesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type PreferencePane = 'general' | 'project' | 'collections' | 'github' | 'debug'

const getNavigationItems = (hasProject: boolean, publishingTools: boolean) =>
  [
    {
      id: 'general' as const,
      name: 'General',
      icon: Settings,
      available: true,
    },
    {
      id: 'project' as const,
      name: 'Project Settings',
      icon: Folder,
      available: hasProject,
    },
    {
      id: 'collections' as const,
      name: 'Collections',
      icon: Layers,
      available: hasProject,
    },
    {
      id: 'github' as const,
      name: 'GitHub',
      icon: CloudUpload,
      available: publishingTools,
    },
    {
      id: 'debug' as const,
      name: 'Advanced',
      icon: Wrench,
      available: true,
    },
  ].filter(item => item.available)

const getPaneTitle = (pane: PreferencePane): string => {
  switch (pane) {
    case 'general':
      return 'General'
    case 'project':
      return 'Project Settings'
    case 'collections':
      return 'Collections'
    case 'github':
      return 'GitHub'
    case 'debug':
      return 'Advanced'
    default:
      return 'General'
  }
}

export const PreferencesDialog: React.FC<PreferencesDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const [activePane, setActivePane] = useState<PreferencePane>('general')
  const { hasProject } = usePreferences()
  const publishingTools = useShowPublishingTools()
  const navigationItems = getNavigationItems(hasProject, publishingTools)

  // Reset to general pane if current pane becomes unavailable.
  // Depend on primitives (not the recreated-each-render navigationItems array)
  // and recompute availability inside.
  React.useEffect(() => {
    const isAvailable = getNavigationItems(hasProject, publishingTools).some(
      item => item.id === activePane
    )
    if (!isAvailable) {
      // oxlint-disable-next-line react-hooks/set-state-in-effect
      setActivePane('general')
    }
  }, [hasProject, publishingTools, activePane])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 font-sans md:max-h-[600px] md:max-w-[900px] lg:max-w-[1000px]">
        <DialogTitle className="sr-only">Preferences</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your application preferences here.
        </DialogDescription>

        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationItems.map(item => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={activePane === item.id}
                          onClick={() => setActivePane(item.id)}
                        >
                          <item.icon />
                          <span>{item.name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex max-h-[600px] flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2">
              <div className="flex items-center gap-2 px-4">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink href="#">Preferences</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        {getPaneTitle(activePane)}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-4 pt-0">
              <div className="space-y-6">
                {activePane === 'general' && <GeneralPane />}
                {activePane === 'project' && <ProjectSettingsPane />}
                {activePane === 'collections' && <CollectionSettingsPane />}
                {activePane === 'github' && <GitHubPane />}
                {activePane === 'debug' && <DebugPane />}
              </div>
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
