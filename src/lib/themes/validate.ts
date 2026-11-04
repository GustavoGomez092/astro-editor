import { isThemeToken } from './tokens'
import type { Theme, ThemeAppearance, ThemeTokenValue } from './types'

export type ValidationResult =
  | { ok: true; theme: Theme; warnings: string[] }
  | { ok: false; errors: string[] }

const APPEARANCES: ThemeAppearance[] = ['light', 'dark', 'both']
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether a string looks like a CSS colour. Loose on purpose: the webview has
 * the final say, and a value it rejects is just ignored. This catches typos
 * (a missing # or bracket) with a message the writer can act on.
 */
export function looksLikeColour(value: string): boolean {
  const v = value.trim()
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true
  if (/^[a-z]+$/i.test(v)) {
    // A colour name. The browser knows the full list; elsewhere accept any word
    return typeof CSS === 'undefined' || !CSS.supports
      ? true
      : CSS.supports('color', v)
  }
  const fn = /^([a-z-]+)\((.*)\)$/is.exec(v)
  if (!fn) return false
  if (
    !/^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|var)$/i.test(
      fn[1] as string
    )
  )
    return false
  let depth = 0
  for (const char of v) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (depth < 0) return false
  }
  return depth === 0
}

function checkColour(value: unknown, label: string, errors: string[]) {
  if (typeof value !== 'string' || !looksLikeColour(value)) {
    errors.push(
      `${label} is not a colour${typeof value === 'string' ? ` ("${value}")` : ''}. Use something like "#1e1e2e" or "oklch(0.2 0 0)".`
    )
  }
}

/**
 * Checks a parsed theme file. Problems that stop it being used are errors;
 * tokens we don't have are warnings (the rest of the theme still works).
 * Tokens left out aren't a problem: they take the Default theme's value.
 */
export function validateTheme(raw: unknown): ValidationResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['The file should hold one JSON object.'] }
  }
  const errors: string[] = []
  const warnings: string[] = []

  const { id, name, author, appearance, tokens } = raw
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    errors.push(
      '"id" is missing or not valid. Use lower-case letters, numbers and dashes, e.g. "my-theme".'
    )
  }
  if (typeof name !== 'string' || !name.trim()) {
    errors.push('"name" is missing. It is what shows in Settings.')
  }
  if (author !== undefined && typeof author !== 'string') {
    errors.push('"author" should be text.')
  }
  if (!APPEARANCES.includes(appearance as ThemeAppearance)) {
    errors.push('"appearance" should be "light", "dark" or "both".')
  }
  if (!isRecord(tokens)) {
    errors.push('"tokens" is missing. It should list colours by name.')
  } else {
    for (const [token, value] of Object.entries(tokens)) {
      if (!isThemeToken(token)) {
        warnings.push(`"${token}" is not a colour Astro Editor has. Ignored.`)
        continue
      }
      if (isRecord(value)) {
        const extra = Object.keys(value).filter(
          key => key !== 'light' && key !== 'dark'
        )
        if (extra.length) {
          errors.push(
            `"${token}" can only have "light" and "dark" (found "${extra.join('", "')}").`
          )
        }
        for (const mode of ['light', 'dark'] as const) {
          if (value[mode] !== undefined) {
            checkColour(value[mode], `"${token}" ${mode}`, errors)
          }
        }
      } else {
        checkColour(value, `"${token}"`, errors)
      }
    }
  }

  if (errors.length) return { ok: false, errors }

  const known: Record<string, ThemeTokenValue> = {}
  for (const [token, value] of Object.entries(
    tokens as Record<string, unknown>
  )) {
    if (isThemeToken(token)) known[token] = value as ThemeTokenValue
  }
  return {
    ok: true,
    warnings,
    theme: {
      id: id as string,
      name: (name as string).trim(),
      author: typeof author === 'string' ? author : '',
      appearance: appearance as ThemeAppearance,
      tokens: known,
    },
  }
}
