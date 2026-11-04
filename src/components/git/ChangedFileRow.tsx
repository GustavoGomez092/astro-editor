import { cn } from '@/lib/utils'
import type { ChangedFile } from '@/lib/bindings'
import { FileChangeIcon, fileChangeLabel } from './FileChangeIcon'

/**
 * One changed file in a list: its change icon and its entry title, or its
 * file name and folder; the full path is in the tooltip. Clicking it opens the
 * file's diff.
 */
export function ChangedFileRow({
  file,
  title,
  selected,
  onSelect,
}: {
  file: ChangedFile
  /** The entry's title, when the file is a content entry */
  title?: string
  selected?: boolean
  onSelect?: (path: string) => void
}) {
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const dir = slash === -1 ? '' : file.path.slice(0, slash)
  const folder = dir.slice(dir.lastIndexOf('/') + 1)
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      title={`${fileChangeLabel(file.change)}: ${file.path}`}
      onClick={() => onSelect?.(file.path)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        selected ? 'bg-primary/15 hover:bg-primary/20' : 'hover:bg-accent'
      )}
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
        <span className="shrink-0 text-xs text-muted-foreground">{folder}</span>
      )}
    </button>
  )
}
