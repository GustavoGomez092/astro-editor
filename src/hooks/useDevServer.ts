import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import { commands, type DevServerState } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { STOPPED_STATE } from '@/lib/dev-server'

/** How often the open output popover reads the server's output */
const LOGS_INTERVAL_MS = 1000

/**
 * The project's dev server state, kept current by the `dev-server-state`
 * events Rust sends on every change. The event is only a signal: the state is
 * read again for this project, so a late event from the previous project's
 * server can't show here.
 */
export function useDevServer(projectPath: string | null): DevServerState {
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: queryKeys.devServer(projectPath ?? ''),
    queryFn: async () => {
      const result = await commands.devServerState(projectPath!)
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    enabled: !!projectPath,
  })

  useEffect(() => {
    if (!projectPath) return
    const unlisten = listen('dev-server-state', () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.devServer(projectPath),
      })
    })
    return () => {
      void unlisten.then(fn => fn())
    }
  }, [projectPath, queryClient])

  return data ?? STOPPED_STATE
}

/** The server's recent output, polled while `open` (the popover is showing) */
export function useDevServerLogs(
  projectPath: string | null,
  open: boolean
): string[] {
  const { data } = useQuery({
    queryKey: queryKeys.devServerLogs(projectPath ?? ''),
    queryFn: async () => {
      const result = await commands.devServerLogs(projectPath!)
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    enabled: open && !!projectPath,
    refetchInterval: open ? LOGS_INTERVAL_MS : false,
  })
  return data ?? []
}
