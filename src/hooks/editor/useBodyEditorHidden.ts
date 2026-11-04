import { useState } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useCollectionsQuery } from '../queries/useCollectionsQuery'
import { useCollectionHasBodyQuery } from '../queries/useCollectionHasBodyQuery'
import { hidesBodyEditor } from '../../lib/files/body-text'

/**
 * Whether the open file's collection hides the body editor (see
 * `lib/files/body-text.ts`): its Body Text setting, or, without one, whether
 * any of its entries has body text. While the open file loads, the last
 * answer is kept where the file is what decides (`hidesBodyEditor`).
 */
export function useBodyEditorHidden(): boolean {
  const collectionName = useEditorStore(
    state => state.currentFile?.collection ?? null
  )
  // A regex test rather than trim(), which copies the whole body on every
  // keystroke
  const fileHasBody = useEditorStore(state => /\S/.test(state.editorContent))
  // openFile clears the baseline and the first load of the file sets it
  const fileLoaded = useEditorStore(state => state.frontmatterBaseline !== null)
  const projectPath = useProjectStore(state => state.projectPath)
  const projectSettings = useProjectStore(state => state.currentProjectSettings)
  const setting = projectSettings?.collections?.find(
    c => c.name === collectionName
  )?.settings.bodyText

  const { data: collections } = useCollectionsQuery(
    projectPath,
    projectSettings
  )
  const collectionPath =
    collections?.find(c => c.name === collectionName)?.path ?? null
  const { data: collectionHasBody } = useCollectionHasBodyQuery(
    projectPath,
    collectionName,
    collectionPath
  )

  const [previous, setPrevious] = useState(false)
  const hidden = hidesBodyEditor({
    setting,
    collectionHasBody,
    fileHasBody: fileLoaded ? fileHasBody : undefined,
    previous,
  })
  if (hidden !== previous) setPrevious(hidden)
  return hidden
}
