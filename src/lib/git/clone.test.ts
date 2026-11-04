import { describe, expect, it } from 'vitest'
import type { RepoSummary } from '@/lib/bindings'
import {
  cloneProgressPercent,
  cloneUrlFromInput,
  filterRepos,
  sitesFolder,
} from './clone'

const repo = (fullName: string): RepoSummary => {
  const [owner = '', name = ''] = fullName.split('/')
  return {
    fullName,
    owner,
    name,
    private: false,
    defaultBranch: 'main',
    cloneUrl: `https://github.com/${fullName}.git`,
    updatedAt: '2026-11-01T10:00:00Z',
  }
}

describe('filterRepos', () => {
  const repos = [
    repo('kevinrobinson/site'),
    repo('kevinrobinson/portfolio'),
    repo('studio/Site-Archive'),
  ]
  it('keeps everything for an empty search', () => {
    expect(filterRepos(repos, '  ')).toHaveLength(3)
  })
  it('matches owner or name, ignoring case', () => {
    expect(filterRepos(repos, 'SITE').map(r => r.fullName)).toEqual([
      'kevinrobinson/site',
      'studio/Site-Archive',
    ])
    expect(filterRepos(repos, 'studio/')).toHaveLength(1)
  })
})

describe('cloneUrlFromInput', () => {
  it('accepts a GitHub web or clone URL', () => {
    expect(cloneUrlFromInput('https://github.com/kr/site')).toBe(
      'https://github.com/kr/site.git'
    )
    expect(cloneUrlFromInput(' https://github.com/kr/site.git ')).toBe(
      'https://github.com/kr/site.git'
    )
    expect(cloneUrlFromInput('https://github.com/kr/site/tree/main')).toBe(
      'https://github.com/kr/site.git'
    )
  })
  it('turns an SSH address into HTTPS, which works with the GitHub sign-in', () => {
    expect(cloneUrlFromInput('git@github.com:kr/site.git')).toBe(
      'https://github.com/kr/site.git'
    )
  })
  it('ignores a plain search', () => {
    expect(cloneUrlFromInput('site')).toBeNull()
    expect(cloneUrlFromInput('https://gitlab.com/kr/site')).toBeNull()
  })
})

describe('cloneProgressPercent', () => {
  it('is null until the size is known', () => {
    expect(cloneProgressPercent({ received: 0, total: 0 })).toBeNull()
  })
  it('rounds down and stays within 0–100', () => {
    expect(cloneProgressPercent({ received: 1, total: 3 })).toBe(33)
    expect(cloneProgressPercent({ received: 5, total: 4 })).toBe(100)
  })
})

describe('sitesFolder', () => {
  it('is ~/Sites', () => {
    expect(sitesFolder('/Users/kevin')).toBe('/Users/kevin/Sites')
    expect(sitesFolder('/Users/kevin/')).toBe('/Users/kevin/Sites')
  })
})
