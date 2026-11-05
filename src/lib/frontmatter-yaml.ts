// Saving frontmatter by editing its YAML text in place. Writing the values
// back from scratch reformats every key (quotes, comments, blank lines,
// order), so a one-field edit shows up as a change to the whole frontmatter.
// Here only the keys whose values changed are rewritten, each in the style it
// already had; everything else keeps its exact text. When the text can't be
// edited safely the result says why, and the values are written as before.
//
// Two readers matter: the app's (serde_norway, in Rust), whose values fill the
// form, and the site's (Astro reads frontmatter with this `yaml` package,
// core schema plus timestamps and merge keys). The edit is checked against
// both; Rust checks the text again with its own parser before writing it.

import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Pair,
  type Scalar,
  type ToStringOptions,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import { FieldType, type SchemaField } from './schema'

type Values = Record<string, unknown>
type ScalarType = NonNullable<Scalar['type']>
type QuoteType = 'QUOTE_DOUBLE' | 'QUOTE_SINGLE'

/** Deep equality for parsed YAML values; key order doesn't matter. */
export function sameValues(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValues(item, b[index]))
    )
  }
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => key in b && sameValues(a[key], b[key]))
  )
}

function isObject(value: unknown): value is Values {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isBlock = (type: Scalar['type']) =>
  type === 'BLOCK_LITERAL' || type === 'BLOCK_FOLDED'

/**
 * The frontmatter text, parsed. It ends with a newline, `added` if it didn't.
 * `map` is null when it holds only comments. `values` is what the app reads.
 */
interface Source {
  text: string
  added: boolean
  doc: Document.Parsed
  map: YAMLMap | null
  values: Values
  /** What `yaml` reads, with the final newline the app doesn't see */
  plain: Values
}

/** A document's values, or null when they can't be read (an alias with no anchor) */
function toValues(doc: Document): unknown {
  try {
    return doc.toJS() as unknown
  } catch {
    return null
  }
}

function parseSource(raw: string): Source | null {
  const added = !raw.endsWith('\n')
  const text = added ? `${raw}\n` : raw
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return null
  if (doc.contents === null) {
    return { text, added, doc, map: null, values: {}, plain: {} }
  }
  if (!isMap(doc.contents) || doc.contents.flow) return null
  const values = toValues(doc)
  const plain = toValues(doc)
  if (!isObject(values) || !isObject(plain)) return null
  const source = { text, added, doc, map: doc.contents, values, plain }
  appReading(source)
  return source
}

/**
 * Adjusts the values to how the app reads them. Its parser reads the
 * frontmatter without the line break before the closing `---`, so a `|` or
 * `>` block that ends the text has no final newline.
 */
function appReading(source: Source): void {
  if (!source.added || !source.map) return
  const path: (string | number)[] = []
  let node: unknown = source.map
  for (;;) {
    if ((isMap(node) || isSeq(node)) && !node.flow && node.items.length > 0) {
      const last = node.items[node.items.length - 1]
      if (isMap(node)) {
        const pair = last as Pair
        path.push(isScalar(pair.key) ? String(pair.key.value) : '')
        node = pair.value
      } else {
        path.push(node.items.length - 1)
        node = last
      }
      continue
    }
    break
  }
  if (
    !isScalar(node) ||
    !isBlock(node.type) ||
    node.range?.[1] !== source.text.length ||
    typeof node.value !== 'string' ||
    !node.value.endsWith('\n') ||
    /^[|>]\S*[+-]/.test(source.text.slice(node.range[0]))
  ) {
    return
  }
  let parent: unknown = source.values
  for (const key of path.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[key]
  }
  const last = path[path.length - 1]!
  const container = parent as Record<string | number, unknown>
  container[last] = (container[last] as string).slice(0, -1)
}

/**
 * The values in frontmatter text as the app reads them, or null when it
 * isn't a YAML mapping. Empty text, or only comments, is `{}`.
 */
export function parseFrontmatterValues(raw: string): Values | null {
  return parseSource(raw)?.values ?? null
}

/** The values as the site reads them, or null when it can't */
function siteReading(text: string): Values | null {
  const doc = parseDocument(text, {
    customTags: ['timestamp'],
    merge: true,
    schema: 'core',
  })
  if (doc.errors.length > 0) return null
  if (doc.contents === null) return {}
  const values = toValues(doc)
  return isObject(values) ? values : null
}

interface Splice {
  start: number
  end: number
  text: string
}

interface Context {
  text: string
  added: boolean
  fields: Map<string, SchemaField>
  order: string[]
  quote: QuoteType
  options: ToStringOptions
}

/** How the file writes things, so new text looks like the rest */
function makeContext(source: Source, fields: SchemaField[]): Context {
  const { text, doc, map } = source
  let double = 0
  let single = 0
  let flowPadding: boolean | null = null
  visit(doc, {
    Scalar(_, node) {
      if (node.type === 'QUOTE_DOUBLE') double++
      if (node.type === 'QUOTE_SINGLE') single++
    },
    Collection(_, node) {
      if (flowPadding === null && node.flow && node.items.length > 0) {
        flowPadding = text[node.range![0] + 1] === ' '
      }
    },
  })

  let indent = 2
  let indentSeq = false
  const items = map?.items ?? []
  const nestedMap = items.find(
    pair => isMap(pair.value) && !pair.value.flow && pair.value.items.length
  )
  if (nestedMap) {
    const child = (nestedMap.value as YAMLMap).items[0]!.key as Node
    indent = column(text, child.range![0]) - column(text, keyStart(nestedMap))
  }
  const nestedSeq = items.find(
    pair => isSeq(pair.value) && !pair.value.flow && pair.value.items.length
  )
  if (nestedSeq) {
    const item = (nestedSeq.value as YAMLSeq).items[0] as Node
    indentSeq =
      (dashColumn(text, item) ?? 0) > column(text, keyStart(nestedSeq))
  }

  const quote = double > 0 && single === 0 ? 'QUOTE_DOUBLE' : 'QUOTE_SINGLE'
  return {
    text,
    added: source.added,
    fields: new Map(fields.map(f => [f.name, f])),
    order: fields.map(f => f.name),
    quote,
    options: {
      lineWidth: 0,
      indent: indent > 0 ? indent : 2,
      indentSeq,
      singleQuote: quote === 'QUOTE_SINGLE',
      flowCollectionPadding: flowPadding ?? false,
    },
  }
}

// Positions in the text

const lineStart = (text: string, pos: number) =>
  text.lastIndexOf('\n', pos - 1) + 1

/** The end of the line `pos` is on, after its newline */
function lineEnd(text: string, pos: number): number {
  if (pos > 0 && text[pos - 1] === '\n') return pos
  const newline = text.indexOf('\n', pos)
  return newline === -1 ? text.length : newline + 1
}

const column = (text: string, pos: number) => pos - lineStart(text, pos)

const ownLine = (text: string, pos: number) =>
  /^ *$/.test(text.slice(lineStart(text, pos), pos))

const keyStart = (pair: Pair) => (pair.key as Node).range![0]

function pairEnd(pair: Pair): number {
  const value = pair.value as Node | null
  return value?.range?.[2] ?? (pair.key as Node).range![2]
}

/** The column of a list item's `-`, or null when it isn't `- item` on its own line */
function dashColumn(text: string, item: Node): number | null {
  const start = item.range![0]
  const match = /^( *)- +$/.exec(text.slice(lineStart(text, start), start))
  return match ? match[1]!.length : null
}

function indentLines(text: string, columns: number): string {
  return text.replace(/\n(?=[^\n])/g, `\n${' '.repeat(columns)}`)
}

// Writing values

function isDateField(ctx: Context, path: string): boolean {
  const field = ctx.fields.get(path)
  return (
    field?.type === FieldType.Date ||
    (field?.type === FieldType.Array && field.subType === FieldType.Date)
  )
}

const readsAsDate = (text: string) =>
  toValues(parseDocument(text, { version: '1.1' })) instanceof Date

/**
 * Whether a YAML reader would read this text, unquoted, as the same text.
 * YAML 1.1 readers too (`yes`, `on`, `1:30`), and a date only where a date
 * belongs.
 */
function readsAsText(value: string, dateAllowed: boolean): boolean {
  for (const version of ['1.2', '1.1'] as const) {
    const doc = parseDocument(value, { version })
    if (doc.errors.length > 0) return false
    // `*Featured*` reads as an alias with no anchor, which throws
    let read: unknown
    try {
      read = doc.toJS()
    } catch {
      return false
    }
    if (read === value) continue
    if (version === '1.1' && dateAllowed && read instanceof Date) continue
    return false
  }
  return true
}

/** Whether a date-looking text may stay unquoted: a date field, or it was unquoted */
function datesAllowed(ctx: Context, path: string, old?: Node | null): boolean {
  if (isDateField(ctx, path)) return true
  return (
    !ctx.fields.has(path) &&
    isScalar(old) &&
    old.type === 'PLAIN' &&
    typeof old.value === 'string' &&
    readsAsDate(old.value)
  )
}

/**
 * Characters only a double-quoted string can hold, as escapes: controls, a
 * carriage return, and the line breaks YAML 1.1 has that 1.2 doesn't (U+0085,
 * U+2028, U+2029, which come with text pasted from layout apps). The app's
 * parser can't read those unescaped.
 */
function needsEscapes(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code === 0x09 || code === 0x0a) continue
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    ) {
      return true
    }
  }
  return false
}

