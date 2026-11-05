import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { FieldType, type SchemaField } from './schema'
import { editFrontmatterText, parseFrontmatterValues } from './frontmatter-yaml'

type Values = Record<string, unknown>

const field = (name: string, type = FieldType.String): SchemaField => ({
  name,
  label: name,
  type,
  required: false,
})

/** The edit's result: the text, or why it can't be done in place */
function editResult(
  raw: string,
  change: (values: Values) => void,
  fields: SchemaField[] = [],
  loaded?: Values
) {
  const values = structuredClone(loaded ?? parseFrontmatterValues(raw))
  if (!values) throw new Error('raw does not parse')
  change(values)
  return editFrontmatterText(raw, values, fields, loaded)
}

/** The values the text holds, edited by `change`, written back into it */
function edit(
  raw: string,
  change: (values: Values) => void,
  fields: SchemaField[] = [],
  loaded?: Values
): string | null {
  const result = editResult(raw, change, fields, loaded)
  return 'text' in result ? result.text : null
}

/** Whether the text reads back as the values, as YAML 1.2 and as YAML 1.1 */
function expectReadsAs(text: string | null, values: Values) {
  expect(text).not.toBeNull()
  expect(parse(text!)).toEqual(values)
}

// Kevin's hero entry, exactly as it's on disk (curly apostrophe, ampersand)
const HERO = [
  'firstLine: "Good ideas."',
  'secondLine: "Clear thinking."',
  'thirdLine: "Better execution."',
  'intro: |',
  '  I help connect business needs with creative thinking and execution—bringing people, disciplines, and ideas together to make things happen.',
  'caption: "Creative direction, design & technology"',
  'buttonText: "Let’s talk"',
].join('\n')
const HERO_FIELDS = [
  'firstLine',
  'secondLine',
  'thirdLine',
  'intro',
  'caption',
  'buttonText',
].map(name => field(name))

