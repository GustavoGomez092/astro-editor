import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import type {
  ConflictChoice,
  ConflictFile,
  ConflictResolution,
} from '@/lib/bindings'
import {
  conflictSummary,
  lineDiff,
  type ConflictSummary,
  type DiffLine,
} from '@/lib/git/conflict-summary'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Spinner } from '../ui/spinner'

interface ResolveConflictsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The files that conflict, from `gitConflicts` */
  files: ConflictFile[]
  /** Entry titles by repository-relative path */
  titles: Map<string, string>
  /** Say "GitHub's" only when the remote is on github.com */
  onGitHub: boolean
  onCombine: (choices: ConflictResolution[]) => void
  /** Committing the latest edits, combining or publishing */
  pending: boolean
  /** What stopped the last attempt, shown here rather than behind the dialog */
  message: string | null
}

/** A short fingerprint of the list, so the choices start again when it changes. */
function listKey(files: ConflictFile[]): string {
  let hash = 5381
  for (const file of files) {
    const text = `${file.path}\u0000${file.mine ?? ''}\u0000${file.theirs ?? ''}\u0001`
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 33) ^ text.charCodeAt(i)
    }
  }
  return `${files.length}:${(hash >>> 0).toString(36)}`
}

/**
 * The way out of a conflict: for each conflicting entry, what differs in
 * plain words (its fields by label, and the text), both values side by side,
 * and a choice, Keep mine or Use GitHub's. The full versions are a click
 * away, changed lines marked. Combine and publish runs once every file has a
 * choice. Presentational; the panel supplies the files and does the work.
 */
