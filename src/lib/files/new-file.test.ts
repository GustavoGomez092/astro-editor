import { describe, it, expect } from 'vitest'
import {
  buildNewFileFrontmatter,
  newFileContent,
  newFileName,
  newFileTitlePlaceholder,
} from './new-file'
import { FieldType, type SchemaField } from '../schema'

const field = (
  name: string,
  type: FieldType,
  extra: Partial<SchemaField> = {}
): SchemaField => ({
  name,
  label: name,
  type,
  required: false,
  ...extra,
})

const TODAY = '2026-11-03'

describe('buildNewFileFrontmatter', () => {
  it('omits required fields that have no default instead of writing empty values', () => {
    const fields = [
      field('src', FieldType.Image, { required: true }),
      field('width', FieldType.Integer, { required: true }),
      field('left', FieldType.Number, { required: true }),
      field('email', FieldType.Email, { required: true }),
      field('site', FieldType.URL, { required: true }),
      field('quote', FieldType.String, { required: true }),
      field('kind', FieldType.Enum, {
        required: true,
        enumValues: ['a', 'b'],
      }),
      field('author', FieldType.Reference, { required: true }),
      field('gallery', FieldType.Array, {
        required: true,
        constraints: { minItems: 1 },
      }),
    ]

    expect(buildNewFileFrontmatter(fields, 'Hello', TODAY)).toEqual({})
  })

  it('includes every default, required or not', () => {
    const fields = [
      field('draft', FieldType.Boolean, { default: false }),
      field('order', FieldType.Integer, { default: 10 }),
      field('size', FieldType.Enum, {
        default: 'medium',
        enumValues: ['small', 'medium'],
      }),
      field('tags', FieldType.Array, { default: ['news'] }),
      field('note', FieldType.String),
    ]

    expect(buildNewFileFrontmatter(fields, 'Hello', TODAY)).toEqual({
      draft: false,
      order: 10,
      size: 'medium',
      tags: ['news'],
    })
  })

  it('nests the defaults of flattened fields', () => {
    const fields = [
      field('seo.noindex', FieldType.Boolean, {
        default: false,
        isNested: true,
        parentPath: 'seo',
      }),
    ]

    expect(buildNewFileFrontmatter(fields, 'Hello', TODAY)).toEqual({
      seo: { noindex: false },
    })
  })

  it('sets the title and the published date', () => {
    const fields = [
      field('title', FieldType.String, { required: true }),
      field('pubDate', FieldType.Date, { required: true }),
      field('updatedDate', FieldType.Date),
    ]

    expect(buildNewFileFrontmatter(fields, 'Andrew Dyk', TODAY)).toEqual({
      title: 'Andrew Dyk',
      pubDate: TODAY,
    })
  })

  it('fills required booleans and dates, which have no empty value', () => {
    const fields = [
      field('featured', FieldType.Boolean, { required: true }),
      field('eventDate', FieldType.Date, { required: true }),
    ]

    expect(buildNewFileFrontmatter(fields, 'Hello', TODAY)).toEqual({
      featured: false,
      eventDate: TODAY,
    })
  })

  // An empty list is valid unless the schema asks for items, and a missing
  // one fails the build with "Required"
  it('writes an empty list for a required list that takes no items', () => {
    const fields = [
      field('tags', FieldType.Array, { required: true }),
      field('links', FieldType.Array, {
        required: true,
        constraints: { minItems: 0 },
      }),
    ]

    expect(buildNewFileFrontmatter(fields, 'Hello', TODAY)).toEqual({
      tags: [],
      links: [],
    })
  })
})

describe('newFileContent', () => {
  it('writes YAML frontmatter that keeps each type', () => {
    const content = newFileContent(
      {
        title: 'Say "hi"',
        draft: false,
        order: 3,
        tags: [],
        seo: { noindex: false },
      },
      []
    )

    expect(content).toBe(
      [
        '---',
        'title: "Say \\"hi\\""',
        'draft: false',
        'order: 3',
        'tags: []',
        'seo:',
        '  noindex: false',
        '---',
        '',
        '',
      ].join('\n')
    )
  })

  // Quoted, YAML reads a date as a string, which z.date() rejects
  it('writes dates unquoted so YAML reads them as dates', () => {
    const fields = [
      field('title', FieldType.String),
      field('pubDate', FieldType.Date),
    ]
    expect(
      newFileContent({ title: '2026-11-03', pubDate: TODAY }, fields)
    ).toBe('---\ntitle: "2026-11-03"\npubDate: 2026-11-03\n---\n\n')
  })

  it('writes dates inside objects unquoted too', () => {
    const fields = [
      field('event.start', FieldType.Date, {
        isNested: true,
        parentPath: 'event',
      }),
      field('event.name', FieldType.String, {
        isNested: true,
        parentPath: 'event',
      }),
    ]
    expect(
      newFileContent({ event: { start: TODAY, name: '2026-11-03' } }, fields)
    ).toBe('---\nevent:\n  start: 2026-11-03\n  name: "2026-11-03"\n---\n\n')
  })

  it('writes nothing for empty frontmatter', () => {
    expect(newFileContent({}, [])).toBe('')
  })
})

describe('newFileName', () => {
  it('names the file after the title', () => {
    expect(newFileName('Andrew Dyk', 'md', new Set(), TODAY)).toBe(
      'andrew-dyk.md'
    )
  })

  it('adds a number when the name is taken', () => {
    const taken = new Set(['andrew-dyk.md', 'andrew-dyk-1.md'])
    expect(newFileName('Andrew Dyk', 'md', taken, TODAY)).toBe(
      'andrew-dyk-2.md'
    )
  })

  // Astro's id is the name without the extension, so .md and .mdx collide
  it('counts a name as taken whatever its extension', () => {
    expect(
      newFileName('Andrew Dyk', 'md', new Set(['andrew-dyk.mdx']), TODAY)
    ).toBe('andrew-dyk-1.md')
  })

  it("uses today's date when the title gives no name", () => {
    expect(newFileName('', 'mdx', new Set(), TODAY)).toBe('2026-11-03.mdx')
    expect(newFileName('!!!', 'md', new Set(['2026-11-03.md']), TODAY)).toBe(
      '2026-11-03-1.md'
    )
  })
})

describe('newFileTitlePlaceholder', () => {
  it('names the entry after the collection, in the singular', () => {
    expect(newFileTitlePlaceholder('testimonials')).toBe('New Testimonial')
    expect(newFileTitlePlaceholder('stories')).toBe('New Story')
  })
})
