import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { commands, type GitStatus } from '@/lib/bindings'
import { FETCH_INTERVAL_MS, resetGitFetchTimes } from '@/lib/git/status'
import { useProjectStore } from '../../store/projectStore'
import { useGitStatusQuery } from './useGitStatusQuery'
import { useGitStatusRefresh } from '../useGitStatusRefresh'

vi.mock('@/lib/bindings', () => ({
  commands: {
    gitStatus: vi.fn(),
    gitFetch: vi.fn(),
    githubAuthStatus: vi.fn(),
  },
}))

const STATUS: GitStatus = {
  isRepo: true,
  branch: 'main',
  defaultBranch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  files: [],
  detached: false,
}

function signedIn(value: boolean) {
  vi.mocked(commands.githubAuthStatus).mockResolvedValue({
    status: 'ok',
    data: { signedIn: value, login: null, name: null, avatarUrl: null },
  })
}

function renderStatus() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    () => {
      useGitStatusRefresh('/site')
      return useGitStatusQuery('/site')
    },
    { wrapper }
  )
}

describe('useGitStatusQuery with useGitStatusRefresh', () => {
  let focused = true
  let clock = 0

  beforeEach(() => {
    // Only the refresh interval is faked; TanStack's timers stay real, and
    // the clock loadGitStatus reads moves with advance()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.clearAllMocks()
    resetGitFetchTimes()
    focused = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    useProjectStore.setState({
      globalSettings: {
        general: { showPublishingTools: true },
      } as never,
    })
    vi.mocked(commands.gitStatus).mockResolvedValue({
      status: 'ok',
      data: STATUS,
    })
    vi.mocked(commands.gitFetch).mockResolvedValue({
      status: 'ok',
      data: STATUS,
    })
  })

  /** Moves the clock on, firing the refresh interval. */
  const advance = (ms: number) => {
    clock += ms
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches first on project open when signed in', async () => {
    signedIn(true)
    const { result } = renderStatus()
    await vi.waitFor(() => expect(result.current.data).toEqual(STATUS))
    expect(commands.gitFetch).toHaveBeenCalledTimes(1)
    expect(commands.gitStatus).not.toHaveBeenCalled()
  })

  it('only reads the local status when not signed in', async () => {
    signedIn(false)
    const { result } = renderStatus()
    await vi.waitFor(() => expect(result.current.data).toEqual(STATUS))
    expect(commands.gitFetch).not.toHaveBeenCalled()
    expect(commands.gitStatus).toHaveBeenCalledTimes(1)
  })

  it('fetches again every 5 minutes while the window is focused', async () => {
    signedIn(true)
    const { result } = renderStatus()
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
    advance(FETCH_INTERVAL_MS)
    await vi.waitFor(() => expect(commands.gitFetch).toHaveBeenCalledTimes(2))
  })

  it("doesn't fetch while the window isn't focused", async () => {
    signedIn(true)
    const { result } = renderStatus()
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
    focused = false
    advance(FETCH_INTERVAL_MS * 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(commands.gitFetch).toHaveBeenCalledTimes(1)
    expect(commands.gitStatus).not.toHaveBeenCalled()
  })

  it('reads the local status again when a file changes', async () => {
    signedIn(true)
    const { result } = renderStatus()
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
    act(() => {
      window.dispatchEvent(
        new CustomEvent('file-changed', { detail: { path: '/site/a.md' } })
      )
    })
    await vi.waitFor(() => expect(commands.gitStatus).toHaveBeenCalledTimes(1))
    // Not five minutes yet, so no second fetch
    expect(commands.gitFetch).toHaveBeenCalledTimes(1)
  })

  it('fetches when the window regains focus after five minutes', async () => {
    signedIn(true)
    const { result } = renderStatus()
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
    focused = false
    advance(FETCH_INTERVAL_MS + 1000)
    focused = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() => expect(commands.gitFetch).toHaveBeenCalledTimes(2))
  })

  it('stays off while the publishing tools are hidden', async () => {
    signedIn(true)
    useProjectStore.setState({
      globalSettings: { general: { showPublishingTools: false } } as never,
    })
    renderStatus()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(commands.gitFetch).not.toHaveBeenCalled()
    expect(commands.gitStatus).not.toHaveBeenCalled()
    expect(commands.githubAuthStatus).not.toHaveBeenCalled()
  })
})
