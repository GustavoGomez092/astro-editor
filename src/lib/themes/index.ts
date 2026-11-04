import { BUILTIN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from './builtin'
import { themesToCss } from './css'
import type { Scheme, Theme, ThemeFile } from './types'

export { DEFAULT_THEME_ID } from './builtin'
export { themesToCss } from './css'
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

/** CSS for the two chosen theme ids */
export function cssForChoice(
  files: ThemeFile[],
  lightId: string | undefined,
  darkId: string | undefined
): string {
  const themes = availableThemes(files)
  return themesToCss(
    pickTheme(themes, lightId, 'light'),
    pickTheme(themes, darkId, 'dark')
  )
}

export const THEME_STYLE_ID = 'astro-editor-colour-theme'
const CACHE_KEY = 'astro-editor-theme-css'

/** Puts the theme CSS on the page, and keeps a copy for the next launch's first paint */
export function applyThemeCss(css: string) {
  let el = document.getElementById(THEME_STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = THEME_STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = css
  try {
    // Nothing to remember for the Default theme: App.css already is it
    if (css === cssForChoice([], DEFAULT_THEME_ID, DEFAULT_THEME_ID)) {
      localStorage.removeItem(CACHE_KEY)
    } else {
      localStorage.setItem(CACHE_KEY, css)
    }
  } catch {
    // Private mode or full storage: the theme still applies, just not before first paint
  }
}

/** Applies the last theme straight away, before settings load, so there's no flash of the Default colours */
export function applyCachedThemeCss() {
  try {
    const css = localStorage.getItem(CACHE_KEY)
    if (css) applyThemeCss(css)
  } catch {
    // See above
  }
}
