import { describe, it, expect } from 'vitest'
import { BUILTIN_THEMES, DEFAULT_THEME } from './builtin'
import { THEME_TOKENS } from './tokens'
import { validateTheme } from './validate'
import { resolveTokens, themesToCss } from './css'
import { availableThemes, cssForChoice, pickTheme } from './index'
import type { Theme, ThemeFile } from './types'

const minimal = {
  id: 'mine',
  name: 'Mine',
  appearance: 'both',
  tokens: { background: '#112233' },
}

describe('validateTheme', () => {
  it('accepts a partial theme', () => {
    const result = validateTheme(minimal)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.theme.author).toBe('')
      expect(result.warnings).toEqual([])
    }
  })

  it('accepts a colour for each mode and every colour notation', () => {
    const result = validateTheme({
      ...minimal,
      tokens: {
        background: { light: '#fff', dark: 'oklch(0.2 0 0)' },
        foreground: 'hsl(0 0% 90%)',
        card: 'rgb(0 0 0 / 50%)',
        border: '#11223344',
        required: 'var(--filter)',
      },
    })
    expect(result.ok).toBe(true)
  })

  it('reports tokens it does not have, and still loads the theme', () => {
    const result = validateTheme({
      ...minimal,
      tokens: { background: '#112233', 'not-a-token': '#fff' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('not-a-token')
      expect(result.theme.tokens).not.toHaveProperty('not-a-token')
    }
  })

  it.each([
    ['not an object', 'hello', 'JSON object'],
    ['no id', { ...minimal, id: undefined }, '"id"'],
    ['bad id', { ...minimal, id: 'My Theme' }, '"id"'],
    ['no name', { ...minimal, name: '' }, '"name"'],
    ['bad appearance', { ...minimal, appearance: 'blue' }, '"appearance"'],
    ['no tokens', { ...minimal, tokens: undefined }, '"tokens"'],
    [
      'bad colour',
      { ...minimal, tokens: { background: 'not a colour!' } },
      '"background"',
    ],
    [
      'unclosed bracket',
      { ...minimal, tokens: { background: 'rgb(0 0 0' } },
      '"background"',
    ],
    [
      'bad mode key',
      { ...minimal, tokens: { background: { night: '#000' } } },
      '"night"',
    ],
    [
      'bad dark colour',
      { ...minimal, tokens: { background: { dark: 12 } } },
      '"background" dark',
    ],
  ])('rejects %s', (_label, input, message) => {
    const result = validateTheme(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain(message)
  })
})

describe('resolveTokens (fallback to Default)', () => {
  const partial: Theme = {
    id: 'p',
    name: 'P',
    author: '',
    appearance: 'both',
    tokens: { background: '#112233', foreground: { dark: '#eeeeee' } },
  }

  it('covers every token', () => {
    expect(Object.keys(resolveTokens(partial, 'light'))).toEqual([
      ...THEME_TOKENS,
    ])
  })

  it('uses the theme where it has a value', () => {
    expect(resolveTokens(partial, 'light').background).toBe('#112233')
    expect(resolveTokens(partial, 'dark').foreground).toBe('#eeeeee')
  })

  it('uses Default where the theme has none, or none for that mode', () => {
    const light = resolveTokens(partial, 'light')
    expect(light.card).toBe(
      (DEFAULT_THEME.tokens.card as { light: string }).light
    )
    expect(light.foreground).toBe(
      (DEFAULT_THEME.tokens.foreground as { light: string }).light
    )
  })
})

describe('themesToCss', () => {
  const css = themesToCss(
    BUILTIN_THEMES[1] as Theme,
    BUILTIN_THEMES[2] as Theme
  )

  it('writes a light and a dark rule that beat App.css', () => {
    expect(css).toContain(':root:root.light {')
    expect(css).toContain(':root:root.dark {')
  })

  it('takes light values from the light theme and dark values from the dark theme', () => {
    const [light, dark] = css.split(':root:root.dark')
    expect(light).toContain('--background: #e6e9ef;') // Catppuccin Latte
    expect(dark).toContain('--background: #292e39;') // Nord dark
    expect(dark).not.toContain('#e6e9ef')
  })

  it('sets every token in both rules, as custom properties', () => {
    for (const token of THEME_TOKENS) {
      expect(css.split(`--${token}:`).length - 1).toBe(2)
    }
  })

  it('writes Default as the values App.css already has', () => {
    expect(themesToCss(DEFAULT_THEME, DEFAULT_THEME)).toContain(
      '--active: var(--filter);'
    )
  })
})

describe('choosing themes', () => {
  const custom: ThemeFile[] = [
    {
      file: 'a.json',
      ok: true,
      warnings: [],
      theme: { ...minimal, author: '', appearance: 'dark' },
    },
    { file: 'b.json', ok: false, errors: ['bad'] },
  ]

  it('lists built-ins, then working custom themes only', () => {
    expect(availableThemes(custom).map(t => t.id)).toEqual([
      'default',
      'catppuccin',
      'nord',
      'mine',
    ])
  })

  it('falls back to Default for an unknown id or a theme for the other mode', () => {
    const themes = availableThemes(custom)
    expect(pickTheme(themes, 'gone', 'light').id).toBe('default')
    expect(pickTheme(themes, 'mine', 'light').id).toBe('default')
    expect(pickTheme(themes, 'mine', 'dark').id).toBe('mine')
    expect(pickTheme(themes, undefined, 'dark').id).toBe('default')
  })

  it('builds CSS for a choice', () => {
    expect(cssForChoice(custom, 'nord', 'mine')).toContain(
      '--background: #112233;'
    )
  })
})
