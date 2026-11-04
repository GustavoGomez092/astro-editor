import { describe, expect, it } from 'vitest'
import type { ChangedFile, GraphCommit, PullRequest } from '@/lib/bindings'
import {
  branchNameFrom,
  changeTitles,
  changedFileTitle,
  entryTitle,
  defaultCommitMessage,
  isBehindBranch,
  pullRequestForBranch,
  syncSummary,
} from './changes'

const file = (path: string, change: ChangedFile['change'] = 'modified') => ({
  path,
  oldPath: null,
  change,
})

describe('defaultCommitMessage', () => {
  it('is empty when nothing changed', () => {
    expect(defaultCommitMessage([])).toBe('')
  })
  it('names up to three entries', () => {
    expect(defaultCommitMessage(['About'])).toBe('Update About')
    expect(defaultCommitMessage(['About', 'Contact'])).toBe(
      'Update About, Contact'
    )
    expect(defaultCommitMessage(['About', 'Contact', 'Home'])).toBe(
      'Update About, Contact, Home'
    )
  })
  it('counts the rest after three', () => {
    expect(defaultCommitMessage(['A', 'B', 'C', 'D', 'E'])).toBe(
      'Update A, B, C and 2 more'
    )
  })
  it("doesn't repeat a title", () => {
    expect(defaultCommitMessage(['About', 'About', 'Home'])).toBe(
      'Update About, Home'
    )
  })
})

describe('changedFileTitle', () => {
  const titles = new Map([['/site/src/content/pages/about.md', 'About me']])

  it("uses the entry's title when the file is a known entry", () => {
    expect(
      changedFileTitle(file('src/content/pages/about.md'), '/site', titles)
    ).toBe('About me')
  })
  it('falls back to the file name without its extension', () => {
    expect(
      changedFileTitle(file('src/assets/hero-image.jpg'), '/site', titles)
    ).toBe('hero-image')
    expect(changedFileTitle(file('README'), '/site', titles)).toBe('README')
  })
  it('copes with a trailing slash on the project path', () => {
    expect(
      changedFileTitle(file('src/content/pages/about.md'), '/site/', titles)
    ).toBe('About me')
  })
})

const commit = (
  id: string,
  parents: string[],
  refs: GraphCommit['refs'] = []
): GraphCommit => ({
  id,
  shortId: id,
  parents,
  summary: id,
  authorName: 'K',
  time: 0,
  refs,
})

describe('isBehindBranch', () => {
  it('is false when the default branch is already in the current one', () => {
    const log = [
      commit('s2', ['s1'], [{ name: 'staging', kind: 'head' }]),
      commit('s1', ['m1']),
      commit('m1', [], [{ name: 'origin/main', kind: 'remoteBranch' }]),
    ]
    expect(isBehindBranch(log, 'staging', 'main')).toBe(false)
  })

  it('is true when the default branch has commits the current one lacks', () => {
    const log = [
      commit('m2', ['m1'], [{ name: 'origin/main', kind: 'remoteBranch' }]),
      commit('s1', ['m1'], [{ name: 'staging', kind: 'localBranch' }]),
      commit('m1', []),
    ]
    expect(isBehindBranch(log, 'staging', 'main')).toBe(true)
  })

  it('prefers the remote default branch over a stale local one', () => {
    const log = [
      commit('m2', ['m1'], [{ name: 'origin/main', kind: 'remoteBranch' }]),
      commit('s1', ['m1'], [{ name: 'staging', kind: 'head' }]),
      commit('m1', [], [{ name: 'main', kind: 'localBranch' }]),
    ]
    expect(isBehindBranch(log, 'staging', 'main')).toBe(true)
  })

  it("is null when either tip isn't in the loaded history", () => {
    const log = [commit('s1', [], [{ name: 'staging', kind: 'head' }])]
    expect(isBehindBranch(log, 'staging', 'main')).toBeNull()
  })
})

describe('pullRequestForBranch', () => {
  const pr = (number: number, head: string): PullRequest => ({
    number,
    title: `PR ${number}`,
    head,
    base: 'main',
    state: 'open',
    draft: false,
    htmlUrl: '',
    mergeable: true,
    checks: 'none',
  })
  it('finds the open pull request from this branch', () => {
    expect(
      pullRequestForBranch([pr(1, 'other'), pr(2, 'staging')], 'staging')
        ?.number
    ).toBe(2)
  })
  it('is undefined when there is none', () => {
    expect(pullRequestForBranch([pr(1, 'other')], 'staging')).toBeUndefined()
  })
})

describe('syncSummary', () => {
  const status = (ahead: number, behind: number, upstream: string | null) => ({
    isRepo: true,
    branch: 'main',
    defaultBranch: 'main',
    upstream,
    ahead,
    behind,
    files: [],
    detached: false,
  })

  it('says when everything matches', () => {
    expect(syncSummary(status(0, 0, 'origin/main'), 'GitHub')).toBe(
      'Up to date with GitHub'
    )
  })
  it('counts updates waiting to go up and new ones to bring down', () => {
    expect(syncSummary(status(1, 0, 'origin/main'), 'GitHub')).toBe(
      '1 update not on GitHub yet'
    )
    expect(syncSummary(status(2, 3, 'origin/main'), 'GitHub')).toBe(
      '2 updates not on GitHub yet · 3 new on GitHub'
    )
    expect(syncSummary(status(0, 1, 'origin/main'), 'the server')).toBe(
      '1 new on the server'
    )
  })
  it('explains a branch that was never published', () => {
    expect(syncSummary(status(0, 0, null), 'GitHub')).toBe(
      'Not on GitHub yet. Publish puts it there.'
    )
  })
})

describe('branchNameFrom', () => {
  it('turns words into a branch name', () => {
    expect(branchNameFrom('Spring copy!')).toBe('spring-copy')
    expect(branchNameFrom('  New   Home Page ')).toBe('new-home-page')
  })
  it('keeps slashes and dots that git allows', () => {
    expect(branchNameFrom('kevin/v1.2')).toBe('kevin/v1.2')
  })
  it('is empty when nothing usable is left', () => {
    expect(branchNameFrom('!!!')).toBe('')
  })
})

describe('entryTitle and changeTitles', () => {
  const titles = new Map([['/site/src/content/pages/about.md', 'About me']])
  const files = [
    file('src/assets/cover.jpg', 'added'),
    file('src/content/pages/about.md'),
    file('src/content/notes/old.md', 'deleted'),
  ]

  it('finds the entry title of a changed content file', () => {
    expect(entryTitle(files[1]!, '/site', titles)).toBe('About me')
    expect(entryTitle(files[0]!, '/site', titles)).toBeUndefined()
  })

  it('puts entries with titles first, then other files by name', () => {
    expect(changeTitles(files, '/site', titles)).toEqual([
      'About me',
      'cover',
      'old',
    ])
  })
})
