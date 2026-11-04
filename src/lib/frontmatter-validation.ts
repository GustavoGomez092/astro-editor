// Checks frontmatter values against the collection's schema, so the form can
// say what Astro's build would reject. It never blocks a save: the writer sees
// a message under the field (after leaving it, or after saving) and a warning
// toast on save. The JSON schema is looser than Astro's own checks (see
// schema-system.md), so a clean result doesn't promise the build passes.

import { FieldType, type SchemaField } from './schema'
import { getNestedValue } from './object-utils'

// Close to Zod's email check, without its full pattern: something@domain.tld
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === ''

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`

function isUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function numberError(field: SchemaField, value: unknown): string | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Enter a number'
  if (field.type === FieldType.Integer && !Number.isInteger(value)) {
    return 'Enter a whole number'
  }

  const { min, max, minExclusive, maxExclusive } = field.constraints ?? {}
  if (min !== undefined) {
    if (minExclusive && value <= min) return `Must be more than ${min}`
    if (!minExclusive && value < min) return `Must be at least ${min}`
  }
  if (max !== undefined) {
    if (maxExclusive && value >= max) return `Must be less than ${max}`
    if (!maxExclusive && value > max) return `Must be at most ${max}`
  }
  return null
}

function stringError(field: SchemaField, value: string): string | null {
  const { minLength, maxLength, format } = field.constraints ?? {}

  if (
    (field.type === FieldType.Email || format === 'email') &&
    !EMAIL.test(value)
  ) {
    return 'Enter an email address, like name@example.com'
  }
  if ((field.type === FieldType.URL || format === 'uri') && !isUrl(value)) {
    return 'Enter a full URL, like https://example.com'
  }
  if (minLength !== undefined && value.length < minLength) {
    return `Must be at least ${plural(minLength, 'character')}`
  }
  if (maxLength !== undefined && value.length > maxLength) {
    return `Must be ${plural(maxLength, 'character')} or fewer`
  }
  return null
}

function arrayError(field: SchemaField, value: unknown[]): string | null {
  const { minItems, maxItems } = field.constraints ?? {}
  if (minItems !== undefined && value.length < minItems) {
    return `Add at least ${plural(minItems, 'item')}`
  }
  if (maxItems !== undefined && value.length > maxItems) {
    return `Use ${plural(maxItems, 'item')} or fewer`
  }
  return null
}

/**
 * The message for one field's value in `frontmatter`, or null when it's fine.
 * A required field inside an object that isn't there is skipped: the object
 * itself may be optional, and the flattened fields don't say.
 */
export function fieldError(
  field: SchemaField,
  frontmatter: Record<string, unknown>
): string | null {
  const value = getNestedValue(frontmatter, field.name)

  if (isEmpty(value)) {
    const parentMissing =
      field.parentPath !== undefined &&
      getNestedValue(frontmatter, field.parentPath) == null
    return field.required && !parentMissing ? 'Required' : null
  }

  switch (field.type) {
    case FieldType.Number:
    case FieldType.Integer:
      return numberError(field, value)
    case FieldType.Enum:
      return field.enumValues &&
        !field.enumValues.some(option => option === value)
        ? `Choose one of: ${field.enumValues.join(', ')}`
        : null
    case FieldType.Array:
      return Array.isArray(value) ? arrayError(field, value) : null
    case FieldType.String:
    case FieldType.Email:
    case FieldType.URL:
      return typeof value === 'string' ? stringError(field, value) : null
    default:
      return null
  }
}

/** Every schema field that needs attention, by name, with its message. */
export function validateFrontmatter(
  fields: SchemaField[],
  frontmatter: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const message = fieldError(field, frontmatter)
    if (message) errors[field.name] = message
  }
  return errors
}
