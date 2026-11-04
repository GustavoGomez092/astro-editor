import { describe, test, expect } from 'vitest'
import type { GlobalSettings } from '../project-registry/types'
import {
  GRAMMAR_DIALECTS,
  addWord,
  removeWord,
  resolveGrammarSettings,
} from './settings'

describe('resolveGrammarSettings', () => {
  test('is on, American and empty when nothing is set', () => {
    expect(resolveGrammarSettings(null)).toEqual({
      enabled: true,
      dialect: 'american',
      dictionary: [],
    })
  })

  test('keeps what is set and fills the rest', () => {
    const global = {
      grammar: { enabled: false, dictionary: ['Kevin'] },
    } as unknown as GlobalSettings
    expect(resolveGrammarSettings(global)).toEqual({
      enabled: false,
      dialect: 'american',
      dictionary: ['Kevin'],
    })
  })
})

describe('resolveGrammarSettings with a damaged file', () => {
  test('falls back field by field, without switching checking off', () => {
    const global = {
      grammar: { enabled: 'yes', dialect: 'klingon', dictionary: 'Kevin' },
    } as unknown as GlobalSettings
    expect(resolveGrammarSettings(global)).toEqual({
      enabled: true,
      dialect: 'american',
      dictionary: [],
    })
  })

  test('keeps only the text entries of a dictionary', () => {
    const global = {
      grammar: { dictionary: ['Kevin', 3, null, 'Astro'] },
    } as unknown as GlobalSettings
    expect(resolveGrammarSettings(global).dictionary).toEqual([
      'Kevin',
      'Astro',
    ])
  })

  test('ignores a grammar value that is not an object', () => {
    const global = { grammar: 'off' } as unknown as GlobalSettings
    expect(resolveGrammarSettings(global).enabled).toBe(true)
  })
})

describe('GRAMMAR_DIALECTS', () => {
  test('lists the five dialects, American first', () => {
    expect(GRAMMAR_DIALECTS.map(d => d.value)).toEqual([
      'american',
      'british',
      'canadian',
      'australian',
      'indian',
    ])
    expect(GRAMMAR_DIALECTS[1]?.label).toBe('British English')
  })
})

describe('addWord', () => {
  test('adds a trimmed word and sorts the list', () => {
    expect(addWord(['zebra'], '  Astro ')).toEqual(['Astro', 'zebra'])
  })

  test('ignores a word already there in another case', () => {
    expect(addWord(['Astro'], 'astro')).toEqual(['Astro'])
  })

  test('ignores an empty word', () => {
    expect(addWord(['Astro'], '   ')).toEqual(['Astro'])
  })
})

describe('removeWord', () => {
  test('removes exactly that word', () => {
    expect(removeWord(['Astro', 'Kevin'], 'Astro')).toEqual(['Kevin'])
  })
})
