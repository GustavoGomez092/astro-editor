import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FETCH_INTERVAL_MS } from '@/lib/git/status'
import { queryKeys } from '@/lib/query-keys'
import { useShowPublishingTools } from './settings/useShowPublishingTools'

/**
 * Keeps the git status current. Mount once (Layout). The status is reloaded
 * when a project file changes and when the window regains focus, and every
 * five minutes while it's focused. `loadGitStatus` decides whether a reload
 * also fetches from GitHub (at most every five minutes).
 */
export function useGitStatusRefresh(projectPath: string | null) {
  const queryClient = useQueryClient()
  const enabled = useShowPublishingTools()

  useEffect(() => {
    if (!enabled || !projectPath) return
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.gitStatus(projectPath),
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
