import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { commands, type GitStatus, type PullRequest } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { mockToast, resetToastMocks } from '@/test/mocks/toast'
import { useGitPublishMutation } from './useGitPublishMutation'
import { useGitSyncMutation } from './useGitSyncMutation'
import { useGitCheckoutMutation } from './useGitCheckoutMutation'
import { useCreatePullRequestMutation } from './useCreatePullRequestMutation'
import { useMergePullRequestMutation } from './useMergePullRequestMutation'
import { useMergeDefaultBranchMutation } from './useMergeDefaultBranchMutation'

vi.mock('@/lib/bindings', () => ({
  commands: {
    gitPublish: vi.fn(),
    gitSync: vi.fn(),
    gitCheckout: vi.fn(),
    gitFetch: vi.fn(),
    githubCreatePullRequest: vi.fn(),
    githubMergePullRequest: vi.fn(),
    gitMergeDefaultBranch: vi.fn(),
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const P = '/site'
const STATUS: GitStatus = {
  isRepo: true,
  branch: 'staging',
  defaultBranch: 'main',
  upstream: 'origin/staging',
  ahead: 0,
  behind: 0,
  files: [],
  detached: false,
}
const PR: PullRequest = {
  number: 12,
  title: 'Spring copy',
  head: 'staging',
  base: 'main',
  state: 'open',
  draft: false,
  htmlUrl: 'https://github.com/kr/site/pull/12',
  mergeable: true,
  checks: 'success',
}

function setup<T>(useHook: () => T) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Cached git data a mutation must refresh
  client.setQueryData(queryKeys.gitStatus(P), STATUS)
  client.setQueryData(queryKeys.gitBranches(P), [])
  client.setQueryData(queryKeys.gitLog(P, 300), [])
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(useHook, { wrapper })
  return { client, result }
}

function expectGitRefreshed(client: QueryClient) {
  for (const key of [
    queryKeys.gitStatus(P),
    queryKeys.gitBranches(P),
    queryKeys.gitLog(P, 300),
  ]) {
    expect(client.getQueryState(key)?.isInvalidated, String(key)).toBe(true)
  }
}

const ok = <T,>(data: T) => ({ status: 'ok' as const, data })

describe('git mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetToastMocks()
    vi.mocked(commands.gitFetch).mockResolvedValue(ok(STATUS))
  })

  it('publish refreshes status, branches and history and says so', async () => {
    vi.mocked(commands.gitPublish).mockResolvedValue(
      ok({
        commitId: 'abc',
        pushed: true,
        outcome: 'upToDate',
        message: 'Published to staging.',
        status: STATUS,
      })
    )
    const { client, result } = setup(useGitPublishMutation)
    await act(() =>
      result.current.mutateAsync({ projectPath: P, message: 'Update About' })
    )
    expect(commands.gitPublish).toHaveBeenCalledWith(P, 'Update About')
    expectGitRefreshed(client)
    expect(mockToast.success).toHaveBeenCalled()
  })

  it('publish that could not push warns with the reason', async () => {
    vi.mocked(commands.gitPublish).mockResolvedValue(
      ok({
        commitId: 'abc',
        pushed: false,
        outcome: 'conflict',
        message: 'Your changes are saved on this Mac but not published yet.',
        status: STATUS,
      })
    )
    const { client, result } = setup(useGitPublishMutation)
    await act(() =>
      result.current.mutateAsync({ projectPath: P, message: 'x' })
    )
    expectGitRefreshed(client)
    expect(mockToast.warning).toHaveBeenCalledWith(
      'Your changes are saved on this Mac but not published yet.',
      expect.anything()
    )
  })

  it('sync refreshes git data', async () => {
    vi.mocked(commands.gitSync).mockResolvedValue(
      ok({ outcome: 'fastForwarded', message: 'Up to date', status: STATUS })
    )
    const { client, result } = setup(useGitSyncMutation)
    await act(() => result.current.mutateAsync({ projectPath: P }))
    expectGitRefreshed(client)
  })

  it('checkout refreshes git data', async () => {
    vi.mocked(commands.gitCheckout).mockResolvedValue(ok(STATUS))
    const { client, result } = setup(useGitCheckoutMutation)
    await act(() =>
      result.current.mutateAsync({
        projectPath: P,
        name: 'main',
        create: false,
      })
    )
    expect(commands.gitCheckout).toHaveBeenCalledWith(P, 'main', false)
    expectGitRefreshed(client)
  })

  it('a refused checkout shows the reason and changes nothing', async () => {
    vi.mocked(commands.gitCheckout).mockResolvedValue({
      status: 'error',
      error: 'Switching would overwrite your changes to about.md',
    })
    const { client, result } = setup(useGitCheckoutMutation)
    await act(() =>
      result.current
        .mutateAsync({ projectPath: P, name: 'main', create: false })
        .catch(() => {})
    )
    expect(mockToast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: 'Switching would overwrite your changes to about.md',
      })
    )
    expect(client.getQueryState(queryKeys.gitStatus(P))?.isInvalidated).toBe(
      false
    )
  })

  it('opening a pull request refreshes git data', async () => {
    vi.mocked(commands.githubCreatePullRequest).mockResolvedValue(ok(PR))
    const { client, result } = setup(useCreatePullRequestMutation)
    await act(() =>
      result.current.mutateAsync({
        projectPath: P,
        title: 'Spring copy',
        body: '',
        base: 'main',
        head: 'staging',
      })
    )
    expectGitRefreshed(client)
  })

  it('merging a pull request fetches, then refreshes git data', async () => {
    vi.mocked(commands.githubMergePullRequest).mockResolvedValue(
      ok({ ...PR, state: 'merged' as const })
    )
    const { client, result } = setup(useMergePullRequestMutation)
    await act(() => result.current.mutateAsync({ projectPath: P, number: 12 }))
    expect(commands.gitFetch).toHaveBeenCalledWith(P)
    expectGitRefreshed(client)
  })

  it('bringing in the default branch refreshes git data', async () => {
    vi.mocked(commands.gitMergeDefaultBranch).mockResolvedValue(
      ok({ outcome: 'merged', message: 'Brought in main', status: STATUS })
    )
    const { client, result } = setup(useMergeDefaultBranchMutation)
    await act(() => result.current.mutateAsync({ projectPath: P }))
    expectGitRefreshed(client)
  })

  it('a sync conflict is a warning, not a success', async () => {
    vi.mocked(commands.gitSync).mockResolvedValue(
      ok({
        outcome: 'conflict',
        message: 'Your changes and the changes on GitHub both edited about.md.',
        status: STATUS,
      })
    )
    const { result } = setup(useGitSyncMutation)
    await act(() => result.current.mutateAsync({ projectPath: P }))
    expect(mockToast.warning).toHaveBeenCalled()
    expect(mockToast.success).not.toHaveBeenCalled()
  })
})
