/**
 * Grammar and spelling underlines
 *
 * Checks the body text with Harper (the `checkGrammar` command, which runs in
 * Rust on a background thread) and shows what it finds as quiet underlines:
 * wavy for spelling, dotted for grammar. Pointing at one, clicking it or
 * pressing Cmd+. on it shows Harper's message and buttons for its suggestions,
 * Ignore and Add to dictionary (grammar-popup.ts). Files over
 * GRAMMAR_MAX_CHARACTERS aren't checked; a quiet note under the text says so.
 *
 * `@codemirror/lint` does the scheduling: it waits until typing pauses for
 * GRAMMAR_DELAY_MS, and drops a result if the text changed while the check
 * ran, so an old result never lands on new text. Diagnostics move with edits
 * until the next check replaces them. Rust runs only the newest of several
 * waiting checks and answers the rest with null, which keeps what's shown.
 *
 * Settings are read with getState() on every check. `refreshGrammar()` re-checks
 * at once; `useGrammarRefresh` calls it when the settings change.
 */

import { StateEffect, StateField } from '@codemirror/state'
import { EditorView, showPanel, tooltips, type Panel } from '@codemirror/view'
import {
  forEachDiagnostic,
  forceLinting,
  linter,
  setDiagnostics,
  type Diagnostic,
} from '@codemirror/lint'
import { debug, warn as logWarn } from '@tauri-apps/plugin-log'
import { commands } from '../../bindings'
import { useEditorStore } from '../../../store/editorStore'
import { useProjectStore } from '../../../store/projectStore'
import {
  addWord,
  ignoreIssue,
  issuesToDiagnostics,
  resolveGrammarSettings,
  type GrammarActionHandlers,
} from '../../grammar'
import { projectRegistryManager } from '../../project-registry'
import { getCurrentEditorView } from '../editor-view-ref'
import { grammarPopupExtension } from './grammar-popup'

/** How long typing must pause before the text is checked */
const GRAMMAR_DELAY_MS = 600

/**
 * Files longer than this aren't checked: about 40,000 words, where a first
 * check takes seconds and the underlines would be more noise than help
 */
export const GRAMMAR_MAX_CHARACTERS = 250_000

const refreshGrammarEffect = StateEffect.define<null>()

/** A quiet line under the text saying why nothing is underlined */
const setGrammarNote = StateEffect.define<string | null>()

const grammarNoteField = StateField.define<string | null>({
  create: () => null,
  update(note, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGrammarNote)) return effect.value
    }
    return note
  },
  provide: field =>
    showPanel.from(field, note =>
      note
        ? (): Panel => {
            const dom = document.createElement('div')
            dom.className = 'cm-grammar-note'
            dom.textContent = note
            return { dom }
          }
        : null
    ),
})

function showNote(view: EditorView, note: string | null) {
  if (view.state.field(grammarNoteField, false) === note) return
  view.dispatch({ effects: setGrammarNote.of(note) })
}

const TOO_LONG_NOTE = 'This file is too long to check spelling and grammar.'

/** Logged once, so a check that keeps failing doesn't flood the log */
let loggedFailure = false

function removeDiagnostics(
  view: EditorView,
  remove: (diagnostic: Diagnostic) => boolean
) {
  const kept = currentDiagnostics(view).filter(d => !remove(d))
  view.dispatch(setDiagnostics(view.state, kept))
}

function currentDiagnostics(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    diagnostics.push({ ...diagnostic, from, to })
  })
  return diagnostics
}

const handlers: GrammarActionHandlers = {
  onIgnore(view, key, from, to) {
    const file = useEditorStore.getState().currentFile
    if (file) ignoreIssue(file.path, key)
    removeDiagnostics(view, d => d.from === from && d.to === to)
  },
  onAddWord(view, word) {
    const folded = word.toLowerCase()
    removeDiagnostics(
      view,
      d =>
        d.markClass === 'cm-grammar-spelling' &&
        view.state.sliceDoc(d.from, d.to).toLowerCase() === folded
    )
    // The registry has the settings as last written, even if the store
    // hasn't caught up with a change made a moment ago
    const grammar = resolveGrammarSettings(
      projectRegistryManager.getGlobalSettings()
    )
    void useProjectStore.getState().updateGlobalSettings({
      grammar: { ...grammar, dictionary: addWord(grammar.dictionary, word) },
    })
  },
  onStale(view) {
    refreshGrammar(view)
  },
}

const currentSettings = () =>
  resolveGrammarSettings(useProjectStore.getState().globalSettings)

