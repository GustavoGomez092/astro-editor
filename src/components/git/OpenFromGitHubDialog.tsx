import { useState } from 'react'
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
import { markSitePrepared, prepareSite } from '@/lib/dev-server/prepare'
import { startGitHubSignIn } from '@/lib/git/sign-in'
import { formatRelativeTime } from '@/lib/dates'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useGitStore } from '../../store/gitStore'
import { useProjectStore } from '../../store/projectStore'
import { useGitHubAuthQuery } from '../../hooks/queries/useGitHubAuthQuery'
import {
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

  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<Choice | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  // After the download: installing and reading the collections
  const [preparing, setPreparing] = useState(false)
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
  const matches = filterRepos(repos.data ?? [], pasted ? '' : search)
  const selection = chosen ?? pasted
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
    setCloning(true)
    setError(null)
    setProgress(null)
    const name = folderNameFrom(selection.cloneUrl)
    void cloneRepository(selection.cloneUrl, parentDir, setProgress)
      .then(async projectPath => {
        // Before opening it, so its forms have their schemas at once
        setPreparing(true)
        markSitePrepared(projectPath)
        const prepared = await prepareSite(projectPath)
        setPreparing(false)
        setCloning(false)
        useProjectStore.getState().setProject(projectPath)
        if (prepared) {
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
        setPreparing(false)
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
          <p className="p-3 text-sm text-muted-foreground">
            {search ? 'No repositories match.' : 'No repositories yet.'}
          </p>
        ) : (
          matches.map(repo => (
            <RepoRow
              key={repo.fullName}
              repo={repo}
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
          {destination ? shortenMiddle(shortenHome(destination), 44) : '…'}
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
                (percent === null || preparing) && 'w-1/3 animate-pulse'
              )}
              style={
                percent === null || preparing
                  ? undefined
                  : { width: `${percent}%` }
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {preparing
              ? 'Preparing your site…'
              : `Downloading${percent === null ? '…' : ` ${percent}%`}`}
          </p>
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
  selected,
  disabled,
  onSelect,
}: {
  repo: RepoSummary
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <RepoOption selected={selected} disabled={disabled} onSelect={onSelect}>
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">{repo.owner}/</span>
        <span className="font-medium text-foreground">{repo.name}</span>
      </span>
      {repo.private && (
        <Lock
          aria-label="Private"
          className="size-3 shrink-0 text-muted-foreground"
        />
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {formatRelativeTime(new Date(repo.updatedAt))}
      </span>
    </RepoOption>
  )
}
