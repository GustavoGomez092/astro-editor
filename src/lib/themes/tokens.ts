import { DEFAULT_THEME } from './builtin'

/** Every colour a theme can set. The Default theme (built from App.css) is the list */
export const THEME_TOKENS: readonly string[] = Object.keys(DEFAULT_THEME.tokens)

const TOKEN_SET = new Set(THEME_TOKENS)
export const isThemeToken = (name: string) => TOKEN_SET.has(name)
