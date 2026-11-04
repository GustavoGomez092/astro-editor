// Rebuilds the Default theme and the theme JSON Schema from src/App.css.
// Run after adding, removing or changing a colour token:
//   bun scripts/generate-themes.ts
import { buildDefaultTheme, buildThemeSchema } from './theme-tools'

const css = await Bun.file('src/App.css').text()
const theme = buildDefaultTheme(css)
const count = Object.keys(theme.tokens).length
await Bun.write(
  'src/lib/themes/builtin/default.json',
  JSON.stringify(theme, null, 2) + '\n'
)
await Bun.write(
  'src/lib/themes/theme.schema.json',
  JSON.stringify(buildThemeSchema(Object.keys(theme.tokens)), null, 2) + '\n'
)
console.log(`Wrote the Default theme and schema (${count} tokens)`)
