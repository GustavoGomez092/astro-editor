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

  describe('while the open file is still loading', () => {
    // openFile empties the body before the file loads, so its text is unknown
    const loading = {
      fileHasBody: undefined,
    } as const

    it('keeps the previous choice when only the file can decide', () => {
      for (const previous of [true, false]) {
        for (const collectionHasBody of [true, undefined]) {
          expect(
            hidesBodyEditor({
              ...loading,
              setting: 'hide',
              collectionHasBody,
              previous,
            })
          ).toBe(previous)
        }
      }
    })

    it('decides at once when no entry has body text', () => {
      expect(
        hidesBodyEditor({
          ...loading,
          setting: 'hide',
          collectionHasBody: false,
          previous: false,
        })
      ).toBe(true)
      expect(
        hidesBodyEditor({
          ...loading,
          setting: undefined,
          collectionHasBody: false,
          previous: false,
        })
      ).toBe(true)
    })

    it('decides at once when the file has no say', () => {
      expect(
        hidesBodyEditor({
          ...loading,
          setting: 'show',
          collectionHasBody: false,
          previous: true,
        })
      ).toBe(false)
      expect(
        hidesBodyEditor({
          ...loading,
          setting: undefined,
          collectionHasBody: true,
          previous: true,
        })
      ).toBe(false)
    })
  })
})
