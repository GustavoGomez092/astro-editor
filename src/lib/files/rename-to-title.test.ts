import { describe, it, expect } from 'vitest'
import {
  fileNameMatchesTitle,
  renameTargetFor,
  titleText,
  withSlugField,
} from './rename-to-title'

describe('fileNameMatchesTitle', () => {
  it('matches the title’s slug', () => {
    expect(fileNameMatchesTitle('Andrew Dyk', 'andrew-dyk.md')).toBe(true)
  })

  it('matches a slug that got -1 from a clash', () => {
    expect(fileNameMatchesTitle('Andrew Dyk', 'andrew-dyk-2.mdx')).toBe(true)
  })

  it('does not match a different name', () => {
    expect(fileNameMatchesTitle('Andrew Dyk', 'old-name.md')).toBe(false)
    expect(fileNameMatchesTitle('Andrew Dyk', 'andrew-dyk-extra.md')).toBe(
      false
    )
  })

  it('treats an empty or symbol-only title as matching', () => {
    expect(fileNameMatchesTitle('', 'x.md')).toBe(true)
    expect(fileNameMatchesTitle('   ', 'x.md')).toBe(true)
    expect(fileNameMatchesTitle('!!!', 'x.md')).toBe(true)
    expect(fileNameMatchesTitle(undefined, 'x.md')).toBe(true)
  })
})

describe('renameTargetFor', () => {
  it('returns the slug with the same extension', () => {
    expect(renameTargetFor('Fresh Heading', 'old.mdx', ['old.mdx'])).toBe(
      'fresh-heading.mdx'
    )
  })

  it('adds -1, -2 when the name is taken, whatever its extension', () => {
    expect(
      renameTargetFor('Fresh Heading', 'old.md', [
        'old.md',
        'fresh-heading.md',
        'fresh-heading-1.mdx',
      ])
    ).toBe('fresh-heading-2.md')
  })

  it('treats names that differ only in case as taken', () => {
    expect(
      renameTargetFor('Fresh Heading', 'old.md', ['old.md', 'Fresh-Heading.md'])
    ).toBe('fresh-heading-1.md')
  })

  it('allows a case-only rename of the file itself', () => {
    expect(
      renameTargetFor('Fresh Heading', 'Fresh-Heading.md', ['Fresh-Heading.md'])
    ).toBe('fresh-heading.md')
  })

  it('returns null when the name already follows the title', () => {
    expect(
      renameTargetFor('Fresh Title', 'fresh-title.md', ['fresh-title.md'])
    ).toBeNull()
  })

  it('keeps a -1 that a clash added instead of renaming again', () => {
    expect(
      renameTargetFor('Fresh Title', 'fresh-title-1.md', [
        'fresh-title.md',
        'fresh-title-1.md',
      ])
    ).toBeNull()
  })

  it('returns null without a usable title', () => {
    expect(renameTargetFor('', 'a.md', [])).toBeNull()
    expect(renameTargetFor(undefined, 'a.md', [])).toBeNull()
    expect(renameTargetFor(42, 'a.md', [])).toBeNull()
    expect(renameTargetFor('???', 'a.md', [])).toBeNull()
  })
})

describe('withSlugField', () => {
  it('updates a slug that is text', () => {
    expect(withSlugField({ title: 'T', slug: 'old' }, 'new-name.md')).toEqual({
      title: 'T',
      slug: 'new-name',
    })
  })

  it('returns the same object when the slug already matches', () => {
    const fm = { slug: 'new-name' }
    expect(withSlugField(fm, 'new-name.md')).toBe(fm)
  })

  it('leaves frontmatter without a slug alone', () => {
    const fm = { title: 'T' }
    expect(withSlugField(fm, 'new-name.md')).toBe(fm)
  })

  it('leaves a slug that is not text alone', () => {
    const fm = { slug: 5 }
    expect(withSlugField(fm, 'new-name.md')).toBe(fm)
  })
})

describe('titleText', () => {
  it('trims text and ignores other values', () => {
    expect(titleText('  Hi ')).toBe('Hi')
    expect(titleText(null)).toBe('')
  })
})
