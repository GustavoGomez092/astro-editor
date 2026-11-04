import { describe, expect, it } from 'vitest'
import { FieldType, type SchemaField } from './schema'
import {
  frontmatterToWrite,
  nextFrontmatterBaseline,
  sameValues,
} from './frontmatter-save'

// Quoted YAML, which writing the values back would reformat
const RAW = `title: "Andrew Dyk"\nrole: 'Founder, "AD Studio"'\nfeatured: false\ntags: ["one", "two"]`
const VALUES = {
  title: 'Andrew Dyk',
  role: 'Founder, "AD Studio"',
  featured: false,
  tags: ['one', 'two'],
}
const BASELINE = { values: VALUES, raw: RAW }

describe('sameValues', () => {
  it('compares nested values, whatever the key order', () => {
    expect(
      sameValues({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })
    ).toBe(true)
    expect(sameValues({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(sameValues({ a: false }, {})).toBe(false)
  })
})

describe('frontmatterToWrite', () => {
  it('keeps the original text byte for byte when the values are back to what was loaded', () => {
    // featured toggled on and off again
    const toggled = { ...VALUES, featured: true }
    const back = { ...toggled, featured: false }
    expect(
      frontmatterToWrite({
        frontmatter: back,
        isFrontmatterDirty: true,
        rawFrontmatter: 'title: Andrew Dyk\nfeatured: true',
        frontmatterBaseline: BASELINE,
      })
    ).toEqual({ frontmatter: null, rawFrontmatter: RAW })
  })

  it('writes the values when they really changed', () => {
    const changed = { ...VALUES, featured: true }
    expect(
      frontmatterToWrite({
        frontmatter: changed,
        isFrontmatterDirty: true,
        rawFrontmatter: RAW,
        frontmatterBaseline: BASELINE,
      })
    ).toEqual({ frontmatter: changed, rawFrontmatter: null })
  })

  it('keeps the text on disk when the frontmatter was never edited', () => {
    expect(
      frontmatterToWrite({
        frontmatter: VALUES,
        isFrontmatterDirty: false,
        rawFrontmatter: RAW,
        frontmatterBaseline: null,
      })
    ).toEqual({ frontmatter: null, rawFrontmatter: RAW })
  })
})

describe('nextFrontmatterBaseline', () => {
  const ECHO = { values: { ...VALUES, featured: true }, raw: 'reformatted' }

  it('starts from the first load', () => {
    expect(nextFrontmatterBaseline(null, BASELINE, null)).toEqual(BASELINE)
  })

  it('keeps it through the reload of our own save', () => {
    expect(nextFrontmatterBaseline(BASELINE, ECHO, ECHO.values)).toBe(BASELINE)
  })

  it('moves to a change made outside the app', () => {
    const outside = { values: { title: 'Changed' }, raw: 'title: Changed' }
    expect(nextFrontmatterBaseline(BASELINE, outside, ECHO.values)).toEqual(
      outside
    )
  })
})

describe('frontmatterToWrite with keys the file never had', () => {
  const RAW_NO_FEATURED = 'title: "Andrew Dyk"'
  const BASE = { values: { title: 'Andrew Dyk' }, raw: RAW_NO_FEATURED }
  const field = (
    name: string,
    type: FieldType,
    extra: Partial<SchemaField> = {}
  ): SchemaField =>
    ({ name, label: name, type, required: false, ...extra }) as SchemaField
  const FIELDS = [
    field('title', FieldType.String),
    field('featured', FieldType.Boolean),
    field('pinned', FieldType.Boolean, { default: true }),
    field('tags', FieldType.Array),
    field('note', FieldType.String, { default: '' }),
  ]
  const write = (frontmatter: Record<string, unknown>) =>
    frontmatterToWrite({
      frontmatter,
      isFrontmatterDirty: true,
      rawFrontmatter: 'title: Andrew Dyk',
      frontmatterBaseline: BASE,
      fields: FIELDS,
    })

  it('a boolean switched on and off again is back to the file as it was', () => {
    expect(write({ title: 'Andrew Dyk', featured: false })).toEqual({
      frontmatter: null,
      rawFrontmatter: RAW_NO_FEATURED,
    })
  })

  it('an item added to a list and removed again leaves no change', () => {
    expect(write({ title: 'Andrew Dyk', tags: [] })).toEqual({
      frontmatter: null,
      rawFrontmatter: RAW_NO_FEATURED,
    })
    expect(write({ title: 'Andrew Dyk', note: '' }).frontmatter).toBeNull()
  })

  it('a value that differs from the default is a real change', () => {
    // pinned defaults to true, so false is a choice the writer made
    expect(write({ title: 'Andrew Dyk', pinned: false }).frontmatter).toEqual({
      title: 'Andrew Dyk',
      pinned: false,
    })
    expect(
      write({ title: 'Andrew Dyk', featured: true }).frontmatter
    ).not.toBeNull()
  })
})
