import { useEffect, useRef } from 'react'
import {
  GIT_GUARDED_ATTRIBUTE,
  restoreFocusAfterGitChange,
} from '@/lib/git/repo-change'
import { useGitBusy } from './useGitBusy'

/**
 * Props for an area that takes no edits while git rewrites files (the editor,
 * the frontmatter panel): edits made then would be saved over what came in.
 * It's inert while a git change runs, and when it ends, focus goes back to
 * where the writer was in it.
 */
export function useGitEditGuard() {
  const busy = useGitBusy()
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) restoreFocusAfterGitChange()
    wasBusy.current = busy
  }, [busy])
  return {
    [GIT_GUARDED_ATTRIBUTE]: '',
    inert: busy || undefined,
    'aria-busy': busy || undefined,
  }
}
