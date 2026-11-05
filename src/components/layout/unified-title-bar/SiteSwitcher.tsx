import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { folderName } from '@/lib/projects/recent'
import { recentSites } from '@/lib/projects/home'
import { formatRelativeTime } from '@/lib/dates'
import { getPlatformString } from '@/lib/platform-strings'
import { usePlatform } from '@/hooks/usePlatform'
import { goHome, openProjectViaDialog, openSite } from '@/lib/projects/actions'
import { useShowPublishingTools } from '@/hooks/settings/useShowPublishingTools'
import { useProjectsListQuery } from '@/hooks/queries/useProjectsListQuery'
import { useGitStore } from '@/store/gitStore'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu'
import { SiteThumb } from '../../home/SiteCard'

/**
 * The open site's name in the title bar. It's a button: its menu lists the
 * recent sites, leads back Home and adds a site
 */
export function SiteSwitcher({ projectPath }: { projectPath: string }) {
  const platform = usePlatform()
  const publishingTools = useShowPublishingTools()
  const [open, setOpen] = useState(false)
  // Read when the menu opens: it checks every site's folder
  const projects = useProjectsListQuery(open)
  const recent = recentSites(projects.data ?? [])
  const name = folderName(projectPath)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${name}, switch site`}
            className="h-7 max-w-64 gap-1 px-2 text-xs font-normal text-muted-foreground"
          />
        }
      >
        <span className="truncate">{name}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {recent.map(site => {
          const current = site.path === projectPath
          return (
            <DropdownMenuItem
              key={site.id}
              disabled={!site.folderExists}
              onClick={() => {
                if (!current) void openSite(site.path)
              }}
              className="gap-2.5"
            >
              <SiteThumb
                project={site}
                className="size-8 shrink-0 rounded-sm border text-xs"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {folderName(site.path)}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {!site.folderExists
                    ? 'Folder not found'
                    : current
                      ? 'Open now'
                      : `Edited ${formatRelativeTime(new Date(site.lastOpened))}`}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
        {recent.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => void goHome()}>
          All sites (Home)
          <DropdownMenuShortcut>
            {getPlatformString('homeShortcut', platform)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openProjectViaDialog()}>
          Open a folder…
        </DropdownMenuItem>
        {publishingTools && (
          <DropdownMenuItem
            onClick={() => useGitStore.getState().setOpenFromGitHubOpen(true)}
          >
            Open from GitHub…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
