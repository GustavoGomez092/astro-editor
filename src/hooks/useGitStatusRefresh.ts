import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FETCH_INTERVAL_MS } from '@/lib/git/status'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from './settings/useShowPublishingTools'
import { useGitHubAuthQuery } from './queries/useGitHubAuthQuery'

/**
 * Keeps the git status (and an open diff) current. Mount once (Layout). The
 * status is reloaded when sign-in is confirmed, when a project file changes,
 * when the window regains focus, and every five minutes while it's focused.
 * `loadGitStatus` decides whether a reload also fetches from GitHub in the
 * background (at most about every five minutes).
 */
export function useGitStatusRefresh(projectPath: string | null) {
  const queryClient = useQueryClient()
  const enabled = useShowPublishingTools()
  const signedIn = useGitHubAuthQuery().data?.signedIn ?? false

  // Signing in (or the sign-in check settling after the project opened)
  // reloads the status, which fetches now that it can
  useEffect(() => {
    if (!enabled || !projectPath || !signedIn) return
    void queryClient.invalidateQueries({
      queryKey: queryKeys.gitStatus(projectPath),
    })
  }, [enabled, projectPath, signedIn, queryClient])

  useEffect(() => {
    if (!enabled || !projectPath) return
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.gitStatus(projectPath),
      })
      // An open diff of a changed file
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.git(projectPath), 'diff', 'workingTree'],
      })
    }
    const tick = () => {
      if (document.hasFocus()) refresh()
    }
    const interval = setInterval(tick, FETCH_INTERVAL_MS)
    window.addEventListener('file-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('file-changed', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [enabled, projectPath, queryClient])
}
