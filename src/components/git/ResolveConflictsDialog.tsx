import { useState } from 'react'
import { Check } from 'lucide-react'
import type {
  ConflictChoice,
  ConflictFile,
  ConflictResolution,
} from '@/lib/bindings'
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

const IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i

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
  pending: boolean
}

/**
 * The way out of a conflict: each conflicting entry with both whole versions
 * side by side (read-only), and a choice for each, Keep mine or Use GitHub's.
 * Combine and publish runs once every file has one. Presentational; the panel
 * supplies the files and does the combining.
 */
export function ResolveConflictsDialog({
  open,
  onOpenChange,
  files,
  titles,
  onGitHub,
  onCombine,
  pending,
}: ResolveConflictsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Not while combining: the result must be seen
        if (!pending) onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[85vh] sm:max-w-4xl">
        {/* Remounted on each open, so choices start fresh */}
        {open && (
          <ResolveForm
            files={files}
            titles={titles}
            onGitHub={onGitHub}
            onCancel={() => onOpenChange(false)}
            onCombine={onCombine}
            pending={pending}
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
}: Omit<ResolveConflictsDialogProps, 'open' | 'onOpenChange'> & {
  onCancel: () => void
}) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const ready = files.length > 0 && files.every(file => choices[file.path])
  const theirs = onGitHub ? "GitHub's version" : 'The other version'
  const useTheirs = onGitHub ? "Use GitHub's" : 'Use the other version'
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

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {files.map(file => {
          const name =
            titles.get(file.path) ??
            file.path.slice(file.path.lastIndexOf('/') + 1)
          const chosen = choices[file.path]
          const choose = (choice: ConflictChoice) =>
            setChoices(current => ({ ...current, [file.path]: choice }))
          return (
            <section
              key={file.path}
              role="group"
              aria-label={name}
              className="space-y-2"
            >
              <h3
                className="truncate text-sm font-medium text-heading"
                title={file.path}
              >
                {name}
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Version
                  label="Your version"
                  text={file.mine}
                  file={file}
                  chosen={chosen === 'mine'}
                  action="Keep mine"
                  onChoose={() => choose('mine')}
                  disabled={pending}
                />
                <Version
                  label={theirs}
                  text={file.theirs}
                  file={file}
                  chosen={chosen === 'theirs'}
                  action={useTheirs}
                  onChoose={() => choose('theirs')}
                  disabled={pending}
                />
              </div>
            </section>
          )
        })}
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

/** What one side holds, in words, when there's no text to show. */
function placeholder(file: ConflictFile, text: string | null): string | null {
  if (file.binary) {
    return IMAGE.test(file.path) ? 'Image' : "A file that can't be shown here"
  }
  return text === null ? 'Deleted' : null
}

function Version({
  label,
  text,
  file,
  chosen,
  action,
  onChoose,
  disabled,
}: {
  label: string
  text: string | null
  file: ConflictFile
  chosen: boolean
  action: string
  onChoose: () => void
  disabled: boolean
}) {
  const empty = placeholder(file, text)
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border',
        chosen && 'border-primary ring-1 ring-primary'
      )}
    >
      <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      {empty ? (
        <p className="flex min-h-16 flex-1 items-center justify-center p-3 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <pre className="max-h-64 min-h-16 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-foreground select-text">
          {text}
        </pre>
      )}
      <div className="border-t p-2">
        <Button
          variant={chosen ? 'default' : 'outline'}
          size="sm"
          className="w-full"
          aria-pressed={chosen}
          disabled={disabled}
          onClick={onChoose}
        >
          {chosen && <Check />}
          {action}
        </Button>
      </div>
    </div>
  )
}
