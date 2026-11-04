// Frontmatter and file names for a new entry. A new file must not contain
// values the writer didn't choose: an empty `image: ""`, `width: 0` or
// `email: ""` looks filled in but fails the project's build. So a required
// field without a default is left out, and the form shows it as empty and
// required instead.

import { FieldType, type SchemaField } from '../schema'
import { setNestedValue } from '../object-utils'
import { slugFromTitle } from '../slug'

const PUBLISHED_DATE_FIELDS = new Set(['pubdate', 'date', 'publisheddate'])

const singularize = (word: string): string => {
  const pluralRules = [
    { suffix: 'ies', replacement: 'y' }, // stories -> story
    { suffix: 'es', replacement: 'e' }, // articles -> article (not articl)
    { suffix: 's', replacement: '' }, // notes -> note
  ]

  for (const rule of pluralRules) {
    if (word.endsWith(rule.suffix)) {
      return word.slice(0, -rule.suffix.length) + rule.replacement
    }
  }
  return word
}

/** The title a new entry gets when the writer doesn't give one: "New Article". */
export function newFileTitlePlaceholder(collectionName: string): string {
  const singular = singularize(collectionName)
  return `New ${singular.charAt(0).toUpperCase() + singular.slice(1)}`
}

/**
 * The frontmatter for a new entry: the title, today for the published date,
 * every field's default, and `false` or today for a required boolean or date
 * without one, since those have no empty value. Other required fields without
 * a default are left out.
 */
export function buildNewFileFrontmatter(
  fields: SchemaField[],
  title: string,
  today: string
): Record<string, unknown> {
  let frontmatter: Record<string, unknown> = {}

  for (const field of fields) {
    const name = field.name.toLowerCase()
    let value: unknown

    if (name === 'title') {
      value = title
    } else if (
      field.type === FieldType.Date &&
      PUBLISHED_DATE_FIELDS.has(name)
    ) {
      value = today
    } else if (field.default !== undefined && field.default !== null) {
      value = field.default
    } else if (field.required && field.type === FieldType.Boolean) {
      value = false
    } else if (field.required && field.type === FieldType.Date) {
      value = today
    } else {
      continue
    }

    frontmatter = setNestedValue(frontmatter, field.name, value)
  }

  return frontmatter
}

/**
 * The file's text: YAML frontmatter and an empty body. Values are written as
 * JSON, which YAML reads as the same types (quoted strings, flow arrays and
 * objects). Date fields are left unquoted, because YAML reads a quoted date
 * as a string and `z.date()` rejects it.
 */
export function newFileContent(
  frontmatter: Record<string, unknown>,
  fields: SchemaField[]
): string {
  const entries = Object.entries(frontmatter)
  if (entries.length === 0) return ''

  const dateFields = new Set(
    fields.filter(f => f.type === FieldType.Date).map(f => f.name)
  )
  const lines = entries.map(([key, value]) =>
    dateFields.has(key) && typeof value === 'string'
      ? `${key}: ${value}`
      : `${key}: ${JSON.stringify(value)}`
  )
  return `---\n${lines.join('\n')}\n---\n\n`
}

/**
 * A file name from the title (`andrew-dyk.md`), or today's date when the
 * title has no letters or digits, with `-1`, `-2`, … added until it's unused.
 */
export function newFileName(
  title: string,
  extension: string,
  existingNames: Set<string>,
  today: string
): string {
  const base = slugFromTitle(title) || today
  let filename = `${base}.${extension}`
  let counter = 1

  while (existingNames.has(filename)) {
    filename = `${base}-${counter}.${extension}`
    counter++
  }
  return filename
}
