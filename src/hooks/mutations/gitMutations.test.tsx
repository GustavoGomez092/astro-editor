import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { commands, type GitStatus, type PullRequest } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { mockToast, resetToastMocks } from '@/test/mocks/toast'
import { SAVE_FAILED } from '@/lib/git/repo-change'
import { useEditorStore } from '@/store/editorStore'
import { useProjectStore } from '@/store/projectStore'
import { useGitStore } from '@/store/gitStore'
import { useGitBusy } from '../useGitBusy'
import { useGitPublishMutation } from './useGitPublishMutation'
import { useGitSyncMutation } from './useGitSyncMutation'
import { useGitCheckoutMutation } from './useGitCheckoutMutation'
import { useCreatePullRequestMutation } from './useCreatePullRequestMutation'
import { useMergePullRequestMutation } from './useMergePullRequestMutation'
import { useMergeDefaultBranchMutation } from './useMergeDefaultBranchMutation'

vi.mock('@/lib/bindings', () => ({
  commands: {
    gitPublish: vi.fn(),
    gitStatus: vi.fn(),
    gitSync: vi.fn(),
    gitCheckout: vi.fn(),
    gitFetch: vi.fn(),
    githubCreatePullRequest: vi.fn(),
    githubMergePullRequest: vi.fn(),
    gitMergeDefaultBranch: vi.fn(),
    readFileContent: vi.fn(),
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
    vi.mocked(commands.readFileContent).mockResolvedValue(ok('---\n---\n'))
    useEditorStore.setState({ currentFile: null, isDirty: false })
    useProjectStore.setState({ projectPath: P })
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

  it('publishing the default branch says the site will update', async () => {
    vi.mocked(commands.gitPublish).mockResolvedValue(
      ok({
        commitId: 'abc',
        pushed: true,
        outcome: 'upToDate',
        message: 'Published to main.',
        status: { ...STATUS, branch: 'main', upstream: 'origin/main' },
      })
    )
    const { result } = setup(useGitPublishMutation)
    await act(() =>
      result.current.mutateAsync({ projectPath: P, message: 'Update About' })
    )
    expect(mockToast.success).toHaveBeenCalledWith(
      'Published. Your site will update in a few minutes.'
    )
  })

  it('publishing another branch names it', async () => {
    vi.mocked(commands.gitPublish).mockResolvedValue(
      ok({
        commitId: 'abc',
        pushed: true,
        outcome: 'upToDate',
        message: 'Published to staging.',
        status: STATUS,
      })
    )
    const { result } = setup(useGitPublishMutation)
    await act(() =>
      result.current.mutateAsync({ projectPath: P, message: 'Update About' })
    )
    expect(mockToast.success).toHaveBeenCalledWith('Published to staging.')
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

  it('a sync or publish that reached GitHub counts as checking it', async () => {
    useGitStore.setState({ checkedAt: {} })
    vi.mocked(commands.gitSync).mockResolvedValue(
      ok({ outcome: 'upToDate', message: 'Up to date', status: STATUS })
    )
    const { result } = setup(useGitSyncMutation)
    await act(() => result.current.mutateAsync({ projectPath: P }))
    expect(useGitStore.getState().checkedAt[P]).toBeTypeOf('number')
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

  it('bringing in changes counts them and says to publish', async () => {
    vi.mocked(commands.gitMergeDefaultBranch).mockResolvedValue(
      ok({ outcome: 'merged', message: 'Brought in main', status: STATUS })
    )
    const { client, result } = setup(() =>
      useMergeDefaultBranchMutation({
        present: message => message.replace('the remote', 'GitHub'),
      })
    )
    client.setQueryData(queryKeys.gitBehindDefault(P), 2)
    await act(() => result.current.mutateAsync({ projectPath: P }))
    expect(mockToast.success).toHaveBeenCalledWith(
      'Brought in 2 changes from main. Publish to send them to GitHub.'
    )
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

  describe('unsaved edits', () => {
    const OPEN_FILE = {
      id: 'pages/about',
      path: '/site/src/content/pages/about.md',
      name: 'about',
      extension: 'md',
      collection: 'pages',
      last_modified: null,
      frontmatter: {},
    }

    /** An open file with unsaved edits; `saves` decides whether saving works. */
    function dirtyEditor(order: string[], saves = true) {
      useEditorStore.setState({
        currentFile: OPEN_FILE,
        isDirty: true,
        saveFile: vi.fn(() => {
          order.push('save')
          if (saves) useEditorStore.setState({ isDirty: false })
          return Promise.resolve()
        }),
      })
    }

    it('saves a dirty editor before syncing', async () => {
      const order: string[] = []
      dirtyEditor(order)
      vi.mocked(commands.gitSync).mockImplementation(() => {
        order.push('sync')
        return Promise.resolve(
          ok({ outcome: 'upToDate', message: 'Up to date', status: STATUS })
        )
      })
      const { result } = setup(useGitSyncMutation)
      await act(() => result.current.mutateAsync({ projectPath: P }))
      expect(order).toEqual(['save', 'sync'])
    })

    it('saves a dirty editor before switching branch', async () => {
      const order: string[] = []
      dirtyEditor(order)
      vi.mocked(commands.gitCheckout).mockImplementation(() => {
        order.push('checkout')
        return Promise.resolve(ok(STATUS))
      })
      const { result } = setup(useGitCheckoutMutation)
      await act(() =>
        result.current.mutateAsync({
          projectPath: P,
          name: 'main',
          create: false,
        })
      )
      expect(order).toEqual(['save', 'checkout'])
    })

    it('changes nothing when the save fails', async () => {
      const order: string[] = []
      dirtyEditor(order, false)
      const { result } = setup(useGitCheckoutMutation)
      let failure: unknown
      await act(() =>
        result.current
          .mutateAsync({ projectPath: P, name: 'main', create: false })
          .catch((error: unknown) => (failure = error))
      )
      expect(commands.gitCheckout).not.toHaveBeenCalled()
      expect((failure as Error).message).toBe(SAVE_FAILED)
    })

    it('publish, bring in and merging a pull request save first too', async () => {
      for (const [useHook, variables, command] of [
        [
          useGitPublishMutation,
          { projectPath: P, message: 'x' },
          commands.gitPublish,
        ],
        [
          useMergeDefaultBranchMutation,
          { projectPath: P },
          commands.gitMergeDefaultBranch,
        ],
        [
          useMergePullRequestMutation,
          { projectPath: P, number: 1 },
          commands.githubMergePullRequest,
        ],
      ] as const) {
        const order: string[] = []
        dirtyEditor(order, false)
        const { result } = setup(
          useHook as () => { mutateAsync: (v: unknown) => Promise<unknown> }
        )
        await act(() => result.current.mutateAsync(variables).catch(() => {}))
        expect(order).toEqual(['save'])
        expect(command).not.toHaveBeenCalled()
      }
    })

    it('publish reads the status after saving, so the saved entry is in the message', async () => {
      const order: string[] = []
      dirtyEditor(order)
      const saved: GitStatus = {
        ...STATUS,
        files: [
          {
            path: 'src/content/pages/about.md',
            oldPath: null,
            change: 'modified',
          },
        ],
      }
      vi.mocked(commands.gitStatus).mockImplementation(() => {
        order.push('status')
        return Promise.resolve(ok(saved))
      })
      vi.mocked(commands.gitPublish).mockResolvedValue(
        ok({
          commitId: 'abc',
          pushed: true,
          outcome: 'upToDate',
          message: 'Published to staging.',
          status: STATUS,
        })
      )
      const { result } = setup(useGitPublishMutation)
      await act(() =>
        result.current.mutateAsync({
          projectPath: P,
          message: status => `Update ${status.files.length} entry`,
        })
      )
      expect(order).toEqual(['save', 'status'])
      expect(commands.gitPublish).toHaveBeenCalledWith(P, 'Update 1 entry')
    })

    it('reloads the open file and the file lists after a checkout', async () => {
      useEditorStore.setState({ currentFile: OPEN_FILE, isDirty: false })
      vi.mocked(commands.gitCheckout).mockResolvedValue(ok(STATUS))
      const { client, result } = setup(useGitCheckoutMutation)
      const content = queryKeys.fileContent(P, OPEN_FILE.id)
      const collections = queryKeys.collections(P)
      const files = queryKeys.collectionFiles(P, 'pages')
      const folder = queryKeys.directoryContents(P, 'pages', 'root')
      for (const key of [content, collections, files, folder]) {
        client.setQueryData(key, {})
      }

      await act(() =>
        result.current.mutateAsync({
          projectPath: P,
          name: 'main',
          create: false,
        })
      )
      for (const key of [content, collections, files, folder]) {
        await vi.waitFor(() =>
          expect(client.getQueryState(key)?.isInvalidated, String(key)).toBe(
            true
          )
        )
      }
      expect(useEditorStore.getState().currentFile?.id).toBe(OPEN_FILE.id)
    })

    it("closes the open file when it doesn't exist on the new branch", async () => {
      useEditorStore.setState({ currentFile: OPEN_FILE, isDirty: false })
      vi.mocked(commands.gitCheckout).mockResolvedValue(ok(STATUS))
      vi.mocked(commands.readFileContent).mockResolvedValue({
        status: 'error',
        error: 'File not found',
      })
      const { result } = setup(useGitCheckoutMutation)
      await act(() =>
        result.current.mutateAsync({
          projectPath: P,
          name: 'main',
          create: false,
        })
      )
      await vi.waitFor(() =>
        expect(useEditorStore.getState().currentFile).toBeNull()
      )
    })

    it('keeps edits blocked until the open file has reloaded', async () => {
      useEditorStore.setState({ currentFile: OPEN_FILE, isDirty: false })
      vi.mocked(commands.gitCheckout).mockResolvedValue(ok(STATUS))
      let reads = 0
      let finishReload: (text: string) => void = () => {}
      const { result } = setup(() => ({
        checkout: useGitCheckoutMutation(),
        busy: useGitBusy(),
        content: useQuery({
          queryKey: queryKeys.fileContent(P, OPEN_FILE.id),
          queryFn: () =>
            reads++ === 0
              ? Promise.resolve('old branch')
              : new Promise<string>(resolve => (finishReload = resolve)),
        }),
      }))
      await vi.waitFor(() =>
        expect(result.current.content.data).toBe('old branch')
      )

      let done = false
      act(() => {
        void result.current.checkout
          .mutateAsync({ projectPath: P, name: 'main', create: false })
          .then(() => (done = true))
      })
      await vi.waitFor(() => expect(reads).toBe(2))
      // Checked out, but the open file hasn't reloaded: still blocked
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(result.current.busy).toBe(true)
      expect(done).toBe(false)

      act(() => finishReload('new branch'))
      await vi.waitFor(() => expect(result.current.busy).toBe(false))
      expect(result.current.content.data).toBe('new branch')
    })

    it('leaves files alone when another project opened during the operation', async () => {
      useEditorStore.setState({ currentFile: OPEN_FILE, isDirty: true })
      vi.mocked(commands.gitCheckout).mockImplementation(() => {
        // The writer opened another project meanwhile; its file is dirty
        useProjectStore.setState({ projectPath: '/other' })
        return Promise.resolve(ok(STATUS))
      })
      // The save before the checkout succeeds for the first project's file
      useEditorStore.setState({
        saveFile: vi.fn(() => {
          useEditorStore.setState({ isDirty: false })
          return Promise.resolve()
        }),
      })
      const { client, result } = setup(useGitCheckoutMutation)
      client.setQueryData(queryKeys.collections('/other'), [])
      await act(() =>
        result.current.mutateAsync({
          projectPath: P,
          name: 'main',
          create: false,
        })
      )
      useEditorStore.setState({ isDirty: true })
      expect(commands.readFileContent).not.toHaveBeenCalled()
      expect(useEditorStore.getState().currentFile?.id).toBe(OPEN_FILE.id)
      expect(
        client.getQueryState(queryKeys.collections('/other'))?.isInvalidated
      ).toBe(false)
    })

    it('never closes a file with unsaved edits, even if it seems gone', async () => {
      useEditorStore.setState({ currentFile: OPEN_FILE, isDirty: false })
      vi.mocked(commands.gitCheckout).mockImplementation(() => {
        // Typed into while the checkout ran (edits weren't blocked yet)
        useEditorStore.setState({ isDirty: true })
        return Promise.resolve(ok(STATUS))
      })
      vi.mocked(commands.readFileContent).mockResolvedValue({
        status: 'error',
        error: 'File not found',
      })
      const { result } = setup(useGitCheckoutMutation)
      await act(() =>
        result.current.mutateAsync({
          projectPath: P,
          name: 'main',
          create: false,
        })
      )
      expect(useEditorStore.getState().currentFile?.id).toBe(OPEN_FILE.id)
      expect(useEditorStore.getState().isDirty).toBe(true)
    })

    it('says so when the save fails without saying why', async () => {
      const order: string[] = []
      dirtyEditor(order, false)
      const { result } = setup(useGitSyncMutation)
      await act(() =>
        result.current.mutateAsync({ projectPath: P }).catch(() => {})
      )
      expect(mockToast.error).toHaveBeenCalledTimes(1)
      expect(mockToast.error).toHaveBeenCalledWith(SAVE_FAILED)
      expect(commands.gitSync).not.toHaveBeenCalled()
    })

    it('shows one message when the save fails, not two', async () => {
      const order: string[] = []
      dirtyEditor(order, false)
      // The save reports its own failure, as saveCurrentFile does
      useEditorStore.setState({
        saveFile: vi.fn(() => {
          useEditorStore.getState().noteSaveFailed()
          return Promise.resolve()
        }),
      })
      const { result } = setup(useGitSyncMutation)
      await act(() =>
        result.current.mutateAsync({ projectPath: P }).catch(() => {})
      )
      // The save showed its own error; the sync adds nothing
      expect(mockToast.error).not.toHaveBeenCalled()
      expect(commands.gitSync).not.toHaveBeenCalled()
    })

    it('reloads files after a publish that fast-forwarded', async () => {
      useEditorStore.setState({ currentFile: OPEN_FILE, isDirty: false })
      vi.mocked(commands.gitPublish).mockResolvedValue(
        ok({
          commitId: 'abc',
          pushed: true,
          outcome: 'fastForwarded',
          message: 'Published to staging.',
          status: STATUS,
        })
      )
      const { client, result } = setup(useGitPublishMutation)
      const content = queryKeys.fileContent(P, OPEN_FILE.id)
      client.setQueryData(content, {})
      await act(() =>
        result.current.mutateAsync({ projectPath: P, message: 'x' })
      )
      expect(client.getQueryState(content)?.isInvalidated).toBe(true)
    })
  })
})