describe('editFrontmatterText', () => {
  it('changes only the edited value, and an edit undone later gives back the original bytes', () => {
    const edited = edit(HERO, v => (v.firstLine = 'Good ideas!'), HERO_FIELDS)
    expect(edited).toBe(HERO.replace('"Good ideas."', '"Good ideas!"'))

    // Reopened: the edited text is what's on disk now
    const reverted = edit(
      edited!,
      v => (v.firstLine = 'Good ideas.'),
      HERO_FIELDS
    )
    expect(reverted).toBe(HERO)
  })

  it('keeps the quote style of a changed value', () => {
    const raw = `a: "double"\nb: 'single'\nc: plain`
    const edited = edit(raw, v => {
      v.a = 'Let’s go'
      v.b = 'It’s fine'
      v.c = 'still plain'
    })
    expect(edited).toBe(`a: "Let’s go"\nb: 'It’s fine'\nc: still plain`)
  })

  it('keeps a block scalar a block scalar, with its indentation', () => {
    const raw = [
      'title: Hi',
      'intro: |',
      '    First paragraph.',
      '',
      '    Second paragraph.',
      'after: x',
    ].join('\n')
    const edited = edit(raw, v => {
      v.intro = 'First paragraph.\n\nSecond, edited.\n\nThird.\n'
    })
    expect(edited).toBe(
      [
        'title: Hi',
        'intro: |',
        '    First paragraph.',
        '',
        '    Second, edited.',
        '',
        '    Third.',
        'after: x',
      ].join('\n')
    )
  })

  // The app reads the frontmatter without the line break before the closing
  // `---`, so a `|` block at the very end has no final newline
  it('handles a block scalar as the last key, with no newline after it', () => {
    const raw = 'title: Hi\nintro: |\n  One.\n\n  Two.'
    expect(parseFrontmatterValues(raw)?.intro).toBe('One.\n\nTwo.')
    expect(edit(raw, v => (v.title = 'Bye'))).toBe(raw.replace('Hi', 'Bye'))
    expect(edit(raw, v => (v.intro = 'One.\n\nTwo!'))).toBe(
      'title: Hi\nintro: |\n  One.\n\n  Two!'
    )
  })

  it('keeps comments, blank lines and spacing around an edit', () => {
    const raw = [
      '# Hero section',
      'title:   "Hello"   # the big one',
      '',
      '# Below',
      'draft: false',
    ].join('\n')
    const edited = edit(raw, v => (v.title = 'Bye'))
    expect(edited).toBe(raw.replace('"Hello"', '"Bye"'))
  })

  it('writes dates unquoted, and quotes a date-looking text in a text field', () => {
    const fields = [field('pubDate', FieldType.Date), field('title')]
    const raw = 'title: Hello\npubDate: 2024-01-15'
    const edited = edit(
      raw,
      v => {
        v.pubDate = '2024-02-01'
        v.title = '2024-03-01'
      },
      fields
    )
    expect(edited).toBe("title: '2024-03-01'\npubDate: 2024-02-01")
  })

  it('writes a new date field unquoted', () => {
    const fields = [field('title'), field('pubDate', FieldType.Date)]
    const edited = edit('title: Hi', v => (v.pubDate = '2024-02-01'), fields)
    expect(edited).toBe('title: Hi\npubDate: 2024-02-01')
  })

  it('edits a list in place: adding, removing and changing items', () => {
    const raw = 'tags:\n  - one # first\n  - two\n  - three\ndraft: true'
    expect(edit(raw, v => (v.tags = ['one', 'two', 'three', 'four']))).toBe(
      'tags:\n  - one # first\n  - two\n  - three\n  - four\ndraft: true'
    )
    expect(edit(raw, v => (v.tags = ['one', 'three']))).toBe(
      'tags:\n  - one # first\n  - three\ndraft: true'
    )
    expect(edit(raw, v => (v.tags = ['one', 'TWO', 'three']))).toBe(
      'tags:\n  - one # first\n  - TWO\n  - three\ndraft: true'
    )
    expect(edit(raw, v => (v.tags = ['zero', 'one', 'two', 'three']))).toBe(
      'tags:\n  - zero\n  - one # first\n  - two\n  - three\ndraft: true'
    )
  })

  it('keeps a flow list a flow list', () => {
    const raw = 'tags: ["one", "two"]\ndraft: true'
    expect(edit(raw, v => (v.tags = ['one', 'two', 'three']))).toBe(
      'tags: ["one", "two", "three"]\ndraft: true'
    )
  })

  it('adds a new key in schema order', () => {
    const fields = ['title', 'description', 'pubDate', 'draft'].map(n =>
      field(n)
    )
    const raw = 'title: Hi\n\ndraft: true'
    expect(edit(raw, v => (v.description = 'About'), fields)).toBe(
      'title: Hi\ndescription: About\n\ndraft: true'
    )
    expect(edit('draft: true', v => (v.title = 'Hi'), fields)).toBe(
      'title: Hi\ndraft: true'
    )
    // Not in the schema: at the end
    expect(edit(raw, v => (v.extra = 'x'), fields)).toBe(
      'title: Hi\n\ndraft: true\nextra: x'
    )
  })

  it('adds new keys in the writer’s style', () => {
    const edited = edit('title: Hi', v => {
      v.tags = ['a', 'b']
      v.seo = { title: 'T', noindex: false }
      v.body = 'Line one\nLine two'
    })
    expect(edited).toBe(
      [
        'title: Hi',
        'tags:',
        '- a',
        '- b',
        'seo:',
        '  title: T',
        '  noindex: false',
        'body: |-',
        '  Line one',
        '  Line two',
      ].join('\n')
    )
  })

  it('edits nested objects in place, and adds nested keys in schema order', () => {
    const fields = ['title', 'seo.title', 'seo.description', 'seo.noindex'].map(
      n => field(n)
    )
    const raw = 'title: Hi\nseo:\n    title: "Old" # keep\n    noindex: false'
    expect(
      edit(
        raw,
        v => {
          const seo = v.seo as Values
          seo.title = 'New'
          seo.description = 'About'
        },
        fields
      )
    ).toBe(
      'title: Hi\nseo:\n    title: "New" # keep\n    description: About\n    noindex: false'
    )
  })

  it('removes a key cleanly', () => {
    const raw = 'title: Hi\nimage: ./a.png # cover\nalt: |\n  Text\ndraft: true'
    expect(edit(raw, v => delete v.image)).toBe(
      'title: Hi\nalt: |\n  Text\ndraft: true'
    )
    expect(edit(raw, v => delete v.alt)).toBe(
      'title: Hi\nimage: ./a.png # cover\ndraft: true'
    )
    expect(edit(raw, v => delete v.draft)).toBe(
      'title: Hi\nimage: ./a.png # cover\nalt: |\n  Text'
    )
  })

  it('turns a one-line value into a block when it gets more lines', () => {
    const raw = 'title: Hi # note\ndraft: true'
    expect(edit(raw, v => (v.title = 'One\nTwo'))).toBe(
      'title: |- # note\n  One\n  Two\ndraft: true'
    )
  })

  it('fills a key that had no value', () => {
    expect(
      edit('title: Hi\nimage:\ndraft: true', v => (v.image = 'a.png'))
    ).toBe('title: Hi\nimage: a.png\ndraft: true')
  })

  it('keeps non-ASCII text as it is', () => {
    const raw = 'title: "Café 🎉"\nnote: שלום'
    expect(edit(raw, v => (v.title = 'Crème brûlée 🎂'))).toBe(
      'title: "Crème brûlée 🎂"\nnote: שלום'
    )
  })

  it.each([
    'Note: read this',
    '@handle',
    'yes',
    'no',
    'on',
    '42',
    '3.14',
    'true',
    'null',
    '~',
    ' leading space',
    '# not a comment',
    '- not a list',
    '1:30',
    '0x1F',
    '0b101',
    '01234',
    '*Featured*',
    '*x',
    '**Bold**',
    '&anchor',
    '!important',
    '',
  ])('quotes %j in a plain key so it reads back as that text', value => {
    const edited = edit('title: plain\ndraft: true', v => (v.title = value))
    expectReadsAs(edited, { title: value, draft: true })
    // YAML 1.1 readers (yes/no, 1:30 as a number) read the same text
    expect(parse(edited!, { version: '1.1' })).toEqual({
      title: value,
      draft: true,
    })
    expect(edited).toMatch(/^title: ['"]/)
  })

  it('writes other kinds of value plainly, whatever the old style', () => {
    const raw = 'count: "3"\nflag: "x"'
    expect(
      edit(raw, v => {
        v.count = 4
        v.flag = true
      })
    ).toBe('count: 4\nflag: true')
  })

  it('re-writes a list item that is an object when its first key goes', () => {
    const raw = 'people:\n  - name: A\n    role: B\n  - name: C'
    const edited = edit(raw, v => {
      ;(v.people as Values[])[0] = { role: 'B' }
    })
    expectReadsAs(edited, { people: [{ role: 'B' }, { name: 'C' }] })
    expect(edited).toContain('  - name: C')
  })

  it('edits a key inside a list item that is an object in place', () => {
    const raw = 'people:\n  - name: "A"\n    role: B\n  - name: C'
    expect(
      edit(raw, v => {
        ;(v.people as Values[])[0]!.role = 'Boss'
      })
    ).toBe('people:\n  - name: "A"\n    role: Boss\n  - name: C')
  })

  it.each([
    ['a line separator', 'One\u2028Two', '"One\\LTwo"'],
    ['a paragraph separator', 'One\u2029Two', '"One\\PTwo"'],
    ['a next-line character', 'One\u0085Two', '"One\\NTwo"'],
    ['a control character', 'Bell\u0007', '"Bell\\a"'],
    ['a carriage return', 'One\r\nTwo', '"One\\r\\nTwo"'],
  ])('writes text with %s double-quoted, with escapes', (_, value, written) => {
    // The app's YAML parser can't read these characters unescaped
    for (const raw of ['t: plain', "t: 'single'", 't: |\n  block\nn: 1']) {
      const edited = edit(raw, v => (v.t = value))
      expect(edited).toContain(`t: ${written}`)
      for (const raw of ['\u2028', '\u2029', '\u0085', '\u0007', '\r']) {
        expect(edited).not.toContain(raw)
      }
      expect((parse(edited!) as Values).t).toBe(value)
    }
    const listed = edit('tags:\n  - a', v => (v.tags = ['a', value]))
    expect(listed).toContain(`  - ${written}`)
  })

  it('returns the values the app will read back', () => {
    const result = editResult('t: x\nn: 1', v => (v.t = 'new'))
    expect(result).toEqual({ text: 't: new\nn: 1', values: { t: 'new', n: 1 } })
  })

  it('compares with the values the app loaded, so keys it reads differently stay as they are', () => {
    // The app reads these differently from the yaml package
    const raw = 'zip: 01234\nb: 0b101\nc: +0x1\ntitle: Hi\nd: |+\n  x'
    const loaded = { zip: '01234', b: 5, c: 1, title: 'Hi', d: 'x' }
    const result = editResult(raw, v => (v.title = 'Bye'), [], loaded)
    expect(result).toEqual({
      text: raw.replace('Hi', 'Bye'),
      values: { ...loaded, title: 'Bye' },
    })
  })

  // Rename to match title adds `slug` like this
  it('adds a key after a block that ended the text', () => {
    const fields = ['title', 'intro', 'slug'].map(n => field(n))
    const raw = 'title: Hi\nintro: |\n  One.'
    const result = editResult(raw, v => (v.slug = 'hi'), fields)
    // The site reads `One.\n` either way; the app now reads it that way too
    expect(result).toEqual({
      text: 'title: Hi\nintro: |\n  One.\nslug: hi',
      values: { title: 'Hi', intro: 'One.\n', slug: 'hi' },
    })
  })

  it('keeps the comment on a block’s first line when the block changes', () => {
    const raw = 'intro: | # shown under the title\n  One.\nn: 1'
    expect(edit(raw, v => (v.intro = 'Two.\n'))).toBe(
      'intro: | # shown under the title\n  Two.\nn: 1'
    )
  })

  it('adds keys to frontmatter that only has comments, keeping them', () => {
    const edited = edit(
      '# Hero section\n# Keep it short',
      v => (v.title = 'Hi')
    )
    expect(edited).toBe('# Hero section\n# Keep it short\ntitle: Hi')
  })

  it('edits files the site reads with merge keys', () => {
    // The site merges `<<`, the app reads it as a key: both stay as they were
    const raw = 'base: &b\n  x: 1\nother:\n  <<: *b\n  y: 2\ntitle: Hi'
    expect(edit(raw, v => (v.title = 'Bye'))).toBe(raw.replace('Hi', 'Bye'))
  })

  it('leaves the text alone when nothing changed', () => {
    expect(edit(HERO, () => {}, HERO_FIELDS)).toBe(HERO)
  })

  it('removes the last key, leaving empty text', () => {
    expect(edit('title: Hi', v => delete v.title)).toBe('')
  })

  it('gives up when an alias points at a changed value', () => {
    const raw = 'base: &b hello\ncopy: *b'
    expect(edit(raw, v => (v.base = 'bye'))).toBeNull()
  })

  it('gives up on text that is not a YAML mapping', () => {
    const failed = (raw: string, values: Values) =>
      'failed' in editFrontmatterText(raw, values, [])
    expect(failed('title: [unclosed', { title: 'x' })).toBe(true)
    expect(failed('', { title: 'x' })).toBe(true)
    expect(failed('- a list', { title: 'x' })).toBe(true)
    expect(failed('a: 1\na: 2', { a: 3 })).toBe(true)
    // An alias with no anchor: YAML reads it without an error, then throws
    expect(failed('a: *nowhere\nb: 1', { a: null, b: 2 })).toBe(true)
  })
})

describe('parseFrontmatterValues', () => {
  it('reads the values, or null for text that is not a mapping', () => {
    expect(parseFrontmatterValues('title: Hi\ntags: [a]')).toEqual({
      title: 'Hi',
      tags: ['a'],
    })
    expect(parseFrontmatterValues('title: [')).toBeNull()
    expect(parseFrontmatterValues('- a list')).toBeNull()
    expect(parseFrontmatterValues('a: *nowhere')).toBeNull()
    expect(parseFrontmatterValues('')).toEqual({})
    expect(parseFrontmatterValues('# only a comment')).toEqual({})
  })
})
