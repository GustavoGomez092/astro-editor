import { useRef, useState } from 'react'
import { FolderOpen, Download } from 'lucide-react'
import { filterProjects } from '@/lib/projects/recent'
import { greetingFor, nextCardIndex, showSearch } from '@/lib/projects/home'
import { openProjectViaDialog } from '@/lib/projects/actions'
import { useNow } from '@/hooks/useNow'
import { usePlatform } from '@/hooks/usePlatform'
import { useProjectPreviewEvents } from '@/hooks/useProjectPreviewEvents'
import { useShowPublishingTools } from '@/hooks/settings/useShowPublishingTools'
import { useGitHubAuthQuery } from '@/hooks/queries/useGitHubAuthQuery'
import { useProjectsListQuery } from '@/hooks/queries/useProjectsListQuery'
import { useProjectStore } from '@/store/projectStore'
import { useGitStore } from '@/store/gitStore'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SiteCard } from './SiteCard'

const openFromGitHub = () => useGitStore.getState().setOpenFromGitHubOpen(true)

/**
 * The screen the app opens on: a greeting and the writer's sites as cards.
 * With no sites yet it explains the two ways to start instead
 */
export function HomeScreen() {
  useProjectPreviewEvents()
  const registryLoaded = useProjectStore(state => state.globalSettings != null)
  const projects = useProjectsListQuery(true)
  const sites = projects.data ?? []
  const loading = !registryLoaded || projects.isPending

  return (
    <div
      className="h-full overflow-y-auto bg-background"
      data-testid="home-screen"
    >
      <div className="mx-auto w-full max-w-[880px] px-8 py-16">
        {loading ? null : sites.length === 0 ? <FirstLaunch /> : <Sites />}
      </div>
    </div>
  )
}

function Heading({ title, lede }: { title: string; lede: string }) {
  return (
    <>
      <h1 className="m-0 text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 mb-0 text-base text-muted-foreground">{lede}</p>
    </>
  )
}

function Sites() {
  const platform = usePlatform()
  const publishingTools = useShowPublishingTools()
  const name = useGitHubAuthQuery().data?.name
  const now = useNow(60_000)
  const projects = useProjectsListQuery(true)
  const [search, setSearch] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)

  const all = projects.data ?? []
  const sites = filterProjects(all, search)

  // Arrow keys move between the cards (Tab still visits each one)
  const onKeyDown = (event: React.KeyboardEvent) => {
    const cards = Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>('[data-site-card]') ?? []
    )
    const index = cards.findIndex(card => card === document.activeElement)
    if (index === -1 || cards.length === 0) return
    const columns = cards.filter(
      card =>
        card.parentElement?.offsetTop === cards[0]?.parentElement?.offsetTop
    ).length
    const next = nextCardIndex(index, cards.length, columns, event.key)
    if (next === null) return
    event.preventDefault()
    cards[next]?.focus()
  }

  return (
    <>
      <Heading
        title={greetingFor(new Date(now), name)}
        lede="Pick a site to keep editing."
      />

      <div className="mt-10 mb-4 flex items-center justify-between gap-4">
        <h2 className="m-0 text-sm font-medium text-muted-foreground">
          Your sites
        </h2>
        {showSearch(all.length) && (
          <Input
            type="search"
            aria-label="Search sites"
            placeholder="Search sites"
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="max-w-60"
          />
        )}
      </div>

      <div
        ref={gridRef}
        onKeyDown={onKeyDown}
        className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
      >
        {sites.map(project => (
          <SiteCard key={project.id} project={project} />
        ))}
        {search === '' && (
          <div className="flex flex-col gap-2 rounded-xl border border-dashed p-5">
            <strong className="text-sm font-semibold">Add a site</strong>
            <p className="m-0 mb-1 text-xs text-muted-foreground">
              From a folder on this Mac, or download one from GitHub.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openProjectViaDialog()}
            >
              Open a folder…
            </Button>
            {publishingTools && (
              <Button variant="outline" size="sm" onClick={openFromGitHub}>
                Open from GitHub…
              </Button>
            )}
          </div>
        )}
      </div>

      {sites.length === 0 && (
        <p className="text-sm text-muted-foreground">No sites match.</p>
      )}

      <p className="mt-8 text-xs text-muted-foreground">
        Tip: press{' '}
        <kbd className="rounded border bg-muted px-1 font-sans">
          {platform === 'macos' ? '⌘K' : 'Ctrl+K'}
        </kbd>{' '}
        and type “Projects” to switch sites from anywhere.
      </p>
    </>
  )
}

function FirstLaunch() {
  const publishingTools = useShowPublishingTools()
  return (
    <div className="mx-auto max-w-xl pt-8">
      <Heading
        title="Welcome to Astro Editor+"
        lede="Edit your Astro site's words and pictures, then publish them. Start by opening your site."
      />
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {publishingTools && (
          <button
            type="button"
            onClick={openFromGitHub}
            className="flex flex-col items-start gap-1.5 rounded-xl border bg-card p-5 text-left transition-shadow outline-none hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Download className="mb-1 size-5 text-icon" aria-hidden="true" />
            <strong className="text-sm font-semibold">Open from GitHub</strong>
            <span className="text-sm text-muted-foreground">
              Sign in with GitHub and pick your site. It's downloaded and made
              ready to edit.
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => void openProjectViaDialog()}
          className="flex flex-col items-start gap-1.5 rounded-xl border bg-card p-5 text-left transition-shadow outline-none hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FolderOpen className="mb-1 size-5 text-icon" aria-hidden="true" />
          <strong className="text-sm font-semibold">Open a folder</strong>
          <span className="text-sm text-muted-foreground">
            Already have your site on this Mac? Choose its folder.
          </span>
        </button>
      </div>
      <p className="mt-8 text-xs text-muted-foreground">
        Your sites will show up here as cards, so next time you can open one
        with a click.
      </p>
    </div>
  )
}
