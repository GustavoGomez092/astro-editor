import { create } from 'zustand'
import { loadThemeFiles } from '../lib/themes/load'
import type { ThemeFile } from '../lib/themes'

interface ThemeFilesState {
  files: ThemeFile[]
  /** True once the themes folder has been read, so a custom theme isn't mistaken for a missing one */
  loaded: boolean
  loadFiles: () => Promise<void>
}

export const useThemeFiles = create<ThemeFilesState>(set => ({
  files: [],
  loaded: false,
  loadFiles: async () => {
    try {
      set({ files: await loadThemeFiles(), loaded: true })
    } catch {
      // The themes folder isn't readable: custom themes fall back to Default
      set({ loaded: true })
    }
  },
}))
