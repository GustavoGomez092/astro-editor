import { ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  DiffHunk,
  DiffLine,
  FileChange,
  FileDiff,
} from '@/lib/git/types'

interface DiffViewProps {
  diff: FileDiff
  /** For an image: where to load the version before the change, if it existed. */
  beforeSrc?: string | null
  /** For an image: where to load the version after the change, if it exists. */
  afterSrc?: string | null
  /** How the file changed, for the image note ("New image") */
  change?: FileChange
}

const SIGNS: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: '' }

/** "Line 12" from a hunk header like "@@ -10,4 +12,6 @@". */
function hunkLabel(hunk: DiffHunk): string {
  const start = /\+(\d+)/.exec(hunk.header)?.[1]
  return start ? `Line ${start}` : hunk.header
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/**
 * A read-only, unified view of one file's changes: removed lines tinted red,
 * added lines green, with old and new line numbers. Long lines wrap, because
 * content files are mostly prose. Binary files get a short note instead, with
 * before and after thumbnails for images.
 */
export function DiffView({ diff, beforeSrc, afterSrc, change }: DiffViewProps) {
  const { dir, name } = splitPath(diff.path)

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-baseline gap-1 border-b px-4 py-2.5 text-sm">
        <span className="truncate text-muted-foreground">{dir}</span>
        <span className="shrink-0 font-medium text-foreground">{name}</span>
      </div>
      {diff.binary ? (
        <BinaryNote
          isImage={diff.isImage}
          change={change}
          beforeSrc={beforeSrc}
          afterSrc={afterSrc}
        />
      ) : diff.hunks.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No changes to show.</p>
      ) : (
        <div className="py-2 font-mono text-[13px] leading-relaxed select-text">
          {diff.hunks.map((hunk, index) => (
            <div key={`${hunk.header}-${index}`}>
              <div className="px-4 pt-3 pb-1 font-sans text-xs text-muted-foreground">
                {hunkLabel(hunk)}
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffRow key={lineIndex} line={line} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      data-testid="diff-line"
      data-kind={line.kind}
      className={cn(
        'grid grid-cols-[3rem_3rem_1.25rem_1fr]',
        line.kind === 'add' && 'bg-git-add-bg',
        line.kind === 'del' && 'bg-git-del-bg'
      )}
    >
      <span
        data-col="old"
        className="pr-2 text-right text-muted-foreground/70 select-none"
      >
        {line.oldNo ?? ''}
      </span>
      <span
        data-col="new"
        className="pr-2 text-right text-muted-foreground/70 select-none"
      >
        {line.newNo ?? ''}
      </span>
      <span
        aria-hidden
        className={cn(
          'text-center select-none',
          line.kind === 'add' && 'text-git-add',
          line.kind === 'del' && 'text-git-del'
        )}
      >
        {SIGNS[line.kind]}
      </span>
      <span className="pr-4 break-words whitespace-pre-wrap text-foreground">
        {line.text}
      </span>
    </div>
  )
}

const IMAGE_NOTES: Partial<Record<FileChange, string>> = {
  added: 'New image',
  untracked: 'New image',
  deleted: 'Image deleted',
}

function BinaryNote({
  isImage,
  change,
  beforeSrc,
  afterSrc,
}: {
  isImage: boolean
  change?: FileChange
  beforeSrc?: string | null
  afterSrc?: string | null
}) {
  if (!isImage) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This file changed, but its contents can't be shown as text.
      </p>
    )
  }
  return (
    <div className="space-y-4 p-6">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <ImageIcon className="size-4 text-icon" />
        {(change && IMAGE_NOTES[change]) ?? 'Image changed'}
      </p>
      {(beforeSrc || afterSrc) && (
        <div className="flex flex-wrap gap-6">
          {beforeSrc && <Thumbnail src={beforeSrc} label="Before" />}
          {afterSrc && <Thumbnail src={afterSrc} label="After" />}
        </div>
      )}
    </div>
  )
}

function Thumbnail({ src, label }: { src: string; label: string }) {
  return (
    <figure className="space-y-1.5">
      <img
        src={src}
        alt={label}
        className="max-h-48 max-w-64 rounded-md border bg-muted object-contain"
      />
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  )
}
