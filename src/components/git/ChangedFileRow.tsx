import { Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangedFile } from '@/lib/bindings'
import { FileChangeIcon, fileChangeLabel } from './FileChangeIcon'

/**
 * One changed file in a list: its change icon and its entry title, or its
 * file name and folder; the full path is in the tooltip. Clicking it opens the
 * file's diff. With `onDiscard`, a button on the row throws its changes
 * away; the caller confirms first. A rename has no Discard: it's two paths,
 * and putting one back would leave the other behind.
 */
export function ChangedFileRow({
  file,
  title,
  selected,
  onSelect,
  onDiscard,
  discardDisabled,
}: {
  file: ChangedFile
  /** The entry's title, when the file is a content entry */
  title?: string
  selected?: boolean
  onSelect?: (path: string) => void
  onDiscard?: (path: string) => void
  discardDisabled?: boolean
}) {
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const dir = slash === -1 ? '' : file.path.slice(0, slash)
  const folder = dir.slice(dir.lastIndexOf('/') + 1)
  return (
    <div
      className={cn(
        'group flex w-full items-center rounded-md transition-colors',
        selected ? 'bg-primary/15 hover:bg-primary/20' : 'hover:bg-accent'
      )}
    >
      <button
        type="button"
        aria-current={selected || undefined}
        title={`${fileChangeLabel(file.change)}: ${file.path}`}
        onClick={() => onSelect?.(file.path)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
      >
        <FileChangeIcon change={file.change} />
        <span
          className={cn(
            'min-w-0 truncate text-foreground',
            file.change === 'deleted' && 'text-muted-foreground line-through'
          )}
        >
          {title ?? name}
        </span>
        {!title && folder && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {folder}
          </span>
        )}
      </button>
      {onDiscard && file.change !== 'renamed' && (
        <button
          type="button"
          title="Discard changes"
          aria-label={`Discard changes to ${title ?? name}`}
          disabled={discardDisabled}
          onClick={() => onDiscard(file.path)}
          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-icon hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Undo2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}
