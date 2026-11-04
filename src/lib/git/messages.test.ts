import { describe, expect, it } from 'vitest'
import {
  broughtInMessage,
  pathsIn,
  presentGitMessage,
  publishedMessage,
  shortTitle,
  syncToastKind,
} from './messages'

describe('syncToastKind', () => {
  it('celebrates changes brought in', () => {
    expect(syncToastKind('fastForwarded')).toBe('success')
    expect(syncToastKind('merged')).toBe('success')
  })
  it('stays quiet when there was nothing to do', () => {
    expect(syncToastKind('upToDate')).toBe('info')
    expect(syncToastKind('noUpstream')).toBe('info')
  })
  it('warns when the writer has something to sort out', () => {
    expect(syncToastKind('blockedByLocalChanges')).toBe('warning')
    expect(syncToastKind('conflict')).toBe('warning')
  })
})

describe('presentGitMessage', () => {
  const titles = new Map([
    ['src/content/articles/2023-12-05-schema.md', 'Schema article'],
  ])
  const titleFor = (path: string) => titles.get(path)

  it('names entries by their titles instead of their paths', () => {
    expect(
      presentGitMessage(
        'Your changes and the changes on the remote both edited src/content/articles/2023-12-05-schema.md.',
        { onGitHub: false, titleFor }
      )
    ).toBe('Your changes and the other changes both edited “Schema article”.')
  })

  it('says "the other changes" for a remote that is not GitHub', () => {
    expect(
      presentGitMessage(
        'Your changes and the changes on origin both edited a.md.',
        { onGitHub: false, titleFor }
      )
    ).toBe('Your changes and the other changes both edited a.md.')
    // A branch keeps its name
    expect(
      presentGitMessage('This branch and the changes on main differ.', {
        onGitHub: false,
        titleFor,
      })
    ).toBe('This branch and the changes on main differ.')
  })

  it('leaves paths it has no title for', () => {
    expect(
      presentGitMessage('Both edited STAGING.md.', {
        onGitHub: false,
        titleFor,
      })
    ).toBe('Both edited STAGING.md.')
  })

  it('says GitHub, not the remote, when the remote is GitHub', () => {
    expect(
      presentGitMessage(
        'The remote has changes. Brought in 2 changes from the remote.',
        {
          onGitHub: true,
          titleFor,
        }
      )
    ).toBe('GitHub has changes. Brought in 2 changes from GitHub.')
    expect(
      presentGitMessage('Brought in 2 changes from the remote.', {
        onGitHub: false,
        titleFor,
      })
    ).toBe('Brought in 2 changes from the remote.')
  })

  it('finds the paths a message mentions', () => {
    expect(
      pathsIn(
        'Both edited src/content/a.md and src/assets/b.png. Published to main.'
      )
    ).toEqual(['src/content/a.md', 'src/assets/b.png'])
  })
})

describe('shortTitle', () => {
  it('keeps a title of 40 characters or fewer as it is', () => {
    const forty = 'a'.repeat(40)
    expect(shortTitle(forty)).toBe(forty)
  })
  it('shortens a longer title with an ellipsis, at a word when it can', () => {
    expect(
      shortTitle('How we rebuilt the studio website from the ground up')
    ).toBe('How we rebuilt the studio website from…')
  })
  it('cuts a long word when there is no space to break at', () => {
    expect(shortTitle('x'.repeat(60))).toBe(`${'x'.repeat(39)}…`)
  })
})

describe('publishedMessage', () => {
  it('says the site will update when publishing the default branch', () => {
    expect(publishedMessage('main', 'main')).toBe(
      'Published. Your site will update in a few minutes.'
    )
  })
  it('names the branch otherwise', () => {
    expect(publishedMessage('staging', 'main')).toBe('Published to staging.')
  })
})

describe('broughtInMessage', () => {
  it('counts the changes and says what to do next', () => {
    expect(broughtInMessage(1, 'main')).toBe(
      'Brought in 1 change from main. Publish to send them to the remote.'
    )
    expect(broughtInMessage(3, 'main')).toBe(
      'Brought in 3 changes from main. Publish to send them to the remote.'
    )
  })
  it('leaves the count out when it is not known', () => {
    expect(broughtInMessage(0, 'main')).toBe(
      'Brought in the changes from main. Publish to send them to the remote.'
    )
  })
})
