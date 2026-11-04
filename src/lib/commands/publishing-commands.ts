import {
  CloudDownload,
  CloudUpload,
  GitBranchPlus,
  History,
  RefreshCw,
} from 'lucide-react'
import { useGitStore } from '@/store/gitStore'
import { useUIStore } from '@/store/uiStore'
import type { AppCommand, CommandContext } from './types'

const available = (context: CommandContext) =>
  Boolean(
    context.projectPath && context.globalSettings?.general.showPublishingTools
  )

/** Shows the Changes tab, opening the sidebar if it's closed. */
function showChanges() {
  useUIStore.getState().setSidebarVisible(true)
  useGitStore.getState().setPanelTab('changes')
}

/**
 * Git panel commands. Publish and Sync need the panel's state (the message,
 * sign-in), so they're DOM events that `ChangesPanel` handles like its buttons.
 */
export const publishingCommands: AppCommand[] = [
  {
    id: 'git-publish',
    label: 'Publish',
    description: 'Publish your changes to GitHub',
    icon: CloudUpload,
    group: 'publishing',
    execute: () => {
      showChanges()
      window.dispatchEvent(new CustomEvent('git-publish'))
    },
    isAvailable: available,
  },
  {
    id: 'git-sync',
    label: 'Sync',
    description: 'Bring in new changes from GitHub',
    icon: RefreshCw,
    group: 'publishing',
    execute: () => {
      window.dispatchEvent(new CustomEvent('git-sync'))
    },
    isAvailable: available,
  },
  {
    id: 'git-history',
    label: 'History',
    description: 'See what changed, and when',
    icon: History,
    group: 'publishing',
    execute: () => {
      useGitStore.getState().openHistory()
    },
    isAvailable: available,
  },
  {
    id: 'git-new-branch',
    label: 'New Branch…',
    description: 'Start a separate line of work',
    icon: GitBranchPlus,
    group: 'publishing',
    execute: () => {
      showChanges()
      useGitStore.getState().setNewBranchOpen(true)
    },
    isAvailable: available,
  },
  {
    id: 'git-open-from-github',
    label: 'Open from GitHub…',
    description: 'Download a site from GitHub and open it',
    icon: CloudDownload,
    group: 'project',
    execute: () => {
      useGitStore.getState().setOpenFromGitHubOpen(true)
    },
    // Needs no open project
    isAvailable: context =>
      Boolean(context.globalSettings?.general.showPublishingTools),
  },
]