export function ResolveConflictsDialog({
  open,
  onOpenChange,
  files,
  titles,
  onGitHub,
  onCombine,
  pending,
  message,
}: ResolveConflictsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Not while combining: the result must be seen
        if (!pending) onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[85vh] sm:max-w-3xl">
        {/* Remounted on each open and whenever the list changes, so the
            choices are always for what's shown */}
        {open && (
          <ResolveForm
            key={listKey(files)}
            files={files}
            titles={titles}
            onGitHub={onGitHub}
            onCancel={() => onOpenChange(false)}
            onCombine={onCombine}
            pending={pending}
            message={message}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ResolveForm({
  files,
  titles,
  onGitHub,
  onCancel,
  onCombine,
  pending,
  message,
}: Omit<ResolveConflictsDialogProps, 'open' | 'onOpenChange'> & {
  onCancel: () => void
}) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const ready = files.length > 0 && files.every(file => choices[file.path])
  const where = onGitHub ? 'on GitHub' : 'elsewhere'

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Choose which version to keep</DialogTitle>
        <DialogDescription>
          {files.length === 1
            ? `This was changed here and ${where}. Pick the version to keep, and it's published.`
            : `These were changed here and ${where}. Pick the version to keep for each, and they're published.`}
        </DialogDescription>
      </DialogHeader>

      {message && (
        <div
          role="alert"
          className="flex gap-2 rounded-lg border border-draft/30 bg-draft-bg p-3 text-sm text-foreground"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-draft" />
          <p>{message}</p>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        {files.length === 0 && pending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Adding your latest edits…
          </p>
        )}
        {files.map(file => (
          <ConflictEntry
            key={file.path}
            file={file}
            name={
              titles.get(file.path) ??
              file.path.slice(file.path.lastIndexOf('/') + 1)
            }
            onGitHub={onGitHub}
            chosen={choices[file.path]}
            onChoose={choice =>
              setChoices(current => ({ ...current, [file.path]: choice }))
            }
            disabled={pending}
          />
        ))}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          disabled={!ready || pending}
          onClick={() =>
            onCombine(
              files.map(file => ({
                path: file.path,
                choice: choices[file.path]!,
              }))
            )
          }
        >
          {pending && <Spinner />}
          Combine and publish
        </Button>
      </DialogFooter>
    </div>
  )
}

/** One summary row: what it is, and its value on each side. */
interface Row {
  label: string
  mine: string
  theirs: string
  /** Several lines (the text), shown as they are */
  block?: boolean
}

function rowsFor(summary: ConflictSummary): Row[] {
  switch (summary.kind) {
    case 'image':
      return [{ label: 'The image', mine: 'Image', theirs: 'Image' }]
    case 'binary':
      return [{ label: 'The file', mine: 'Changed', theirs: 'Changed' }]
    case 'deletedMine':
      return [{ label: 'The file', mine: 'Deleted', theirs: 'Changed' }]
    case 'deletedTheirs':
      return [{ label: 'The file', mine: 'Changed', theirs: 'Deleted' }]
    case 'entry':
    case 'text': {
      const rows: Row[] = summary.fields.map(field => ({
        label: field.label,
        mine: field.mine,
        theirs: field.theirs,
      }))
      if (summary.text) {
        rows.push({
          label: summary.kind === 'entry' ? 'The text' : 'The lines',
          mine: summary.text.mine,
          theirs: summary.text.theirs,
          block: true,
        })
      }
      if (rows.length === 0) {
        rows.push({
          label: 'Only spacing',
          mine: 'Same content',
          theirs: 'Same content',
        })
      }
      return rows
    }
  }
}

function ConflictEntry({
  file,
  name,
  onGitHub,
  chosen,
  onChoose,
  disabled,
}: {
  file: ConflictFile
  name: string
  onGitHub: boolean
  chosen: ConflictChoice | undefined
  onChoose: (choice: ConflictChoice) => void
  disabled: boolean
}) {
  const [full, setFull] = useState(false)
  const rows = rowsFor(conflictSummary(file))
  const canShowFull = file.mine !== null && file.theirs !== null && !file.binary
  const columns = 'grid grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3'

  return (
    <section role="group" aria-label={name} className="space-y-2">
      <h3
        className="truncate text-sm font-medium text-heading"
        title={file.path}
      >
        {name}
      </h3>
      <div role="table" className="space-y-1 text-sm">
        <div
          role="row"
          className={cn(columns, 'text-xs font-medium text-muted-foreground')}
        >
          <span role="columnheader" />
          <span role="columnheader" className={sideClass(chosen === 'mine')}>
            Your version
          </span>
          <span role="columnheader" className={sideClass(chosen === 'theirs')}>
            {onGitHub ? "GitHub's version" : 'The other version'}
          </span>
        </div>
        {rows.map(row => (
          <div key={row.label} role="row" className={cn(columns, 'py-0.5')}>
            <span role="rowheader" className="text-muted-foreground">
              {row.label}
            </span>
            <Value text={row.mine} block={row.block} />
            <Value text={row.theirs} block={row.block} />
          </div>
        ))}
        <div className={cn(columns, 'pt-1')}>
          <span />
          <ChoiceButton
            label="Keep mine"
            chosen={chosen === 'mine'}
            disabled={disabled}
            onClick={() => onChoose('mine')}
          />
          <ChoiceButton
            label={onGitHub ? "Use GitHub's" : 'Use the other version'}
            chosen={chosen === 'theirs'}
            disabled={disabled}
            onClick={() => onChoose('theirs')}
          />
        </div>
      </div>
      {canShowFull && (
        <div>
          <button
            type="button"
            aria-expanded={full}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setFull(!full)}
          >
            {full ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Show full versions
          </button>
          {full && <FullVersions mine={file.mine!} theirs={file.theirs!} />}
        </div>
      )}
    </section>
  )
}

const sideClass = (chosen: boolean) => cn(chosen && 'text-foreground')

function Value({ text, block }: { text: string; block?: boolean }) {
  return (
    <span
      role="cell"
      className={cn(
        'min-w-0 text-foreground select-text',
        block
          ? 'max-h-32 overflow-y-auto rounded bg-muted/40 px-2 py-1 text-xs whitespace-pre-wrap'
          : 'break-words'
      )}
    >
      {text}
    </span>
  )
}

function ChoiceButton({
  label,
  chosen,
  disabled,
  onClick,
}: {
  label: string
  chosen: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant={chosen ? 'default' : 'outline'}
      size="sm"
      aria-pressed={chosen}
      disabled={disabled}
      onClick={onClick}
    >
      {chosen && <Check />}
      {label}
    </Button>
  )
}

function FullVersions({ mine, theirs }: { mine: string; theirs: string }) {
  const { left, right } = lineDiff(mine, theirs)
  return (
    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Lines lines={left} tone="mine" />
      <Lines lines={right} tone="theirs" />
    </div>
  )
}

function Lines({
  lines,
  tone,
}: {
  lines: DiffLine[]
  tone: 'mine' | 'theirs'
}) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg border p-2 font-mono text-xs text-foreground select-text">
      {lines.map((line, index) => (
        <div
          // Lines can repeat, so the position is part of the key
          key={index}
          data-changed={line.changed}
          className={cn(
            'min-h-4 px-1 whitespace-pre-wrap',
            line.changed &&
              (tone === 'mine' ? 'bg-git-del-bg' : 'bg-git-add-bg')
          )}
        >
          {line.text}
        </div>
      ))}
    </pre>
  )
}
