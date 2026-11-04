# New files: no empty required values, and a name before the file

A new file got an empty value for every required field without a default: `image: ""`, `width: 0`, `email: ""`, `size: ""`. Each looks filled in, but none is valid, so the project's build failed as soon as the file existed, and the form gave no hint which fields still needed a real value. Defaults on optional fields (`draft`, `order`) were left out instead. And every file was named for today's date (`2026-11-03.md`, then `2026-11-03-1.md`), so the writer had to rename it to match the title.

**Frontmatter** (`lib/files/new-file.ts`, out of `useCreateFile`):
- Required fields without a default are left out; the form shows them empty and required.
- Every default is written, required or not, nested ones under their parent.
- The title and the published date (`pubDate`, `date`, `publishedDate`) are set as before. A required boolean gets `false` and a required date today, since those have no empty value.
- Values are written as JSON, which YAML reads as the same types, so a title with quotes in it is escaped. Dates are written unquoted, because YAML reads a quoted date as a string and `z.date()` rejects it.

**Name step:** New File (Cmd+N, the toolbar, the sidebar, the palette) now opens a small dialog asking for the title, showing the file name it will give. The file is named after the slugified title (the same slug as Copy as slug) with `-1`, `-2` added if it's taken. Leaving the title empty keeps the old behaviour: today's date and a "New Article" placeholder title, with the title field selected. With a title, the editor gets focus instead.

- Tests for the builder, the YAML, the file name and the placeholder (`new-file.test.ts`), and for the dialog (`NewFileDialog.test.tsx`).
- The website's Creating New Files section and the special-fields page describe it.

Checked in the dev app on a collection with a required `image()`, `z.number().int().min(100).max(2000)`, an email, an enum and two defaults: the new file had only `title`, `order: 10` and `featured: false`, the image picker and empty required fields showed in the form, a second file with the same title was `maria-oneil-1.md`, an empty title gave `2026-11-03.md`, and a new article got `pubDate: 2026-11-03` unquoted.
