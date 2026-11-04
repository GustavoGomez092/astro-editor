import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { commands, type PullRequest } from '@/lib/bindings'
import { useProjectStore } from '../../store/projectStore'
import {
  PULL_REQUEST_POLL_MS,
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
  return renderHook(() => usePullRequestsQuery('/site'), { wrapper })
}

const calls = () => vi.mocked(commands.githubListPullRequests).mock.calls.length

describe('usePullRequestsQuery polling', () => {
  let focused = true

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.clearAllMocks()
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

  it('waits while the window is in the background', async () => {
    vi.mocked(commands.githubListPullRequests).mockResolvedValue(ok([PR]))
    const { result } = render()
    await vi.waitFor(() => expect(result.current.data).toEqual([PR]))
    focused = false
    await tick()
    await tick()
    expect(calls()).toBe(1)
  })
})
