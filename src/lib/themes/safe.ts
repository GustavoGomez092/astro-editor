/**
 * The only characters a colour needs. No quotes, colons, semicolons, braces,
 * angle brackets, backslashes, @ or *, so a value can't close a rule, start a
 * new one or write a comment, however the stylesheet is built.
 */
const COLOUR_CHARACTERS = /^[a-z0-9#%.,()/\s+_-]+$/i

/**
 * Whether a value is made only of the characters a colour needs, with its
 * brackets closed. Checked when a theme file is read and again just before the
 * value reaches the page, so nothing that skipped the first check gets through.
 */
export function isSafeValue(value: string): boolean {
  if (!COLOUR_CHARACTERS.test(value)) return false
  let depth = 0
  for (const char of value) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (depth < 0) return false
  }
  return depth === 0
}
