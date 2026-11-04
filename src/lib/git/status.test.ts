import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commands, type GitStatus } from '@/lib/bindings'
import {
  FETCH_INTERVAL_MS,
  FETCH_SLACK_MS,
  loadGitStatus,
  resetGitFetchTimes,
} from './status'

vi.mock('@/lib/bindings', () => ({
  commands: { gitStatus: vi.fn(), gitFetch: vi.fn() },
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
const FETCHED = { ...STATUS, behind: 2 }

describe('loadGitStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetGitFetchTimes()
    vi.mocked(commands.gitStatus).mockResolvedValue({
      status: 'ok',
      data: STATUS,
    })
    vi.mocked(commands.gitFetch).mockResolvedValue({
      status: 'ok',
      data: FETCHED,
    })
  })

  it('returns the local status at once and fetches in the background when signed in', async () => {
    let finishFetch: (value: unknown) => void = () => {}
    vi.mocked(commands.gitFetch).mockReturnValue(
      new Promise(resolve => (finishFetch = resolve)) as never
    )
    const onFetched = vi.fn()

    const status = await loadGitStatus('/site', {
      signedIn: true,
      now: 0,
      onFetched,
    })
    // The fetch hasn't finished, and the status didn't wait for it
    expect(status).toEqual(STATUS)
    expect(commands.gitFetch).toHaveBeenCalledWith('/site')
    expect(onFetched).not.toHaveBeenCalled()

    finishFetch({ status: 'ok', data: FETCHED })
    await vi.waitFor(() => expect(onFetched).toHaveBeenCalledWith(FETCHED))
  })

  it('reads the local status before the fetch starts', async () => {
    const order: string[] = []
    vi.mocked(commands.gitStatus).mockImplementation(() => {
      order.push('status')
      return Promise.resolve({ status: 'ok', data: STATUS })
    })
    vi.mocked(commands.gitFetch).mockImplementation(() => {
      order.push('fetch')
      return Promise.resolve({ status: 'ok', data: FETCHED })
    })
    await loadGitStatus('/site', { signedIn: true, now: 0 })
    expect(order).toEqual(['status', 'fetch'])
  })

  it('never fetches when not signed in', async () => {
    await loadGitStatus('/site', { signedIn: false, now: 0 })
    expect(commands.gitFetch).not.toHaveBeenCalled()
  })

  it('fetches again after about five minutes, allowing for timer slack', async () => {
    await loadGitStatus('/site', { signedIn: true, now: 0 })
    await loadGitStatus('/site', { signedIn: true, now: 60_000 })
    expect(commands.gitFetch).toHaveBeenCalledTimes(1)

    // A 5-minute timer that fires a little early still fetches
    await loadGitStatus('/site', {
      signedIn: true,
      now: FETCH_INTERVAL_MS - FETCH_SLACK_MS,
    })
    expect(commands.gitFetch).toHaveBeenCalledTimes(2)
  })

  it('remembers the last fetch per project', async () => {
    await loadGitStatus('/site', { signedIn: true, now: 0 })
    await loadGitStatus('/other', { signedIn: true, now: 10 })
    // Back to the first project within five minutes: no new fetch
    await loadGitStatus('/site', { signedIn: true, now: 20 })
    expect(vi.mocked(commands.gitFetch).mock.calls).toEqual([
      ['/site'],
      ['/other'],
    ])
  })

  it('keeps the local status when the fetch fails (offline)', async () => {
    vi.mocked(commands.gitFetch).mockResolvedValue({
      status: 'error',
      error: "Couldn't reach GitHub",
    })
    const onFetched = vi.fn()
    const status = await loadGitStatus('/site', {
      signedIn: true,
      now: 0,
      onFetched,
    })
    expect(status).toEqual(STATUS)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onFetched).not.toHaveBeenCalled()
  })

  it('throws the readable message when status itself fails', async () => {
    vi.mocked(commands.gitStatus).mockResolvedValue({
      status: 'error',
      error: 'The project folder is missing',
    })
    await expect(
      loadGitStatus('/site', { signedIn: false, now: 0 })
    ).rejects.toThrow('The project folder is missing')
  })
})
