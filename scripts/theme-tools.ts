// Reads the colour tokens out of src/App.css and builds the Default theme and
// the JSON Schema from them. Used by scripts/generate-themes.ts and checked by
// scripts/themes.test.ts, so the theme files can't drift from App.css.

/** :root tokens that aren't themeable colours */
const NOT_THEMEABLE = [/^app-corner-radius$/, /^radius$/, /^traffic-light-/]

export type TokenValue = string | { light: string; dark: string }

/** Splits on separators that aren't inside parentheses */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

function rootBlock(css: string): string {
  const start = css.indexOf(':root {')
  if (start === -1) throw new Error('No :root block in App.css')
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}') depth--
    if (depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('Unclosed :root block in App.css')
}

const squash = (value: string) => value.replace(/\s+/g, ' ').trim()

/** Every themeable colour token in App.css's :root, in file order */
export function parseCssTokens(css: string): Record<string, TokenValue> {
  const body = rootBlock(css).replace(/\/\*[\s\S]*?\*\//g, '')
  const tokens: Record<string, TokenValue> = {}
  for (const declaration of splitTopLevel(body, ';')) {
    const match = /^\s*--([a-z0-9-]+)\s*:([\s\S]+)$/.exec(declaration)
    if (!match) continue
    const name = match[1] as string
    if (NOT_THEMEABLE.some(pattern => pattern.test(name))) continue
    const value = squash(match[2] as string)
    if (value.startsWith('light-dark(') && value.endsWith(')')) {
      const [light, dark] = splitTopLevel(value.slice(11, -1), ',')
      tokens[name] = { light: squash(light ?? ''), dark: squash(dark ?? '') }
    } else {
      tokens[name] = value
    }
  }
  return tokens
}

export function buildDefaultTheme(css: string) {
  return {
    $schema: './theme.schema.json',
    id: 'default',
    name: 'Default',
    author: 'Astro Editor',
    appearance: 'both',
    tokens: parseCssTokens(css),
  }
}

export function buildThemeSchema(tokenNames: string[]) {
  const colour = {
    type: 'string',
    minLength: 1,
    description:
      'Any CSS colour: #rrggbb, rgb(), hsl(), oklch(), a colour name, or a var() of another token.',
  }
  const tokenValue = {
    oneOf: [
      colour,
      {
        type: 'object',
        description: 'Different values for light and dark mode.',
        properties: { light: colour, dark: colour },
        additionalProperties: false,
      },
    ],
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Astro Editor theme',
    description:
      'A colour theme for Astro Editor. Tokens you leave out use the Default theme.',
    type: 'object',
    required: ['id', 'name', 'appearance', 'tokens'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      id: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]*$',
        description:
          'A short unique name: lower-case letters, numbers, dashes.',
      },
      name: { type: 'string', minLength: 1, description: 'Shown in Settings.' },
      author: { type: 'string' },
      appearance: {
        enum: ['light', 'dark', 'both'],
        description:
          'Where the theme can be picked: light mode, dark mode, or either.',
      },
      tokens: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          tokenNames.map(name => [name, tokenValue])
        ),
      },
    },
  }
}
