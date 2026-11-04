import { describe, expect, it } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { queryClient } from '@/lib/query-client'
import { handleTauriFileDrop } from '@/lib/editor/dragdrop/handlers'
import { GIT_CHANGE_MUTATION_KEY } from './repo-change'
import { isGitBusy } from './busy'

/** Starts a git change that runs until `finish` is called. */
function startGitChange() {
  let finish = () => {}
  const running = new Promise<void>(resolve => {
    finish = resolve
  })
  const observer = new MutationObserver(queryClient, {
    mutationKey: GIT_CHANGE_MUTATION_KEY,
    mutationFn: () => running,
  })
  const done = observer.mutate()
  return async () => {
    finish()
    await done
  }
}

describe('isGitBusy', () => {
  it('is true only while a git change runs', async () => {
    expect(isGitBusy()).toBe(false)
    const finish = startGitChange()
    expect(isGitBusy()).toBe(true)
    await finish()
    expect(isGitBusy()).toBe(false)
  })

  it('makes the editor ignore file drops meanwhile', async () => {
    const view = new EditorView({ state: EditorState.create({ doc: '' }) })
    const finish = startGitChange()
    const result = await handleTauriFileDrop(
      { paths: ['/tmp/photo.jpg'], position: { x: 1, y: 1 } },
      view
    )
    await finish()
    expect(result.success).toBe(false)
    expect(view.state.doc.toString()).toBe('')
    expect(result.error).toMatch(/git/i)
    view.destroy()
  })
})
