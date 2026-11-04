# Opening the open file again wipes it

Clicking the entry that's already open in the sidebar (or opening it again from the Content Finder or a deep link) blanks the editor and the frontmatter form. `openFile` clears the store before setting `currentFile`, but the file's content query is cached under the same key and `useEditorFileContent` only re-runs when the file changes, so nothing loads it back. The next keystroke marks the file dirty and auto-save writes the blank form over the file on disk.

`openFile` already returned early for a dirty file being opened again. It now returns early whenever the file is already open, dirty or not, so opening it again does nothing.

- Regression test in `editorStore.test.ts`: opening the open, saved file keeps `editorContent`, `frontmatter`, `rawFrontmatter` and `imports` and doesn't mark it dirty. The integration test that asserted the clearing now asserts nothing changes.
- `editor.md` says why.

Checked in the dev app: opened an entry, clicked it again in the sidebar, and the body and form stayed; an edit afterwards saved the full file.
