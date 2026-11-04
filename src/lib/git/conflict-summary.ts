import { parse as parseYaml } from 'yaml'
import type { ConflictFile } from '@/lib/bindings'
import { camelCaseToTitleCase } from '@/lib/utils'

/** One line of a version, and whether the other version lacks it. */
export interface DiffLine {
  text: string
  changed: boolean
}

/** Above this many line pairs, every line counts as changed (no quadratic work). */
const MAX_DIFF_CELLS = 2_000_000

/**
 * A line diff of two texts (longest common subsequence): each side's lines,
 * marked when the other side doesn't have them in the same order.
 */
export function lineDiff(
  a: string,
  b: string
): { left: DiffLine[]; right: DiffLine[] } {
  const left = a.split('\n')
  const right = b.split('\n')
  const n = left.length
  const m = right.length
  if (n * m > MAX_DIFF_CELLS) {
    return {
      left: left.map(text => ({ text, changed: true })),
      right: right.map(text => ({ text, changed: true })),
    }
  }
  // lengths[i][j]: common lines of left[i..] and right[j..]
  const lengths: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        left[i] === right[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const leftChanged = new Array<boolean>(n).fill(true)
  const rightChanged = new Array<boolean>(m).fill(true)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      leftChanged[i] = false
      rightChanged[j] = false
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return {
    left: left.map((text, index) => ({ text, changed: leftChanged[index]! })),
    right: right.map((text, index) => ({
      text,
      changed: rightChanged[index]!,
    })),
  }
}

/** A field that differs between the two versions, in words. */
export interface FieldDifference {
  /** Dot path, for nested fields */
  key: string
  label: string
  mine: string
  theirs: string
}

/** What differs between the two versions of a conflicted file. */
export interface ConflictSummary {
  /**
   * entry: a Markdown entry, by field and text; text: another text file, by
   * line; image and binary: nothing to show; deletedMine / deletedTheirs:
   * one side deleted it
   */
  kind: 'entry' | 'text' | 'image' | 'binary' | 'deletedMine' | 'deletedTheirs'
  fields: FieldDifference[]
  /** The lines that differ, on each side, when the text (or body) differs */
  text: { mine: string; theirs: string } | null
}

const IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i
const ENTRY = /\.mdx?$/i
const EMPTY = '(empty)'

/** The frontmatter values and the body of an entry's text. */
function splitEntry(text: string): {
  data: Record<string, unknown>
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { data: {}, body: text }
  let data: unknown = {}
  try {
    data = parseYaml(match[1] ?? '')
  } catch {
    data = {}
  }
  return {
    data:
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
    body: text.slice(match[0].length),
  }
}

/** Nested objects as dot paths, so each field is compared on its own. */
function flatten(
  values: Record<string, unknown>,
  prefix = '',
  into = new Map<string, unknown>()
): Map<string, unknown> {
  for (const [key, value] of Object.entries(values)) {
    const path = `${prefix}${key}`
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value instanceof Date) into.set(path, value)
      else flatten(value as Record<string, unknown>, `${path}.`, into)
    } else {
      into.set(path, value)
    }
  }
  return into
}

/** A value as the writer reads it. */
function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return EMPTY
  if (value === true) return 'On'
  if (value === false) return 'Off'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (Array.isArray(value)) {
    return value.length === 0 ? EMPTY : value.map(display).join(', ')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const labelFor = (key: string) =>
  key
    .split('.')
    .map(part => camelCaseToTitleCase(part))
    .join(' ')

/** The lines of each text that the other doesn't have, or null if none. */
function changedLines(
  mine: string,
  theirs: string
): { mine: string; theirs: string } | null {
  if (mine.trim() === theirs.trim()) return null
  const { left, right } = lineDiff(mine.trim(), theirs.trim())
  const pick = (lines: DiffLine[]) =>
    lines
      .filter(line => line.changed && line.text.trim() !== '')
      .map(line => line.text)
      .join('\n') || EMPTY
  return { mine: pick(left), theirs: pick(right) }
}

/**
 * What differs between the two versions of a conflicted file, for the
 * Resolve view: an entry's fields by label with both values ("Role: Founder
 * / Director"), plus the lines of its text that differ.
 */
export function conflictSummary(file: ConflictFile): ConflictSummary {
  const none = { fields: [], text: null }
  if (file.binary) {
    return { kind: IMAGE.test(file.path) ? 'image' : 'binary', ...none }
  }
  if (file.mine === null) return { kind: 'deletedMine', ...none }
  if (file.theirs === null) return { kind: 'deletedTheirs', ...none }
  if (!ENTRY.test(file.path)) {
    return {
      kind: 'text',
      fields: [],
      text: changedLines(file.mine, file.theirs),
    }
  }

  const mine = splitEntry(file.mine)
  const theirs = splitEntry(file.theirs)
  const mineValues = flatten(mine.data)
  const theirValues = flatten(theirs.data)
  const keys = [
    ...mineValues.keys(),
    ...[...theirValues.keys()].filter(key => !mineValues.has(key)),
  ]
  const fields: FieldDifference[] = []
  for (const key of keys) {
    const a = display(mineValues.get(key))
    const b = display(theirValues.get(key))
    if (a !== b) fields.push({ key, label: labelFor(key), mine: a, theirs: b })
  }
  return { kind: 'entry', fields, text: changedLines(mine.body, theirs.body) }
}