/** `yaml` writes these unescaped even in double quotes */
const escapeLineBreaks = (text: string) =>
  text
    .replace(/\u0085/g, '\\N')
    .replace(/\u2028/g, '\\L')
    .replace(/\u2029/g, '\\P')

function stringType(
  value: string,
  hint: Scalar['type'],
  dateAllowed: boolean,
  ctx: Context
): ScalarType {
  if (needsEscapes(value)) return 'QUOTE_DOUBLE'
  if (hint && hint !== 'PLAIN') return hint
  if (value.includes('\n')) return 'BLOCK_LITERAL'
  return readsAsText(value, dateAllowed) ? 'PLAIN' : ctx.quote
}

/** Gives every text in a new node its style: `hint`, or plain unless it needs quotes */
function style(
  node: unknown,
  path: string,
  hint: Scalar['type'],
  dateAllowed: boolean,
  ctx: Context
): void {
  if (isScalar(node)) {
    if (typeof node.value === 'string') {
      node.type = stringType(node.value, hint, dateAllowed, ctx)
    }
  } else if (isSeq(node)) {
    for (const item of node.items) style(item, path, hint, dateAllowed, ctx)
  } else if (isMap(node)) {
    for (const pair of node.items) {
      const childPath = `${path}.${String((pair.key as Scalar).value)}`
      style(pair.value, childPath, undefined, isDateField(ctx, childPath), ctx)
    }
  }
}

