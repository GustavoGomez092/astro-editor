import { useState } from 'react'
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
import { Label } from '../ui/label'
import { Spinner } from '../ui/spinner'
import { AutoExpandingTextarea } from '../ui/auto-expanding-textarea'

interface OpenPullRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  branch: string
  defaultBranch: string
  /** The suggested title (`pullRequestTitle`) */
  defaultTitle: string
  onSubmit: (title: string, body: string) => void
  pending?: boolean
}

/**
 * Asks for a pull request's title and description. It always merges the
 * current branch into the default branch.
 */
export function OpenPullRequestDialog({
  open,
  onOpenChange,
  branch,
  defaultBranch,
  defaultTitle,
  onSubmit,
  pending,
}: OpenPullRequestDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Remounted on each open, so the fields start fresh */}
        {open && (
          <PullRequestForm
            branch={branch}
            defaultBranch={defaultBranch}
            defaultTitle={defaultTitle}
            onCancel={() => onOpenChange(false)}
            onSubmit={onSubmit}
            pending={pending}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PullRequestForm({
  branch,
  defaultBranch,
  defaultTitle,
  onCancel,
  onSubmit,
  pending,
}: {
  branch: string
  defaultBranch: string
  defaultTitle: string
  onCancel: () => void
  onSubmit: (title: string, body: string) => void
  pending?: boolean
}) {
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState('')
  const canSubmit = title.trim() !== '' && !pending

  return (
    <form
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault()
        if (canSubmit) onSubmit(title.trim(), body.trim())
      }}
    >
      <DialogHeader>
        <DialogTitle>Open pull request</DialogTitle>
        <DialogDescription>
          Ask to merge {branch} into {defaultBranch}. You can review it on
          GitHub before merging.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="pr-title">Title</Label>
        <Input
          id="pr-title"
          value={title}
          onChange={event => setTitle(event.target.value)}
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pr-body">Description</Label>
        <AutoExpandingTextarea
          id="pr-body"
          value={body}
          onChange={event => setBody(event.target.value)}
          placeholder="What changed, and anything to check (optional)"
          minRows={3}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {pending && <Spinner />} Open pull request
        </Button>
      </DialogFooter>
    </form>
  )
}
