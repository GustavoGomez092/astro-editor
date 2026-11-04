# Astro Editor

![Screenshots of Astro Editor](docs/assets/header.png)

A native macOS markdown editor for Astro content collections. Clean writing interface with automatic frontmatter editing based on your collection schemas.

https://github.com/user-attachments/assets/dc32dd12-2094-47c4-ab90-620ecd11ba48

## Features

**Writing Environment**

- Clean markdown/MDX editor with syntax highlighting. Frontmatter and imports are hidden while editing, shown in a dedicated sidebar.
- Focus mode (highlights current sentence), copyedit mode (highlights parts of speech), and typewriter mode (keeps the cursor centered on screen).
- Customizable heading colors with separate settings for dark and light themes.
- Image preview on hover (Option + hover over paths).
- Comprehensive keyboard shortcuts for formatting, headings, and navigation.
- Auto-save: saves 2 seconds after you stop typing (configurable) with backup saves every 10 seconds while typing. Crash recovery included.

**Frontmatter & Schema Integration**

- Generates editing forms from your Astro collection schemas with proper validation.
- Supports all Zod types: strings, numbers, dates, booleans, enums, arrays, nested objects, references, and image fields.
- Image fields provide drag-and-drop with automatic copying to your assets directory using relative paths by default (configurable per project/collection).
- Field constraints (min/max, character limits) enforced in the UI.

**MDX Components**

- `Cmd + /` opens component builder showing all components in your `src/components/mdx/` directory.
- Supports Astro, React, Vue, and Svelte components.
- Automatically detects available props and lets you tab through values after insertion.

**File Management**

- Collections and files automatically discovered from your `content.config.ts`.
- Full support for subdirectories within collections.
- Files sorted by publication date (configurable field name) with draft indicators.
- Context menu for rename, duplicate, reveal in Finder, copy path.
- Command palette (`Cmd + P`) for quick file switching and command access.

**Project Configuration**

- Per-project and per-collection settings for custom directory structures.
- Configurable field mappings (title, date, draft, description fields).
- Light/dark theme with system integration.
- IDE integration (open files/projects in VSCode, Cursor, etc.).

## Supported Astro Projects

- **Astro Version**: 5.x (may work with 4.x but expect bugs)
- **Content Collections**: Must use the `glob` loader and have a schema defined with `defineCollection`
- **Configuration**: Requires `src/content/config.ts` or `src/content.config.ts`

Non-markdown/MDX files in collections are ignored.

Default directory structure (all paths are configurable per project and per collection):

```
my-astro-site
└── src
    ├── assets/mycollection/      # Images and media
    ├── components/mdx/            # Astro/React/Vue/Svelte components for MDX
    ├── content/mycollection/      # Markdown and MDX files
    └── content.config.ts          # Collection definitions
```

## Astro Editor+

This is a fork of Astro Editor, published as **Astro Editor+**. It adds git and GitHub publishing and a dev-server panel on top of the original editor, has its own app identity (so it installs alongside the original), updates from this repository's releases, and sends no telemetry.

**Install:**

1. Download the latest `.dmg` from the [Releases page](https://github.com/GustavoGomez092/astro-editor/releases) and drag **Astro Editor+** into Applications.
2. Releases signed with an Apple Developer ID are notarised by Apple and open normally, with no "Open Anyway" step. Releases built without the Apple secrets fall back to a self-signed certificate, which macOS blocks on first launch: try to open the app once, then go to **System Settings -> Privacy & Security**, scroll to the message about "Astro Editor+" and click **Open Anyway**. Later updates install from inside the app.
3. When updating from a self-signed build to a Developer ID build, the signing identity changes, so macOS may ask for Keychain access once (for example, for the saved GitHub token). Choose Always Allow; it does not ask again for later Developer ID releases.

## Installation

See [Astro Editor+](#astro-editor) above. Requires macOS 12 or later. Download the `.dmg` from this fork's [Releases](https://github.com/GustavoGomez092/astro-editor/releases); the Homebrew cask belongs to the original app and does not install this fork.

**Other Platforms:** The fork's releases are macOS-only. To run on Windows or Linux, build from source (see [Contributing](docs/CONTRIBUTING.md)); these are not officially supported.

## Documentation

- **[Documentation](https://astroeditor.danny.is/getting-started/)** - Complete feature documentation
- **[Contributing](docs/CONTRIBUTING.md)** - Development setup and guidelines

## Disclaimer

Work in progress. Commit your Astro project regularly when using the editor.

## Contributing

Bug reports and feature requests are welcome. See the [issue tracker](https://github.com/dannysmith/astro-editor/issues).

**Project Philosophy:**

- This is a tool for "writer mode", not "coder mode". Features related to git, publishing, deployment, or code editing are out of scope.
- The UI is intentionally opinionated for simplicity. Customization options are limited to what's needed to work with different Astro project structures.

Pull requests welcome. See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for development setup.

## Roadmap

See the [GitHub Project](https://github.com/users/dannysmith/projects/5/)

## Credits

- [iA Writer](https://ia.net/writer) for inspiration and [typography](https://github.com/iaolo/iA-Fonts)
- [DarkMatter](https://getdarkmatter.dev/) by [Vadim Demedes](https://vadimdemedes.com/)

## Development

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) and [developer docs](docs/developer/) for setup and architecture details.

**Quick start:**

```bash
bun install
bun run reset:testdata  # Creates test Astro project
bun run tauri:dev   # Starts dev server
```

**Development commands:**

```bash
bun run check:all       # Run all checks (TypeScript, Rust, tests)
bun run fix:all         # Auto-fix linting/formatting issues
```
