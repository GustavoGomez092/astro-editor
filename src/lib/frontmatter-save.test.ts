import { warn as logWarn } from '@tauri-apps/plugin-log'
import { describe, expect, it, vi } from 'vitest'
import { FieldType, type SchemaField } from './schema'
import { frontmatterToWrite, nextFrontmatterBaseline } from './frontmatter-save'
import { sameValues } from './frontmatter-yaml'

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
    ).toEqual({ frontmatter: null, rawFrontmatter: RAW, written: null })
  })

  it('edits the text on disk in place when the values really changed', () => {
    const changed = { ...VALUES, featured: true }
    expect(
      frontmatterToWrite({
        frontmatter: changed,
        isFrontmatterDirty: true,
        rawFrontmatter: RAW,
        frontmatterBaseline: BASELINE,
      })
    ).toEqual({
      // The values too, so Rust can check the text reads as them
      frontmatter: changed,
      rawFrontmatter: RAW.replace('featured: false', 'featured: true'),
      written: changed,
    })
  })

  it('compares with the values the app loaded from the text on disk', () => {
    // The app reads 01234 as text; `yaml` would read it as a number
    const loaded = { zip: '01234', title: 'Hi' }
    expect(
      frontmatterToWrite({
        frontmatter: { ...loaded, title: 'Bye' },
        isFrontmatterDirty: true,
        rawFrontmatter: 'zip: 01234\ntitle: Hi',
        rawFrontmatterValues: loaded,
        frontmatterBaseline: null,
      }).rawFrontmatter
    ).toBe('zip: 01234\ntitle: Bye')
  })

  it('writes the values when editing the text fails, and says why in the log', () => {
    vi.mocked(logWarn).mockClear()
    const changed = { title: 'Fixed' }
    expect(
      frontmatterToWrite({
        frontmatter: changed,
        isFrontmatterDirty: true,
        // An alias with no anchor reads without an error, then throws
        rawFrontmatter: 'title: Hi\nref: *nowhere',
        frontmatterBaseline: null,
      })
    ).toEqual({ frontmatter: changed, rawFrontmatter: null, written: changed })
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('isn’t a YAML mapping')
    )
    expect(vi.mocked(logWarn).mock.calls[0]![0]).not.toContain('Fixed')
  })

  it('writes *Featured* without failing the save', () => {
    const result = frontmatterToWrite({
      frontmatter: { title: '*Featured*' },
      isFrontmatterDirty: true,
      rawFrontmatter: 'title: Plain',
      frontmatterBaseline: null,
    })
    expect(result.rawFrontmatter).toBe("title: '*Featured*'")
  })

  it('writes the values, as before, when the text on disk is not valid YAML', () => {
    const changed = { title: 'Fixed' }
    expect(
      frontmatterToWrite({
        frontmatter: changed,
        isFrontmatterDirty: true,
        rawFrontmatter: 'title: [unclosed',
        frontmatterBaseline: null,
      })
    ).toEqual({ frontmatter: changed, rawFrontmatter: null, written: changed })
  })

  it('writes the values when the file has no frontmatter yet', () => {
    const values = { title: 'New' }
    expect(
      frontmatterToWrite({
        frontmatter: values,
        isFrontmatterDirty: true,
        rawFrontmatter: '',
        frontmatterBaseline: null,
      })
    ).toEqual({ frontmatter: values, rawFrontmatter: null, written: values })
  })

  it('keeps the text on disk when the frontmatter was never edited', () => {
    expect(
      frontmatterToWrite({
        frontmatter: VALUES,
        isFrontmatterDirty: false,
        rawFrontmatter: RAW,
        frontmatterBaseline: null,
      })
    ).toEqual({ frontmatter: null, rawFrontmatter: RAW, written: null })
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
  ): SchemaField => ({ name, label: name, type, required: false, ...extra })
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
      written: null,
    })
  })

  it('an item added to a list and removed again leaves no change', () => {
    expect(write({ title: 'Andrew Dyk', tags: [] })).toEqual({
      frontmatter: null,
      rawFrontmatter: RAW_NO_FEATURED,
      written: null,
    })
    expect(write({ title: 'Andrew Dyk', note: '' }).written).toBeNull()
  })

  it('a value that differs from the default is a real change', () => {
    // pinned defaults to true, so false is a choice the writer made
    expect(write({ title: 'Andrew Dyk', pinned: false })).toEqual({
      frontmatter: { title: 'Andrew Dyk', pinned: false },
      rawFrontmatter: 'title: Andrew Dyk\npinned: false',
      written: { title: 'Andrew Dyk', pinned: false },
    })
    expect(write({ title: 'Andrew Dyk', featured: true }).rawFrontmatter).toBe(
      'title: Andrew Dyk\nfeatured: true'
    )
  })

  it('leaves out keys the file never had whose value is only the default', () => {
    // Another field changed, so the text is edited rather than restored
    expect(write({ title: 'Andrew', featured: false, tags: [] })).toEqual({
      frontmatter: { title: 'Andrew' },
      rawFrontmatter: 'title: Andrew',
      written: { title: 'Andrew' },
    })
  })
})
