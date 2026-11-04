/**
 * Issues the writer chose to ignore, one at a time. They're remembered per
 * file until the app quits, by a key built from the rule, the flagged text and
 * the words around it, so the same issue stays ignored while the writer edits
 * elsewhere, and the same word in another sentence is still checked.
 */

import type { GrammarIssue } from '@/lib/bindings'

/** How much text either side of an issue (on its line) identifies it */
const CONTEXT_CHARS = 20

const ignoredByFile = new Map<string, Set<string>>()

export function ignoreKey(doc: string, issue: GrammarIssue): string {
  const lineStart = doc.lastIndexOf('\n', issue.from - 1) + 1
  const newline = doc.indexOf('\n', issue.to)
  const lineEnd = newline === -1 ? doc.length : newline
  const before = doc.slice(
    Math.max(lineStart, issue.from - CONTEXT_CHARS),
    issue.from
  )
  const after = doc.slice(issue.to, Math.min(lineEnd, issue.to + CONTEXT_CHARS))
  return [issue.rule, issue.problem, before, after].join('\u0000')
}

export function ignoreIssue(filePath: string, key: string) {
  let keys = ignoredByFile.get(filePath)
  if (!keys) {
    keys = new Set()
    ignoredByFile.set(filePath, keys)
  }
  keys.add(key)
}

export function isIgnored(filePath: string, key: string): boolean {
  return ignoredByFile.get(filePath)?.has(key) ?? false
}

/** For tests */
export function clearIgnoredIssues() {
  ignoredByFile.clear()
}
