import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildDefaultTheme,
  buildThemeSchema,
  parseCssTokens,
} from './theme-tools'
import { BUILTIN_THEMES } from '../src/lib/themes/builtin'
import { resolveTokens } from '../src/lib/themes/css'
import type { Scheme, Theme } from '../src/lib/themes/types'

const read = (path: string) => readFileSync(path, 'utf8')
const css = read('src/App.css')

describe('generated theme files', () => {
  it('parses light-dark() pairs, single values and var() references', () => {
    const tokens = parseCssTokens(`:root {
      --a: light-dark(oklch(1 0 0), oklch(0 0 0));
      --b: oklch(0.5 0 0 / 0.5); /* note */
      --c: light-dark(var(--x, var(--y)), var(--z));
      --radius: 0.5rem;
      --traffic-light-close: red;
    }`)
    expect(tokens).toEqual({
      a: { light: 'oklch(1 0 0)', dark: 'oklch(0 0 0)' },
      b: 'oklch(0.5 0 0 / 0.5)',
      c: { light: 'var(--x, var(--y))', dark: 'var(--z)' },
    })
  })

  it('keeps default.json in step with App.css (run: bun scripts/generate-themes.ts)', () => {
    expect(JSON.parse(read('src/lib/themes/builtin/default.json'))).toEqual(
      buildDefaultTheme(css)
    )
  })

  it('keeps theme.schema.json in step with the tokens', () => {
    const names = Object.keys(parseCssTokens(css))
    expect(JSON.parse(read('src/lib/themes/theme.schema.json'))).toEqual(
      buildThemeSchema(names)
    )
  })

  it('only sets tokens that exist, in every built-in theme', () => {
    const names = new Set(Object.keys(parseCssTokens(css)))
    for (const theme of BUILTIN_THEMES) {
      for (const token of Object.keys(theme.tokens)) {
        expect(names.has(token), `${theme.id}: ${token}`).toBe(true)
      }
    }
  })
})

// WCAG 2.x contrast for #rrggbb colours (the published palettes are hex)
function channel(v: number) {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string) {
  const n = parseInt(hex.slice(1, 7), 16)
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  )
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

// Text on the surface it sits on: body text needs 4.5:1 (WCAG AA)
const TEXT_ON_SURFACE: [string, string, number][] = [
  ['editor-color-text', 'editor-color-background', 4.5],
  ['foreground', 'background', 4.5],
  ['foreground', 'card', 4.5],
  ['foreground', 'secondary', 4.5],
  ['foreground', 'accent', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['heading', 'background', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['draft', 'draft-bg', 4.5],
  ['filter', 'filter-bg', 4.5],
  ['git-add', 'git-add-bg', 4.5],
  ['git-del', 'git-del-bg', 4.5],
  ['required', 'card', 4.5],
  ['editor-color-red', 'editor-color-background', 4.5],
  ['editor-color-blue', 'editor-color-background', 4.5],
  ['editor-color-green', 'editor-color-background', 4.5],
  ['editor-color-brown', 'editor-color-background', 4.5],
  ['editor-color-pink', 'editor-color-background', 4.5],
  // Markdown marks are meant to be quiet, but still readable
  ['editor-color-mdtag', 'editor-color-background', 2],
]

describe.each(BUILTIN_THEMES.filter(t => t.id !== 'default'))(
  'contrast: $name',
  (theme: Theme) => {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      it(`${scheme} text meets WCAG AA`, () => {
        const c = resolveTokens(theme, scheme)
        const failures = TEXT_ON_SURFACE.flatMap(([fg, bg, min]) => {
          const ratio = contrast(c[fg] as string, c[bg] as string)
          return ratio < min
            ? [`${fg} on ${bg}: ${ratio.toFixed(2)} (needs ${min})`]
            : []
        })
        expect(failures).toEqual([])
      })
    }
  }
)
