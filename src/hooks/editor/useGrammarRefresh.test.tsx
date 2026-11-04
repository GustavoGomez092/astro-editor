import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useProjectStore } from '../../store/projectStore'
import { DEFAULT_GLOBAL_SETTINGS } from '../../lib/project-registry/defaults'
import { refreshGrammar } from '../../lib/editor/extensions/grammar'
import { useGrammarRefresh } from './useGrammarRefresh'

vi.mock('../../lib/editor/extensions/grammar', () => ({
  refreshGrammar: vi.fn(),
}))

describe('useGrammarRefresh', () => {
  beforeEach(() => {
    vi.mocked(refreshGrammar).mockClear()
    useProjectStore.setState({ globalSettings: DEFAULT_GLOBAL_SETTINGS })
  })

  it('re-checks when the grammar settings change, not other settings', () => {
    renderHook(() => useGrammarRefresh())

    act(() => {
      useProjectStore.setState({
        globalSettings: {
          ...DEFAULT_GLOBAL_SETTINGS,
          general: { ...DEFAULT_GLOBAL_SETTINGS.general, autoSaveDelay: 5 },
        },
      })
    })
    expect(refreshGrammar).not.toHaveBeenCalled()

    act(() => {
      useProjectStore.setState({
        globalSettings: {
          ...DEFAULT_GLOBAL_SETTINGS,
          grammar: { enabled: false },
        },
      })
    })
    expect(refreshGrammar).toHaveBeenCalledTimes(1)
  })
})
