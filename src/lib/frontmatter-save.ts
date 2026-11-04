// Saving frontmatter without changing a file that didn't really change.
// Writing the values back reformats the YAML (quotes, spacing, order), so an
// edit that was undone, like a toggle switched on and off, would still show
// up as a change to publish. When the values are back to what was on disk,
// the original text is written instead.

import { FieldType, type SchemaField } from './schema'

type Values = Record<string, unknown>

/** The frontmatter on disk: its values and the exact text they came from. */
export interface FrontmatterBaseline {
  values: Values
  raw: string
}

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
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false
  }
  const left = a as Values
  const right = b as Values
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => key in right && sameValues(left[key], right[key]))
  )
}

/**
 * Whether a value the file didn't have is just the field's default, so
 * writing it changes nothing for the site: a switch turned on and off again
 * (false), an emptied list ([]) or an emptied text field (''). A value that
 * differs from the schema's own default is a real choice.
 */
function isUnsetValue(field: SchemaField | undefined, value: unknown): boolean {
  if (field && field.default !== undefined) {
    // Older schemas give defaults as text ("false")
    return (
      sameValues(value, field.default) ||
      (typeof field.default === 'string' &&
        typeof value !== 'string' &&
        JSON.stringify(value) === field.default)
    )
  }
  if (value === '' || (Array.isArray(value) && value.length === 0)) return true
  return value === false && field?.type === FieldType.Boolean
}

/**
 * The values as they'd be written, minus keys the baseline doesn't have whose
 * value is only the default (see `isUnsetValue`), nested ones included.
 */
function withoutUnsetKeys(
  values: Values,
  baseline: Values,
  fields: SchemaField[],
  prefix = ''
): Values {
  const result: Values = {}
  for (const [key, value] of Object.entries(values)) {
    const path = `${prefix}${key}`
    const before = baseline[key]
    if (!(key in baseline)) {
      if (
        isUnsetValue(
          fields.find(f => f.name === path),
          value
        )
      )
        continue
      result[key] = value
    } else if (
      value &&
      before &&
      typeof value === 'object' &&
      typeof before === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(before)
    ) {
      result[key] = withoutUnsetKeys(
        value as Values,
        before as Values,
        fields,
        `${path}.`
      )
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * What a save passes for the frontmatter: the values to write, or the text to
 * keep. The text on disk is kept when the frontmatter wasn't edited, and the
 * baseline's text when the edits ended where they started. A key the file
 * didn't have counts as where it started while its value is only the
 * default, so writing the baseline's text leaves it out again.
 */
export function frontmatterToWrite({
  frontmatter,
  isFrontmatterDirty,
  rawFrontmatter,
  frontmatterBaseline,
  fields = [],
}: {
  frontmatter: Values
  isFrontmatterDirty: boolean
  rawFrontmatter: string
  frontmatterBaseline: FrontmatterBaseline | null
  /** The collection's schema fields, for their defaults */
  fields?: SchemaField[]
}): { frontmatter: Values | null; rawFrontmatter: string | null } {
  if (!isFrontmatterDirty) return { frontmatter: null, rawFrontmatter }
  if (
    frontmatterBaseline &&
    sameValues(
      withoutUnsetKeys(frontmatter, frontmatterBaseline.values, fields),
      frontmatterBaseline.values
    )
  ) {
    return { frontmatter: null, rawFrontmatter: frontmatterBaseline.raw }
  }
  return { frontmatter, rawFrontmatter: null }
}

/**
 * The baseline after the open file loads from disk. It's the first load
 * after opening, and moves to any later load that isn't the reload of our own
 * save (whose values are the ones we last wrote): a change made outside the
 * app, or by git, becomes the new starting point.
 */
export function nextFrontmatterBaseline(
  current: FrontmatterBaseline | null,
  loaded: FrontmatterBaseline,
  lastWritten: Values | null
): FrontmatterBaseline {
  if (current === null) return loaded
  const ownSave = lastWritten !== null && sameValues(loaded.values, lastWritten)
  return ownSave ? current : loaded
}
