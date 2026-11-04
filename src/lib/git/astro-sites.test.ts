import { beforeEach, describe, expect, it } from 'vitest'
import type { RepoSummary } from '@/lib/bindings'
import {
  cachedCheck,
  chunk,
  loadShowAll,
  saveChecks,
  saveShowAll,
  visibleRepos,
  type SiteStatus,
} from './astro-sites'

const repo = (fullName: string, pushedAt: string | null): RepoSummary => ({
  fullName,
  owner: 'k',
  name: fullName,
  private: false,
  defaultBranch: 'main',
  cloneUrl: '',
  updatedAt: '2026-11-01T00:00:00Z',
  pushedAt,
})

describe('astro site cache', () => {
  beforeEach(() => localStorage.clear())

  it('remembers definite answers for the same push', () => {
    const a = repo('k/a', '2026-10-01T00:00:00Z')
    const b = repo('k/b', '2026-10-01T00:00:00Z')
    saveChecks(
      [a, b],
      new Map([
        ['k/a', 'astro'],
        ['k/b', 'notAstro'],
      ])
    )
    expect(cachedCheck(a)).toBe('astro')
    expect(cachedCheck(b)).toBe('notAstro')
  })

  it('checks again after a push', () => {
    saveChecks([repo('k/a', 'one')], new Map([['k/a', 'astro']]))
    expect(cachedCheck(repo('k/a', 'two'))).toBeNull()
  })

  it("doesn't remember unknown", () => {
    const a = repo('k/a', 'one')
    saveChecks([a], new Map([['k/a', 'unknown']]))
    expect(cachedCheck(a)).toBeNull()
  })

  it('survives a damaged cache', () => {
    localStorage.setItem('astro-editor:astro-site-checks', '{nope')
    expect(cachedCheck(repo('k/a', 'one'))).toBeNull()
  })
})

describe('visibleRepos', () => {
  const repos = ['astro', 'notAstro', 'unknown', 'checking'].map(s =>
    repo(s, null)
  )
  const statusOf = (r: RepoSummary) => r.fullName as SiteStatus

  it('drops only the ones known not to be Astro', () => {
    expect(visibleRepos(repos, statusOf, false).map(r => r.fullName)).toEqual([
      'astro',
      'unknown',
      'checking',
    ])
  })
  it('shows everything when asked', () => {
    expect(visibleRepos(repos, statusOf, true)).toHaveLength(4)
  })
})

describe('helpers', () => {
  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('remembers the show-all choice, off by default', () => {
    localStorage.clear()
    expect(loadShowAll()).toBe(false)
    saveShowAll(true)
    expect(loadShowAll()).toBe(true)
  })
})
