/**
 * Spelling and grammar settings: on/off, the English dialect and the personal
 * dictionary. They live in global settings (`grammar`), in the app's data
 * folder, never in the user's project.
 */

import type { GrammarDialect } from '@/lib/bindings'
import type { GlobalSettings, GrammarSettings } from '../project-registry/types'

export const GRAMMAR_DIALECTS: { value: GrammarDialect; label: string }[] = [
  { value: 'american', label: 'American English' },
  { value: 'british', label: 'British English' },
  { value: 'canadian', label: 'Canadian English' },
  { value: 'australian', label: 'Australian English' },
  { value: 'indian', label: 'Indian English' },
]

/**
 * The grammar settings with defaults filled in: on, American, no words. The
 * file can be edited by hand, so each field is checked on its own: a damaged
 * field falls back to its default without switching checking off
 */
export function resolveGrammarSettings(
  global: GlobalSettings | null | undefined
): Required<GrammarSettings> {
  const stored: unknown = global?.grammar
  const grammar =
    stored && typeof stored === 'object'
      ? (stored as Record<string, unknown>)
      : {}
  const { enabled, dialect, dictionary } = grammar
  return {
    enabled: typeof enabled === 'boolean' ? enabled : true,
    dialect: GRAMMAR_DIALECTS.some(d => d.value === dialect)
      ? (dialect as GrammarDialect)
      : 'american',
    dictionary: Array.isArray(dictionary)
      ? dictionary.filter((w): w is string => typeof w === 'string')
      : [],
  }
}

/** The dictionary with `word` added (trimmed, once whatever its case), sorted */
export function addWord(words: string[], word: string): string[] {
  const trimmed = word.trim()
  const folded = trimmed.toLowerCase()
  if (!trimmed || words.some(w => w.toLowerCase() === folded)) return words
  return [...words, trimmed].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )
}

/** The dictionary without `word` */
export function removeWord(words: string[], word: string): string[] {
  return words.filter(w => w !== word)
}
