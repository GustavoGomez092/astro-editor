import { describe, expect, it } from 'vitest'
import { pathsIn, presentGitMessage, syncToastKind } from './messages'

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
    ).toBe(
      'Your changes and the changes on the remote both edited “Schema article”.'
    )
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
