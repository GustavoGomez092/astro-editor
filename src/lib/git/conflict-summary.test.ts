import { describe, expect, it } from 'vitest'
import type { ConflictFile } from '@/lib/bindings'
import { conflictSummary, lineDiff } from './conflict-summary'

describe('lineDiff', () => {
  it('marks the lines only one side has', () => {
    const { left, right } = lineDiff('a\nb\nc', 'a\nB\nc\nd')
    expect(left).toEqual([
      { text: 'a', changed: false },
      { text: 'b', changed: true },
      { text: 'c', changed: false },
    ])
    expect(right).toEqual([
      { text: 'a', changed: false },
      { text: 'B', changed: true },
      { text: 'c', changed: false },
      { text: 'd', changed: true },
    ])
  })

  it('has nothing changed for equal texts', () => {
    const { left, right } = lineDiff('x\ny', 'x\ny')
    expect([...left, ...right].some(line => line.changed)).toBe(false)
  })
})

const entry = (path: string, mine: string | null, theirs: string | null) =>
  ({ path, mine, theirs, binary: false }) satisfies ConflictFile

describe('conflictSummary', () => {
  it('names the changed fields in plain words, with both values', () => {
    const summary = conflictSummary(
      entry(
        'src/content/team/andrew.md',
        '---\ntitle: Andrew Dyk\nrole: Founder\nfeatured: true\ntags: [a, b]\n---\n\nSame text.\n',
        '---\ntitle: "Andrew Dyk"\nrole: Director\nfeatured: false\ntags: [a]\n---\n\nSame text.\n'
      )
    )
    expect(summary.kind).toBe('entry')
    expect(summary.fields).toEqual([
      { key: 'role', label: 'Role', mine: 'Founder', theirs: 'Director' },
      { key: 'featured', label: 'Featured', mine: 'On', theirs: 'Off' },
      { key: 'tags', label: 'Tags', mine: 'a, b', theirs: 'a' },
    ])
    expect(summary.text).toBeNull()
  })

  it('says the text differs, with the lines that differ', () => {
    const summary = conflictSummary(
      entry(
        'src/content/team/andrew.md',
        '---\ntitle: A\n---\n\nFirst.\nMine here.\nLast.\n',
        '---\ntitle: A\n---\n\nFirst.\nTheirs here.\nLast.\n'
      )
    )
    expect(summary.fields).toEqual([])
    expect(summary.text).toEqual({ mine: 'Mine here.', theirs: 'Theirs here.' })
  })

  it('shows an empty field as "(empty)", and a nested one by its path', () => {
    const summary = conflictSummary(
      entry(
        'src/content/work/a.md',
        '---\ntitle: A\ncover:\n  alt: A photo\n---\n',
        '---\ntitle: A\ncover:\n  alt: Another\nsubtitle: New\n---\n'
      )
    )
    expect(summary.fields).toEqual([
      {
        key: 'cover.alt',
        label: 'Cover Alt',
        mine: 'A photo',
        theirs: 'Another',
      },
      { key: 'subtitle', label: 'Subtitle', mine: '(empty)', theirs: 'New' },
    ])
  })

  it('tells images, deleted files and other files apart', () => {
    expect(
      conflictSummary({
        path: 'src/assets/a.jpg',
        mine: null,
        theirs: null,
        binary: true,
      }).kind
    ).toBe('image')
    expect(conflictSummary(entry('src/content/a.md', null, 'x')).kind).toBe(
      'deletedMine'
    )
    expect(conflictSummary(entry('src/content/a.md', 'x', null)).kind).toBe(
      'deletedTheirs'
    )
    const config = conflictSummary(entry('astro.config.mjs', 'a\nb', 'a\nc'))
    expect(config.kind).toBe('text')
    expect(config.text).toEqual({ mine: 'b', theirs: 'c' })
  })
})
