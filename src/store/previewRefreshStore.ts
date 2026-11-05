import { create } from 'zustand'

/**
 * The sites whose preview is being refreshed. Kept here rather than in the
 * card so the progress is still shown after leaving Home and coming back
 */
interface PreviewRefreshState {
  refreshing: Record<string, true>
  setRefreshing: (projectPath: string, on: boolean) => void
}

export const usePreviewRefreshStore = create<PreviewRefreshState>(set => ({
  refreshing: {},
  setRefreshing: (projectPath, on) =>
    set(state => {
      const refreshing = { ...state.refreshing }
      if (on) refreshing[projectPath] = true
      else delete refreshing[projectPath]
      return { refreshing }
    }),
}))
