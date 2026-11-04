import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { formatRelativeTime } from '@/lib/dates'
import { getPlatformString } from '@/lib/platform-strings'
import { folderName, shortenHome } from '@/lib/projects/recent'
import { siteInitial } from '@/lib/projects/home'
import {
  openSite,
  refreshSitePreview,
  removeSite,
  showSiteInFileManager,
} from '@/lib/projects/actions'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import { useShowPublishingTools } from '@/hooks/settings/useShowPublishingTools'
import { useGitHubRepoInfoQuery } from '@/hooks/queries/useGitHubRepoInfoQuery'
import { useProjectPreviewQuery } from '@/hooks/queries/useProjectPreviewQuery'
import type { ListedProject } from '@/hooks/queries/useProjectsListQuery'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Spinner } from '../ui/spinner'

/** A site's picture, or its initial when there isn't one */
export function SiteThumb({
  project,
  className,
}: {
  project: ListedProject
  className?: string
}) {
  const preview = useProjectPreviewQuery(project.path, project.folderExists)
  const src = preview.data?.src
  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden bg-muted text-muted-foreground',
        className
      )}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover object-top" />
      ) : (
        <span className="font-semibold">{siteInitial(project.path)}</span>
      )}
    </div>
  )
}

/**
 * One site on Home. The whole card is a button that opens the site; the ⋯
 * menu beside it has the other actions
 */
export function SiteCard({ project }: { project: ListedProject }) {
  const platform = usePlatform()
  const publishingTools = useShowPublishingTools()
  const [refreshing, setRefreshing] = useState(false)
  const missing = !project.folderExists
  const onGitHub =
    useGitHubRepoInfoQuery(missing ? null : project.path).data != null
  const name = folderName(project.path)

  const refresh = () => {
    setRefreshing(true)
    void refreshSitePreview(project.path).then(() => setRefreshing(false))
  }

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground transition-shadow',
        missing ? 'opacity-70' : 'hover:shadow-md'
      )}
    >
      <button
        type="button"
        data-site-card
        aria-disabled={missing}
        aria-busy={refreshing}
        onClick={() => {
          if (!missing) void openSite(project.path)
        }}
        className={cn(
          'flex flex-1 flex-col text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
          missing && 'cursor-default'
        )}
      >
        <span className="relative block w-full">
          <SiteThumb
            project={project}
            className="aspect-[1.9/1] w-full border-b text-4xl"
          />
          {refreshing && (
            <span className="absolute inset-0 flex items-center justify-center gap-2 bg-background/70 text-sm text-foreground">
              <Spinner /> Updating preview…
            </span>
          )}
        </span>
        <span className="flex flex-col gap-1 px-3.5 pt-3 pb-3.5">
          <span
            className={cn(
              'truncate text-sm font-semibold',
              missing && 'text-muted-foreground'
            )}
          >
            {name}
          </span>
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={project.path}
          >
            {shortenHome(project.path)}
          </span>
          {missing ? (
            <span className="text-xs text-draft">
              Folder not found. Is its drive connected?
            </span>
          ) : (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Edited {formatRelativeTime(new Date(project.lastOpened))}
              </span>
              {onGitHub && (
                <span className="flex items-center gap-1.5 before:size-1 before:rounded-full before:bg-muted-foreground/60">
                  GitHub
                </span>
              )}
            </span>
          )}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`More actions for ${name}`}
              className="absolute top-2 right-2 size-7 bg-background/90 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {!missing && (
            <DropdownMenuItem onClick={() => void openSite(project.path)}>
              Open
            </DropdownMenuItem>
          )}
          {!missing && (
            <DropdownMenuItem
              onClick={() => void showSiteInFileManager(project.path)}
            >
              {getPlatformString('showInFileManager', platform)}
            </DropdownMenuItem>
          )}
          {!missing && publishingTools && (
            <DropdownMenuItem disabled={refreshing} onClick={refresh}>
              Refresh preview
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void removeSite(project.id)}>
            Remove from list
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
