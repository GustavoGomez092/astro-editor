# Colour themes (upstream #197)

Spec: the maintainer's design in the issue (colour tokens only, a theme is a JSON file of token values) plus the brief.

1. `src/lib/themes/`: token list, theme types, `validateTheme` (unknown tokens reported, bad values rejected, missing tokens fall back to Default), `themeToCss` (token values to `:root.light` / `:root.dark` rules), built-in themes (Default, Catppuccin, Nord) as JSON, loader for `themes/*.json` in the app data folder.
2. Default theme JSON is complete and generated from `App.css` (`scripts/generate-themes.ts`); a test keeps it in sync, and also checks the token list covers every `:root` colour token. The JSON Schema is generated from the token list the same way.
3. Rust: `list_theme_files`, `open_themes_folder`.
4. Settings: `appearance.lightTheme` / `darkTheme` ids. A hook in Layout builds the CSS and writes one `<style>` element, so changes apply instantly. The CSS is cached in localStorage and injected before first paint.
5. Settings -> Appearance: a theme picker for light and dark, swatches, broken files listed with their error, Show themes folder.
6. Tests (validation, fallback, CSS, contrast), docs, screenshots.
