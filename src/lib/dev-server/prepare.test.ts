import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '@/lib/bindings'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { mockToast, resetToastMocks } from '@/test/mocks/toast'
import { prepareSite, prepareSiteIfNeeded, siteNeedsPreparing } from './prepare'

vi.mock('@/lib/bindings', () => ({
  commands: {
    projectDependencies: vi.fn(),
    readFileContent: vi.fn(),
    devServerPrepare: vi.fn(),
  },
}))

const ok = <T>(data: T) => ({ status: 'ok' as const, data })
const COLLECTIONS = [
  { name: 'team', path: '/site/src/content/team' },
  { name: 'pages', path: '/site/src/content/pages' },
]
const STOPPED = {
  status: 'stopped' as const,
  url: null,
  command: null,
  pid: null,
  error: null,
}

describe('siteNeedsPreparing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(commands.projectDependencies).mockResolvedValue(ok(['astro']))
    vi.mocked(commands.readFileContent).mockResolvedValue({
      status: 'error',
      error: 'missing',
    })
  })

  it('is true for an Astro site with collections but no generated schemas', async () => {
    expect(await siteNeedsPreparing('/site', COLLECTIONS)).toBe(true)
    expect(commands.readFileContent).toHaveBeenCalledWith(
      '/site/.astro/collections/team.schema.json',
      '/site'
    )
  })

  it('is false once any collection has its schema', async () => {
    vi.mocked(commands.readFileContent)
      .mockResolvedValueOnce({ status: 'error', error: 'missing' })
      .mockResolvedValueOnce(ok('{}'))
    expect(await siteNeedsPreparing('/site', COLLECTIONS)).toBe(false)
  })

  it('is false without astro in package.json, or without collections', async () => {
    vi.mocked(commands.projectDependencies).mockResolvedValue(ok(['react']))
    expect(await siteNeedsPreparing('/site', COLLECTIONS)).toBe(false)
    vi.mocked(commands.projectDependencies).mockResolvedValue(ok(['astro']))
    expect(await siteNeedsPreparing('/site', [])).toBe(false)
  })
})

describe('prepareSite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetToastMocks()
  })

  it('runs the preparation, then reloads the collections', async () => {
    vi.mocked(commands.devServerPrepare).mockResolvedValue(ok(STOPPED))
    queryClient.setQueryData(queryKeys.collections('/site'), [])
    expect(await prepareSite('/site')).toBe(true)
    expect(commands.devServerPrepare).toHaveBeenCalledWith('/site')
    expect(
      queryClient.getQueryState(queryKeys.collections('/site'))?.isInvalidated
    ).toBe(true)
  })

  it('reports a failed preparation as false', async () => {
    vi.mocked(commands.devServerPrepare).mockResolvedValue(
      ok({ ...STOPPED, status: 'error' as const, error: 'npm ERR!' })
    )
    expect(await prepareSite('/site')).toBe(false)
  })
})

describe('prepareSiteIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetToastMocks()
    vi.mocked(commands.projectDependencies).mockResolvedValue(ok(['astro']))
    vi.mocked(commands.readFileContent).mockResolvedValue({
      status: 'error',
      error: 'missing',
    })
    vi.mocked(commands.devServerPrepare).mockResolvedValue(ok(STOPPED))
  })

  it('prepares once per project, saying so', async () => {
    await prepareSiteIfNeeded('/fresh', COLLECTIONS)
    await prepareSiteIfNeeded('/fresh', COLLECTIONS)
    expect(commands.devServerPrepare).toHaveBeenCalledTimes(1)
    expect(mockToast.info).toHaveBeenCalledWith(
      'Preparing your site…',
      expect.anything()
    )
  })
})
