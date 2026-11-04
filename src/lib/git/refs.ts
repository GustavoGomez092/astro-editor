import type { GraphRef } from '@/lib/bindings'

export interface RefLabel extends GraphRef {
  /** The branch (or detached HEAD) that's checked out */
  current: boolean
}

/**
 * The labels to show on a commit. The engine marks the checked-out commit
 * with a `HEAD` ref; when the current branch is also on that commit, its own
 * label is marked current instead, so the graph says "staging" rather than
 * "HEAD". A detached HEAD keeps its label.
 */
export function refLabels(
  refs: GraphRef[],
  currentBranch: string | null
): RefLabel[] {
  const hasHead = refs.some(ref => ref.kind === 'head')
  const onBranch =
    hasHead &&
    currentBranch !== null &&
    refs.some(ref => ref.kind === 'localBranch' && ref.name === currentBranch)
  return refs
    .filter(ref => !(onBranch && ref.kind === 'head'))
    .map(ref => ({
      ...ref,
      current:
        ref.kind === 'head' ||
        (onBranch && ref.kind === 'localBranch' && ref.name === currentBranch),
    }))
}