/** The lint source. Exported for tests */
export async function grammarLintSource(
  view: EditorView
): Promise<Diagnostic[]> {
  const settings = currentSettings()
  const file = useEditorStore.getState().currentFile
  const tooLong = view.state.doc.length > GRAMMAR_MAX_CHARACTERS
  showNote(view, settings.enabled && file && tooLong ? TOO_LONG_NOTE : null)
  if (!settings.enabled || !file || tooLong) return []
  const doc = view.state.doc.toString()
  if (!doc.trim()) return []

  const started = performance.now()
  const result = await commands.checkGrammar(
    doc,
    file.extension === 'mdx' ? 'mdx' : 'md',
    settings.dialect,
    settings.dictionary
  )
  if (result.status === 'error') {
    if (!loggedFailure) {
      loggedFailure = true
      void logWarn(`Astro Editor [GRAMMAR] Check failed: ${result.error}`)
    }
    return []
  }
  // A newer check replaced this one before it ran; keep what's shown
  if (result.data === null) return currentDiagnostics(view)
  // The settings may have changed while it ran
  const latest = currentSettings()
  if (!latest.enabled) return []
  if (import.meta.env.DEV) {
    const ms = Math.round(performance.now() - started)
    void debug(
      `Astro Editor [GRAMMAR] ${result.data.length} issues in ${ms} ms (${doc.length} characters)`
    )
  }
  return issuesToDiagnostics(
    doc,
    result.data,
    file.path,
    handlers,
    latest.dictionary
  )
}

/** Re-check the open file now, after a settings change */
export function refreshGrammar(view = getCurrentEditorView()) {
  if (!view) return
  view.dispatch({ effects: refreshGrammarEffect.of(null) })
  forceLinting(view)
}

const grammarTheme = EditorView.theme({
  // Replace the lint package's background squiggles with text decoration,
  // which follows the text's size and stays thin
  '.cm-lintRange': {
    backgroundImage: 'none !important',
    paddingBottom: '0',
    textDecorationSkipInk: 'none',
  },
  '.cm-lintRange.cm-grammar-spelling': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationColor: 'var(--editor-color-spelling)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '0.25em',
  },
  '.cm-lintRange.cm-grammar-grammar': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textDecorationColor: 'var(--editor-color-grammar)',
    textDecorationThickness: '2px',
    textUnderlineOffset: '0.3em',
  },
  // The popup (grammar-popup.ts) reuses the lint package's classes; style the
  // tooltip that holds one
  '.cm-tooltip:has(.cm-tooltip-lint)': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: '0 4px 16px var(--image-preview-shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip-lint': {
    width: 'max-content',
    maxWidth: '320px',
    padding: '4px',
    fontSize: '13px',
    lineHeight: '1.4',
  },
  '.cm-tooltip-lint .cm-diagnostic': {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    borderLeft: 'none',
    margin: '0',
    padding: '6px 8px',
    whiteSpace: 'normal',
  },
  '.cm-tooltip-lint .cm-diagnostic + .cm-diagnostic': {
    borderTop: '1px solid var(--border)',
  },
  '.cm-tooltip-lint .cm-diagnosticText': {
    flexBasis: '100%',
    marginBottom: '4px',
  },
  '.cm-tooltip-lint .cm-diagnosticAction': {
    margin: '0',
    padding: '2px 8px',
    borderRadius: 'calc(var(--radius) - 2px)',
    fontSize: '12px',
    lineHeight: '1.5',
    border: '1px solid var(--border)',
    backgroundColor: 'transparent',
    color: 'var(--popover-foreground)',
  },
  '.cm-tooltip-lint .cm-diagnosticAction.cm-grammar-suggestion': {
    backgroundColor: 'var(--secondary)',
    color: 'var(--secondary-foreground)',
    fontWeight: '500',
  },
  '.cm-tooltip-lint .cm-diagnosticAction.cm-grammar-secondary': {
    borderColor: 'transparent',
    color: 'var(--muted-foreground)',
  },
  '.cm-tooltip-lint .cm-diagnosticAction:focus-visible': {
    outline: '2px solid var(--ring)',
    outlineOffset: '1px',
  },
  '.cm-grammar-note': {
    padding: '4px 12px',
    fontSize: '12px',
    color: 'var(--muted-foreground)',
    backgroundColor: 'var(--editor-color-background)',
    textAlign: 'center',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: 'none',
  },
  '.cm-tooltip-lint .cm-diagnosticAction:hover': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
})

export function createGrammarExtension() {
  return [
    linter(grammarLintSource, {
      delay: GRAMMAR_DELAY_MS,
      // grammar-popup.ts draws the popup, for hover, click and the keyboard
      tooltipFilter: () => [],
      needsRefresh: update =>
        update.transactions.some(tr =>
          tr.effects.some(effect => effect.is(refreshGrammarEffect))
        ),
    }),
    // The editor's panel clips anything that overflows it, so a popup near
    // its edge was cut off. Mounting tooltips on the body avoids that;
    // CodeMirror copies the editor's theme classes onto them
    tooltips({ parent: document.body }),
    grammarPopupExtension(),
    grammarNoteField,
    grammarTheme,
  ]
}