function buildNode(
  value: unknown,
  path: string,
  hint: Scalar['type'],
  dateAllowed: boolean,
  ctx: Context,
  flow = false
): Node {
  const node = new Document().createNode(value)
  style(node, path, hint, dateAllowed, ctx)
  if (flow && (isMap(node) || isSeq(node))) node.flow = true
  return node
}

/** `key: value`, as YAML text without the final newline */
function renderPair(
  key: string,
  node: Node,
  ctx: Context,
  indent?: number
): string {
  const doc = new Document({ [key]: null })
  ;(doc.contents as YAMLMap).items[0]!.value = node
  const options = indent ? { ...ctx.options, indent } : ctx.options
  return escapeLineBreaks(doc.toString(options)).replace(/\n$/, '')
}

/** What follows `key:` for this value: ` text`, or lines for a block */
const renderValue = (node: Node, ctx: Context, indent?: number) =>
  renderPair('k', node, ctx, indent).slice(2)

/** A list item, `- value`, indented to its `-` and ending in a newline */
function renderItem(node: Node, dash: number, ctx: Context): string {
  const doc = new Document([null])
  ;(doc.contents as YAMLSeq).items[0] = node
  const text = escapeLineBreaks(doc.toString(ctx.options)).replace(/\n$/, '')
  return `${' '.repeat(dash)}${indentLines(text, dash)}\n`
}

/** The style of the first text in a collection, for its new items */
function firstTextType(node: unknown): Scalar['type'] {
  if (!isSeq(node) && !isMap(node)) return undefined
  for (const item of node.items) {
    const value: unknown = isSeq(node) ? item : (item as Pair).value
    if (isScalar(value) && typeof value.value === 'string') return value.type
  }
  return undefined
}

