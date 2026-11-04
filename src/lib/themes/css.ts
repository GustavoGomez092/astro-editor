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

export interface ThemeRule {
  selector: string
  tokens: Record<string, string>
}

/**
 * The rules for the chosen themes: one per mode, setting every token on
 * <html>, where the theme provider puts .light or .dark. The doubled :root
 * beats App.css's :root wherever the stylesheets load. These are data, not
 * CSS text: they're handed to the browser one property at a time
 * (applyThemeTokens), so no value can ever add a rule of its own.
 */
export function themesToRules(
  lightTheme: Theme,
  darkTheme: Theme
): [ThemeRule, ThemeRule] {
  return [
    {
      selector: ':root:root.light',
      tokens: resolveTokens(lightTheme, 'light'),
    },
    { selector: ':root:root.dark', tokens: resolveTokens(darkTheme, 'dark') },
  ]
}
