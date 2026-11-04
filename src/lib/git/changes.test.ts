import { describe, expect, it } from 'vitest'
import type { GitStatus, GraphCommit, PullRequest } from '@/lib/bindings'
import {
  BUSY,
  REPEAT,
  branchNameFrom,
  bringInBlocker,
  checkedLabel,
  entryTitle,
  gitStateSignature,
  publishBlocker,
  publishMessage,
  pullRequestForBranch,
  pullRequestTitle,
  syncBlocker,
  syncSummary,
  waitingToPublish,
  type MessageItem,
} from './changes'

const entry = (
  title: string | undefined,
  change: MessageItem['change'] = 'modified'
): MessageItem => ({
  title,
  change,
  entry: true,
  path: `src/content/pages/${title ?? 'x'}.md`,
})
const asset = (
  path: string,
  change: MessageItem['change'] = 'added'
): MessageItem => ({ path, change, entry: false })

describe('publishMessage', () => {
  it('is empty when nothing changed', () => {
    expect(publishMessage([])).toBe('')
  })

  it('names up to three entries by title', () => {
    expect(publishMessage([entry('About')])).toBe('Update About')
    expect(
      publishMessage([entry('About'), entry('Contact'), entry('Home')])
    ).toBe('Update About, Contact, Home')
  })

  it('counts the rest after three', () => {
    expect(publishMessage(['A', 'B', 'C', 'D', 'E'].map(t => entry(t)))).toBe(
      'Update A, B, C and 2 more'
    )
  })

  it('says Add and Remove for new and deleted entries', () => {
    expect(publishMessage([entry('Harbour', 'untracked')])).toBe('Add Harbour')
    expect(publishMessage([entry('Old site', 'deleted')])).toBe(
      'Remove Old site'
    )
    expect(
      publishMessage([
        entry('About'),
        entry('Harbour', 'added'),
        entry('Old site', 'deleted'),
      ])
    ).toBe('Add Harbour, update About, remove Old site')
  })

  it('never names images or other files', () => {
    expect(
      publishMessage([entry('About'), asset('src/assets/cover.jpg')])
    ).toBe('Update About and images')
    expect(
      publishMessage([entry('About'), asset('astro.config.mjs', 'modified')])
    ).toBe('Update About and other files')
  })

  it('describes changes that are only images or other files', () => {
    expect(publishMessage([asset('a.png'), asset('b.webp', 'modified')])).toBe(
      'Update images'
    )
    expect(publishMessage([asset('a.png'), asset('b.svg')])).toBe('Add images')
    expect(publishMessage([asset('package.json', 'modified')])).toBe(
      'Update site files'
    )
  })

  it("counts entries whose title isn't known instead of naming their files", () => {
    expect(publishMessage([entry(undefined, 'deleted')])).toBe('Remove 1 entry')
    expect(publishMessage([entry('About'), entry(undefined, 'deleted')])).toBe(
      'Update About, remove 1 entry'
    )
    expect(
      publishMessage([
        entry('About'),
        entry(undefined, 'deleted'),
        asset('src/assets/new.jpg'),
      ])
    ).toBe('Update About, remove 1 entry and images')
    // Once names overflow, untitled entries join the count
    expect(
      publishMessage([
        ...['A', 'B', 'C', 'D'].map(t => entry(t)),
        entry(undefined, 'deleted'),
      ])
    ).toBe('Update A, B, C and 2 more')
  })

  it("doesn't repeat a title", () => {
    expect(publishMessage([entry('About'), entry('About')])).toBe(
      'Update About'
    )
  })

  it('drops the end punctuation of each title it names', () => {
    expect(
      publishMessage(
        [
          'Clarity',
          'Good ideas. Clear thinking. Better execution.',
          'Andrew Dyk',
          'Why now?',
          'Hello!',
          'Coming soon…',
          'Notes;',
        ].map(t => entry(t))
      )
    ).toBe(
      'Update Clarity, Good ideas. Clear thinking. Better execution, Andrew Dyk and 4 more'
    )
    expect(publishMessage([entry('Why now?'), entry('Hello!', 'added')])).toBe(
      'Add Hello, update Why now'
    )
    expect(publishMessage([entry('Coming soon…'), entry('Notes;')])).toBe(
      'Update Coming soon, Notes'
    )
  })
})

describe('entryTitle', () => {
  const titles = new Map([['/site/src/content/pages/about.md', 'About me']])
  it('finds the title of a known entry, with or without a trailing slash', () => {
    expect(
      entryTitle({ path: 'src/content/pages/about.md' }, '/site', titles)
    ).toBe('About me')
    expect(
      entryTitle({ path: 'src/content/pages/about.md' }, '/site/', titles)
    ).toBe('About me')
    expect(
      entryTitle({ path: 'src/assets/cover.jpg' }, '/site', titles)
    ).toBeUndefined()
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
    expect(pullRequestForBranch([pr(1, 'other')], 'staging')).toBeUndefined()
  })
})

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

