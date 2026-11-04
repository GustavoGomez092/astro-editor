import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commands, type GitHubAuthStatus } from '@/lib/bindings'
import { queryKeys } from '@/lib/query-keys'
import { useGitStore } from '@/store/gitStore'
import { mockToast, resetToastMocks } from '@/test/mocks/toast'
import { cancelGitHubSignIn, startGitHubSignIn } from './sign-in'

vi.mock('@/lib/bindings', () => ({
  commands: {
    githubDeviceStart: vi.fn(),
    githubDevicePoll: vi.fn(),
    githubSignOut: vi.fn(),
    githubCancelSignIn: vi.fn(),
  },
}))
const { setQueryData } = vi.hoisted(() => ({ setQueryData: vi.fn() }))
vi.mock('@/lib/query-client', () => ({
  queryClient: { setQueryData, invalidateQueries: vi.fn() },
}))

const CODE = {
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
}
const SIGNED_IN: GitHubAuthStatus = {
  signedIn: true,
  login: 'kevinrobinson',
  name: 'Kevin Robinson',
  avatarUrl: null,
}

describe('GitHub sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetToastMocks()
    useGitStore.getState().setSignIn({ open: false })
    vi.mocked(commands.githubDeviceStart).mockResolvedValue({
      status: 'ok',
      data: CODE,
    })
    vi.mocked(commands.githubSignOut).mockResolvedValue({
      status: 'ok',
      data: null,
    })
    vi.mocked(commands.githubCancelSignIn).mockResolvedValue({
      status: 'ok',
      data: null,
    })
  })

  it('shows the code, then signs in when GitHub approves', async () => {
    let approve: (value: unknown) => void = () => {}
    vi.mocked(commands.githubDevicePoll).mockReturnValue(
      new Promise(resolve => (approve = resolve)) as never
    )
    const done = startGitHubSignIn()
    await vi.waitFor(() =>
      expect(useGitStore.getState().signIn.step).toBe('waiting')
    )
    expect(useGitStore.getState().signIn.code?.userCode).toBe('WDJB-MJHT')

    approve({ status: 'ok', data: SIGNED_IN })
    await done
    expect(setQueryData).toHaveBeenCalledWith(queryKeys.githubAuth, SIGNED_IN)
    expect(useGitStore.getState().signIn.open).toBe(false)
    expect(mockToast.success).toHaveBeenCalledWith('Signed in as kevinrobinson')
  })

  it('keeps the sheet open with a readable message when the code expires', async () => {
    vi.mocked(commands.githubDevicePoll).mockResolvedValue({
      status: 'error',
      error: 'The code expired. Start again to get a new one.',
    })
    await startGitHubSignIn()
    expect(useGitStore.getState().signIn).toMatchObject({
      open: true,
      step: 'error',
      error: 'The code expired. Start again to get a new one.',
    })
  })

  it('shows a start failure, e.g. no client ID or offline', async () => {
    vi.mocked(commands.githubDeviceStart).mockResolvedValue({
      status: 'error',
      error: "Couldn't reach GitHub.",
    })
    await startGitHubSignIn()
    expect(useGitStore.getState().signIn.step).toBe('error')
    expect(commands.githubDevicePoll).not.toHaveBeenCalled()
  })

  it('cancelling stops the wait, keeps any sign-in, and ignores what comes back', async () => {
    let finish: (value: unknown) => void = () => {}
    vi.mocked(commands.githubDevicePoll).mockReturnValue(
      new Promise(resolve => (finish = resolve)) as never
    )
    const done = startGitHubSignIn()
    await vi.waitFor(() =>
      expect(useGitStore.getState().signIn.step).toBe('waiting')
    )
    cancelGitHubSignIn()
    expect(commands.githubCancelSignIn).toHaveBeenCalled()
    expect(commands.githubSignOut).not.toHaveBeenCalled()
    expect(useGitStore.getState().signIn.open).toBe(false)

    finish({ status: 'error', error: 'Cancelled' })
    await done
    expect(useGitStore.getState().signIn.open).toBe(false)
    expect(setQueryData).not.toHaveBeenCalled()
  })
})
