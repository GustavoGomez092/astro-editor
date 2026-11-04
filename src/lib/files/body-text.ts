// Some collections are only frontmatter (settings, testimonials, gallery
// items), so the body editor is just an empty page that invites text the site
// never shows. It's hidden for those collections.

import type { CollectionSpecificSettings } from '../project-registry/types'
import { useProjectStore } from '../../store/projectStore'
import { queryClient } from '../query-client'
import { queryKeys } from '../query-keys'

interface BodyEditorState {
  /** The collection's "Body text" setting; undefined detects it */
  setting: CollectionSpecificSettings['bodyText']
  /** Whether any entry has body text, or undefined while that's unknown */
  collectionHasBody: boolean | undefined
  /**
   * Whether the open file has body text (more than whitespace), or undefined
   * while it loads: opening a file empties the body until its content arrives
   */
  fileHasBody: boolean | undefined
  /** The last choice, kept while the loading file is what decides */
  previous?: boolean
}

/**
 * Whether to hide the body editor: when the collection is set to have no body
 * text, or, without a setting, when none of its entries has any. Text the open
 * file already has is never hidden, so it can't be lost from view.
 *
 * While the file loads, the answer only waits for it in a collection set to
 * hide body text where some entry has some: there the previous choice is
 * kept, so a file with text doesn't flash the form first. Everywhere else the
 * file can't change the answer.
 */
export function hidesBodyEditor({
  setting,
  collectionHasBody,
  fileHasBody,
  previous = false,
}: BodyEditorState): boolean {
  if (
    fileHasBody === undefined &&
    setting === 'hide' &&
    collectionHasBody !== false
  ) {
    return previous
  }
  if (fileHasBody) return false
  if (setting === 'show') return false
  if (setting === 'hide') return true
  return collectionHasBody === false
}

/**
 * Whether a new, empty entry in `collectionName` gets its form in the main
 * area, from the collection's setting and the cached check for body text.
 * Read just after creating the entry, before its own content has loaded.
 */
export function newEntryHidesBodyEditor(collectionName: string): boolean {
  const { projectPath, currentProjectSettings } = useProjectStore.getState()
  const setting = currentProjectSettings?.collections?.find(
    c => c.name === collectionName
  )?.settings.bodyText
  const collectionHasBody = queryClient.getQueryData<boolean>(
    queryKeys.collectionHasBody(projectPath ?? '', collectionName)
  )
  return hidesBodyEditor({ setting, collectionHasBody, fileHasBody: false })
}
