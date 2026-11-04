import { describe, it, expect } from 'vitest'
import { hidesBodyEditor } from './body-text'

describe('hidesBodyEditor', () => {
  it('hides the editor when no entry in the collection has body text', () => {
    expect(
      hidesBodyEditor({
        setting: undefined,
        collectionHasBody: false,
        fileHasBody: false,
      })
    ).toBe(true)
  })

  it('shows it when some entry has body text', () => {
    expect(
      hidesBodyEditor({
        setting: undefined,
        collectionHasBody: true,
        fileHasBody: false,
      })
    ).toBe(false)
  })

  it('shows it while the collection is still being checked', () => {
    expect(
      hidesBodyEditor({
        setting: undefined,
        collectionHasBody: undefined,
        fileHasBody: false,
      })
    ).toBe(false)
  })

  it('follows the collection setting over detection', () => {
    expect(
      hidesBodyEditor({
        setting: 'show',
        collectionHasBody: false,
        fileHasBody: false,
      })
    ).toBe(false)
    expect(
      hidesBodyEditor({
        setting: 'hide',
        collectionHasBody: true,
        fileHasBody: false,
      })
    ).toBe(true)
  })

  it('never hides body text the open file has', () => {
    expect(
      hidesBodyEditor({
        setting: 'hide',
        collectionHasBody: false,
        fileHasBody: true,
      })
    ).toBe(false)
  })
})
