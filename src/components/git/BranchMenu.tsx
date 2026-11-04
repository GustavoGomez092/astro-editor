import { useState } from 'react'
import {
  Check,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Plus,
} from 'lucide-react'
import type { BranchInfo, PullRequest } from '@/lib/bindings'
import { branchNameFrom } from '@/lib/git/changes'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

interface BranchMenuProps {
  current: string | null
  branches: BranchInfo[]
  /** Open pull requests for the repository */
  pullRequests: PullRequest[]
  onSwitch: (name: string) => void
  onNewBranch: () => void
  disabled?: boolean
}

/** Remote branches that have no local branch of the same name. */
function remoteOnly(branches: BranchInfo[]): BranchInfo[] {
  const local = new Set(branches.filter(b => !b.isRemote).map(b => b.name))
  return branches.filter(
    b =>
      b.isRemote &&
      !b.name.endsWith('/HEAD') &&
      !local.has(b.name.slice(b.name.indexOf('/') + 1))
  )
}

/**
 * The current branch, as a menu: switch to another branch (including ones only
 * on GitHub), start a new one, or go to a pull request's branch.
 */
export function BranchMenu({
  current,
  branches,
  pullRequests,
  onSwitch,
  onNewBranch,
  disabled,
}: BranchMenuProps) {
  const local = branches
    .filter(b => !b.isRemote)
    .sort((a, b) => b.lastCommitTime - a.lastCommitTime)
  const remote = remoteOnly(branches)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-full min-w-0 gap-1.5 px-2 font-medium text-foreground"
            title="Switch branch"
          />
        }
      >
        <GitBranch className="size-3.5 text-icon" />
        <span className="truncate">{current ?? 'No branch'}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Branches</DropdownMenuLabel>
          {local.map(branch => (
            <DropdownMenuItem
              key={branch.name}
              onClick={() => {
                if (branch.name !== current) onSwitch(branch.name)
              }}
            >
              <Check
                className={
                  branch.name === current ? 'opacity-100' : 'opacity-0'
                }
              />
              <span className="truncate">{branch.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {remote.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Only on GitHub</DropdownMenuLabel>
            {remote.map(branch => (
              <DropdownMenuItem
                key={branch.name}
                onClick={() =>
                  onSwitch(branch.name.slice(branch.name.indexOf('/') + 1))
                }
              >
                <GitBranch className="opacity-60" />
                <span className="truncate">
                  {branch.name.slice(branch.name.indexOf('/') + 1)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onNewBranch}>
          <Plus /> New branch…
        </DropdownMenuItem>
        {pullRequests.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Pull requests</DropdownMenuLabel>
              {pullRequests.map(pr => (
                <DropdownMenuItem
                  key={pr.number}
                  onClick={() => {
                    if (pr.head !== current) onSwitch(pr.head)
                  }}
                  title={`${pr.head} into ${pr.base}`}
                >
                  <GitPullRequest className="text-git-add" />
                  <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                  <span className="text-xs text-muted-foreground">
                    #{pr.number}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface NewBranchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The branch the new one starts from */
  from: string | null
  onCreate: (name: string) => void
}

/** Names a new branch, which starts from the current one with its changes. */
export function NewBranchDialog({
  open,
  onOpenChange,
  from,
  onCreate,
}: NewBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <NewBranchForm
            from={from}
            onCancel={() => onOpenChange(false)}
            onCreate={onCreate}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function NewBranchForm({
  from,
  onCancel,
  onCreate,
}: {
  from: string | null
  onCancel: () => void
  onCreate: (name: string) => void
}) {
  const [input, setInput] = useState('')
  const name = branchNameFrom(input)
  return (
    <form
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault()
        if (name) onCreate(name)
      }}
    >
      <DialogHeader>
        <DialogTitle>New branch</DialogTitle>
        <DialogDescription>
          A separate line of work{from ? `, starting from ${from}` : ''}. Your
          unpublished changes come with you.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="branch-name">Name</Label>
        <Input
          id="branch-name"
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="spring-update"
          autoFocus
        />
        {input && name !== input.trim() && (
          <p className="text-xs text-muted-foreground">
            It will be called <span className="font-mono">{name || '…'}</span>
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name}>
          Create branch
        </Button>
      </DialogFooter>
    </form>
  )
}
