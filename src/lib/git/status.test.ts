import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commands, type GitStatus } from '@/lib/bindings'
import { FETCH_INTERVAL_MS, loadGitStatus, resetGitFetchTimes } from './status'

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
      data: { ...STATUS, behind: 2 },
    })
  })

  it('fetches first when signed in and the project has just opened', async () => {
    const status = await loadGitStatus('/site', { signedIn: true, now: 0 })
    expect(commands.gitFetch).toHaveBeenCalledWith('/site')
    expect(commands.gitStatus).not.toHaveBeenCalled()
    expect(status.behind).toBe(2)
  })

  it('only reads local status when not signed in', async () => {
    await loadGitStatus('/site', { signedIn: false, now: 0 })
    expect(commands.gitFetch).not.toHaveBeenCalled()
    expect(commands.gitStatus).toHaveBeenCalledWith('/site')
  })

  it('fetches again only after five minutes', async () => {
    await loadGitStatus('/site', { signedIn: true, now: 0 })
    await loadGitStatus('/site', { signedIn: true, now: FETCH_INTERVAL_MS - 1 })
    expect(commands.gitFetch).toHaveBeenCalledTimes(1)
    expect(commands.gitStatus).toHaveBeenCalledTimes(1)

    await loadGitStatus('/site', { signedIn: true, now: FETCH_INTERVAL_MS })
    expect(commands.gitFetch).toHaveBeenCalledTimes(2)
  })

  it('fetches first again when another project opens', async () => {
    await loadGitStatus('/site', { signedIn: true, now: 0 })
    await loadGitStatus('/other', { signedIn: true, now: 10 })
    expect(commands.gitFetch).toHaveBeenLastCalledWith('/other')
  })

  it('falls back to local status when the fetch fails (offline)', async () => {
    vi.mocked(commands.gitFetch).mockResolvedValue({
      status: 'error',
      error: "Couldn't reach GitHub",
    })
    const status = await loadGitStatus('/site', { signedIn: true, now: 0 })
    expect(status).toEqual(STATUS)
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
