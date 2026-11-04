import { formatDisplayDate } from '@/lib/dates'
import type { CommitDetails as Details } from '@/lib/bindings'
import { ChangedFileRow } from './ChangedFileRow'

interface CommitDetailsProps {
  details: Details
  selectedPath?: string | null
  onSelectFile?: (path: string) => void
}

/** Splits a commit message into its first line and the rest. */
function splitMessage(message: string): { title: string; body: string } {
  const [title = '', ...rest] = message.trim().split('\n')
  return { title, body: rest.join('\n').trim() }
}

/**
 * What one commit changed: its message, who made it and when, and the files
 * it touched. Each file opens its diff.
 */
export function CommitDetails({
  details,
  selectedPath,
  onSelectFile,
}: CommitDetailsProps) {
  const { title, body } = splitMessage(details.message || details.summary)
  const date = new Date(details.time * 1000)
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const fileCount = details.files.length

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1.5">
        <h3 className="text-sm leading-snug font-semibold text-heading select-text">
          {title}
        </h3>
        {body && (
          <p className="text-sm whitespace-pre-wrap text-foreground select-text">
            {body}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">By</dt>
        <dd className="truncate text-foreground" title={details.authorEmail}>
          {details.authorName}
        </dd>
        <dt className="text-muted-foreground">On</dt>
        <dd className="text-foreground">
          {formatDisplayDate(date)}, {time}
        </dd>
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="font-mono text-foreground select-text">
          {details.shortId}
        </dd>
      </dl>
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">
          {fileCount === 1 ? '1 file changed' : `${fileCount} files changed`}
        </div>
        <div className="-mx-2">
          {details.files.map(file => (
            <ChangedFileRow
              key={file.path}
              file={file}
              selected={file.path === selectedPath}
              onSelect={onSelectFile}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
