# Hide the body editor for collections without body text

Plenty of collections are only frontmatter: site settings, testimonials, gallery items, the sections of a one-page site. For those, the editor is a big empty page in the middle of the window that invites text the site never shows, while the fields that matter are squeezed into the side panel. A writer who types there gets body text that goes nowhere.

- **Detected:** `collection_has_body_text` (Rust) reads the collection's entries until one has text after its frontmatter and MDX imports. When none has any, the editor is hidden and a short note says the entries are edited in the panel, and where to change it. Its query sits under the collection's files key, so the watcher and saves refresh it with the file list.
- **Setting:** Collection Settings → File Defaults → **Body Text**: Detect (the default), Entries have body text, or No body text.
- **Safe:** an open file that has body text always shows the editor, whatever the setting, so text is never hidden from view. The editor is hidden with CSS, not unmounted, so its state stays.

- Rust tests for what counts as body text (frontmatter only, whitespace, imports only, text, no frontmatter) and for the scan (nested folders, ignored files, a missing folder); Vitest tests for the decision (`body-text.test.ts`).
- `app-data.md` and the website's preferences page describe it.

Checked in the dev app: a testimonials collection whose entries are only frontmatter shows the note instead of the editor, with the form unchanged; an articles entry shows the editor as before (a long file scrolls to the end, and the agent bridge's outline still finds the editor); setting Body Text to "Entries have body text" in Collection Settings brought the editor back straight away and saved `bodyText: "show"`. Light and dark.
