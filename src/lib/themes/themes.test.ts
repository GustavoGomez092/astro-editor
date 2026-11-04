import { describe, it, expect } from 'vitest'
import { BUILTIN_THEMES, DEFAULT_THEME } from './builtin'
import { THEME_TOKENS } from './tokens'
import { isSafeValue } from './safe'
import { validateTheme } from './validate'
import { resolveTokens, themesToRules } from './css'
import {
  applyThemeTokens,
  availableThemes,
  pickTheme,
  tokensForChoice,
  THEME_STYLE_ID,
} from './index'
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

describe('validateTheme: values that could break out of a colour', () => {
  const withValue = (
    background: unknown,
    extra: Record<string, unknown> = {}
  ) => validateTheme({ ...minimal, tokens: { background, ...extra } })
  const evil =
    'rgb(0 0 0); } body { background: url(https://evil.example/t.gif) } x:not(y'

  it.each([
    ['the reported payload', evil],
    [
      'a var() that closes the rule',
      'var(--a); } body { display: none } x:not(y',
    ],
    [
      'a var() with a url fallback',
      'var(--x, url(https://evil.example/a.gif))',
    ],
    ['a semicolon', 'rgb(0 0 0);'],
    ['a brace', 'rgb(0 0 0) }'],
    ['an angle bracket', '</style><script>'],
    ['a backslash escape', 'rg\\62 (0 0 0)'],
    ['a comment', 'rgb(0 0 0) /* x */'],
    ['an at-rule', '@import "x"'],
    ['url()', 'url(https://evil.example/a.gif)'],
    ['image()', 'image(red)'],
    ['image-set()', 'image-set("a.png" 1x)'],
    ['a function that is not a colour', 'calc(1px + 2px)'],
    ['a function hidden in colour-mix', 'color-mix(in srgb, url(a), red)'],
  ])('rejects %s', (_label, value) => {
    expect(withValue(value).ok).toBe(false)
    expect(withValue({ light: '#fff', dark: value }).ok).toBe(false)
  })

  it.each([
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    'currentcolor',
    'currentColor',
    'INHERIT',
  ])('rejects the keyword %s', value => {
    expect(withValue(value).ok).toBe(false)
  })

  it('keeps colours that use a slash, a percentage and colour-mix', () => {
    expect(withValue('rgb(0 0 0 / 50%)').ok).toBe(true)
    expect(withValue('color-mix(in oklab, #fff 20%, red)').ok).toBe(true)
    expect(withValue('transparent').ok).toBe(true)
  })

  describe('var()', () => {
    it('allows pointing at another token', () => {
      expect(withValue('var(--filter)').ok).toBe(true)
    })
    it.each([
      ['an unknown token', 'var(--nope)'],
      ['a fallback', 'var(--filter, red)'],
      ['itself', 'var(--background)'],
      ['a custom property of the page', 'var(--heading-color-light)'],
      ['more than a bare var()', 'var(--filter) red'],
    ])('rejects %s', (_label, value) => {
      expect(withValue(value).ok).toBe(false)
    })
    it('rejects a loop between two tokens', () => {
      const result = withValue('var(--card)', { card: 'var(--background)' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join(' ')).toContain('loop')
    })
    it('rejects a loop that runs through the Default theme', () => {
      // Default has active: var(--filter)
      const result = validateTheme({
        ...minimal,
        tokens: { filter: 'var(--active)' },
      })
      expect(result.ok).toBe(false)
    })
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

describe('themesToRules', () => {
  const rules = themesToRules(
    BUILTIN_THEMES[1] as Theme,
    BUILTIN_THEMES[2] as Theme
  )
  const [light, dark] = rules

  it('makes a light and a dark rule that beat App.css', () => {
    expect(light.selector).toBe(':root:root.light')
    expect(dark.selector).toBe(':root:root.dark')
  })

  it('takes light values from the light theme and dark values from the dark theme', () => {
    expect(light.tokens.background).toBe('#e6e9ef') // Catppuccin Latte
    expect(dark.tokens.background).toBe('#292e39') // Nord dark
  })

  it('sets every token in both rules', () => {
    expect(Object.keys(light.tokens)).toEqual([...THEME_TOKENS])
    expect(Object.keys(dark.tokens)).toEqual([...THEME_TOKENS])
  })

  it('writes Default as the values App.css already has', () => {
    const [l] = themesToRules(DEFAULT_THEME, DEFAULT_THEME)
    expect(l?.tokens.active).toBe('var(--filter)')
  })
})

describe('applyThemeTokens', () => {
  const sheetRules = () => {
    const el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement
    return Array.from(el.sheet?.cssRules ?? []) as CSSStyleRule[]
  }

  it('puts the colours in two rules and replaces them on the next call', () => {
    applyThemeTokens(tokensForChoice([], 'nord', 'nord'))
    applyThemeTokens(tokensForChoice([], 'catppuccin', 'default'))
    const rules = sheetRules()
    expect(rules.map(r => r.selectorText)).toEqual([
      ':root:root.light',
      ':root:root.dark',
    ])
    expect(rules[0]?.style.getPropertyValue('--background')).toBe('#e6e9ef')
  })

  it('can never make a rule of its own, whatever a value holds', () => {
    const evil =
      'rgb(0 0 0); } body { background: url(https://evil.example/t.gif) } x:not(y'
    const [light, dark] = themesToRules(DEFAULT_THEME, DEFAULT_THEME)
    applyThemeTokens([
      { ...light, tokens: { ...light.tokens, background: evil } },
      dark,
    ])
    const rules = sheetRules()
    expect(rules).toHaveLength(2)
    expect(rules.every(r => r.selectorText.startsWith(':root:root'))).toBe(true)
    // ...and the value that isn't plainly a colour never reaches the page
    expect(rules[0]?.style.getPropertyValue('--background')).toBe('')
    expect(rules[0]?.style.getPropertyValue('--foreground')).not.toBe('')
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

  it('builds the rules for a choice', () => {
    expect(tokensForChoice(custom, 'nord', 'mine')[1].tokens.background).toBe(
      '#112233'
    )
  })
})

describe('built-in themes pass the safety check applied before values reach the page', () => {
  it.each(BUILTIN_THEMES.map(t => [t.id, t] as const))('%s', (_id, theme) => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [token, value] of Object.entries(
        resolveTokens(theme, scheme)
      )) {
        expect(isSafeValue(value), `${token}: ${value}`).toBe(true)
      }
    }
  })
})