/** How far a block's lines are indented past its key */
function blockIndent(node: Node, keyColumn: number, ctx: Context) {
  const lines = ctx.text.slice(node.range![0], node.range![1]).split('\n')
  const first = lines.slice(1).find(line => line.trim() !== '')
  if (!first) return undefined
  const relative = first.length - first.trimStart().length - keyColumn
  return relative > 0 ? relative : undefined
}

// Editing

/** Writes a key's new value over its old one, in the old one's style */
function replaceValue(
  pair: Pair,
  newValue: unknown,
  path: string,
  ctx: Context
): Splice[] | null {
  const node = pair.value as Node | null
  if (!node?.range) return null
  const { text } = ctx
  const isCollection = isMap(node) || isSeq(node)
  const flow = isCollection && node.flow === true
  const block = isScalar(node) && isBlock(node.type)

  const hint = isScalar(node)
    ? node.type
    : flow
      ? firstTextType(node)
      : undefined
  let value = newValue
  // A `|` block that ends the text reads without its last newline, so it
  // keeps its `|` (rather than `|-`) with one added
  if (
    block &&
    ctx.added &&
    node.range[1] === text.length &&
    typeof value === 'string' &&
    !value.endsWith('\n') &&
    !/^[|>]\S*[+-]/.test(text.slice(node.range[0]))
  ) {
    value = `${value}\n`
  }
  const built = buildNode(
    value,
    path,
    hint,
    datesAllowed(ctx, path, node),
    ctx,
    flow && (Array.isArray(newValue) || isObject(newValue))
  )
  const keyColumn = column(text, keyStart(pair))
  const rendered = renderValue(
    built,
    ctx,
    block ? blockIndent(node, keyColumn, ctx) : undefined
  )

  if (!rendered.includes('\n') && !block && (!isCollection || flow)) {
    const [start, end] = node.range
    // An empty value (`image:`) gets the space after the colon too
    return [{ start, end, text: start === end ? rendered : rendered.slice(1) }]
  }
  const colon = text.indexOf(':', (pair.key as Node).range![1]) + 1
  // The comment after a one-line value, or on a block's first line, moves to
  // the key's line (left after the value, it would be inside the block)
  const end =
    isCollection || block ? node.range[1] : lineEnd(text, node.range[2]) - 1
  const comment = block
    ? /^[|>][^\s#]*[ \t]+(#.*)$/m.exec(text.slice(node.range[0]))?.[1]
    : isCollection
      ? undefined
      : /^\s*(#.*?)\s*$/.exec(text.slice(node.range[1], end))?.[1]
  const lines = rendered.split('\n')
  if (comment) lines[0] = `${lines[0]} ${comment}`
  const newline = text[end - 1] === '\n' ? '\n' : ''
  return [
    {
      start: colon,
      end,
      text: indentLines(lines.join('\n'), keyColumn) + newline,
    },
  ]
}

function patchValue(
  pair: Pair,
  oldValue: unknown,
  newValue: unknown,
  path: string,
  ctx: Context
): Splice[] | null {
  const node = pair.value
  if (isMap(node) && isObject(oldValue) && isObject(newValue)) {
    const splices = patchMap(node, oldValue, newValue, path, ctx)
    if (splices) return splices
  }
  if (isSeq(node) && Array.isArray(oldValue) && Array.isArray(newValue)) {
    const splices = patchSeq(node, oldValue, newValue, path, ctx)
    if (splices) return splices
  }
  return replaceValue(pair, newValue, path, ctx)
}

/** Where the schema puts a key: the first field at or under its path */
function orderIndex(ctx: Context, path: string): number {
  return ctx.order.findIndex(
    name => name === path || name.startsWith(`${path}.`)
  )
}

/**
 * Edits a block mapping: changed values in place, removed keys with their
 * lines, new keys in schema order. Null when that can't be done in place.
 */
function patchMap(
  map: YAMLMap,
  oldValues: Values,
  newValues: Values,
  path: string,
  ctx: Context
): Splice[] | null {
  if (map.flow) return null
  const { text } = ctx
  const splices: Splice[] = []
  const kept: { pair: Pair; order: number }[] = []
  const existing = new Set<string>()

  for (const pair of map.items) {
    if (!isScalar(pair.key) || !pair.key.range) return null
    const key = String(pair.key.value)
    const childPath = path ? `${path}.${key}` : key
    existing.add(key)
    if (!(key in newValues)) {
      if (!ownLine(text, keyStart(pair))) return null
      splices.push({
        start: lineStart(text, keyStart(pair)),
        end: lineEnd(text, pairEnd(pair)),
        text: '',
      })
      continue
    }
    kept.push({ pair, order: orderIndex(ctx, childPath) })
    if (sameValues(oldValues[key], newValues[key])) continue
    const changed = patchValue(
      pair,
      oldValues[key],
      newValues[key],
      childPath,
      ctx
    )
    if (!changed) return null
    splices.push(...changed)
  }

  const pathOf = (key: string) => (path ? `${path}.${key}` : key)
  const rank = (key: string) => {
    const index = orderIndex(ctx, pathOf(key))
    return index === -1 ? Infinity : index
  }
  const added = Object.keys(newValues)
    .filter(key => !existing.has(key))
    .sort((a, b) => rank(a) - rank(b))
  if (added.length === 0) return splices
  if (kept.length === 0) return null

  const first = map.items[0]!
  const keyColumn = column(text, keyStart(first))
  const afterPair = (pair: Pair) => lineEnd(text, pairEnd(pair))
  const last = kept[kept.length - 1]!.pair

  for (const key of added) {
    const index = orderIndex(ctx, pathOf(key))
    let position: number
    if (index === -1) {
      position = afterPair(last)
    } else {
      const before = kept
        .filter(k => k.order !== -1 && k.order < index)
        .sort((a, b) => b.order - a.order)[0]
      const after = kept.find(k => k.order > index)
      if (before) position = afterPair(before.pair)
      else if (after) {
        if (!ownLine(text, keyStart(after.pair))) return null
        position = lineStart(text, keyStart(after.pair))
      } else position = afterPair(last)
    }
    splices.push({
      start: position,
      end: position,
      text: newKeyText(key, newValues[key], pathOf(key), keyColumn, ctx),
    })
  }
  return splices
}

/** A new `key: value`, in the file's style, at a column, ending in a newline */
function newKeyText(
  key: string,
  value: unknown,
  path: string,
  keyColumn: number,
  ctx: Context
): string {
  const node = buildNode(value, path, undefined, isDateField(ctx, path), ctx)
  const lines = indentLines(renderPair(key, node, ctx), keyColumn)
  return `${' '.repeat(keyColumn)}${lines}\n`
}

/** New keys for frontmatter with only comments, after them, in schema order */
function addToEmpty(values: Values, ctx: Context): Splice[] {
  const rank = (key: string) => {
    const index = orderIndex(ctx, key)
    return index === -1 ? Infinity : index
  }
  const end = ctx.text.length
  return Object.keys(values)
    .sort((a, b) => rank(a) - rank(b))
    .map(key => ({
      start: end,
      end,
      text: newKeyText(key, values[key], key, 0, ctx),
    }))
}

/** Pairs of indices of items both lists share, in order (longest common subsequence) */
function commonItems(a: unknown[], b: unknown[]): [number, number][] {
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = sameValues(a[i], b[j])
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (sameValues(a[i], b[j])) {
      pairs.push([i, j])
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

/**
 * Edits a block list: items changed in place when the length is the same,
 * otherwise removed and added items around the ones that stayed.
 */
function patchSeq(
  seq: YAMLSeq,
  oldItems: unknown[],
  newItems: unknown[],
  path: string,
  ctx: Context
): Splice[] | null {
  if (
    seq.flow ||
    newItems.length === 0 ||
    seq.items.length === 0 ||
    seq.items.length !== oldItems.length
  ) {
    return null
  }
  const { text } = ctx
  const items = seq.items as Node[]
  const dashes: number[] = []
  for (const item of items) {
    if (!isScalar(item) && !isMap(item) && !isSeq(item)) return null
    if (!item.range) return null
    const dash = dashColumn(text, item)
    if (dash === null) return null
    dashes.push(dash)
  }
  const hint = firstTextType(seq)
  const dateAllowed = (old?: Node) => datesAllowed(ctx, path, old)
  const itemEnd = (item: Node) => lineEnd(text, item.range![2])
  const splices: Splice[] = []

  if (oldItems.length === newItems.length) {
    for (const [i, item] of items.entries()) {
      const oldValue = oldItems[i]
      const newValue = newItems[i]
      if (sameValues(oldValue, newValue)) continue
      if (isMap(item) && isObject(oldValue) && isObject(newValue)) {
        const inner = patchMap(item, oldValue, newValue, path, ctx)
        if (inner) {
          splices.push(...inner)
          continue
        }
      }
      if (isScalar(item) && !isBlock(item.type)) {
        const node = buildNode(
          newValue,
          path,
          item.type,
          dateAllowed(item),
          ctx
        )
        const rendered = renderValue(node, ctx)
        if (!rendered.includes('\n')) {
          const [start, end] = item.range!
          splices.push({ start, end, text: rendered.slice(1) })
          continue
        }
      }
      splices.push({
        start: lineStart(text, item.range![0]),
        end: itemEnd(item),
        text: renderItem(
          buildNode(newValue, path, hint, dateAllowed(), ctx),
          dashes[i]!,
          ctx
        ),
      })
    }
    return splices
  }

  const common = commonItems(oldItems, newItems)
  const keptOld = new Set(common.map(([i]) => i))
  for (const [i, item] of items.entries()) {
    if (keptOld.has(i)) continue
    splices.push({
      start: lineStart(text, item.range![0]),
      end: itemEnd(item),
      text: '',
    })
  }
  for (const [j, newValue] of newItems.entries()) {
    if (common.some(([, k]) => k === j)) continue
    const previous = common.filter(([, k]) => k < j).pop()
    const position = previous
      ? itemEnd(items[previous[0]]!)
      : lineStart(text, items[0]!.range![0])
    splices.push({
      start: position,
      end: position,
      text: renderItem(
        buildNode(newValue, path, hint, dateAllowed(), ctx),
        dashes[0]!,
        ctx
      ),
    })
  }
  return splices
}

/** Applies splices, given in source positions, from the end of the text back */
function applySplices(text: string, splices: Splice[]): string {
  const ordered = splices
    .map((splice, index) => ({ ...splice, index }))
    .sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index)
  let result = text
  for (const { start, end, text: replacement } of ordered) {
    result = result.slice(0, start) + replacement + result.slice(end)
  }
  return result
}

const NOT_SAME = Symbol('not the same')

/**
 * What the app reads now for a value whose text didn't change: what it read
 * before, unless the `yaml` reading moved, which only happens when a block
 * stops or starts ending the text and gains or loses its last newline.
 */
function carried(app: unknown, before: unknown, after: unknown): unknown {
  if (sameValues(before, after)) return app
  if (typeof app === 'string' && typeof before === 'string') {
    if (after === `${before}\n`) return `${app}\n`
    if (`${after as string}\n` === before && app.endsWith('\n')) {
      return app.slice(0, -1)
    }
  }
  if (
    Array.isArray(app) &&
    Array.isArray(before) &&
    Array.isArray(after) &&
    app.length === before.length &&
    before.length === after.length
  ) {
    const items = app.map((item, i) => carried(item, before[i], after[i]))
    return items.includes(NOT_SAME) ? NOT_SAME : items
  }
  if (isObject(app) && isObject(before) && isObject(after)) {
    const keys = Object.keys(app)
    if (!sameValues(keys.sort(), Object.keys(after).sort())) return NOT_SAME
    const result: Values = {}
    for (const key of keys) {
      result[key] = carried(app[key], before[key], after[key])
      if (result[key] === NOT_SAME) return NOT_SAME
    }
    return result
  }
  return NOT_SAME
}

/**
 * Whether the site reads a value as the app does. A date field's value is
 * text in the app and a date on the site.
 */
function siteMatches(
  site: unknown,
  app: unknown,
  path: string,
  ctx: Context
): boolean {
  if (site instanceof Date) {
    const field = ctx.fields.get(path)
    return (
      typeof app === 'string' &&
      (field === undefined || isDateField(ctx, path)) &&
      sameValues(siteReading(`d: ${app}`)?.d, site)
    )
  }
  if (Array.isArray(site) && Array.isArray(app)) {
    return (
      site.length === app.length &&
      site.every((item, i) => siteMatches(item, app[i], path, ctx))
    )
  }
  if (isObject(site) && isObject(app)) {
    const keys = Object.keys(site)
    return (
      keys.length === Object.keys(app).length &&
      keys.every(
        key =>
          key in app && siteMatches(site[key], app[key], `${path}.${key}`, ctx)
      )
    )
  }
  return sameValues(site, app)
}

/**
 * Checks the edited text key by key. A key the form didn't change must read
 * as before, for the app and the site; a changed or new key must read as the
 * form's value; a removed key must be gone. Returns what the app will read,
 * or why the text won't do.
 */
function checkEdit(
  source: Source,
  edited: Source,
  loaded: Values,
  target: Values,
  ctx: Context
): { values: Values } | { failed: string } {
  const siteBefore = siteReading(source.text)
  const siteAfter = siteReading(edited.text)
  if (!siteBefore || !siteAfter) return { failed: 'the site can’t read it' }
  const before = source.values
  const after = edited.values
  const keys = new Set([
    ...Object.keys(target),
    ...Object.keys(loaded),
    ...Object.keys(after),
    ...Object.keys(siteBefore),
    ...Object.keys(siteAfter),
  ])
  const values: Values = {}
  for (const key of keys) {
    const inForm = key in target
    const wasLoaded = key in loaded
    const untouched =
      inForm && wasLoaded && sameValues(target[key], loaded[key])
    if (untouched) {
      if (!(key in after)) return { failed: `“${key}” went missing` }
      const value = carried(loaded[key], before[key], after[key])
      if (value === NOT_SAME)
        return { failed: `“${key}” would read differently` }
      values[key] = value
    } else if (inForm) {
      if (!sameValues(after[key], target[key])) {
        return { failed: `“${key}” wouldn’t read as its new value` }
      }
      values[key] = target[key]
    } else if (wasLoaded && key in after) {
      return { failed: `“${key}” wasn’t removed` }
    }

    // The site: unchanged keys (and keys only it sees, from merge keys) read
    // as before, changed ones as `yaml` reads them, removed ones are gone
    const siteOk =
      untouched || (!inForm && !wasLoaded)
        ? sameValues(siteAfter[key], siteBefore[key])
        : inForm
          ? siteMatches(siteAfter[key], edited.plain[key], key, ctx)
          : !(key in siteAfter)
    if (!siteOk) return { failed: `the site would read “${key}” differently` }
  }
  return { values }
}

/** The text to write, with what the app will read from it, or why there's none */
export type FrontmatterEdit =
  | { text: string; values: Values }
  | { failed: string }

/**
 * The frontmatter text with the values written into it. Keys whose values
 * didn't change keep their exact text; a changed value keeps its key's style
 * (quotes, `|` blocks) where it can; removed keys go with their lines; new
 * keys go in the schema's field order, in the style the file already uses.
 * `loaded` is what the app read from `raw` (the form's starting point); the
 * edit compares with it, so keys the app reads differently from `yaml`
 * (`zip: 01234`) count as unchanged. Fails when the text can't be edited
 * safely (it doesn't parse, isn't a mapping, there's none yet, or the edit
 * wouldn't read back right): write the values instead.
 */
export function editFrontmatterText(
  raw: string,
  values: Values,
  fields: SchemaField[],
  loaded?: Values | null
): FrontmatterEdit {
  if (raw.trim() === '') return { failed: 'there’s no frontmatter yet' }
  const source = parseSource(raw)
  if (!source) return { failed: 'it isn’t a YAML mapping' }
  // Only what YAML can hold, as the values were read (no undefined keys)
  const target = JSON.parse(JSON.stringify(values)) as Values
  const starting = loaded ?? source.values
  const ctx = makeContext(source, fields)
  const splices = source.map
    ? patchMap(source.map, starting, target, '', ctx)
    : addToEmpty(target, ctx)
  if (!splices) return { failed: 'it can’t be edited in place' }

  let text = applySplices(source.text, splices)
  if (source.added && text.endsWith('\n')) text = text.slice(0, -1)
  const edited = parseSource(text)
  if (!edited) return { failed: 'the edited text doesn’t parse' }
  const checked = checkEdit(source, edited, starting, target, ctx)
  return 'failed' in checked ? checked : { text, values: checked.values }
}
