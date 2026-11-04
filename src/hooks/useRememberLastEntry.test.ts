import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEditorStore } from '@/store/editorStore'
import { useProjectStore } from '@/store/projectStore'

const { rememberLastEntry } = vi.hoisted(() => ({ rememberLastEntry: vi.fn() }))
vi.mock('@/lib/projects/last-entry', () => ({ rememberLastEntry }))

import { useRememberLastEntry } from './useRememberLastEntry'

const file = (path: string) =>
  ({ id: path, path, name: 'x', extension: 'md', collection: 'blog' }) as never

describe('useRememberLastEntry', () => {
  beforeEach(() => {
    rememberLastEntry.mockClear()
    useEditorStore.setState({ currentFile: null })
    useProjectStore.setState({ projectPath: '/s/a' })
  })

  it('records each entry as it is opened, and nothing when none is open', () => {
    renderHook(() => useRememberLastEntry())
    expect(rememberLastEntry).not.toHaveBeenCalled()

    act(() => useEditorStore.setState({ currentFile: file('/s/a/x.md') }))
    expect(rememberLastEntry).toHaveBeenLastCalledWith('/s/a', '/s/a/x.md')

    act(() => useEditorStore.setState({ currentFile: null }))
    expect(rememberLastEntry).toHaveBeenCalledTimes(1)
  })
})
