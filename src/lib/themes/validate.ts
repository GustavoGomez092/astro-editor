import { resolveTokens } from './css'
import { isSafeValue } from './safe'
import { isThemeToken } from './tokens'
import type { Scheme, Theme, ThemeAppearance, ThemeTokenValue } from './types'

export type ValidationResult =
  | { ok: true; theme: Theme; warnings: string[] }
  | { ok: false; errors: string[] }

const APPEARANCES: ThemeAppearance[] = ['light', 'dark', 'both']
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Functions a colour can use. Anything else (url(), image(), calc()...) is refused */
const COLOUR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'var',
])

/** Words that aren't colours: CSS-wide keywords, and the colour of the surrounding text */
const NOT_A_COLOUR = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'currentcolor',
])

/** What `var(--name)` points at, if the whole value is exactly that */
const BARE_VAR = /^var\(\s*--([a-z0-9-]+)\s*\)$/i

/** Names of the tokens a value points at with var() */
export function tokenReferences(value: string): string[] {
  return [...value.matchAll(/var\(\s*--([a-z0-9-]+)/gi)].map(
    m => m[1] as string
  )
}

/**
 * Whether a string is a colour a theme may use. Structural checks first, so a
 * value is safe even where the browser's own check isn't available; then the
 * browser's, which has the last word on whether it really is a colour.
 */
export function looksLikeColour(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 200) return false
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true
  if (!isSafeValue(v)) return false

  for (const [, name] of v.matchAll(/([a-z-]*)\(/gi)) {
    if (!COLOUR_FUNCTIONS.has((name as string).toLowerCase())) return false
  }

  if (/^[a-z-]+$/i.test(v)) {
    if (NOT_A_COLOUR.has(v.toLowerCase())) return false
  } else if (!/^[a-z-]+\(/i.test(v)) {
    return false
  }
  if (/\b(inherit|initial|unset|revert|revert-layer|currentcolor)\b/i.test(v)) {
    return false
  }

  // var() is only for pointing at one of our tokens: checked in checkReference
  if (/^var\(/i.test(v)) return BARE_VAR.test(v)
  if (/var\(/i.test(v)) return false

  return typeof CSS === 'undefined' || !CSS.supports
    ? true
    : CSS.supports('color', v)
}

function checkColour(
  token: string,
  value: unknown,
  label: string,
  errors: string[]
) {
  if (typeof value !== 'string' || !looksLikeColour(value)) {
    errors.push(
      `${label} is not a colour${typeof value === 'string' ? ` ("${value.slice(0, 60)}")` : ''}. Use something like "#1e1e2e" or "oklch(0.2 0 0)".`
    )
    return
  }
  const target = BARE_VAR.exec(value.trim())?.[1]
  if (target !== undefined && (!isThemeToken(target) || target === token)) {
    errors.push(
      `${label} points at "${target}", which ${target === token ? 'is itself' : 'is not a colour Astro Editor has'}. A var() can only point at another colour in the list.`
    )
  }
}

/** The name of a token that ends up pointing at itself through var(), if any */
function findLoop(theme: Theme): string | undefined {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const resolved = resolveTokens(theme, scheme)
    const visiting = new Set<string>()
    const done = new Set<string>()
    const walk = (token: string): string | undefined => {
      if (done.has(token)) return undefined
      if (visiting.has(token)) return token
      visiting.add(token)
      for (const next of tokenReferences(resolved[token] ?? '')) {
        if (!isThemeToken(next)) continue
        const loop = walk(next)
        if (loop) return loop
      }
      visiting.delete(token)
      done.add(token)
      return undefined
    }
    for (const token of Object.keys(resolved)) {
      const loop = walk(token)
      if (loop) return loop
    }
  }
  return undefined
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
            checkColour(token, value[mode], `"${token}" ${mode}`, errors)
          }
        }
      } else {
        checkColour(token, value, `"${token}"`, errors)
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
  const theme: Theme = {
    id: id as string,
    name: (name as string).trim(),
    author: typeof author === 'string' ? author : '',
    appearance: appearance as ThemeAppearance,
    tokens: known,
  }
  const loop = findLoop(theme)
  if (loop) {
    return {
      ok: false,
      errors: [
        `"${loop}" ends up pointing back at itself through var(). Give one of the colours in the loop a real colour.`,
      ],
    }
  }
  return { ok: true, warnings, theme }
}
