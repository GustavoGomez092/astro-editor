import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useQueryClient } from '@tanstack/react-query'
import { PREVIEW_UPDATED_EVENT } from '@/lib/projects/previews'
import { queryKeys } from '@/lib/query-keys'

/** Refreshes a site's picture when the previews engine stores a new one */
export function useProjectPreviewEvents() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const unlisten = listen<{ projectPath: string }>(
      PREVIEW_UPDATED_EVENT,
      event => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.projectPreview(event.payload.projectPath),
        })
      }
    )
    return () => {
      void unlisten.then(fn => fn())
    }
  }, [queryClient])
}