describe('syncSummary and waitingToPublish', () => {
  it('describes where the branch stands', () => {
    expect(syncSummary(STATUS, 'GitHub')).toBe('Up to date with GitHub')
    expect(syncSummary({ ...STATUS, ahead: 2, behind: 3 }, 'GitHub')).toBe(
      '2 updates not on GitHub yet · 3 new on GitHub'
    )
    expect(syncSummary({ ...STATUS, upstream: null }, 'GitHub')).toBe(
      'Not on GitHub yet. Publish puts it there.'
    )
  })
  it('says how many updates are saved but waiting', () => {
    expect(waitingToPublish(1)).toBe(
      'Everything is saved. 1 update waiting to be published.'
    )
    expect(waitingToPublish(3)).toBe(
      'Everything is saved. 3 updates waiting to be published.'
    )
  })
})

describe('branchNameFrom', () => {
  it('turns words into a branch name', () => {
    expect(branchNameFrom('Spring copy!')).toBe('spring-copy')
    expect(branchNameFrom('kevin/v1.2')).toBe('kevin/v1.2')
    expect(branchNameFrom('!!!')).toBe('')
  })
})

describe('gitStateSignature', () => {
  it('changes with a fetch, a commit, an edit or a branch switch', () => {
    const base = gitStateSignature(STATUS, 0)
    expect(gitStateSignature({ ...STATUS }, 0)).toBe(base)
    expect(gitStateSignature({ ...STATUS, behind: 1 }, 0)).not.toBe(base)
    expect(gitStateSignature({ ...STATUS, ahead: 1 }, 0)).not.toBe(base)
    expect(gitStateSignature({ ...STATUS, branch: 'staging' }, 0)).not.toBe(
      base
    )
    expect(gitStateSignature(STATUS, 2)).not.toBe(base)
    expect(
      gitStateSignature(
        {
          ...STATUS,
          files: [{ path: 'a.md', oldPath: null, change: 'modified' }],
        },
        0
      )
    ).not.toBe(base)
  })
})

describe('action guards', () => {
  const changed: GitStatus = {
    ...STATUS,
    files: [{ path: 'a.md', oldPath: null, change: 'modified' }],
  }
  const ready = {
    status: changed,
    busy: false,
    heldBack: null,
    message: 'Update A',
  }

  it('lets Publish run when there is something to publish and a message', () => {
    expect(publishBlocker(ready)).toBeNull()
    expect(
      publishBlocker({ ...ready, status: { ...STATUS, ahead: 1 } })
    ).toBeNull()
  })

  it('says why Publish is held back', () => {
    expect(publishBlocker({ ...ready, busy: true })).toBe(BUSY)
    expect(
      publishBlocker({ ...ready, status: { ...changed, isRepo: false } })
    ).toMatch(/isn't a git repository/)
    expect(
      publishBlocker({ ...ready, status: { ...changed, detached: true } })
    ).toMatch(/not a branch/)
    expect(publishBlocker({ ...ready, status: STATUS })).toBe(
      'Nothing new to publish.'
    )
    expect(publishBlocker({ ...ready, message: '  ' })).toMatch(/message/)
    expect(publishBlocker({ ...ready, heldBack: 'publish' })).toBe(REPEAT)
  })

  it('lets Publish run with unsaved edits, which it saves first', () => {
    expect(
      publishBlocker({
        ...ready,
        status: STATUS,
        message: '',
        unsavedEdits: true,
      })
    ).toBeNull()
  })

  it('holds back only the action that hit the conflict', () => {
    const input = { status: STATUS, busy: false, heldBack: 'bringIn' as const }
    expect(syncBlocker(input)).toBeNull()
    expect(bringInBlocker(input)).toBe(REPEAT)
    expect(syncBlocker({ ...input, busy: true })).toBe(BUSY)
  })
})

describe('pullRequestTitle', () => {
  const commit = (
    id: string,
    summary: string,
    parents: string[],
    head = false
  ): GraphCommit => ({
    id,
    shortId: id,
    parents,
    summary,
    authorName: 'Kevin',
    time: 0,
    refs: head ? [{ name: 'HEAD', kind: 'head' }] : [],
  })

  it('uses the latest commit on the branch', () => {
    const log = [
      commit('c', 'Add Jordan Ellis', ['b'], true),
      commit('b', 'Update About', ['a']),
      commit('a', 'Start', []),
    ]
    expect(pullRequestTitle(log, 'spring', 2)).toBe('Add Jordan Ellis')
  })

  it('skips merge commits made by Sync or Bring in', () => {
    const log = [
      commit('m', 'Combine changes from GitHub', ['c', 'x'], true),
      commit('c', 'Add Jordan Ellis', ['a']),
      commit('x', 'Theirs', ['a']),
      commit('a', 'Start', []),
    ]
    expect(pullRequestTitle(log, 'spring', 2)).toBe('Add Jordan Ellis')
  })

  it('falls back to the branch when there is no commit of its own', () => {
    const log = [commit('a', 'Start', [], true)]
    expect(pullRequestTitle(log, 'spring', 0)).toBe('Changes from spring')
    expect(pullRequestTitle([], 'spring', 1)).toBe('Changes from spring')
  })
})

describe('checkedLabel', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const ago = (ms: number) => checkedLabel(now - ms, now)
  it('says how long ago GitHub was checked, in plain words', () => {
    expect(ago(20_000)).toBe('Checked just now')
    expect(ago(3 * 60_000)).toBe('Checked 3 min ago')
    expect(ago(60 * 60_000)).toBe('Checked 1 hour ago')
    expect(ago(5 * 60 * 60_000)).toBe('Checked 5 hours ago')
    expect(ago(2 * 24 * 60 * 60_000)).toBe('Checked 2 days ago')
  })
})
