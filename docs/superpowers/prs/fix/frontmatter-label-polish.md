# Quieter labels in the frontmatter panel and the sidebar

A few labels said too much, or said it in code:

- **"Copy as slug"** sat under every title, but a slug only matters where the collection's URLs are built from one. It now shows only when the collection has a URL pattern.
- **"Default:"** with nothing after it appeared under fields whose default is `''`, `[]` or `{}`. Empty defaults aren't shown.
- **Repeated ranges:** a schema like `z.number().min(0).max(95).describe('Distance from the left edge, in % (0–95).')` showed "0–95" twice, once in the description and again as a hint. A bound hint is left out when the description already gives every number in it (length limits too; "950" doesn't count as "95").
- **Collection names** showed as raw keys (`floating`, `sketch-strip`) and, when the config couldn't be read, in whatever order the filesystem returned the folders. They're now shown as words ("Floating", "Sketch strip") in the sidebar, its header, Collection Settings, the palette and the New File tooltip, through `collectionDisplayName`; ids, folder names and settings keep the real name. The parsed config already gives collections in config order (now pinned by a test); the folder-scan fallback lists them by name.

- Tests: `collection-name.test.ts`; `FieldWrapper.test.tsx` for stated ranges and lengths, a range only half stated, a number inside a longer one, and empty defaults; `FrontmatterField.test.tsx` for Copy as slug with and without a URL pattern; Rust tests for config order and the sorted fallback.
- `ui-patterns.md` and the website's special-fields page describe it.

Checked in the dev app with a `sketch-strip` collection (`left: z.number().min(0).max(95).describe('… (0–95).')`, `caption: z.string().default('')`, no URL pattern): the form showed the description once with no "0–95" hint, no "Default:" under Caption and no "Copy as slug"; the sidebar, its header and the New File tooltip said "Sketch strip". The collection list followed the config's order when it parsed, and was sorted by name on the folder fallback. Light and dark.
