// Saving frontmatter by editing its YAML text in place. Writing the values
// back from scratch reformats every key (quotes, comments, blank lines,
// order), so a one-field edit shows up as a change to the whole frontmatter.
// Here only the keys whose values changed are rewritten, each in the style it
// already had; everything else keeps its exact text. When the text can't be
// edited safely the result is null, and the values are written as before.

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

/** The frontmatter text, parsed. It ends with a newline, `added` if it didn't. */
interface Source {
  text: string
  added: boolean
  doc: Document.Parsed
  map: YAMLMap
}

function parseSource(raw: string): Source | null {
  const added = !raw.endsWith('\n')
  const text = added ? `${raw}\n` : raw
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isMap(doc.contents) || doc.contents.flow) {
    return null
  }
  return { text, added, doc, map: doc.contents }
}

/**
 * The values, as the app reads them. Its parser reads the frontmatter without
 * the line break before the closing `---`, so a `|` or `>` block that ends
 * the text has no final newline.
 */
function readValues(source: Source): Values {
  const values = source.doc.toJS() as Values
  if (!source.added) return values

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
    return values
  }
  let parent: unknown = values
  for (const key of path.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[key]
  }
  const last = path[path.length - 1]!
  const container = parent as Record<string | number, unknown>
  container[last] = (container[last] as string).slice(0, -1)
  return values
}

/** The values in frontmatter text, or null when it isn't a YAML mapping. */
export function parseFrontmatterValues(raw: string): Values | null {
  const source = parseSource(raw)
  return source ? readValues(source) : null
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
  const nestedMap = map.items.find(
    pair => isMap(pair.value) && !pair.value.flow && pair.value.items.length
  )
  if (nestedMap) {
    const child = (nestedMap.value as YAMLMap).items[0]!.key as Node
    indent = column(text, child.range![0]) - column(text, keyStart(nestedMap))
  }
  const nestedSeq = map.items.find(
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
  parseDocument(text, { version: '1.1' }).toJS() instanceof Date

/**
 * Whether a YAML reader would read this text, unquoted, as the same text.
 * YAML 1.1 readers too (`yes`, `on`, `1:30`), and a date only where a date
 * belongs.
 */
function readsAsText(value: string, dateAllowed: boolean): boolean {
  for (const version of ['1.2', '1.1'] as const) {
    const doc = parseDocument(value, { version })
    if (doc.errors.length > 0) return false
    const read: unknown = doc.toJS()
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

function stringType(
  value: string,
  hint: Scalar['type'],
  dateAllowed: boolean,
  ctx: Context
): ScalarType {
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
  return doc.toString(options).replace(/\n$/, '')
}

/** What follows `key:` for this value: ` text`, or lines for a block */
const renderValue = (node: Node, ctx: Context, indent?: number) =>
  renderPair('k', node, ctx, indent).slice(2)

/** A list item, `- value`, indented to its `-` and ending in a newline */
function renderItem(node: Node, dash: number, ctx: Context): string {
  const doc = new Document([null])
  ;(doc.contents as YAMLSeq).items[0] = node
  const text = doc.toString(ctx.options).replace(/\n$/, '')
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
  // A one-line value's comment would end up inside the block: it goes too
  const end =
    isCollection || block ? node.range[1] : lineEnd(text, node.range[2]) - 1
  const newline = text[end - 1] === '\n' ? '\n' : ''
  return [
    { start: colon, end, text: indentLines(rendered, keyColumn) + newline },
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
    const childPath = pathOf(key)
    const node = buildNode(
      newValues[key],
      childPath,
      undefined,
      isDateField(ctx, childPath),
      ctx
    )
    const lines = indentLines(renderPair(key, node, ctx), keyColumn)
    splices.push({
      start: position,
      end: position,
      text: `${' '.repeat(keyColumn)}${lines}\n`,
    })
  }
  return splices
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
  if (seq.flow || newItems.length === 0 || seq.items.length === 0) return null
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

/**
 * Whether the text reads as the values, as the app reads it or as the site
 * does (with the line break before `---`, which only differs for a `|` block
 * left at the end, like one above a removed last key). Empty text, or only
 * comments, is `{}`.
 */
function readsAs(text: string, values: Values): boolean {
  const doc = parseDocument(`${text}\n`)
  if (doc.errors.length > 0) return false
  if (doc.contents === null) return Object.keys(values).length === 0
  const app = parseFrontmatterValues(text)
  return (
    (app !== null && sameValues(app, values)) || sameValues(doc.toJS(), values)
  )
}

/**
 * The frontmatter text with the values written into it. Keys whose values
 * didn't change keep their exact text; a changed value keeps its key's style
 * (quotes, `|` blocks) where it can; removed keys go with their lines; new
 * keys go in the schema's field order, in the style the file already uses.
 * Null when the text can't be edited safely (it doesn't parse, isn't a
 * mapping, or the edit wouldn't read back as the values): write the values
 * instead.
 */
export function editFrontmatterText(
  raw: string,
  values: Values,
  fields: SchemaField[]
): string | null {
  const source = parseSource(raw)
  if (!source) return null
  // Only what YAML can hold, as the values were read (no undefined keys)
  const target = JSON.parse(JSON.stringify(values)) as Values
  const ctx = makeContext(source, fields)
  const splices = patchMap(source.map, readValues(source), target, '', ctx)
  if (!splices) return null

  let text = applySplices(source.text, splices)
  if (source.added && text.endsWith('\n')) text = text.slice(0, -1)
  return readsAs(text, target) ? text : null
}
