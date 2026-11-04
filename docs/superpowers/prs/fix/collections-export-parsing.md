# Read quoted keys and trailing commas in the collections export

Collection names often have hyphens, so a config like this is common:

```ts
export const collections = {
  work,
  'sketch-strip': sketchStrip,
  'floating-sketches': floatingSketches,
};
```

The parser only read the export when it was a plain list of names with no trailing comma. Here it found no collections, so the scan fell back to the folders in the content directory. That fallback has no `image()` or `reference()` information, so every image field became a plain text field and references lost their collection, with nothing in the UI to say why.

The parser now reads the export entry by entry, splitting at top-level commas: shorthand names, `name: variable`, single- or double-quoted keys, inline `defineCollection(…)` calls, any line breaks, and a trailing comma. A quoted key's schema and `file()` loader check use the variable it points to. Collections come back in the order of the config.

- Rust tests in `parser.rs` for each form: single-quoted keys over several lines with a trailing comma, double-quoted keys on one line, shorthand names with a trailing comma, `blog: blogCollection`, a quoted key with an inline `defineCollection`, and a quoted key pointing at a `file()` collection (still skipped). Each checks the collections found and, where there are any, that the `image()` field survives.
- `schema-system.md` lists the forms and what the fallback loses.
