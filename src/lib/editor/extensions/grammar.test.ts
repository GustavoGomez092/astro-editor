import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { commands, type GrammarIssue } from '@/lib/bindings'
import { useEditorStore } from '@/store/editorStore'
import { useProjectStore } from '@/store/projectStore'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/project-registry/defaults'
import {
  GRAMMAR_MAX_CHARACTERS,
  createGrammarExtension,
  grammarLintSource,
} from './grammar'

vi.mock('@/lib/bindings', () => ({ commands: { checkGrammar: vi.fn() } }))

const teh: GrammarIssue = {
  from: 8,
  to: 11,
  rule: 'SpellCheck',
  kind: 'spelling',
  problem: 'teh',
  message: 'Did you mean to spell `teh` this way?',
  suggestions: ['the'],
}

let view: EditorView | null = null

function setup(doc: string) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: createGrammarExtension() }),
  })
  return view
}

const setGrammar = (grammar: object) =>
  useProjectStore.setState({
    globalSettings: { ...DEFAULT_GLOBAL_SETTINGS, grammar },
  })

beforeEach(() => {
  vi.mocked(commands.checkGrammar).mockReset()
  setGrammar({})
  useEditorStore.setState({
    currentFile: {
      id: 'a',
      path: '/site/a.md',
      name: 'a',
      extension: 'md',
      collection: 'posts',
      last_modified: null,
      frontmatter: null,
    },
  })
})

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('grammarLintSource', () => {
  test('maps the issues it gets back', async () => {
    vi.mocked(commands.checkGrammar).mockResolvedValue({
      status: 'ok',
      data: [teh],
    })
    const diagnostics = await grammarLintSource(setup('This is teh test.'))
    expect(diagnostics.map(d => [d.from, d.to])).toEqual([[8, 11]])
  })

  test('skips a very long file and says so quietly', async () => {
    const v = setup('word '.repeat(GRAMMAR_MAX_CHARACTERS / 5 + 1))
    expect(await grammarLintSource(v)).toEqual([])
    expect(commands.checkGrammar).not.toHaveBeenCalled()
    expect(v.dom.querySelector('.cm-grammar-note')?.textContent).toMatch(
      /too long/i
    )
  })

  test('the note goes once the file is short enough', async () => {
    const v = setup('word '.repeat(GRAMMAR_MAX_CHARACTERS / 5 + 1))
    await grammarLintSource(v)
    vi.mocked(commands.checkGrammar).mockResolvedValue({
      status: 'ok',
      data: [],
    })
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'Hi.' } })
    await grammarLintSource(v)
    expect(v.dom.querySelector('.cm-grammar-note')).toBeNull()
  })

  test('shows nothing if checking was switched off while it ran', async () => {
    vi.mocked(commands.checkGrammar).mockImplementation(() => {
      setGrammar({ enabled: false })
      return Promise.resolve({ status: 'ok', data: [teh] })
    })
    expect(await grammarLintSource(setup('This is teh test.'))).toEqual([])
  })

  test('drops a word added to the dictionary while it ran', async () => {
    vi.mocked(commands.checkGrammar).mockImplementation(() => {
      setGrammar({ dictionary: ['teh'] })
      return Promise.resolve({ status: 'ok', data: [teh] })
    })
    expect(await grammarLintSource(setup('This is teh test.'))).toEqual([])
  })
})
