# Colour system and dark mode

Every colour in the app is a CSS custom property defined once in `src/App.css`, with its light and dark values side by side. Components only use these tokens, never Tailwind's palette colours or literal values, so any colour can be changed in one place for both themes.

## Tokens

All colour tokens live in one `:root` block near the top of `src/App.css`:

```css
:root {
  color-scheme: light dark;
  --background: light-dark(oklch(1 0 0), oklch(0.1815 0 0));
  --draft: light-dark(oklch(0.47 0.102 69.33), oklch(0.8371 0.1285 69.9811));
  /* ... */
}
```

- **`light-dark()`** picks a value by the element's `color-scheme`, so a token never needs a second definition in `.dark`. Webview support is in `cross-platform.md`.
- **Values are oklch.** Write new ones in oklch too, so the file stays consistent (see Adding a token for exact conversion).
- **`@theme inline`** maps each token to a Tailwind colour (`--color-draft: var(--draft)`), so it works as a normal utility with variants and opacity modifiers: `text-draft`, `hover:bg-draft-bg/80`.
- **The styleguide's "Colour tokens" section** (`localhost:1420/styleguide.html?section=colours`) shows every token as a swatch. Shoot it with `bun run app styleguide colours` to compare both themes. It flags any `:root` colour token missing from its list.

### Groups

- **App chrome:** shadcn's tokens plus our own. A comment above them in `App.css` says what each surface is for:
  - `--background` is the chrome: sidebars, and the title bar while a panel is open;
  - `--card` and `--popover` are raised above it (dialogs, menus);
  - `--muted`, `--secondary` and `--accent` are subtle fills, hover and selected rows;
  - `--sidebar-*` is only for the preferences dialog's sidebar.

  Our own chrome tokens are `--heading`, `--icon`, `--active`, `--overlay`, `--image-preview*` and `--framework-*`.
- **Status:** `--draft`, `--filter` (each with a `-bg` tint) and `--required`. A strong colour and its background tint are separate tokens, because each token name means one colour for every utility.
- **Window controls:** the Windows caption buttons and the macOS traffic lights.
- **Editor:** `--editor-color-*`, the iA Writer palette for the writing surface only (see `editor-styles.md`). Keep all of it, used or not. The chrome and the editor differ on purpose; for example, editor text in dark mode is softer than UI text. The app chrome uses the editor background in one place: the title bar when both panels are hidden, so the window reads as one surface.

## How the theme is applied

`ThemeProvider` (`src/lib/theme-provider.tsx`) takes `light`, `dark` or `system` and:

1. sets the native window theme with Tauri's `setTheme()` (`null` for system), so native context menus and dialogs match the app rather than the OS;
2. adds `.light` or `.dark` to `<html>`, resolving `system` with `prefers-color-scheme` and following its changes.

`.light` and `.dark` set `color-scheme`, which `light-dark()` follows. Until React adds a class, `:root { color-scheme: light dark }` follows the OS, so the first paint is already in the system theme. Tailwind's `dark:` variant is keyed to the `.dark` class (`@custom-variant dark`).

The user's heading colours from Appearance settings are set once by Layout as `--heading-color-light` and `--heading-color-dark`. `--editor-color-heading` picks between them with `light-dark()`, falling back to the editor text colour.

## Colour themes

A theme is a JSON file of values for these tokens, and nothing else: themes never change type, spacing or layout. The format, as the JSON Schema `src/lib/themes/theme.schema.json` describes it:

```json
{
  "id": "my-theme",
  "name": "My theme",
  "author": "Me",
  "appearance": "both",
  "tokens": {
    "background": { "light": "#e6e9ef", "dark": "#181825" },
    "foreground": "#4c4f69"
  }
}
```

