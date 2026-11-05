# Frontmatter saves change only what changed: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A frontmatter save edits the YAML text on disk in place, so untouched keys keep their exact text and a changed value keeps its key's style.

**Architecture:** A new pure module `src/lib/frontmatter-yaml.ts` parses the current raw frontmatter with `yaml`'s `parseDocument`, diffs its values against the form's, and splices new text into the source by node ranges (never `doc.toString()`, which reformats). Changed values are rendered through a one-key `Document` with the old node's scalar type and the file's detected indentation. The result is checked by re-parsing; on any doubt it returns `null` and the save falls back to the Rust value writer exactly as today. `frontmatterToWrite` passes the edited text as `rawFrontmatter`.

**Tech Stack:** TypeScript, `yaml` 2.9.1, Vitest; Rust raw path unchanged except one newline fix.

**Spec:** the coordinator's brief (feature "frontmatter saves change only what changed") + `.superpowers/sdd/2026-11-04-four-features/shared-brief.md`.

## Global Constraints

- Untouched keys byte-for-byte (quotes, comments, spacing, block scalars, order, blank lines).
- Changed value keeps its style: double-quoted stays double, single stays single, `|`/`>` stay block scalars (with their indentation), plain stays plain unless the value would read back as something else.
- New keys in schema field order relative to existing keys, in the current writer's style (plain, `- item` sequences unindented, `|-` for multi-line); quote character follows the file when it uses only one.
- Removed keys removed with their lines.
- Date fields stay unquoted; a date-looking string in a non-date field is quoted (`z.date()` / js-yaml timestamps).
- Unparseable YAML, empty frontmatter, or a non-map root: Rust writer, unchanged.
- An exact revert still writes the baseline raw text.
- `lib/` has no React; commits have no trailers.

## Review Focus

- Re-parse safety net: an edit that would not read back as the form's values (aliases to a changed anchor, odd nesting) must fall back, not write wrong data — test with an anchor/alias.
- A sequence item that is a map (`- name: A`) whose first key is removed or a new key goes first — must not produce `-     role:`; re-render the item instead — test.
- Raw frontmatter with no trailing newline and a block scalar as the last key — test.
- A key with an empty value (`image:`) getting a value — test.
- Strings needing quotes in a plain key: `a: b`, `@x`, `yes`, `no`, `42`, `true`, `~`, `2024-01-15` (string field), leading space — assert by re-parsing (core and 1.1).

---

### Task 1: `editFrontmatterText` (in-place YAML editing)

**Files:**
- Create: `src/lib/frontmatter-yaml.ts`, `src/lib/frontmatter-yaml.test.ts`
- Modify: `src/lib/frontmatter-save.ts` (move `sameValues` into the new module, import it back)

**Interfaces:**
- Produces: `editFrontmatterText(raw: string, values: Record<string, unknown>, fields: SchemaField[]): string | null` and `parseFrontmatterValues(raw: string): Record<string, unknown> | null` (null when the text doesn't parse to a map); `sameValues` exported from here.

- [ ] Tests first (in `frontmatter-yaml.test.ts`): hero round trip (edit `firstLine`, then revert on the edited text → byte-for-byte the original); double-quoted stays double; `intro: |` multi-paragraph stays `|` with 2-space indent; comments and blank lines survive; dates stay unquoted; date-looking string in a string field gets quoted; tags: add, remove, change one item in place; new key lands in schema order (before, between, after; nested); removed key disappears with its line; non-ASCII; quoting cases above asserted by re-parse; flow sequence stays flow; empty value gets a value; seq-of-maps first key removed; anchor/alias change falls back to `null`; broken YAML → `null`.
- [ ] Run `bun run test:run src/lib/frontmatter-yaml.test.ts`: FAIL (module missing).
- [ ] Implement: parse (append `\n` if missing, strip it after); collect `{start, end, text}` splices from a recursive map/seq walk; apply from the end; verify by re-parse with `sameValues`.
- [ ] Run the test file: PASS.

### Task 2: Use it in saves

**Files:**
- Modify: `src/lib/frontmatter-save.ts` (`frontmatterToWrite` returns `written: Values | null` too), `src/lib/frontmatter-save.test.ts`, `src/hooks/editor/useEditorActions.ts` (`lastWrittenFrontmatter: toWrite.written`), `src/hooks/editor/useEditorActions.test.tsx`
- Modify: `src-tauri/src/commands/files.rs` `rebuild_markdown_with_raw_frontmatter` always adds the newline before `---` (raw never includes the last one; a trailing blank line was lost) + a test.

- [ ] Tests: changed values give `{ frontmatter: null, rawFrontmatter: <edited>, written }`; unparseable raw gives the values (fallback, as today); baseline revert unchanged; unset-default keys the file lacks are left out of the edit; `useEditorActions` sends edited raw text and sets `lastWrittenFrontmatter`.
- [ ] Implement, run `bun run test:run` and `bun run rust:test`.
- [ ] Docs: `docs/developer/editor.md` (saving section) says how frontmatter is written.
- [ ] `bun run check:all` exit 0, commit.

### Task 3: Drive it in the dev app

- [ ] Copy site-sections to scratch (rsync, no node_modules, fresh `git init` + commit), open it in the dev app (`bun run tauri:dev` in the background), edit Hero First Line, save, switch entries, come back, revert, save: `git diff` empty. Edit a project's discipline: diff is one line. Screenshots. Stop the app; check the original site is clean.
- [ ] Report to `yaml-report.md`.
