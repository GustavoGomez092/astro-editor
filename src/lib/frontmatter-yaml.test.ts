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

/** The values the text holds, edited by `change`, written back into it */
function edit(
  raw: string,
  change: (values: Values) => void,
  fields: SchemaField[] = []
): string | null {
  const values = structuredClone(parseFrontmatterValues(raw))
  if (!values) throw new Error('raw does not parse')
  change(values)
  return editFrontmatterText(raw, values, fields)
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
      'title: |-\n  One\n  Two\ndraft: true'
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
    expect(editFrontmatterText('title: [unclosed', { title: 'x' }, [])).toBe(
      null
    )
    expect(editFrontmatterText('', { title: 'x' }, [])).toBeNull()
    expect(editFrontmatterText('# only a comment', { title: 'x' }, [])).toBe(
      null
    )
    expect(editFrontmatterText('a: 1\na: 2', { a: 3 }, [])).toBeNull()
  })
})

describe('parseFrontmatterValues', () => {
  it('reads the values, or null for text that is not a mapping', () => {
    expect(parseFrontmatterValues('title: Hi\ntags: [a]')).toEqual({
      title: 'Hi',
      tags: ['a'],
    })
    expect(parseFrontmatterValues('title: [')).toBeNull()
    expect(parseFrontmatterValues('')).toBeNull()
  })
})
