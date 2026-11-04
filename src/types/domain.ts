/**
 * Domain types for Astro Editor.
 *
 * These types are auto-generated from Rust structs via tauri-specta.
 * This file re-exports them with JSDoc documentation for IDE support.
 *
 * @see src-tauri/src/models/ - Rust source structs
 * @see src/lib/bindings.ts - Generated bindings
 */

// Re-export all domain types from generated bindings
// This ensures type safety across the Tauri IPC boundary
export type {
  /**
   * Represents a markdown file in an Astro content collection.
   *
   * This type is auto-generated from the Rust FileEntry struct.
   * @see src-tauri/src/models/file_entry.rs
   *
   * Fields:
   * - `id` - Unique identifier (relative path from collection root without extension)
   * - `path` - Absolute file path
   * - `name` - Display name (filename without extension)
   * - `extension` - File extension ('md' or 'mdx')
   * - `collection` - Collection this file belongs to
   * - `last_modified` - Unix timestamp of last modification (null when unavailable)
   * - `frontmatter` - Parsed frontmatter data (null when not loaded)
   *
   * Note: Draft status is determined in the frontend using the user-configured
   * draft field from settings, accessed via `file.frontmatter[draftField]`.
   */
  FileEntry,
  /**
   * Markdown file content with parsed YAML frontmatter.
   *
   * This type is auto-generated from the Rust MarkdownContent struct.
   * @see src-tauri/src/commands/files.rs
   *
   * Fields:
   * - `frontmatter` - Parsed frontmatter as key-value pairs
   * - `content` - Markdown content (body, without frontmatter)
   * - `raw_frontmatter` - Raw YAML frontmatter text (between --- delimiters)
   * - `imports` - MDX imports at top of file
   */
  MarkdownContent,
  /**
   * Represents an Astro content collection.
   *
   * This type is auto-generated from the Rust Collection struct.
   * @see src-tauri/src/models/collection.rs
   *
   * Fields:
   * - `name` - Collection name (e.g., "posts", "docs")
   * - `path` - Absolute path to collection directory
   * - `complete_schema` - Serialized CompleteSchema from Rust backend
   */
  Collection,
  /**
   * Directory information for nested collection navigation.
   *
   * This type is auto-generated from the Rust DirectoryInfo struct.
   * @see src-tauri/src/models/directory_info.rs
   *
   * Fields:
   * - `name` - Directory name only (e.g., "2024")
   * - `relative_path` - Path relative to collection root (e.g., "2024/january")
   * - `full_path` - Full filesystem path
   */
  DirectoryInfo,
  /**
   * Result of scanning a directory within a collection.
   * Used for nested navigation like posts/2024/january/
   *
   * Fields:
   * - `subdirectories` - Subdirectories in this directory
   * - `files` - Files in this directory
   */
  DirectoryScanResult,
  /**
   * Information about an MDX component discovered in the project.
   *
   * Fields:
   * - `name` - Component name
   * - `file_path` - Path to component file
   * - `props` - Component props information
   * - `has_slot` - Whether component has a slot
   * - `description` - Component description (from JSDoc)
   * - `framework` - Component framework (astro, react, vue, svelte)
   * - `import_source` - The package it's imported from, for package components
   * - `named_export` - Imported by name (`import { Aside }`) rather than as a default export
   * - `slot_template` - What the builder inserts inside the tag, which can contain other components
   */
  MdxComponent,
  /**
   * The imports the component builder adds with a component and the images
   * and entries picked for its props, planned without saving.
   *
   * Fields:
   * - `imports` - The import block with everything added
   * - `added` - The statements added or changed, empty when nothing is
   * - `existing` - The statement that already has the component's name, which may be something else of the same name
   * - `names` - The name each picked image or entry is imported or loaded as, by the prop it was picked for
   */
  ImportPlan,
  /**
   * The images and collection entries picked for a component's props, which
   * the file has to import or load.
   */
  PropImports,
  /**
   * An image picked for an image prop: the prop, the file's name, which its
   * import's name comes from, and the path to import it from.
   */
  ImageImport,
  /**
   * A collection entry picked for an entry prop: the prop, the collection and
   * the entry's id in Astro, which the file loads with `getEntry`.
   */
  EntryImport,
  /**
   * Information about a component prop.
   *
   * Fields:
   * - `name` - Prop name
   * - `prop_type` - TypeScript type as written in the component's source
   * - `kind` - What kind of value the prop takes (see `PropKind`)
   * - `is_optional` - Whether prop is optional
   * - `default_value` - Default from destructuring: strings unquoted, anything else as written
   * - `description` - The prop's JSDoc comment
   */
  PropInfo,
  /**
   * What kind of value a prop takes, resolved from its TypeScript type, which
   * decides the control the component builder shows. Tagged by `kind`:
   * `string`, `number`, `boolean`, `literals` (with `values`), `array` (with
   * `items`), `date`, `image`, `collectionEntry` (with `collection`) or
   * `unknown`.
   */
  PropKind,
  /**
   * Supported component frameworks.
   */
  ComponentFramework,
  /**
   * A project's dev server, which the title bar's Preview control starts and
   * stops. Sent with every `dev-server-state` event.
   *
   * Fields:
   * - `status` - `stopped`, `installing` (dependencies), `starting`, `running`, `external` (another server for the project was already running) or `error`
   * - `url` - The local URL the server printed, once running
   * - `command` - The command that runs it (the Dev command override, or `<package manager> run dev`)
   * - `pid` - The shell process, which leads the server's process group
   * - `error` - Why it stopped or couldn't start, ending with its last output lines
   */
  DevServerState,
  /**
   * Where a dev server is in its life. See `DevServerState`.
   */
  DevServerStatus,
  /**
   * A file that conflicts between the current branch and its upstream, from
   * `gitConflicts` (an in-memory merge; nothing is written).
   *
   * Fields:
   * - `path` - Relative to the repository root, with forward slashes
   * - `mine` - This computer's whole file; `null` if deleted here or binary
   * - `theirs` - The upstream's whole file; `null` if deleted there or binary
   * - `binary` - Either side is binary (an image, say), so there's no text to show
   */
  ConflictFile,
  /**
   * Which whole-file version `gitResolveConflicts` keeps: `mine` or `theirs`.
   */
  ConflictChoice,
  /**
   * One conflicted file's choice, passed to `gitResolveConflicts`.
   */
  ConflictResolution,
  /**
   * One spelling or grammar problem from `checkGrammar` (Harper).
   * @see src-tauri/src/grammar/mod.rs
   *
   * Fields:
   * - `from`, `to` - The range in the text that was checked, in UTF-16 code units (CodeMirror positions)
   * - `rule` - Harper's rule name, such as `SpellCheck`
   * - `kind` - `spelling` or `grammar`, which underline it gets
   * - `problem` - The text in the range
   * - `message` - Harper's explanation
   * - `suggestions` - Replacement text for the range, best first; `""` removes it
   */
  GrammarIssue,
  /**
   * `md` or `mdx`: MDX also skips imports, component tags and `{expressions}`.
   */
  GrammarFileType,
  /**
   * The English dialect to check against. American unless set.
   */
  GrammarDialect,
  /**
   * JSON-compatible value type (serde_json::Value).
   * Used for dynamic frontmatter data.
   */
  Value as JsonValue,
} from '@/lib/bindings'

// Re-export commands for convenience
// This allows importing both types and commands from @/types
export { commands } from '@/lib/bindings'
