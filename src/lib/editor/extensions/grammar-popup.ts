/**
 * The grammar popup: Harper's message for an underlined issue and buttons for
 * its suggestions, Ignore and Add to dictionary.
 *
 * It opens three ways, all drawing the same popup:
 * - pointing at an underline (a hover tooltip; the lint package's own hover
 *   tooltip is switched off with `tooltipFilter` in grammar.ts),
 * - clicking one,
 * - Cmd+. (Ctrl+. elsewhere) with the cursor on one. This moves focus to the
 *   first suggestion: Tab or the arrow keys move between buttons, Enter
 *   chooses, Escape goes back to the text.
 *
 * Clicking and the shortcut open it through `grammarPopupField`, which closes
 * it again when the text or the diagnostics change.
 */

import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import {
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  type Tooltip,
} from '@codemirror/view'
import {
  forEachDiagnostic,
  setDiagnosticsEffect,
  type Diagnostic,
} from '@codemirror/lint'

interface PopupRequest {
  pos: number
  /** Move focus to the first button (opened from the keyboard) */
  focus: boolean
}

interface LiveDiagnostic {
  diagnostic: Diagnostic
  from: number
  to: number
}

const setPopup = StateEffect.define<PopupRequest | null>()

/** The diagnostics covering `pos`, with their current ranges */
function diagnosticsAt(state: EditorState, pos: number): LiveDiagnostic[] {
  const found: LiveDiagnostic[] = []
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (from <= pos && pos <= to) found.push({ diagnostic, from, to })
  })
  return found
}

/** A diagnostic's range now, or null if it's gone */
function liveRange(state: EditorState, target: Diagnostic) {
  let range: { from: number; to: number } | null = null
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (diagnostic === target) range = { from, to }
  })
  return range as { from: number; to: number } | null
}

function renderPopup(
  view: EditorView,
  diagnostics: LiveDiagnostic[],
  onDone: () => void
): HTMLElement {
  const dom = document.createElement('div')
  const list = document.createElement('ul')
  list.className = 'cm-tooltip-lint'
  dom.appendChild(list)

  for (const { diagnostic } of diagnostics) {
    const item = document.createElement('li')
    item.className = `cm-diagnostic cm-diagnostic-${diagnostic.severity}`
    const text = document.createElement('span')
    text.className = 'cm-diagnosticText'
    text.textContent = diagnostic.message
    item.appendChild(text)

    for (const action of diagnostic.actions ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `cm-diagnosticAction${action.markClass ? ` ${action.markClass}` : ''}`
      button.textContent = action.name
      // Keep the editor's selection when clicked with the mouse
      button.addEventListener('mousedown', event => event.preventDefault())
      button.addEventListener('click', () => {
        const range = liveRange(view.state, diagnostic)
        onDone()
        if (range) action.apply(view, range.from, range.to)
        view.focus()
      })
      item.appendChild(button)
    }
    list.appendChild(item)
  }

  dom.addEventListener('keydown', event => {
    const buttons = [...dom.querySelectorAll('button')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDone()
      view.focus()
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[(index + 1) % buttons.length]?.focus()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
    }
  })
  return dom
}

function popupTooltip(
  state: EditorState,
  request: PopupRequest
): Tooltip | null {
  const diagnostics = diagnosticsAt(state, request.pos)
  if (diagnostics.length === 0) return null
  return {
    pos: Math.min(...diagnostics.map(d => d.from)),
    end: Math.max(...diagnostics.map(d => d.to)),
    create: view => {
      const dom = renderPopup(view, diagnostics, () =>
        view.dispatch({ effects: setPopup.of(null) })
      )
      return {
        dom,
        mount: () => {
          if (request.focus) dom.querySelector('button')?.focus()
        },
      }
    },
  }
}

const grammarPopupField = StateField.define<PopupRequest | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPopup)) return effect.value
    }
    if (!value) return null
    if (tr.docChanged || tr.effects.some(e => e.is(setDiagnosticsEffect))) {
      return null
    }
    return value
  },
  provide: field =>
    showTooltip.compute([field], state => {
      const request = state.field(field)
      return request ? popupTooltip(state, request) : null
    }),
})

export function isGrammarPopupOpen(state: EditorState): boolean {
  return state.field(grammarPopupField, false) != null
}

/** Opens the popup for the issue at `pos`. Returns false if there's none */
export function openGrammarPopupAt(
  view: EditorView,
  pos: number,
  focus: boolean
): boolean {
  if (diagnosticsAt(view.state, pos).length === 0) return false
  view.dispatch({ effects: setPopup.of({ pos, focus }) })
  return true
}

/** The keyboard command: the issue at the cursor, focus on its first button */
export function openGrammarPopupAtCursor(view: EditorView): boolean {
  const { main } = view.state.selection
  if (!main.empty) return false
  return openGrammarPopupAt(view, main.head, true)
}

export function closeGrammarPopup(view: EditorView): boolean {
  if (!isGrammarPopupOpen(view.state)) return false
  view.dispatch({ effects: setPopup.of(null) })
  return true
}

export function grammarPopupExtension() {
  return [
    grammarPopupField,
    hoverTooltip(
      (view, pos, side) => {
        if (isGrammarPopupOpen(view.state)) return null
        const diagnostics = diagnosticsAt(view.state, pos).filter(
          d => (d.from < pos || side > 0) && (d.to > pos || side < 0)
        )
        if (diagnostics.length === 0) return null
        return {
          pos: Math.min(...diagnostics.map(d => d.from)),
          end: Math.max(...diagnostics.map(d => d.to)),
          create: view => ({
            dom: renderPopup(view, diagnostics, () => {}),
          }),
        }
      },
      {
        hideOn: tr =>
          tr.docChanged ||
          tr.effects.some(
            effect => effect.is(setPopup) || effect.is(setDiagnosticsEffect)
          ),
      }
    ),
    keymap.of([
      { key: 'Mod-.', run: openGrammarPopupAtCursor },
      { key: 'Escape', run: closeGrammarPopup },
    ]),
    EditorView.domEventHandlers({
      click: (event, view) => {
        if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
          return false
        }
        if (!view.state.selection.main.empty) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null || !openGrammarPopupAt(view, pos, false)) {
          closeGrammarPopup(view)
        }
        return false
      },
    }),
  ]
}
