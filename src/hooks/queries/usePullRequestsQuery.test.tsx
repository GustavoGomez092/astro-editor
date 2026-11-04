import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { commands, type PullRequest } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { useProjectStore } from '../../store/projectStore'
import {
  NEW_PULL_REQUEST_MS,
  PULL_REQUEST_POLL_MS,
  forgetSeenPullRequests,
  usePullRequestsQuery,
} from './usePullRequestsQuery'

vi.mock('@/lib/bindings', () => ({
  commands: {
    githubAuthStatus: vi.fn(),
    githubRepoInfo: vi.fn(),
    githubListPullRequests: vi.fn(),
  },
}))

const ok = <T,>(data: T) => ({ status: 'ok' as const, data })
const PR: PullRequest = {
  number: 3,
  title: 'Spring copy',
  head: 'spring',
  base: 'main',
  state: 'open',
  draft: false,
  htmlUrl: 'https://github.com/kr/site/pull/3',
  mergeable: true,
  checks: 'pending',
}

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return {
    client,
    ...renderHook(() => usePullRequestsQuery('/site'), { wrapper }),
  }
}

const calls = () => vi.mocked(commands.githubListPullRequests).mock.calls.length

describe('usePullRequestsQuery polling', () => {
  let focused = true

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.clearAllMocks()
    forgetSeenPullRequests()
    focused = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    useProjectStore.setState({
      globalSettings: { general: { showPublishingTools: true } } as never,
    })
    vi.mocked(commands.githubAuthStatus).mockResolvedValue(
      ok({ signedIn: true, login: 'kr', name: null, avatarUrl: null })
    )
    vi.mocked(commands.githubRepoInfo).mockResolvedValue(
      ok({
        owner: 'kr',
        repo: 'site',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/kr/site',
      })
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function tick() {
    await act(async () => {
      vi.advanceTimersByTime(PULL_REQUEST_POLL_MS)
      await Promise.resolve()
    })
  }

  it('checks again every 15 seconds while checks are pending, until they finish', async () => {
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([PR]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([PR]))
    expect(calls()).toBe(1)

    await tick()
    await vi.waitFor(() => expect(calls()).toBe(2))

    vi.mocked(commands.githubListPullRequests).mockResolvedValue(
      ok([{ ...PR, checks: 'success' }])
    )
    await tick()
    await vi.waitFor(() =>
      expect(result.current.data?.[0]?.checks).toBe('success')
    )
    await tick()
    await tick()
    expect(calls()).toBe(3)
  })

  it("checks again for a new pull request whose checks GitHub hasn't registered yet", async () => {
    const fresh = { ...PR, number: 40, checks: 'none' as const }
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([fresh]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([fresh]))

    vi.mocked(commands.githubListPullRequests).mockResolvedValue(
      ok([{ ...fresh, checks: 'success' }])
    )
    await tick()
    await vi.waitFor(() =>
      expect(result.current.data?.[0]?.checks).toBe('success')
    )
    await tick()
    expect(calls()).toBe(2)
  })

  it('stops waiting for checks ten minutes after first seeing the pull request', async () => {
    const quiet = { ...PR, number: 41, checks: 'none' as const }
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([quiet]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([quiet]))

    await tick()
    await vi.waitFor(() => expect(calls()).toBe(2))

    vi.setSystemTime(Date.now() + NEW_PULL_REQUEST_MS)
    await tick()
    await tick()
    expect(calls()).toBe(2)
  })

  it('keeps checking a pull request whose checks are still running after ten minutes', async () => {
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([PR]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([PR]))

    vi.setSystemTime(Date.now() + NEW_PULL_REQUEST_MS * 2)
    await tick()
    await vi.waitFor(() => expect(calls()).toBe(2))
    await tick()
    await vi.waitFor(() => expect(calls()).toBe(3))
  })

  it('waits for checks again on a pull request that left the list and came back', async () => {
    const quiet = { ...PR, number: 41, checks: 'none' as const }
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([quiet]))
    const { result, client } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([quiet]))

    // Closed, then reopened long after the app first saw it
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([]))
    await act(() =>
      client.invalidateQueries({ queryKey: queryKeys.git('/site') })
    )
    await vi.waitFor(() => expect(result.current.data).toEqual([]))
    vi.setSystemTime(Date.now() + NEW_PULL_REQUEST_MS * 2)
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([quiet]))
    await act(() =>
      client.invalidateQueries({ queryKey: queryKeys.git('/site') })
    )
    await vi.waitFor(() => expect(result.current.data).toEqual([quiet]))
    expect(calls()).toBe(3)

    await tick()
    await vi.waitFor(() => expect(calls()).toBe(4))
  })

  it('reads again as soon as the window comes back to the front', async () => {
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([PR]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([PR]))
    focused = false
    await tick()
    expect(calls()).toBe(1)

    focused = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await vi.waitFor(() => expect(calls()).toBe(2))
  })

  it('waits while the window is in the background', async () => {
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([PR]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([PR]))
    focused = false
    await tick()
    await tick()
    expect(calls()).toBe(1)
  })

  it('stops after signing out', async () => {
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([PR]))
    const { result, client } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([PR]))
    vi.mocked(commands.githubAuthStatus).mockResolvedValue(
      ok({ signedIn: false, login: null, name: null, avatarUrl: null })
    )
    await act(() =>
      client.invalidateQueries({ queryKey: queryKeys.githubAuth })
    )
    // TanStack tells components on a (real) timer
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    await tick()
    await tick()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(calls()).toBe(1)
  })

  it('stops when the publishing tools are turned off', async () => {
    const fresh = { ...PR, number: 42, checks: 'none' as const }
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([fresh]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([fresh]))
    act(() => {
      useProjectStore.setState({
        globalSettings: { general: { showPublishingTools: false } } as never,
      })
    })
    await tick()
    await tick()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(calls()).toBe(1)
  })
})
