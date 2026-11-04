import { DEFAULT_THEME } from './builtin'
import { THEME_TOKENS } from './tokens'
import type { Scheme, Theme, ThemeTokenValue } from './types'

function pick(
  value: ThemeTokenValue | undefined,
  scheme: Scheme
): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value[scheme]
}

/**
 * Every token's value in one mode. A token the theme leaves out (or doesn't
 * give for this mode) takes the Default theme's value.
 */
export function resolveTokens(
  theme: Theme,
  scheme: Scheme
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const token of THEME_TOKENS) {
    resolved[token] =
      pick(theme.tokens[token], scheme) ??
      (pick(DEFAULT_THEME.tokens[token], scheme) as string)
  }
  return resolved
}

const rule = (selector: string, tokens: Record<string, string>) =>
  `${selector} {\n${Object.entries(tokens)
    .map(([token, value]) => `  --${token}: ${value};`)
    .join('\n')}\n}`

/**
 * The CSS for the chosen themes: one rule per mode, setting every token on
 * <html>, where the theme provider puts .light or .dark. The doubled :root
 * beats App.css's :root wherever the stylesheets load.
 */
export function themesToCss(lightTheme: Theme, darkTheme: Theme): string {
  return [
    rule(':root:root.light', resolveTokens(lightTheme, 'light')),
    rule(':root:root.dark', resolveTokens(darkTheme, 'dark')),
  ].join('\n')
}
