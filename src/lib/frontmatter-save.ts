// Saving frontmatter without changing more of the file than really changed.
// Writing the values back reformats the YAML (quotes, spacing, order), so a
// one-field edit, or an edit that was undone, would show up as a change to
// the whole frontmatter. Instead the text on disk is edited in place
// (lib/frontmatter-yaml.ts), and when the values are back to what was on
// disk when the file was opened, that text is written as it was.

import {
  editFrontmatterText,
  parseFrontmatterValues,
  sameValues,
} from './frontmatter-yaml'
import { FieldType, type SchemaField } from './schema'

type Values = Record<string, unknown>

/** The frontmatter on disk: its values and the exact text they came from. */
export interface FrontmatterBaseline {
  values: Values
  raw: string
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
 * What a save passes for the frontmatter: the text to write, or the values
 * for the app's own writer. The text on disk is kept when the frontmatter
 * wasn't edited, and the baseline's text when the edits ended where they
 * started. Otherwise it's the text on disk with the edits made in place, or,
 * when that text can't be edited (it isn't valid YAML, or there's none yet),
 * the values. A key the file didn't have is left out while its value is
 * only the default. `written` is the values a new text holds, so the reload
 * of this save isn't taken for a change made outside the app.
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
  /** The collection's schema fields, for their order, types and defaults */
  fields?: SchemaField[]
}): {
  frontmatter: Values | null
  rawFrontmatter: string | null
  written: Values | null
} {
  if (!isFrontmatterDirty) {
    return { frontmatter: null, rawFrontmatter, written: null }
  }
  if (
    frontmatterBaseline &&
    sameValues(
      withoutUnsetKeys(frontmatter, frontmatterBaseline.values, fields),
      frontmatterBaseline.values
    )
  ) {
    return {
      frontmatter: null,
      rawFrontmatter: frontmatterBaseline.raw,
      written: null,
    }
  }
  const onDisk = parseFrontmatterValues(rawFrontmatter)
  if (onDisk) {
    const written = withoutUnsetKeys(frontmatter, onDisk, fields)
    const text = editFrontmatterText(rawFrontmatter, written, fields)
    if (text !== null)
      return { frontmatter: null, rawFrontmatter: text, written }
  }
  return { frontmatter, rawFrontmatter: null, written: frontmatter }
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
