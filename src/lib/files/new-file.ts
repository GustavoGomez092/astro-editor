// Frontmatter and file names for a new entry. A new file must not contain
// values the writer didn't choose: an empty `image: ""`, `width: 0` or
// `email: ""` looks filled in but fails the project's build. So a required
// field without a default is left out, and the form shows it as empty and
// required instead.

import { FieldType, type SchemaField } from '../schema'
import { setNestedValue } from '../object-utils'
import { slugFromTitle } from '../slug'
import { collectionDisplayName } from '../collection-name'

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
  // "sketch-strip" reads "New Sketch strip", the same words the sidebar uses
  const singular = singularize(collectionDisplayName(collectionName))
  return `New ${singular.charAt(0).toUpperCase() + singular.slice(1)}`
}

/**
 * The frontmatter for a new entry: the title, today for the published date,
 * every field's default, and `false`, today or `[]` for a required boolean,
 * date or list without one (a list only when it may be empty), since those
 * have a valid value that isn't a placeholder. Other required fields without
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
    } else if (
      field.required &&
      field.type === FieldType.Array &&
      !(field.constraints?.minItems && field.constraints.minItems > 0)
    ) {
      value = []
    } else {
      continue
    }

    frontmatter = setNestedValue(frontmatter, field.name, value)
  }

  return frontmatter
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0

/** YAML lines for `values`, with nested objects indented under their key */
function yamlLines(
  values: Record<string, unknown>,
  dateFields: Set<string>,
  parentPath = '',
  indent = ''
): string[] {
  return Object.entries(values).flatMap(([key, value]) => {
    const path = parentPath ? `${parentPath}.${key}` : key
    if (isObject(value)) {
      return [
        `${indent}${key}:`,
        ...yamlLines(value, dateFields, path, `${indent}  `),
      ]
    }
    return dateFields.has(path) && typeof value === 'string'
      ? [`${indent}${key}: ${value}`]
      : [`${indent}${key}: ${JSON.stringify(value)}`]
  })
}

/**
 * The file's text: YAML frontmatter and an empty body. Values are written as
 * JSON, which YAML reads as the same types (quoted strings, flow arrays), and
 * objects as indented YAML. Date fields, nested ones too, are left unquoted,
 * because YAML reads a quoted date as a string and `z.date()` rejects it.
 */
export function newFileContent(
  frontmatter: Record<string, unknown>,
  fields: SchemaField[]
): string {
  if (Object.keys(frontmatter).length === 0) return ''

  const dateFields = new Set(
    fields.filter(f => f.type === FieldType.Date).map(f => f.name)
  )
  const lines = yamlLines(frontmatter, dateFields)
  return `---\n${lines.join('\n')}\n---\n\n`
}

/**
 * A file name from the title (`andrew-dyk.md`), or today's date when the
 * title has no letters or digits, with `-1`, `-2`, … added until it's unused.
 * A name counts as taken whatever its extension: Astro's id is the name
 * without it, so `andrew-dyk.md` and `andrew-dyk.mdx` would collide.
 */
export function newFileName(
  title: string,
  extension: string,
  existingNames: Set<string>,
  today: string
): string {
  const taken = new Set(
    [...existingNames].map(name => name.replace(/\.[^.]+$/, ''))
  )
  const base = slugFromTitle(title) || today
  let stem = base
  let counter = 1

  while (taken.has(stem)) {
    stem = `${base}-${counter}`
    counter++
  }
  return `${stem}.${extension}`
}
