import { describe, test, expect, beforeEach, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { GrammarIssue } from '@/lib/bindings'
import { issuesToDiagnostics, plainMessage } from './diagnostics'
import { clearIgnoredIssues, ignoreIssue, ignoreKey } from './ignored'

const DOC = 'This is teh test and an apple.'

const spelling: GrammarIssue = {
  from: 8,
  to: 11,
  rule: 'SpellCheck',
  kind: 'spelling',
  problem: 'teh',
  message: 'Did you mean to spell `teh` this way?',
  suggestions: ['the', 'tea'],
}

const grammar: GrammarIssue = {
  from: 21,
  to: 23,
  rule: 'AnA',
  kind: 'grammar',
  problem: 'an',
  message: 'Incorrect indefinite article.',
  suggestions: ['a', ''],
}

const handlers = () => ({ onIgnore: vi.fn(), onAddWord: vi.fn() })

describe('plainMessage', () => {
  test('turns code quotes into curly quotes', () => {
    expect(plainMessage('Did you mean to spell `teh` this way?')).toBe(
      'Did you mean to spell “teh” this way?'
    )
  })
})

describe('issuesToDiagnostics', () => {
  beforeEach(() => clearIgnoredIssues())

  test('maps ranges, classes and plain messages', () => {
    const [d] = issuesToDiagnostics(DOC, [spelling], '/a.md', handlers())
    expect(d).toMatchObject({
      from: 8,
      to: 11,
      severity: 'warning',
      markClass: 'cm-grammar-spelling',
      message: 'Did you mean to spell “teh” this way?',
    })
    const [g] = issuesToDiagnostics(DOC, [grammar], '/a.md', handlers())
    expect(g).toMatchObject({
      severity: 'info',
      markClass: 'cm-grammar-grammar',
    })
  })

  test('offers suggestions, then Ignore, then Add to dictionary for spelling', () => {
    const [d] = issuesToDiagnostics(DOC, [spelling], '/a.md', handlers())
    expect(d?.actions?.map(a => a.name)).toEqual([
      'the',
      'tea',
      'Ignore',
      'Add to dictionary',
    ])
  })

  test('labels an empty suggestion Remove and offers no dictionary for grammar', () => {
    const [g] = issuesToDiagnostics(DOC, [grammar], '/a.md', handlers())
    expect(g?.actions?.map(a => a.name)).toEqual(['a', 'Remove', 'Ignore'])
  })

  test('drops ignored issues for that file only', () => {
    ignoreIssue('/a.md', ignoreKey(DOC, spelling))
    expect(issuesToDiagnostics(DOC, [spelling], '/a.md', handlers())).toEqual(
      []
    )
    expect(
      issuesToDiagnostics(DOC, [spelling], '/b.md', handlers())
    ).toHaveLength(1)
  })

  test('drops issues outside the document', () => {
    const stale = { ...spelling, from: 40, to: 44 }
    expect(issuesToDiagnostics(DOC, [stale], '/a.md', handlers())).toEqual([])
  })

  test('applying a suggestion replaces the range', () => {
    const view = new EditorView({ state: EditorState.create({ doc: DOC }) })
    const [d] = issuesToDiagnostics(DOC, [spelling], '/a.md', handlers())
    d?.actions?.[0]?.apply(view, d.from, d.to)
    expect(view.state.doc.toString()).toBe('This is the test and an apple.')
    view.destroy()
  })

  test('Ignore and Add to dictionary call their handlers', () => {
    const h = handlers()
    const view = new EditorView({ state: EditorState.create({ doc: DOC }) })
    const [d] = issuesToDiagnostics(DOC, [spelling], '/a.md', h)
    d?.actions?.[2]?.apply(view, d.from, d.to)
    d?.actions?.[3]?.apply(view, d.from, d.to)
    expect(h.onIgnore).toHaveBeenCalledWith(view, ignoreKey(DOC, spelling))
    expect(h.onAddWord).toHaveBeenCalledWith(view, 'teh')
    view.destroy()
  })
})
