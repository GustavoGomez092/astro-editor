import { describe, test, expect, beforeEach } from 'vitest'
import type { GrammarIssue } from '@/lib/bindings'
import {
  clearIgnoredIssues,
  ignoreIssue,
  ignoreKey,
  isIgnored,
} from './ignored'

const issueAt = (doc: string, word: string, nth = 0): GrammarIssue => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = doc.indexOf(word, from + 1)
  return {
    from,
    to: from + word.length,
    rule: 'SpellCheck',
    kind: 'spelling',
    problem: word,
    message: '',
    suggestions: [],
  }
}

describe('ignoreKey', () => {
  test('stays the same when text elsewhere changes', () => {
    const before = 'First line.\nI saw teh dog.\nLast line.'
    const after = 'A new first paragraph.\n\nI saw teh dog.\nLast line changed.'
    expect(ignoreKey(before, issueAt(before, 'teh'))).toBe(
      ignoreKey(after, issueAt(after, 'teh'))
    )
  })

  test('differs for the same word in another sentence', () => {
    const doc = 'I saw teh dog.\nThen teh cat ran.'
    expect(ignoreKey(doc, issueAt(doc, 'teh', 0))).not.toBe(
      ignoreKey(doc, issueAt(doc, 'teh', 1))
    )
  })
})

describe('ignored issues', () => {
  beforeEach(() => clearIgnoredIssues())

  test('are remembered per file', () => {
    ignoreIssue('/a.md', 'key')
    expect(isIgnored('/a.md', 'key')).toBe(true)
    expect(isIgnored('/b.md', 'key')).toBe(false)
  })
})
