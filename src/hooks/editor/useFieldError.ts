import { useEditorStore } from '../../store/editorStore'
import { fieldError } from '../../lib/frontmatter-validation'
import type { SchemaField } from '../../lib/schema'

/**
 * The validation message to show under a frontmatter field, or null. Only
 * fields in the store's `shownFieldErrors` show one; the message follows the
 * value, so it goes away as soon as the value is fixed.
 */
export function useFieldError(
  name: string,
  field: SchemaField | undefined
): string | null {
  return useEditorStore(state =>
    field && state.shownFieldErrors[name]
      ? fieldError(field, state.frontmatter)
      : null
  )
}
