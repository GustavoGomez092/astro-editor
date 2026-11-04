import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SettingExplanation } from '@/lib/project-registry/explain-settings'

/** Text with `backticked` names set in code. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="text-xs">
            {part}
          </code>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        )
      )}
    </>
  )
}

/**
 * Whether a collection setting is set here or worked out automatically, what
 * it uses and why, e.g. "Automatic · Using `draft` (found in the schema)". A
 * set value can be cleared, which goes back to the automatic one
 */
export function SettingStatus({
  explanation,
  onClear,
  code = true,
}: {
  explanation: SettingExplanation
  onClear?: () => void
  /** Show the value as a name (a folder or field), not as words */
  code?: boolean
}) {
  const { state, value, reason, warning } = explanation
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1)
  return (
    <div className="space-y-1 text-sm" data-setting-state={state}>
      <div className="flex min-h-6 items-center gap-2">
        <span
          className={
            state === 'set'
              ? 'rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary'
              : 'rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground'
          }
        >
          {state === 'set' ? 'Set' : 'Automatic'}
        </span>
        <span className="min-w-0 flex-1 text-muted-foreground">
          {value === null ? (
            <WithCode text={`${sentence}.`} />
          ) : (
            <>
              Using{' '}
              {code ? (
                <code className="text-xs">{value}</code>
              ) : (
                <span className="text-foreground">{value}</span>
              )}{' '}
              (<WithCode text={reason} />)
            </>
          )}
        </span>
        {state === 'set' && onClear && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      {warning && (
        <p className="flex items-start gap-1.5 text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-draft" />
          <WithCode text={warning} />
        </p>
      )}
    </div>
  )
}
