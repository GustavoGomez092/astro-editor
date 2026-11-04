import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/store/projectStore'

const { saveUnsavedEdits } = vi.hoisted(() => ({
  saveUnsavedEdits: vi.fn(),
}))
vi.mock('../quit', () => ({ saveUnsavedEdits }))
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
  it('saves first and keeps the open site if that fails', async () => {
    const setProject = vi.fn()
    useProjectStore.setState({ setProject })
    saveUnsavedEdits.mockResolvedValue(false)

    await openSite('/Users/k/other')
    expect(setProject).not.toHaveBeenCalled()

    saveUnsavedEdits.mockResolvedValue(true)
    await openSite('/Users/k/other')
    expect(setProject).toHaveBeenCalledWith('/Users/k/other')
  })
})
