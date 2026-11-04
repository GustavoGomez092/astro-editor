/**
 * Turns Harper's issues into CodeMirror lint diagnostics: the underline's
 * range and class, the message, and the popup's buttons (each suggestion,
 * Ignore, and Add to dictionary for a misspelt word).
 */

import type { Action, Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { GrammarIssue } from '@/lib/bindings'
import { ignoreKey, isIgnored } from './ignored'

export interface GrammarActionHandlers {
  /** `from` and `to` are the issue's range now, after any edits since the check */
  onIgnore: (view: EditorView, key: string, from: number, to: number) => void
  onAddWord: (view: EditorView, word: string) => void
  /** The text under an issue changed before its button was used: check again */
  onStale: (view: EditorView) => void
}

/** Harper quotes words in backticks, which read as code; use curly quotes */
export function plainMessage(message: string): string {
  return message.replace(/`([^`]*)`/g, '“$1”')
}

/**
 * `dictionary` is filtered here as well as in Rust, so a check that was already
 * running when a word was added can't bring its underline back
 */
export function issuesToDiagnostics(
  doc: string,
  issues: GrammarIssue[],
  filePath: string,
  handlers: GrammarActionHandlers,
  dictionary: string[] = []
): Diagnostic[] {
  const words = new Set(dictionary.map(w => w.toLowerCase()))
  const diagnostics: Diagnostic[] = []
  for (const issue of issues) {
    if (issue.to > doc.length || issue.from >= issue.to) continue
    if (words.has(issue.problem.toLowerCase())) continue
    const key = ignoreKey(doc, issue)
    if (isIgnored(filePath, key)) continue

    const spelling = issue.kind === 'spelling'
    const actions: Action[] = issue.suggestions.map(replacement => ({
      name: replacement || 'Remove',
      markClass: 'cm-grammar-suggestion',
      apply: (view, from, to) => {
        if (view.state.sliceDoc(from, to) !== issue.problem) {
          handlers.onStale(view)
          return
        }
        view.dispatch({
          changes: { from, to, insert: replacement },
          userEvent: 'input.complete',
        })
      },
    }))
    actions.push({
      name: 'Ignore',
      markClass: 'cm-grammar-secondary',
      apply: (view, from, to) => {
        if (view.state.sliceDoc(from, to) !== issue.problem) {
          handlers.onStale(view)
          return
        }
        handlers.onIgnore(view, key, from, to)
      },
    })
    if (spelling && !/\s/.test(issue.problem)) {
      actions.push({
        name: 'Add to dictionary',
        markClass: 'cm-grammar-secondary',
        apply: view => handlers.onAddWord(view, issue.problem),
      })
    }

    diagnostics.push({
      from: issue.from,
      to: issue.to,
      severity: spelling ? 'warning' : 'info',
      markClass: spelling ? 'cm-grammar-spelling' : 'cm-grammar-grammar',
      message: plainMessage(issue.message),
      actions,
    })
  }
  return diagnostics
}
