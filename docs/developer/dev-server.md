# Dev server

The title bar's **Preview** control runs the project's dev server so a writer can see the site without a terminal: start it, open the site in the browser, stop it, and read its output when it fails. It's hidden unless the General preference **Show preview and publishing tools** (`general.showPublishingTools`) is on.

## How it fits together

- **Rust (`src-tauri/src/dev_server/`)** owns the processes. `detect.rs` works out what to run and reads the output; `process.rs` starts and stops servers; `mod.rs` holds the types and `DevServers`, the managed state with one server per project path. The commands are in `commands/dev_server.rs`: `devServerStart`, `devServerStop`, `devServerState` and `devServerLogs`, all taking the project path.
- **Every state change emits `dev-server-state`** with the new `DevServerState`. `useDevServer` treats the event as a signal and reads the state again for the open project, so a late event from the previous project's server can't show up in the title bar.
- **The UI** is `components/dev-server/`: `PreviewButton` (connected to the stores and queries) renders `PreviewControl` (one state, no stores, which the styleguide's `dev-server` section shows in every state) and `DevServerOutput` (the output popover). The actions and the text helpers are plain functions in `lib/dev-server/`.

## What runs

- **The command** is the project's **Dev command** (Project Settings, `devCommand`) if set, else the `dev` script through the package manager its lockfile implies: `bun.lock`/`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, anything else → npm. Without either, starting fails with a message that says so. Rust reads the override straight from the project's preferences file (via `project-registry.json`), because the commands take only the path.
- **Dependencies are installed first** when `node_modules` is missing or the lockfile is newer than the package manager's install marker (`node_modules/.package-lock.json`, `.yarn-state.yml`, `.modules.yaml`, `.bun-tag`, or the `node_modules` folder's own time). The status is `installing` meanwhile. npm uses `npm ci` when there's a `package-lock.json`, so installing never rewrites the lockfile and shows up as a change to publish; the others use `<pm> install`.
- **Through the login shell:** `$SHELL -lc "<command>"` (falling back to `/bin/zsh`), in the project folder. An app opened from the Dock doesn't get a terminal's `PATH`, so without the login shell it wouldn't find Node from nvm or Homebrew. A login shell reads `.zprofile` but not `.zshrc`, so Node set up only in `.zshrc` isn't found; the error then says Node couldn't be found and links to nodejs.org. Windows uses `cmd /C`.
- **Its own process group** (`process_group(0)`): the shell leads a group that holds everything the server starts (npm, Astro, Vite, esbuild), so stopping signals the group rather than one process.

## Ready, failed, already running

Output is read line by line from stdout and stderr, with colour codes stripped, and the last 200 lines are kept for the popover.

- The first `http://localhost:<port>`, `127.0.0.1` or `[::1]` URL marks it `running`.
- Astro's "Another astro dev server is already running" message, followed by its URL, marks it `external`: the site is up, but Astro Editor didn't start it and can't stop it. Stop then only clears the state and says so.
- Exiting before a URL is `error`; exiting after one is `error` too ("stopped unexpectedly"). Each error is a plain-words first line followed by the last output lines. The status dot's tooltip shows the first output line that reads as an error (`firstErrorLine`), except when Node is missing, where the first line already says what to do.
- When the shell exits by itself, whatever it left in its group is killed, so a crash leaves no orphans.

## Stopping

SIGTERM to the process group, then SIGKILL if anything in it is still there after 3 seconds. It stops on:

- the Stop button;
- opening another project (`projectStore.setProject`, which doesn't wait for it);
- quitting: `quit_app` and the quit timeout stop every server before the app is allowed to quit, on a thread of their own since it can take a few seconds, and `RunEvent::Exit` does it again as a backstop. On Windows and Linux, closing the window quits, so it goes the same way.

On macOS, closing the window only hides the app (see `cross-platform.md`), so the server keeps running until quit or a project switch. `Drop` on the managed state kills any group still running, if Tauri drops it at all on exit.

A run counter keeps an old run's threads from changing a newer run's state, and the server is spawned after a successful install with the lock held, so a Stop during the install either sees the server's process or prevents it from starting.

## Gotchas

- **Logs are tagged `Astro Editor [DEV_SERVER]`:** each command run, each stop and how each run ended. The server's own output stays in the popover, not the log.

- **Astro backgrounds itself when it thinks an AI agent started it.** Astro 7 checks for agent environment variables (`CLAUDECODE`, `AI_AGENT` and others, via `am-i-vibing`), switches to JSON output and starts a detached server that outlives its process group. A dev app launched from an agent's terminal passes those on, so for agent testing start `tauri:dev` without them (for example `env -u CLAUDECODE -u AI_AGENT bun run tauri:dev`). An app opened from the Dock doesn't have them.
- **Tests replace the login shell** with a script that skips the user's profile (`Config::shell`), so they control `PATH` and fake npm with small shell scripts.
