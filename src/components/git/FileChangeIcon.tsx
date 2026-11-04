import {
  ArrowRight,
  CircleAlert,
  Minus,
  PenLine,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileChange } from '@/lib/git/types'

const CHANGES: Record<
  FileChange,
  { label: string; Icon: LucideIcon; className: string }
> = {
  added: { label: 'New', Icon: Plus, className: 'text-git-add' },
  untracked: { label: 'New', Icon: Plus, className: 'text-git-add' },
  modified: { label: 'Edited', Icon: PenLine, className: 'text-icon' },
  renamed: { label: 'Renamed', Icon: ArrowRight, className: 'text-icon' },
  deleted: { label: 'Deleted', Icon: Minus, className: 'text-git-del' },
  conflicted: {
    label: 'Changed in two places',
    Icon: CircleAlert,
    className: 'text-git-del',
  },
}

/** What happened to a file, in plain words, for a tooltip or screen reader. */
export function fileChangeLabel(change: FileChange): string {
  return CHANGES[change].label
}

/** A small icon for how a file changed: new, edited, renamed or deleted. */
export function FileChangeIcon({
  change,
  className,
}: {
  change: FileChange
  className?: string
}) {
  const { label, Icon, className: tone } = CHANGES[change]
  return (
    <Icon
      className={cn('size-3.5 shrink-0', tone, className)}
      aria-label={label}
      role="img"
    >
      <title>{label}</title>
    </Icon>
  )
}
