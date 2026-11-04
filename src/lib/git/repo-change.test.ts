import { afterEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '@/store/editorStore'
import { restoreFocusAfterGitChange, saveBeforeGitChange } from './repo-change'

describe('focus around a git change', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function guardedInput() {
    document.body.innerHTML = `
      <div data-git-guarded><input id="title" /></div>
      <input id="elsewhere" />`
    return document.getElementById('title') as HTMLInputElement
  }

  it('puts focus back where it was in the editor or frontmatter', async () => {
    useEditorStore.setState({ isDirty: false })
    const input = guardedInput()
    input.focus()
    await saveBeforeGitChange()
    // Making the area inert takes focus away
    input.blur()
    expect(document.activeElement).toBe(document.body)

    restoreFocusAfterGitChange()
    expect(document.activeElement).toBe(input)
  })

  it("doesn't take focus from somewhere else the writer went", async () => {
    useEditorStore.setState({ isDirty: false })
    const input = guardedInput()
    input.focus()
    await saveBeforeGitChange()
    const elsewhere = document.getElementById('elsewhere') as HTMLInputElement
    elsewhere.focus()

    restoreFocusAfterGitChange()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('leaves focus alone when it started outside the guarded areas', async () => {
    useEditorStore.setState({ isDirty: false })
    guardedInput()
    const elsewhere = document.getElementById('elsewhere') as HTMLInputElement
    elsewhere.focus()
    await saveBeforeGitChange()
    elsewhere.blur()

    restoreFocusAfterGitChange()
    expect(document.activeElement).toBe(document.body)
  })
})
