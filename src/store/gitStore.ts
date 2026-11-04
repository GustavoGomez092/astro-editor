import { create } from 'zustand'

export type GitPanelTab = 'files' | 'changes'

interface GitState {
  /** The left sidebar's tab: the content files, or the Git panel */
  panelTab: GitPanelTab
  /** A changed file whose diff is shown in the main area */
  selectedDiffPath: string | null
  /** Whether the History view is shown in the main area */
  historyOpen: boolean
  /** The commit whose details History shows */
  selectedCommitId: string | null
  /** A file of the selected commit whose diff History shows */
  selectedCommitFilePath: string | null

  setPanelTab: (tab: GitPanelTab) => void
  openDiff: (path: string) => void
  openHistory: () => void
  /** Back to the editor */
  closeMainView: () => void
  selectCommit: (id: string | null) => void
  selectCommitFile: (path: string | null) => void
  reset: () => void
}

const INITIAL = {
  panelTab: 'files' as GitPanelTab,
  selectedDiffPath: null,
  historyOpen: false,
  selectedCommitId: null,
  selectedCommitFilePath: null,
}

/**
 * What the Git panel shows. The main area shows at most one of a diff and the
 * History view, over the editor, which stays mounted underneath.
 */
export const useGitStore = create<GitState>(set => ({
  ...INITIAL,

  setPanelTab: tab => set({ panelTab: tab }),
  openDiff: path => set({ selectedDiffPath: path, historyOpen: false }),
  openHistory: () => set({ historyOpen: true, selectedDiffPath: null }),
  closeMainView: () => set({ selectedDiffPath: null, historyOpen: false }),
  selectCommit: id =>
    set({ selectedCommitId: id, selectedCommitFilePath: null }),
  selectCommitFile: path => set({ selectedCommitFilePath: path }),
  reset: () => set(INITIAL),
}))
