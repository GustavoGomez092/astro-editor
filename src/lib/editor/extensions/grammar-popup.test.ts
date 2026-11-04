import { afterEach, describe, expect, test, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import {
  closeGrammarPopup,
  grammarPopupExtension,
  isGrammarPopupOpen,
  openGrammarPopupAtCursor,
} from './grammar-popup'

const DOC = 'This is teh test.'

const diagnostic = (apply = vi.fn()): Diagnostic => ({
  from: 8,
  to: 11,
  severity: 'warning',
  markClass: 'cm-grammar-spelling',
  message: 'Did you mean to spell “teh” this way?',
  actions: [
    { name: 'the', markClass: 'cm-grammar-suggestion', apply },
    { name: 'Ignore', markClass: 'cm-grammar-secondary', apply: vi.fn() },
  ],
})

let view: EditorView | null = null

function setup(cursor: number, d = diagnostic()) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: cursor },
      extensions: [linter(null), grammarPopupExtension()],
    }),
  })
  view.dispatch(setDiagnostics(view.state, [d]))
  return view
}

const popup = () => document.querySelector('.cm-tooltip-lint')

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('grammar popup', () => {
  test('opens for the issue at the cursor with focus on the first suggestion', () => {
    const v = setup(9)
    expect(openGrammarPopupAtCursor(v)).toBe(true)
    expect(isGrammarPopupOpen(v.state)).toBe(true)
    expect(popup()?.textContent).toContain('Did you mean to spell “teh”')
    expect(document.activeElement?.textContent).toBe('the')
  })

  test('does nothing when the cursor is not on an issue', () => {
    const v = setup(2)
    expect(openGrammarPopupAtCursor(v)).toBe(false)
    expect(isGrammarPopupOpen(v.state)).toBe(false)
  })

  test('Escape closes it and returns to the editor', () => {
    const v = setup(9)
    openGrammarPopupAtCursor(v)
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    expect(isGrammarPopupOpen(v.state)).toBe(false)
    expect(popup()).toBeNull()
  })

  test('choosing a suggestion applies it to the issue range and closes', () => {
    const apply = vi.fn()
    const v = setup(9, diagnostic(apply))
    openGrammarPopupAtCursor(v)
    ;(document.activeElement as HTMLButtonElement).click()
    expect(apply).toHaveBeenCalledWith(v, 8, 11)
    expect(isGrammarPopupOpen(v.state)).toBe(false)
  })

  test('closes when the text changes', () => {
    const v = setup(9)
    openGrammarPopupAtCursor(v)
    v.dispatch({ changes: { from: 0, insert: 'Yes. ' } })
    expect(isGrammarPopupOpen(v.state)).toBe(false)
  })

  test('closeGrammarPopup reports whether one was open', () => {
    const v = setup(9)
    expect(closeGrammarPopup(v)).toBe(false)
    openGrammarPopupAtCursor(v)
    expect(closeGrammarPopup(v)).toBe(true)
  })
})
