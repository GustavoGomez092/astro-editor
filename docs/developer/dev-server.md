# Dev server

The title bar's **Preview** control runs the project's dev server so a writer can see the site without a terminal: start it, open the site in the browser, stop it, and read its output when it fails. It's hidden unless the General preference **Show preview and publishing tools** (`general.showPublishingTools`) is on.

## How it fits together

- **Rust (`src-tauri/src/dev_server/`)** owns the processes. `detect.rs` works out what to run and reads the output; `process.rs` starts and stops servers; `mod.rs` holds the types and `DevServers`, the managed state with one server per project path. The commands are in `commands/dev_server.rs`: `devServerStart`, `devServerStop`, `devServerState`, `devServerLogs` and `devServerPrepare`, all taking the project path.
- **Every state change emits `dev-server-state`** with the new `DevServerState`. `useDevServer` treats the event as a signal and reads the state again for the open project, so a late event from the previous project's server can't show up in the title bar.
- **The UI** is `components/dev-server/`: `PreviewButton` (connected to the stores and queries) renders `PreviewControl` (one state, no stores, which the styleguide's `dev-server` section shows in every state) and `DevServerOutput` (the output popover). The actions and the text helpers are plain functions in `lib/dev-server/`.

## What runs

- **The command** is the project's **Dev command** (Project Settings, `devCommand`) if set, else the `dev` script through the package manager its lockfile implies: `bun.lock`/`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, anything else → npm. Without either, starting fails with a message that says so. Rust reads the override straight from the project's preferences file (via `project-registry.json`), because the commands take only the path.
- **Dependencies are installed first** when `node_modules` is missing or the lockfile is newer than the package manager's install marker (`node_modules/.package-lock.json`, `.yarn-state.yml`, `.modules.yaml`, `.bun-tag`, or the `node_modules` folder's own time). The status is `installing` meanwhile. npm uses `npm ci` when there's a `package-lock.json`, so installing never rewrites the lockfile and shows up as a change to publish; the others use `<pm> install`.
- **With the user's `PATH`** (`env_path.rs`). An app opened from the Dock gets launchd's bare `PATH`, and a login shell alone (`-l`) skips `~/.zshrc`, where the nvm, fnm and bun installers put themselves. So the first time it's needed, the app runs `$SHELL -ilc` (falling back to `/bin/zsh`) to print `PATH` between markers, with stdin `/dev/null`, its own process group, `ASTRO_EDITOR_RESOLVING_ENVIRONMENT=1` (a `.zshrc` can test it to skip slow setup) and an 8-second timeout that kills the group. Only `PATH` is kept; prompts and greetings around the markers are ignored. The well-known folders that exist are appended either way: nvm's `default` alias, Volta, fnm's default, `~/.bun/bin`, `$PNPM_HOME`, asdf and mise shims, `/opt/homebrew/bin`, `/usr/local/bin`. If the shell fails, the app's own `PATH` stands in for its answer. The result is kept for the app's life, so a change to `.zshrc` needs a restart. Nothing resolves it at launch, so the user's shell never runs for someone who doesn't use the tools: `devServerState` (which the Preview control asks for first), `devServerStart` and `devServerPrepare` start it on a thread of its own (`env_path::warm_up`, once), and a start waits for it.
- **`/bin/sh -c "<command>"`** in the project folder, with that `PATH` (the install step too). Windows uses `cmd /C`.
- **A cleaned environment.** Variables that make tools behave differently depending on how the app was launched are removed: AI-agent markers (`CLAUDECODE`, `CLAUDE_CODE_*`, `AI_AGENT`, `CODEX_*`, `GEMINI_CLI`, `CURSOR_*`, `TERM_PROGRAM` and the rest that `am-i-vibing` checks; with them, Astro 7 switches to JSON output and starts a detached server that escapes the process group), and `npm_*`, `INIT_CWD`, `NODE_ENV`, `PORT`, `HOST` and `NODE_OPTIONS`, which belong to whatever started the app. The list is `REMOVED_VARIABLES` in `process.rs`.
- **Its own process group** (`process_group(0)`): the shell leads a group that holds everything the server starts (npm, Astro, Vite, esbuild), so stopping signals the group rather than one process.

## Preparing a project

`devServerPrepare` gets a freshly cloned or opened project ready to edit without starting a server: it installs dependencies when they're needed (status `installing`, stoppable like a start's install), then runs `astro sync` through the package manager (`npx astro sync`, `pnpm exec astro sync`, `yarn astro sync`, `bunx astro sync`) with the same `PATH` and cleaned environment, which writes the collection schemas into `.astro/` so the frontmatter forms have them. It blocks until done and returns `stopped`, or `error` with a plain first line and the last output lines (stored, so the Preview control shows it; Start is available again). With a server installing, starting or running, it only syncs and returns the server's state, leaving the server alone. A project whose `package.json` doesn't list `astro` is left alone. `astro sync` gets 3 minutes before its group is killed.

## Ready, failed, already running

Output is read line by line from stdout and stderr, with colour codes stripped and each line cut to 4 KB, and the last 200 lines are kept for the popover.

- The first `http://localhost:<port>`, `127.0.0.1` or `[::1]` URL marks it `running`.
- Astro's "Another astro dev server is already running" message, followed by its URL, marks it `external`: the site is up, but Astro Editor didn't start it and can't stop it. Stop then only clears the state and says so.
- Exiting before a URL is `error`; exiting after one is `error` too ("stopped unexpectedly"). Each error is a plain-words first line followed by the last output lines. The status dot's tooltip shows the first output line that reads as an error (`firstErrorLine`), except when Node is missing, where the first line already says what to do.
- A shell that can't find the command's own program (exit 127) gets a message that says what to do: for `node`, `npm`, `npx`, `pnpm`, `yarn` and `corepack` (or `env: node: No such file or directory` from a script) it links to nodejs.org, for `bun` to bun.sh, and for anything else it points to the Dev command in Project Settings. A program missing further in, like `astro` when dependencies aren't installed, gets the ordinary error with the output.
- When the shell exits by itself, whatever it left in its group is killed, so a crash leaves no orphans.

## Stopping

SIGTERM to the process group, then SIGKILL if anything in it is still there after 3 seconds. It stops on:

- the Stop button;
- opening another project (`projectStore.setProject`, once the new project has loaded, without waiting for it);
- turning **Show preview and publishing tools** off (`projectStore.updateGlobalSettings`);
- quitting: `quit_app` and the quit timeout stop every server before the app is allowed to quit, on a thread of their own since it can take a few seconds (meanwhile they wait for running git commands; see `git-and-github.md`). A guard quits when it's dropped, so a panic while stopping can't stop the app quitting, and the server locks recover from poisoning. And `RunEvent::Exit` does it again as a backstop. On Windows and Linux, closing the window quits, so it goes the same way.

On macOS, closing the window only hides the app (see `cross-platform.md`), so the server keeps running until quit or a project switch. `Drop` on the managed state kills any group still running, if Tauri drops it at all on exit.

A run counter keeps an old run's threads from changing a newer run's state, and the server is spawned after a successful install with the lock held, so a Stop during the install either sees the server's process or prevents it from starting.

## Gotchas

- **Logs are tagged `Astro Editor [DEV_SERVER]`:** each command run, each stop and how each run ended. The server's own output stays in the popover, not the log.

- **The output popover closes when the server stops,** so it doesn't reopen by itself on the next start or keep polling the logs.
- **Tests set `PATH` themselves** (`Config::path`) instead of resolving the user's, and fake npm and servers with small shell scripts. `env_path.rs`'s tests use a fake `$SHELL` and a temporary home.
