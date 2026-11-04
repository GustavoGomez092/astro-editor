# App data

What the app stores on the user's machine, where, and the reasoning behind the settings model. The settings model is due a rework, so this covers the reasoning and gotchas rather than every setting; for the shapes, read `src/lib/project-registry/types.ts`.

## Where it lives

Everything is in Tauri's `AppLocalData` folder, named after the bundle identifier:

- **macOS:** `~/Library/Application Support/is.gustavogomez.astroeditorplus/`
- **Windows:** `%LOCALAPPDATA%\is.gustavogomez.astroeditorplus\`
- **Linux:** `~/.local/share/is.gustavogomez.astroeditorplus/` (or under `$XDG_DATA_HOME`)

Dev builds use `is.gustavogomez.astroeditorplus.dev` instead, so they never read or write the installed app's data (see `agent-tooling.md`).

Inside it:

- `preferences/global-settings.json`: app-wide settings (theme, IDE command, auto-save delay, appearance and so on).
- `preferences/project-registry.json`: every project ever opened (ID, name, path, dates) and which was open last.
- `preferences/projects/{id}.json`: one project's settings, including its collection overrides.
- `recovery/` and `crash-reports/`: see [Recovery Files](#recovery-files).
- `telemetry.json`: the anonymous install ID. Release builds only.
- `.window-state.json`: window size and position, from the window-state plugin.

The webview's localStorage holds a few per-machine conveniences: panel sizes (`panel-v4:*`), a copy of the theme (`astro-editor-theme`) so the theme provider has it before settings load, and a skipped update version. Logs live elsewhere; see `agent-tooling.md`.

All preferences reads and writes go through Rust commands (`readAppDataFile`, `writeAppDataFile`) that refuse paths outside the app data folder.

## How a setting resolves

Project and collection settings resolve **collection → project → hard-coded default**. There's deliberately no global layer for them: a project's paths or field names don't make sense as an app-wide default. The one exception is `defaultFileType` (md or mdx), which is a writing preference, so it goes collection → project → global → `'md'` (`default-file-type.ts`).

`collection-settings.ts` is where the fallbacks are written out.

- **Collection overrides are sparse.** `settings.collections` lists only collections the user has changed, never the collections discovered in the project. Nothing has to stay in sync with discovery, and settings for a collection that's since been removed are harmless.
- **Path overrides are relative to the project root,** at both levels, not to the content directory: `content/blog/` means `<project>/content/blog/`. Assets go in a folder named after the collection inside the assets directory (`<assets>/<collection>/`), overridden or not.
- **Collection Settings says where each value comes from.** `explainCollectionSettings` (`explain-settings.ts`) gives each setting a collection uses (content and assets folders, title, description, draft and date fields, file list order, file type) as **set** (stored for this collection) or **inferred**, with what's used and why ("found in the schema", "from the glob loader", "the project's setting") and a warning when nothing usable was found, such as no draft field. The pane also explains the settings with the collection's own ones removed, which is what Clear goes back to. A project-level value equal to the seeded default (`DEFAULT_PROJECT_SETTINGS`) is described as the usual name, since the writer didn't choose it.
- **Frontmatter mappings are collection-scoped in the UI** (which field is the title, date, description, draft). Each collection has its own schema, so the dropdowns list that collection's fields; a project-level dropdown merged fields from every collection, which was confusing and often wrong. Project-level mappings still exist in the files and act as the fallback, but there's no UI for them.

## Project IDs

A project's ID is its `package.json` `name`, made filename-safe, or the folder name if there's no `package.json`. On a clash with an existing ID, a short hash of the path is appended (`utils.ts`).

A project is found by its path first. Only when no registered project has the path does `findMovedProject` look for one that moved: a registered project whose folder is `missing` (`folder_states`) and whose `package.json` name the new folder has. `missing` means the folder is gone from a parent folder that's still there; a folder whose parent is gone too (an unplugged drive: `/Volumes/<drive>` itself, or anything under it), that can't be read, or that has a file in its place is `unavailable`, and is never treated as moved, so the project keeps its settings for when the drive is back. A project whose folder is still there is never treated as moved, so two copies of one template stay two projects with their own settings. A folder name alone never matches, since unrelated folders often share one.

## Gotchas

- **`projectRegistryManager.updateProjectSettings` replaces `collections` wholesale.** Path overrides and frontmatter mappings are merged one level deep, but a `collections` array overwrites the stored one, so callers must send the full array. `usePreferences.updateCollectionSettings` does.
- **A new collection setting must be added to `hasCollectionSettings`** (`collection-settings.ts`). `updateCollectionSettings` (`src/hooks/usePreferences.ts`) and `withCollectionSort` use it to drop collections whose settings are all empty, checking each known field by name, so a field it doesn't know about is dropped on save.
- **The sidebar sort is a collection setting** (`sort: { mode, direction }`), saved each time it changes so it survives a restart. The Default sort isn't stored. It's written straight from the sidebar (`withCollectionSort`), not through the preferences pane, and Reset in Collection Settings clears it with the rest. `projectStore.updateProjectSettings` shows a `collections` change before writing it (and puts it back if the write fails), so two quick clicks on the sort arrow each build on the last.
- **Body Text (`bodyText`) hides the editor for collections without body text.** Unset, it's detected by `collection_has_body_text` (Rust, `commands/project.rs`), which reads entries until one has text after its frontmatter and imports; its query key sits under `collectionFiles`, so the watcher and saves refresh it with the file list. `hidesBodyEditor` (`lib/files/body-text.ts`) decides, and never hides an open file that has body text. `MainEditor` hides the editor with CSS rather than unmounting it, and shows the form where the editor was: `FrontmatterPanel` is rendered twice (`placement` `sidebar` and `main`). The copy not in use is hidden and `inert` rather than unmounted, so a field's local state (a YAML draft) survives the form moving away and back; only the copy in use has `data-frontmatter-panel` and the title field's fixed id (`FormInUseContext`), so `focusNewFile` finds the right one. The copy that comes into use dispatches a window `resize`, because its text boxes measured their height while hidden. Layout collapses the right panel while the form is in the main area without changing `frontmatterPanelVisible` (its resize sync ignores that collapse), so the panel comes back with the next file that has body text. Meanwhile nothing changes that setting: the toolbar's panel button is disabled, the Toggle Frontmatter Panel command isn't offered, Cmd+2 and the menu item do nothing (`isBodyEditorHidden` in `lib/files/focus-new-file.ts` reads the page), and a new entry in such a collection doesn't open the panel (`newEntryHidesBodyEditor`). While a file loads, the placement is kept where the file's own text decides it (`hidesBodyEditor`), so it doesn't flicker.
- **Changing path overrides has side effects.** `projectStore.updateProjectSettings` saves and closes the open file (with a toast explaining why), invalidates every query for the project (collections, file lists, counts), and restarts the file watcher, because the paths under the open file may have moved. That applies to the project's `pathOverrides` and to a `collections` change that moves a collection's content or assets folder (`collectionPathsChanged`); other collection changes, like the sort, don't trigger it.
- **A collection's content directory override is the collection's own folder,** relative to the project root (`writing/posts` holds that collection's entries), not a parent like the project-level one. `getCollectionFolderOverrides` (`path-resolution.ts`) turns the overrides into a `name → folder` map that the frontend passes to every Rust command that finds collections: `scan_project_with_content_dir`, `resolve_file_entry` and `start_watching_project_with_content_dir`. Rust's `discover_collections` (`commands/project.rs`) uses the folder in place of `<content directory>/<name>`, whether the collections came from the config or from the content directory's folders, and the watcher also watches each collection folder outside the content directory.
- **New project files are seeded with `DEFAULT_PROJECT_SETTINGS`** (`defaults.ts`), so the project layer is rarely empty and the hard-coded defaults in `collection-settings.ts` seldom apply; change both together. The published date field is the exception: it isn't seeded, and `getPublishedDate` (`lib/files/sorting.ts`) tries `DEFAULT_PUBLISHED_DATE_FIELDS` after the mapped field, because older project files seeded `date` for every project.
- **A preferences file that doesn't parse is kept, then replaced with defaults.** `readJsonFile` (`persistence.ts`) tells a missing file (it can't be read: a new install or project) from a broken one (it reads but isn't a JSON object). A broken one is copied to `<name>.broken-<timestamp>.json` beside it, logged, and a toast tells the writer, with a button that opens the preferences folder. The defaults are then written over it at once, so it's reported only once. This applies to global settings, the project registry and project files.
- **Project files have a leftover top-level `collections` field that nothing reads.** Collection overrides are in `settings.collections`.

## Recovery files

When a save throws, the `catch` in `saveCurrentFile` (`useEditorActions.ts`) writes the unsaved content to `recovery/` (`{timestamp}-{name}.recovery.json` and `.recovery.md`) and a report to `crash-reports/` (`{timestamp}-crash.json`), keeps the file marked dirty, and shows an error toast.

That's all it is: a fallback dump for failed saves. Nothing is written on an actual crash, force quit or power loss. There's no UI to restore from these files, and nothing cleans them up. The real protection against losing work is auto-save's maximum delay; see `editor.md`.
