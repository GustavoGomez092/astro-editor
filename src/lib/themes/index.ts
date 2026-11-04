import { BUILTIN_THEMES, DEFAULT_THEME } from './builtin'
import { themesToRules, type ThemeRule } from './css'
import { isSafeValue } from './safe'
import type { Scheme, Theme, ThemeFile } from './types'

export { DEFAULT_THEME_ID } from './builtin'
export { themesToRules } from './css'
export type { ThemeRule } from './css'
export type { Scheme, Theme, ThemeFile } from './types'

/** Built-in themes, then the usable ones from the themes folder */
export function availableThemes(files: ThemeFile[]): Theme[] {
  return [
    ...BUILTIN_THEMES,
    ...files.flatMap(file => (file.ok ? [file.theme] : [])),
  ]
}

/** The themes that can be picked for a mode */
export function themesForScheme(themes: Theme[], scheme: Scheme): Theme[] {
  return themes.filter(t => t.appearance === 'both' || t.appearance === scheme)
}

/** The chosen theme, or Default if it's gone or doesn't suit the mode */
export function pickTheme(
  themes: Theme[],
  id: string | undefined,
  scheme: Scheme
): Theme {
  const found = themesForScheme(themes, scheme).find(t => t.id === id)
  return found ?? DEFAULT_THEME
}

/** The rules for the two chosen theme ids */
export function tokensForChoice(
  files: ThemeFile[],
  lightId: string | undefined,
  darkId: string | undefined
): [ThemeRule, ThemeRule] {
  const themes = availableThemes(files)
  return themesToRules(
    pickTheme(themes, lightId, 'light'),
    pickTheme(themes, darkId, 'dark')
  )
}

export const THEME_STYLE_ID = 'astro-editor-colour-theme'
const CHOICE_KEY = 'astro-editor-theme-choice'

/**
 * Puts the theme colours on the page. Each token goes in with setProperty on a
 * rule the browser has already parsed, so a value is only ever a value: it
 * can't close the rule, start another or load anything.
 */
export function applyThemeTokens(rules: ThemeRule[]) {
  let el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = THEME_STYLE_ID
    document.head.appendChild(el)
  }
  const sheet = el.sheet
  if (!sheet) return
  while (sheet.cssRules.length) sheet.deleteRule(0)
  for (const { selector, tokens } of rules) {
    const rule =
      sheet.cssRules[sheet.insertRule(`${selector} {}`, sheet.cssRules.length)]
    if (!(rule instanceof CSSStyleRule)) continue
    for (const [token, value] of Object.entries(tokens)) {
      // Checked again here: a value that isn't plainly a colour is skipped
      if (/^[a-z0-9-]+$/.test(token) && isSafeValue(value)) {
        rule.style.setProperty(`--${token}`, value)
      }
    }
  }
}

/** Applies the chosen themes, and remembers the choice for the next launch's first paint */
export function applyThemeChoice(
  files: ThemeFile[],
  lightId: string | undefined,
  darkId: string | undefined
) {
  applyThemeTokens(tokensForChoice(files, lightId, darkId))
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify([lightId, darkId]))
  } catch {
    // Private mode or full storage: the theme still applies, just not before first paint
  }
}

/**
 * Applies the last choice straight away, before settings load, so there's no
 * flash of the Default colours. Only theme ids are remembered, never CSS: the
 * colours come from the built-in themes (or wait for the themes folder to be
 * read, then are validated like any other theme file).
 */
export function applyRememberedThemeChoice() {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null')
    if (!Array.isArray(raw)) return
    const [light, dark] = raw as unknown[]
    const id = (v: unknown) => (typeof v === 'string' ? v : undefined)
    applyThemeTokens(tokensForChoice([], id(light), id(dark)))
  } catch {
    // Nothing remembered, or storage is unavailable
  }
}
