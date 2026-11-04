import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/store/projectStore'

const { saveUnsavedEdits } = vi.hoisted(() => ({
  saveUnsavedEdits: vi.fn(),
}))
const { reopenLastEntry, waitForProjectReady } = vi.hoisted(() => ({
  reopenLastEntry: vi.fn(),
  waitForProjectReady: vi.fn(),
}))
vi.mock('../quit', () => ({ saveUnsavedEdits }))
vi.mock('./last-entry', () => ({ reopenLastEntry }))
vi.mock('./ready', () => ({ waitForProjectReady }))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }))

import { goHome, openSite } from './actions'

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
    useProjectStore.setState({ projectPath: '/Users/k/site', closeProject })
  })

  it('saves unsaved edits first, then closes the site', async () => {
    saveUnsavedEdits.mockImplementation(() => {
      order.push('save')
      return Promise.resolve(true)
    })

    await goHome()

    expect(order).toEqual(['save', 'close'])
  })

  it('stays in the site when the save fails', async () => {
    saveUnsavedEdits.mockResolvedValue(false)

    await goHome()

    expect(closeProject).not.toHaveBeenCalled()
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
    waitForProjectReady.mockReset().mockResolvedValue(true)
    useProjectStore.setState({ setProject })
  })

  it('saves first and keeps the open site if that fails', async () => {
    saveUnsavedEdits.mockResolvedValue(false)
    await openSite('/Users/k/other')
    expect(setProject).not.toHaveBeenCalled()
    expect(reopenLastEntry).not.toHaveBeenCalled()

    saveUnsavedEdits.mockResolvedValue(true)
    await openSite('/Users/k/other')
    expect(setProject).toHaveBeenCalledWith('/Users/k/other')
  })

  it('reopens the site’s last entry once the site is ready', async () => {
    saveUnsavedEdits.mockResolvedValue(true)
    await openSite('/Users/k/other')
    expect(reopenLastEntry).toHaveBeenCalledWith('/Users/k/other')
  })

  it('leaves the collection list when the site never became ready', async () => {
    saveUnsavedEdits.mockResolvedValue(true)
    waitForProjectReady.mockResolvedValue(false)
    await openSite('/Users/k/other')
    expect(reopenLastEntry).not.toHaveBeenCalled()
  })
})
