import { useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { error as logError } from '@tauri-apps/plugin-log'
import { FolderOpen, FolderX } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { projectRegistryManager } from '@/lib/project-registry'
import { folderStates } from '@/lib/project-registry/utils'
import { filterProjects, folderName, shortenHome } from '@/lib/projects/recent'
import { shortenMiddle } from '@/lib/git/clone'
import { openProjectViaDialog } from '@/lib/projects/actions'
import { formatRelativeTime } from '@/lib/dates'
import { getPlatformString } from '@/lib/platform-strings'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import {
  useProjectsListQuery,
  type ListedProject,
} from '@/hooks/queries/useProjectsListQuery'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from '@/hooks/settings/useShowPublishingTools'
import { useProjectsScreenStore } from '../../store/projectsScreenStore'
import { useProjectStore } from '../../store/projectStore'
import { useGitStore } from '../../store/gitStore'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'

/**
 * The Projects screen: every project opened before, like an editor's Open
 * Recent. Search, open one, show its folder, or take it off the list (its
 * files are left alone). A project whose folder has gone says so
 */
export function ProjectsDialog() {
  const open = useProjectsScreenStore(state => state.isOpen)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) useProjectsScreenStore.getState().close()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {open && <ProjectsList />}
      </DialogContent>
    </Dialog>
  )
}

function ProjectsList() {
  const queryClient = useQueryClient()
  const projects = useProjectsListQuery(true)
  const currentPath = useProjectStore(state => state.projectPath)
  const publishingTools = useShowPublishingTools()
  const platform = usePlatform()
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)

  const matches = filterProjects(projects.data ?? [], search)
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0))
  const close = () => useProjectsScreenStore.getState().close()

  const openProject = (project: ListedProject) => {
    if (!project.folderExists) return
    if (project.path === currentPath) {
      close()
      return
    }
    void folderStates([project.path]).then(([state]) => {
      if (state !== 'present') {
        // Gone since the list was read: show it as not found
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectsList })
        return
      }
      close()
      useProjectStore.getState().setProject(project.path)
    })
  }

  const removeProject = (project: ListedProject) => {
    void projectRegistryManager
      .removeProject(project.id)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.projectsList })
      )
      .catch((reason: unknown) => {
        toast.error("Couldn't remove the project from the list")
        void logError(
          `Astro Editor [PROJECTS] Removing ${project.id} failed: ${String(reason)}`
        )
      })
  }

  const revealProject = (project: ListedProject) => {
    void revealItemInDir(project.path).catch((reason: unknown) => {
      void logError(
        `Astro Editor [PROJECTS] Revealing ${project.path} failed: ${String(reason)}`
      )
    })
  }

  const openAnother = () => {
    close()
    void openProjectViaDialog()
  }

  const openFromGitHub = () => {
    close()
    useGitStore.getState().setOpenFromGitHubOpen(true)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(activeIndex + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const project = matches[activeIndex]
      if (project) openProject(project)
    }
  }

  const rowId = (index: number) => `projects-row-${index}`
  const total = projects.data?.length ?? 0

  return (
    <div className="min-w-0 space-y-4">
      <DialogHeader>
        <DialogTitle>Projects</DialogTitle>
        <DialogDescription>
          Sites you&apos;ve opened before. Removing one from this list leaves
          its files alone.
        </DialogDescription>
      </DialogHeader>

      <Input
        aria-label="Search projects"
        placeholder="Search by name or folder"
        value={search}
        onChange={event => {
          setSearch(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        aria-controls="projects-list"
        aria-activedescendant={
          matches.length > 0 ? rowId(activeIndex) : undefined
        }
        autoFocus
      />

      <div
        id="projects-list"
        className="h-72 overflow-y-auto rounded-md border p-1"
        role="listbox"
        aria-label="Projects"
      >
        {projects.isPending ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading your projects…
          </div>
        ) : matches.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {total === 0
              ? 'No projects yet. Open a site folder to start.'
              : 'No projects match.'}
          </p>
        ) : (
          matches.map((project, index) => (
            <ProjectRow
              key={project.id}
              id={rowId(index)}
              project={project}
              isActive={index === activeIndex}
              isCurrent={project.path === currentPath}
              revealLabel={getPlatformString('revealInFileManager', platform)}
              onHover={() => setActive(index)}
              onOpen={() => openProject(project)}
              onReveal={() => revealProject(project)}
              onRemove={() => removeProject(project)}
            />
          ))
        )}
      </div>

      <DialogFooter>
        {publishingTools && (
          <Button variant="outline" onClick={openFromGitHub}>
            Open from GitHub
          </Button>
        )}
        <Button onClick={openAnother}>
          <FolderOpen /> Open Project…
        </Button>
      </DialogFooter>
    </div>
  )
}

function ProjectRow({
  id,
  project,
  isActive,
  isCurrent,
  revealLabel,
  onHover,
  onOpen,
  onReveal,
  onRemove,
}: {
  id: string
  project: ListedProject
  isActive: boolean
  isCurrent: boolean
  revealLabel: string
  onHover: () => void
  onOpen: () => void
  onReveal: () => void
  onRemove: () => void
}) {
  const missing = !project.folderExists
  const opened = formatRelativeTime(new Date(project.lastOpened))
  return (
    <div
      id={id}
      role="option"
      aria-selected={isActive}
      aria-disabled={missing}
      onMouseEnter={onHover}
      className={cn(
        'flex min-h-11 items-center gap-2 rounded px-2 py-1.5 text-sm',
        isActive && 'bg-accent'
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        disabled={missing}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
      >
        {missing ? (
          <FolderX className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen className="size-4 shrink-0 text-icon" />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate font-medium',
              missing ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {folderName(project.path)}
          </span>
          <span
            className="block truncate text-xs text-muted-foreground"
            title={project.path}
          >
            {shortenMiddle(shortenHome(project.path), 64)}
          </span>
        </span>
        {(missing || !isActive || isCurrent) && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {missing
              ? 'Folder not found — is its drive connected?'
              : isCurrent
                ? 'Open now'
                : `Opened ${opened}`}
          </span>
        )}
      </button>
      {(missing || isActive) && (
        <div className="flex shrink-0 gap-1">
          {!missing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onReveal}
            >
              {revealLabel}
            </Button>
          )}
          {!isCurrent && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onRemove}
            >
              Remove from list
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
