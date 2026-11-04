import { create } from 'zustand'
import type { DeviceCode } from '@/lib/bindings'

export type GitPanelTab = 'files' | 'changes'

/** The GitHub sign-in sheet; `lib/git/sign-in.ts` drives it. */
export interface SignInState {
  open: boolean
  /** Asking GitHub for a code, waiting for approval, or stopped on an error */
  step: 'starting' | 'waiting' | 'error'
  code: DeviceCode | null
  error: string | null
}

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
  signIn: SignInState
  newBranchOpen: boolean

  setPanelTab: (tab: GitPanelTab) => void
  openDiff: (path: string) => void
  openHistory: () => void
  /** Back to the editor */
  closeMainView: () => void
  selectCommit: (id: string | null) => void
  selectCommitFile: (path: string | null) => void
  setSignIn: (update: Partial<SignInState>) => void
  setNewBranchOpen: (open: boolean) => void
  /** Back to the initial state, e.g. when another project opens */
  reset: () => void
}

const INITIAL = {
  panelTab: 'files' as GitPanelTab,
  selectedDiffPath: null,
  historyOpen: false,
  selectedCommitId: null,
  selectedCommitFilePath: null,
  signIn: {
    open: false,
    step: 'starting',
    code: null,
    error: null,
  } as SignInState,
  newBranchOpen: false,
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
  setSignIn: update =>
    set(state => ({
      signIn: {
        ...state.signIn,
        code: null,
        error: null,
        ...update,
      },
    })),
  setNewBranchOpen: open => set({ newBranchOpen: open }),
  // Sign-in isn't tied to a project, so it survives a project switch
  reset: () => set(state => ({ ...INITIAL, signIn: state.signIn })),
}))
