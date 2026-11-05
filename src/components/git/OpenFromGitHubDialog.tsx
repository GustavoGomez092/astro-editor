import { useRef, useState } from 'react'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { error as logError } from '@tauri-apps/plugin-log'
import { Link2, Lock } from 'lucide-react'
import type { CloneProgress, RepoSummary } from '@/lib/bindings'
import {
  cloneProgressPercent,
  cloneRepository,
  cloneUrlFromInput,
  filterRepos,
  shortenMiddle,
} from '@/lib/git/clone'
import {
  loadShowAll,
  saveShowAll,
  visibleRepos,
  type SiteStatus,
} from '@/lib/git/astro-sites'
import {
  isAstroSite,
  markSitePrepared,
  prepareSite,
} from '@/lib/dev-server/prepare'
import { commands } from '@/lib/bindings'
import { startGitHubSignIn } from '@/lib/git/sign-in'
import { openSite } from '@/lib/projects/actions'
import { formatRelativeTime } from '@/lib/dates'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useGitStore } from '../../store/gitStore'
import { useGitHubAuthQuery } from '../../hooks/queries/useGitHubAuthQuery'
import {
  useAstroSiteStatus,
  useGitHubReposQuery,
  useSitesFolderQuery,
} from '../../hooks/queries/useGitHubReposQuery'
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
import { Switch } from '../ui/switch'

/** What to clone: a repository from the list, or a pasted link. */
interface Choice {
  label: string
  cloneUrl: string
}

/** "/Users/kevin/Sites" → "~/Sites" */
function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function folderNameFrom(cloneUrl: string): string {
  return (
    cloneUrl
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') ?? 'site'
  )
}

/**
 * Open from GitHub: pick one of the writer's repositories (or paste a link),
 * choose where it goes (~/Sites by default), download it and open it as the
 * project. Before it opens, the site is prepared (dependencies installed,
 * `astro sync` run) so its forms have their schemas at once.
 */
