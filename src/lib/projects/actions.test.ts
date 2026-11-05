import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/store/projectStore'
import { useEditorStore } from '@/store/editorStore'

const {
  saveUnsavedEdits,
  ask,
  reopenLastEntry,
  waitForProjectReady,
  waitForSaves,
} = vi.hoisted(() => ({
  saveUnsavedEdits: vi.fn(),
  ask: vi.fn(),
  reopenLastEntry: vi.fn(),
  waitForProjectReady: vi.fn(),
  waitForSaves: vi.fn(),
}))
vi.mock('../quit', () => ({ saveUnsavedEdits }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask }))
vi.mock('../files/pending-saves', () => ({ waitForSaves }))
vi.mock('./last-entry', () => ({ reopenLastEntry }))
vi.mock('./ready', () => ({ waitForProjectReady }))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }))

import { toast } from '../toast'
import { goHome, openProjectViaDialog, openSite } from './actions'

vi.mock('../toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

describe('goHome', () => {
  const order: string[] = []
  const closeProject = vi.fn(() => {
    order.push('close')
    return Promise.resolve()
  })

  beforeEach(() => {
    order.length = 0
    closeProject.mockClear()
    saveUnsavedEdits.mockReset()
    ask.mockReset()
    waitForSaves.mockReset().mockImplementation(() => {
      order.push('wait')
      return Promise.resolve()
    })
    useProjectStore.setState({ projectPath: '/Users/k/site', closeProject })
  })

  it('waits for running saves, saves unsaved edits, then closes the site', async () => {
    saveUnsavedEdits.mockImplementation(() => {
      order.push('save')
      return Promise.resolve(true)
    })

    await goHome()

    expect(order).toEqual(['wait', 'save', 'close'])
    expect(ask).not.toHaveBeenCalled()
  })

  it('stays in the site when the save fails and the writer chooses Stay', async () => {
    saveUnsavedEdits.mockResolvedValue(false)
    ask.mockResolvedValue(false)

    await goHome()

    expect(ask).toHaveBeenCalledTimes(1)
    expect(closeProject).not.toHaveBeenCalled()
  })

  it('leaves when the save fails and the writer chooses Leave Anyway', async () => {
    saveUnsavedEdits.mockResolvedValue(false)
    ask.mockResolvedValue(true)

    await goHome()

    expect(closeProject).toHaveBeenCalled()
  })

  it('does nothing on Home already', async () => {
    useProjectStore.setState({ projectPath: null })

    await goHome()

    expect(saveUnsavedEdits).not.toHaveBeenCalled()
    expect(closeProject).not.toHaveBeenCalled()
  })
})

describe('openSite', () => {
  const setProject = vi.fn()

  beforeEach(() => {
    setProject.mockClear()
    reopenLastEntry.mockReset()
    ask.mockReset()
    waitForSaves.mockReset().mockResolvedValue(undefined)
    waitForProjectReady.mockReset().mockResolvedValue(true)
    useEditorStore.setState({ currentFile: null })
    useProjectStore.setState({ setProject, projectPath: null })
  })

  it('keeps the open site if its edits could not be saved and the writer stays', async () => {
    saveUnsavedEdits.mockResolvedValue(false)
    ask.mockResolvedValue(false)

    expect(await openSite('/Users/k/other')).toBe(false)

    expect(setProject).not.toHaveBeenCalled()
    expect(reopenLastEntry).not.toHaveBeenCalled()
  })

  it('saves first, opens the site and reopens its last entry', async () => {
    saveUnsavedEdits.mockResolvedValue(true)

    expect(await openSite('/Users/k/other')).toBe(true)

    expect(setProject).toHaveBeenCalledWith('/Users/k/other')
    expect(reopenLastEntry).toHaveBeenCalledWith('/Users/k/other')
  })

  it('reports false when the site never became ready', async () => {
    saveUnsavedEdits.mockResolvedValue(true)
    waitForProjectReady.mockResolvedValue(false)

    expect(await openSite('/Users/k/other')).toBe(false)

    expect(reopenLastEntry).not.toHaveBeenCalled()
  })

  it('ignores a second open while one is in progress', async () => {
    saveUnsavedEdits.mockResolvedValue(true)
    let ready: (value: boolean) => void = () => {}
    waitForProjectReady.mockReturnValue(
      new Promise<boolean>(resolve => {
        ready = resolve
      })
    )

    const first = openSite('/Users/k/other')
    const second = openSite('/Users/k/other')
    expect(await second).toBe(false)
    ready(true)
    expect(await first).toBe(true)

    expect(setProject).toHaveBeenCalledTimes(1)
    // And it can be used again afterwards
    waitForProjectReady.mockResolvedValue(true)
    expect(await openSite('/Users/k/third')).toBe(true)
  })

  it('only reopens the last entry for the site that is already open', async () => {
    useProjectStore.setState({ projectPath: '/Users/k/other' })

    expect(await openSite('/Users/k/other')).toBe(true)

    expect(setProject).not.toHaveBeenCalled()
    expect(saveUnsavedEdits).not.toHaveBeenCalled()
    expect(reopenLastEntry).toHaveBeenCalledWith('/Users/k/other')
  })
})

describe('openProjectViaDialog', () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear()
    reopenLastEntry.mockReset()
    waitForSaves.mockReset().mockResolvedValue(undefined)
    saveUnsavedEdits.mockReset().mockResolvedValue(true)
    useProjectStore.setState({ setProject: vi.fn(), projectPath: null })
    globalThis.mockTauri.invoke.mockResolvedValue('/Users/k/picked')
  })

  it('says the project opened only when it did', async () => {
    waitForProjectReady.mockReset().mockResolvedValue(true)
    await openProjectViaDialog()
    expect(toast.success).toHaveBeenCalledTimes(1)

    vi.mocked(toast.success).mockClear()
    waitForProjectReady.mockResolvedValue(false)
    await openProjectViaDialog()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
