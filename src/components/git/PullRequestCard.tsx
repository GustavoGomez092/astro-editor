import { useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  CircleCheck,
  CircleDot,
  CircleX,
  ExternalLink,
  GitPullRequest,
} from 'lucide-react'
import type { PullRequest } from '@/lib/bindings'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Spinner } from '../ui/spinner'

const CHECKS: Record<
  Exclude<PullRequest['checks'], 'none'>,
  { label: string; Icon: typeof CircleCheck; className: string }
> = {
  success: {
    label: 'Checks passed',
    Icon: CircleCheck,
    className: 'text-git-add',
  },
  pending: {
    label: 'Checks running',
    Icon: CircleDot,
    className: 'text-draft',
  },
  failure: { label: 'Checks failed', Icon: CircleX, className: 'text-git-del' },
}

interface PullRequestCardProps {
  pr: PullRequest
  onMerge: () => void
  merging?: boolean
}

/**
 * The open pull request for the current branch: what it merges into, its
 * checks, and Merge (after a confirmation, since the default branch usually
 * goes live) or View on GitHub.
 */
export function PullRequestCard({
  pr,
  onMerge,
  merging,
}: PullRequestCardProps) {
  const [confirming, setConfirming] = useState(false)
  const checks = pr.checks === 'none' ? null : CHECKS[pr.checks]
  const blocked = pr.draft || pr.mergeable === false

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <GitPullRequest className="mt-0.5 size-4 shrink-0 text-git-add" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-sm leading-snug font-medium text-foreground">
            {pr.title}
          </div>
          <div className="text-xs text-muted-foreground">
            #{pr.number} · {pr.head} into {pr.base}
            {pr.draft && ' · Draft'}
          </div>
        </div>
      </div>

      {checks && (
        <div className="flex items-center gap-1.5 text-xs text-foreground">
          <checks.Icon className={cn('size-3.5', checks.className)} />
          {checks.label}
        </div>
      )}
      {pr.mergeable === false && (
        <p className="text-xs text-muted-foreground">
          This can't be merged automatically. Open it on GitHub to sort it out.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={blocked || merging}
          onClick={() => setConfirming(true)}
        >
          {merging && <Spinner />} Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => void openUrl(pr.htmlUrl)}
        >
          <ExternalLink /> View on GitHub
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge into {pr.base}?</AlertDialogTitle>
            <AlertDialogDescription>
              The changes on {pr.head} go into {pr.base}. If your site publishes
              from {pr.base}, they'll go live.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                onMerge()
              }}
            >
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