export function OpenFromGitHubDialog() {
  const open = useGitStore(state => state.openFromGitHubOpen)
  const close = () => useGitStore.getState().setOpenFromGitHubOpen(false)
  // Closing mid-download would lose what happened to it
  const requestClose = () => {
    if (!useGitStore.getState().cloneInProgress) close()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) requestClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {open && <OpenFromGitHubForm onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function OpenFromGitHubForm({ onDone }: { onDone: () => void }) {
  const auth = useGitHubAuthQuery()
  const signedIn = auth.data?.signedIn ?? false
  const repos = useGitHubReposQuery(signedIn)
  const defaultFolder = useSitesFolderQuery().data ?? null
  // Astro sites only, unless the writer chose to see everything (remembered)
  const [showAll, setShowAll] = useState(loadShowAll)
  const changeShowAll = (value: boolean) => {
    setShowAll(value)
    saveShowAll(value)
  }
  const statusOf = useAstroSiteStatus(repos.data ?? [], signedIn)

  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<Choice | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  // After the download: the project being prepared (installing, reading the
  // collections), which the writer can skip
  const [preparing, setPreparing] = useState<string | null>(null)
  const skippedRef = useRef(false)
  const skipPreparing = () => {
    if (!preparing) return
    skippedRef.current = true
    void commands.devServerStop(preparing)
  }
  const cloning = useGitStore(state => state.cloneInProgress)
  const setCloning = (value: boolean) =>
    useGitStore.getState().setCloneInProgress(value)
  const [error, setError] = useState<string | null>(null)

  const parentDir = folder ?? defaultFolder
  const pastedUrl = cloneUrlFromInput(search)
  const pasted: Choice | null = pastedUrl
    ? {
        label: pastedUrl.replace(/^https:\/\/github\.com\/|\.git$/g, ''),
        cloneUrl: pastedUrl,
      }
    : null
  const matches = filterRepos(
    visibleRepos(repos.data ?? [], statusOf, showAll, chosen?.cloneUrl ?? null),
    pasted ? '' : search
  )
  const selection = chosen ?? pasted
  const stillChecking = (repos.data ?? []).some(r => statusOf(r) === 'checking')
  // Said aloud when the check finishes or the switch changes, so the list
  // changing isn't a surprise. Not affected by the search box or the pick.
  const listed = visibleRepos(repos.data ?? [], statusOf, showAll)
  const unchecked = listed.filter(r => statusOf(r) === 'unknown').length
  const listStatus =
    repos.data && !stillChecking
      ? showAll
        ? `Showing all ${listed.length} repositories`
        : `Showing ${listed.length} Astro ${listed.length === 1 ? 'site' : 'sites'}${
            unchecked > 0 ? ` (${unchecked} couldn't be checked)` : ''
          }`
      : ''
  const destination =
    parentDir && selection
      ? `${parentDir}/${folderNameFrom(selection.cloneUrl)}`
      : parentDir

  const chooseFolder = () => {
    void pickFolder({
      directory: true,
      defaultPath: parentDir ?? undefined,
      title: 'Choose where to save the site',
    })
      .then(picked => {
        if (typeof picked === 'string') setFolder(picked)
      })
      .catch((reason: unknown) => {
        void logError(
          `Astro Editor [GIT] Folder picker failed: ${String(reason)}`
        )
      })
  }

  const startClone = () => {
    if (!selection || !parentDir) return
    skippedRef.current = false
    setCloning(true)
    setError(null)
    setProgress(null)
    const name = folderNameFrom(selection.cloneUrl)
    void cloneRepository(selection.cloneUrl, parentDir, setProgress)
      .then(async projectPath => {
        markSitePrepared(projectPath)
        // Before opening an Astro site, so its forms have their schemas at once
        let prepared = true
        if (await isAstroSite(projectPath)) {
          setPreparing(projectPath)
          prepared = await prepareSite(projectPath)
        }
        const skipped = skippedRef.current
        setPreparing(null)
        setCloning(false)
        const opened = await openSite(projectPath)
        // The writer chose to stay in the site that's open
        if (!opened) {
          onDone()
          return
        }
        if (skipped) {
          toast.info(`Opened ${name}`, {
            description:
              "It wasn't prepared, so some fields may be missing until Preview runs.",
          })
        } else if (prepared) {
          toast.success(`Opened ${name}`)
        } else {
          toast.warning(`Opened ${name}, but some fields may be missing.`, {
            description:
              "Its collections couldn't be read yet. Preview's output shows why.",
          })
        }
        onDone()
      })
      .catch((reason: unknown) => {
        setPreparing(null)
        setCloning(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  if (auth.isPending) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner /> Checking your GitHub sign-in…
      </div>
    )
  }

  if (!signedIn) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Open from GitHub</DialogTitle>
          <DialogDescription>
            Sign in with GitHub to see your sites and download one to this Mac.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button onClick={() => void startGitHubSignIn()}>
            Sign in with GitHub
          </Button>
        </DialogFooter>
      </>
    )
  }

  const percent = progress ? cloneProgressPercent(progress) : null

  return (
    // min-w-0: a long folder path mustn't widen the dialog past its buttons
    <form
      className="min-w-0 space-y-4"
      onSubmit={event => {
        event.preventDefault()
        startClone()
      }}
    >
      <DialogHeader>
        <DialogTitle>Open from GitHub</DialogTitle>
        <DialogDescription>
          Download a site to this Mac and open it.
        </DialogDescription>
      </DialogHeader>

      <Input
        aria-label="Search your repositories"
        placeholder="Search your repositories, or paste a GitHub link"
        value={search}
        onChange={event => {
          setSearch(event.target.value)
          setChosen(null)
        }}
        disabled={cloning}
        autoFocus
      />

      <div className="flex items-center gap-2 text-sm">
        <Switch
          id="show-all-repos"
          checked={showAll}
          onCheckedChange={changeShowAll}
          aria-label="Show all repositories"
        />
        <label htmlFor="show-all-repos" className="cursor-pointer">
          Show all repositories
        </label>
        {!showAll && (
          <span className="text-xs text-muted-foreground">
            Showing Astro sites only
          </span>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {listStatus}
      </p>

      <div
        className="h-64 overflow-y-auto rounded-md border p-1"
        role="listbox"
        aria-label="Repositories"
      >
        {pasted && (
          <RepoOption
            selected={!chosen}
            onSelect={() => setChosen(null)}
            disabled={cloning}
          >
            <Link2 className="size-3.5 shrink-0 text-icon" />
            <span className="truncate font-medium">{pasted.label}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              From the link
            </span>
          </RepoOption>
        )}
        {repos.isPending ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading your repositories…
          </div>
        ) : repos.error ? (
          <p className="p-3 text-sm text-foreground">{repos.error.message}</p>
        ) : matches.length === 0 && !pasted ? (
          <div className="space-y-2 p-3 text-sm text-muted-foreground">
            <p>
              {showAll
                ? search
                  ? 'No repositories match.'
                  : 'No repositories yet.'
                : search
                  ? 'No Astro sites match.'
                  : 'None of your repositories look like Astro sites.'}
            </p>
            {!showAll && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => changeShowAll(true)}
              >
                Show all repositories
              </Button>
            )}
          </div>
        ) : (
          matches.map(repo => (
            <RepoRow
              key={repo.fullName}
              repo={repo}
              status={showAll ? 'astro' : statusOf(repo)}
              selected={chosen?.cloneUrl === repo.cloneUrl}
              disabled={cloning}
              onSelect={() =>
                setChosen({ label: repo.fullName, cloneUrl: repo.cloneUrl })
              }
            />
          ))
        )}
      </div>

      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="shrink-0 text-muted-foreground">Save in</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={destination ?? ''}
        >
          {destination ? shortenMiddle(shortenHome(destination), 38) : '…'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={chooseFolder}
          disabled={cloning}
        >
          Change…
        </Button>
      </div>

      {cloning && (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full bg-primary transition-[width]',
                (percent === null || preparing !== null) &&
                  'w-1/3 animate-pulse'
              )}
              style={
                percent === null || preparing !== null
                  ? undefined
                  : { width: `${percent}%` }
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {preparing
                ? 'Preparing your site…'
                : `Downloading${percent === null ? '…' : ` ${percent}%`}`}
            </p>
            {preparing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={skipPreparing}
              >
                Skip
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-foreground">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={cloning}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!selection || !parentDir || cloning}>
          {cloning && <Spinner />} Download and open
        </Button>
      </DialogFooter>
    </form>
  )
}

function RepoOption({
  selected,
  disabled,
  onSelect,
  children,
}: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
        selected ? 'bg-primary/15' : 'hover:bg-accent'
      )}
    >
      {children}
    </button>
  )
}

function RepoRow({
  repo,
  status,
  selected,
  disabled,
  onSelect,
}: {
  repo: RepoSummary
  status: SiteStatus
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <RepoOption selected={selected} disabled={disabled} onSelect={onSelect}>
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">{repo.owner}/</span>
        <span
          className={cn(
            'font-medium',
            status === 'checking' ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {repo.name}
        </span>
      </span>
      {repo.private && (
        <Lock
          aria-label="Private"
          className="size-3 shrink-0 text-muted-foreground"
        />
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {status === 'checking'
          ? 'Checking…'
          : status === 'unknown'
            ? "Couldn't check"
            : formatRelativeTime(new Date(repo.updatedAt))}
      </span>
    </RepoOption>
  )
}