- `appearance` (`light`, `dark` or `both`) says which mode's list the theme appears in. A token is a colour for both modes, or `{ light, dark }`.
- Token names are the `:root` names in `App.css` without the `--`. The traffic-light colours and the radius aren't themeable (the list is `parseCssTokens` in `scripts/theme-tools.ts`).
- **The Default theme is `src/lib/themes/builtin/default.json`, generated from `App.css`.** After adding, removing or changing a token, run `bun scripts/generate-themes.ts`; it also rewrites the schema. A test fails if either file is out of date, and another if a built-in theme sets a token that doesn't exist.
- A token a theme leaves out takes Default's value (`resolveTokens`), so a partial theme works. Unknown tokens are reported next to the file in Settings and ignored; a bad colour or missing field makes the file unusable and lists the reason there.
- **How it's applied:** `useColourThemes` (called by Layout) builds one `<style id="astro-editor-colour-theme">` from the light and dark choices (`themesToCss`): a `:root:root.light` rule with the light theme's light values, and a `:root:root.dark` rule with the dark theme's dark values. They sit on the same element as `color-scheme`, so the `var()` tokens (`--active`, `--server-error`) follow. The CSS is also cached in localStorage and applied in `main.tsx` before the first paint, so a non-default theme doesn't flash Default colours. Nothing in `App.css` changes: components still just use tokens.
- **The writer's own heading colour** (Settings) feeds `--editor-color-heading` through `--heading-color-light/dark`. The built-in themes leave `editor-color-heading` out, so that choice keeps working; a theme that sets it overrides the picker.
- **Custom themes** live in `themes/*.json` in the app data folder. Settings reads the folder whenever it opens, and "Show themes folder" opens it. A copy of the schema is written there as `theme.schema.json`, so an editor can check and complete a file (`"$schema": "./theme.schema.json"`). A theme can't reuse a built-in id, and the first of two files with one id wins; the other is listed as an error.
- Choices are `appearance.lightTheme` and `appearance.darkTheme` (theme ids) in global settings. An id that has gone, or a theme for the other mode, falls back to Default.
- **Contrast:** `scripts/themes.test.ts` checks every built-in theme (not Default) in both modes: body, muted and heading text, button text, status text on its tint and the editor's accent colours need 4.5:1 (WCAG AA); markdown marks 2:1.

## Rules

- **No Tailwind palette colours** (`text-gray-700`, `bg-black/50`, `text-white`). The ast-grep rule `no-palette-colours` fails `check:all` on them.
- **No arbitrary token classes** (`bg-[var(--x)]`). Register the token in `@theme inline` and use the utility.
- **Don't name a `:root` token `--color-*`.** That namespace belongs to `@theme`, and a clash silently breaks the generated utilities.
- **Tokens are full colour values.** Use `var(--token)`, never `hsl(var(--token))`, which is invalid and silently dropped.
- **Never register a token with `@property`.** WebKit and Firefox resolve a registered `light-dark()` value wrongly.
- **Avoid relative colour syntax** (`oklch(from var(--x) …)`) on tokens; early WebKit got it wrong with `light-dark()`.
- **Non-colour dark-mode overrides** go in a `.dark` rule, placed after the `:root` rule they override, since both have the same specificity. The editor's lighter dark-mode font weight in `Editor.css` is one.
- **Text selection outside the editor is left to the system.** A custom `::selection` would lose the grey selection macOS shows in an inactive window. The editor draws its own with `--editor-color-selectedtext-background`.

### shadcn components

- shadcn's own `dark:` idioms in `src/components/ui/` (`dark:bg-input/30`, `dark:aria-invalid:ring-destructive/40`) stay. They already read from tokens, and stripping them would make every future `shadcn add` a bigger merge. Literal colours in them get replaced with tokens.
- shadcn's standard theme tokens stay even when nothing reads them yet (`--card-foreground`, `--sidebar-primary*`): components added later expect them.
- `shadcn add` writes any CSS variables a component ships into `:root` and `.dark` blocks. Fold them into the token block as `light-dark()` pairs.

## Adding a token

1. Add it to the right group in the `:root` block in `App.css` as a `light-dark()` pair, or a single value if it's the same in both themes. Add a short comment if its use isn't obvious from the name.
2. If components use it as a class, register it in `@theme inline`: `--color-name: var(--name)`.
3. Add it to `GROUPS` in `src/styleguide/ColoursSection.tsx`.
4. Run `bun scripts/generate-themes.ts` so the Default theme and the schema include it. Add it to Catppuccin and Nord if it needs a palette colour (otherwise they use Default's).

To convert existing colours to oklch exactly, `@csstools/css-color-parser` is in `node_modules` (a dependency of jsdom). It parses any CSS colour and serialises to oklch. Four decimal places stay within a fraction of one 8-bit level.
