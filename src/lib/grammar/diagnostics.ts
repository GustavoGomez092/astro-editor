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
  onIgnore: (view: EditorView, key: string) => void
  onAddWord: (view: EditorView, word: string) => void
}

/** Harper quotes words in backticks, which read as code; use curly quotes */
export function plainMessage(message: string): string {
  return message.replace(/`([^`]*)`/g, '“$1”')
}

export function issuesToDiagnostics(
  doc: string,
  issues: GrammarIssue[],
  filePath: string,
  handlers: GrammarActionHandlers
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const issue of issues) {
    if (issue.to > doc.length || issue.from >= issue.to) continue
    const key = ignoreKey(doc, issue)
    if (isIgnored(filePath, key)) continue

    const spelling = issue.kind === 'spelling'
    const actions: Action[] = issue.suggestions.map(replacement => ({
      name: replacement || 'Remove',
      apply: (view, from, to) => {
        view.dispatch({
          changes: { from, to, insert: replacement },
          userEvent: 'input.complete',
        })
      },
    }))
    actions.push({
      name: 'Ignore',
      apply: view => handlers.onIgnore(view, key),
    })
    if (spelling && !/\s/.test(issue.problem)) {
      actions.push({
        name: 'Add to dictionary',
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
