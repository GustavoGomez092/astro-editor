import { beforeEach, describe, expect, it } from 'vitest'
import { useGitStore } from './gitStore'

describe('gitStore', () => {
  beforeEach(() => useGitStore.getState().reset())

  it('starts on the Files tab with nothing open', () => {
    const state = useGitStore.getState()
    expect(state.panelTab).toBe('files')
    expect(state.selectedDiffPath).toBeNull()
    expect(state.historyOpen).toBe(false)
    expect(state.selectedCommitId).toBeNull()
  })

  it('switches tabs', () => {
    useGitStore.getState().setPanelTab('changes')
    expect(useGitStore.getState().panelTab).toBe('changes')
  })

  it('shows either a diff or the history in the main area, not both', () => {
    useGitStore.getState().openHistory()
    useGitStore.getState().openDiff('src/content/a.md')
    expect(useGitStore.getState().historyOpen).toBe(false)
    expect(useGitStore.getState().selectedDiffPath).toBe('src/content/a.md')

    useGitStore.getState().openHistory()
    expect(useGitStore.getState().historyOpen).toBe(true)
    expect(useGitStore.getState().selectedDiffPath).toBeNull()
  })

  it('selecting another commit clears the selected commit file', () => {
    useGitStore.getState().selectCommit('one')
    useGitStore.getState().selectCommitFile('a.md')
    useGitStore.getState().selectCommit('two')
    expect(useGitStore.getState().selectedCommitId).toBe('two')
    expect(useGitStore.getState().selectedCommitFilePath).toBeNull()
  })

  it('closes the main-area views', () => {
    useGitStore.getState().openDiff('a.md')
    useGitStore.getState().closeMainView()
    useGitStore.getState().openHistory()
    useGitStore.getState().closeMainView()
    expect(useGitStore.getState().selectedDiffPath).toBeNull()
    expect(useGitStore.getState().historyOpen).toBe(false)
  })

  it('opens and closes the sign-in sheet and the new-branch dialog', () => {
    useGitStore.getState().setSignIn({ open: true, step: 'starting' })
    expect(useGitStore.getState().signIn).toMatchObject({
      open: true,
      step: 'starting',
      code: null,
      error: null,
    })
    useGitStore.getState().setSignIn({ open: false })
    expect(useGitStore.getState().signIn.open).toBe(false)

    useGitStore.getState().setNewBranchOpen(true)
    expect(useGitStore.getState().newBranchOpen).toBe(true)
  })
})
