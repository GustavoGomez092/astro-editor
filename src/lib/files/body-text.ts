// Some collections are only frontmatter (settings, testimonials, gallery
// items), so the body editor is just an empty page that invites text the site
// never shows. It's hidden for those collections.

import type { CollectionSpecificSettings } from '../project-registry/types'

interface BodyEditorState {
  /** The collection's "Body text" setting; undefined detects it */
  setting: CollectionSpecificSettings['bodyText']
  /** Whether any entry has body text, or undefined while that's unknown */
  collectionHasBody: boolean | undefined
  /** Whether the open file has body text (more than whitespace) */
  fileHasBody: boolean
}

/**
 * Whether to hide the body editor: when the collection is set to have no body
 * text, or, without a setting, when none of its entries has any. Text the open
 * file already has is never hidden, so it can't be lost from view.
 */
export function hidesBodyEditor({
  setting,
  collectionHasBody,
  fileHasBody,
}: BodyEditorState): boolean {
  if (fileHasBody) return false
  if (setting === 'show') return false
  if (setting === 'hide') return true
  return collectionHasBody === false
}
