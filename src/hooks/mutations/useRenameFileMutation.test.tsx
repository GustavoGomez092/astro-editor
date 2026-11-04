import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { commands } from '@/lib/bindings'
import { ignoreIssue, isIgnored } from '@/lib/grammar'
import { useRenameFileMutation } from './useRenameFileMutation'

vi.mock('@/lib/bindings', () => ({
  commands: { renameFile: vi.fn() },
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('useRenameFileMutation', () => {
  it('keeps ignored grammar issues with the renamed file', async () => {
    vi.mocked(commands.renameFile).mockResolvedValue({
      status: 'ok',
      data: null,
    })
    const client = new QueryClient()
    const { result } = renderHook(() => useRenameFileMutation(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    ignoreIssue('/site/old.md', 'key')

    await act(() =>
      result.current.mutateAsync({
        oldPath: '/site/old.md',
        oldFileId: 'old',
        newPath: '/site/new.md',
        projectPath: '/site',
        collectionName: 'posts',
      })
    )

    expect(isIgnored('/site/new.md', 'key')).toBe(true)
  })
})
