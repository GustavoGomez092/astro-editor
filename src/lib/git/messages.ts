import type { SyncOutcome } from '@/lib/bindings'
import { toast } from '@/lib/toast'

/** How a sync's outcome is shown: done, nothing to do, or needs attention. */
export function syncToastKind(
  outcome: SyncOutcome
): 'success' | 'info' | 'warning' {
  switch (outcome) {
    case 'fastForwarded':
    case 'merged':
      return 'success'
    case 'upToDate':
    case 'noUpstream':
      return 'info'
    case 'blockedByLocalChanges':
    case 'conflict':
      return 'warning'
  }
}

/** Shows a sync's or merge's plain-language message as the right kind of toast. */
export function showSyncOutcome(result: {
  outcome: SyncOutcome
  message: string
}): void {
  toast[syncToastKind(result.outcome)](result.message)
}
