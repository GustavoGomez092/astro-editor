/** Marks the body editor's wrapper with "shown" or "hidden" (MainEditor). */
export const BODY_EDITOR_ATTRIBUTE = 'data-body-editor'

/** Marks the frontmatter panel, where a new entry's fields are. */
export const FRONTMATTER_PANEL_ATTRIBUTE = 'data-frontmatter-panel'

const FIELD = 'input, textarea, select, button, [contenteditable="true"]'

/**
 * Puts the cursor where a new entry is written: the title field when it was
 * created without a title, the first frontmatter field when its collection
 * hides the body editor (there's nowhere else to type), and the editor
 * otherwise. Call once the entry is open and its form has rendered.
 */
export function focusNewFile({ titleGiven }: { titleGiven: boolean }): void {
  if (!titleGiven) {
    const titleField = document.getElementById('frontmatter-title-field')
    if (titleField instanceof HTMLTextAreaElement) {
      titleField.focus()
      titleField.select()
      return
    }
  }

  const bodyHidden =
    document.querySelector(`[${BODY_EDITOR_ATTRIBUTE}="hidden"]`) !== null
  if (bodyHidden) {
    const field = document
      .querySelector(`[${FRONTMATTER_PANEL_ATTRIBUTE}]`)
      ?.querySelector(FIELD)
    if (field instanceof HTMLElement) field.focus()
    return
  }

  const editor = document.querySelector('.cm-editor .cm-content')
  if (editor instanceof HTMLElement) editor.focus()
}
