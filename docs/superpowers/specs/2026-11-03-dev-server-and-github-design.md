# Dev server control and a GitHub panel for Astro Editor

Status: draft for approval · 2026-11-03 · fork `GustavoGomez092/astro-editor`

## Why

Astro Editor is a great place to write, but a writer still has to leave it twice: to see the site (start a dev server in a terminal) and to publish (commit and push with git). For a non-technical site owner, both steps are where things go wrong. The first user is a designer, not a developer, who edits his Astro site in Astro Editor; the site deploys automatically when `main` is pushed, and previews when `staging` is pushed. He should be able to preview, publish and review history without a terminal or a second app.

Success: he opens his project, clicks **Preview** to see the site, edits, clicks **Publish**, and it's live, all inside the app. When he wants a preview first, he works on a branch and opens and merges a pull request from the app. He can see what changed and when in a visual history.

The work is built so it can be offered upstream as pull requests. The upstream project says git and publishing are out of scope, so each feature is self-contained, optional, and can be switched off; the maintainer may decline it, and the fork carries it either way.

## Goals

1. **Dev server, one button.** Start and stop the project's dev server from the title bar; open the site in the browser; see why it failed when it does; never leave a server running after the app closes or the project changes.
2. **Publish.** See changed files and their diffs, write a message, commit and push in one click.
3. **Sync.** Fetch on project open and on demand; fast-forward when it's safe; explain clearly when it isn't.
4. **Branches and pull requests.** Switch and create branches; push a branch; open a pull request into the default branch; see open pull requests and merge one, from the app.
5. **Commit graph.** A visual history: commits on coloured lanes with merges and branch labels; click a commit to see what changed.
6. **Sign in with GitHub** via the OAuth device flow; the token lives in the macOS Keychain.

## Non-goals

- A general git client: no staging individual hunks, no rebase, no stash UI, no cherry-pick, no submodules, no LFS, no SSH-key management. Changes are committed together.
- Hosts other than GitHub for pull requests and sign-in (plain git push to any HTTPS remote still works with the GitHub token only for github.com).
- Resolving merge conflicts inside the app. On a conflict the app stops, leaves the repo as it was, and says what to do.
- An embedded site preview inside the editor window (the site opens in the default browser).

## Anti-goals (failure even if it "works")

- Losing a writer's edits: no operation may discard uncommitted changes. Checkout and fast-forward only proceed when libgit2's safe checkout succeeds.
- Leaving orphan dev-server processes after quit, crash of the webview, project switch or window close.
- Git jargon in the main path. Buttons say **Preview**, **Publish**, **Sync**, **Open pull request**, **Merge**; the commit graph can show git terms.
- Breaking upstream rules (Zustand selectors, tokens for colour, plugin-log, React Compiler, `check:all`).
- Blocking the UI: every git and network call runs off the main thread and shows progress.

## Constraints

- Tauri 2 + React 19 + Zustand + TanStack Query, the rules in the repo's `AGENTS.md`, `docs/developer/architecture-guide.md`, `ui-patterns.md`, `color-system.md`. Tests for `lib/` logic and anything easy to break; `bun run check:all` passes; docs updated in `docs/developer/`.
- Commands are typed with specta and exported to `src/lib/bindings.ts` (generated; never hand-edited in the final branch).
- macOS first (the supported platform). Windows and Linux must compile; behaviour there can be best-effort.
- Git via the `git2` crate (vendored libgit2), so it works on a Mac without the Xcode command-line tools. Network auth for github.com uses the signed-in token (`x-access-token` + token over HTTPS).
- GitHub sign-in: OAuth App device flow (no client secret needed). The client ID is compiled in from `ASTRO_EDITOR_GITHUB_CLIENT_ID` (`option_env!`), with an override in Preferences → Advanced so a build without it can still be configured. Scope `repo`. Token in the Keychain (`keyring` crate); never in preferences files or logs.
- Off by default upstream: a General preference **Show Git and preview tools** (default `false` upstream, `true` in the fork build via a compile-time default). Everything below is hidden when it's off.

## The design

### 1. Dev server

**Title bar:** a **Preview** button (play icon) when stopped; while starting, a spinner; when running, a split control: **Open site** (opens the URL) and **Stop**. A small status dot shows the state; its tooltip shows the URL or the error. Clicking the dot opens a popover with the last ~200 lines of server output and a Copy button.

**What runs:** the project's `dev` script from `package.json`, through the package manager its lockfile implies (`bun.lock(b)` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm). Project settings get an optional **Dev command** override. If there's no `dev` script and no override, the button explains that.

**Dependencies:** before starting, if `node_modules` is missing or the lockfile is newer than `node_modules/.package-lock.json` (npm) or the package manager's equivalent marker, the app runs the install command first (`npm ci`/`npm install`, `bun install`, …) and shows **Installing…**. If no Node/package manager can be found in the login shell, the error says so in plain words with a link to nodejs.org.

**Environment:** spawned through the user's login shell (`$SHELL -lc "<command>"`, falling back to `/bin/zsh`) in the project root, so `PATH` includes nvm, Homebrew and similar. (Apps launched from the Dock don't inherit the shell's `PATH`; this is exactly what broke editors launched from the Dock on the first user's Mac.) The child gets its own process group.

**Ready and URL:** stdout/stderr are read line by line (ANSI stripped). The first `http://localhost:<port>` or `http://127.0.0.1:<port>` URL marks it **Running** and sets the URL. If the process exits before that, it's **Error**, with the last output lines as the reason. Astro's "Another astro dev server is already running … URL: …" message is recognised: the state becomes **Running (external)** with that URL, and Stop explains that this server was started elsewhere.

**Stopping:** SIGTERM to the process group, SIGKILL after 3 s. Stop happens on: the Stop button; opening another project; app quit (the existing quit flow in `commands/quit.rs`, plus `RunEvent::Exit` as a backstop); and the real window close on Windows and Linux. On macOS, closing the window only hides the app (see `cross-platform.md`), so the server keeps running until quit. A Rust `Drop` on the managed state kills any remaining group too.

**Interface (Rust → TS, specta):**

```ts
type DevServerStatus = 'stopped' | 'installing' | 'starting' | 'running' | 'external' | 'error'
interface DevServerState { status: DevServerStatus; url: string | null; command: string | null; pid: number | null; error: string | null }
commands.devServerStart(projectPath: string): Promise<DevServerState>
commands.devServerStop(projectPath: string): Promise<DevServerState>
commands.devServerState(projectPath: string): Promise<DevServerState>
// DevServerStatus also includes 'installing'
commands.devServerLogs(projectPath: string): Promise<string[]>
// event "dev-server-state" with payload DevServerState on every change
```

### 2. GitHub sign-in

Preferences gets a **GitHub** pane: **Sign in with GitHub** → shows the one-time code large, a **Copy code & open GitHub** button (opens `verification_uri`), and waits (polling at the given interval) until done, expired or denied. Signed in: avatar, login, **Sign out**. The same sign-in sheet opens from the Git panel when an action needs it.

```ts
interface GitHubAuthStatus { signedIn: boolean; login: string | null; name: string | null; avatarUrl: string | null }
interface DeviceCode { userCode: string; verificationUri: string; expiresIn: number; interval: number }
commands.githubAuthStatus(): Promise<GitHubAuthStatus>
commands.githubDeviceStart(): Promise<DeviceCode>
commands.githubDevicePoll(): Promise<GitHubAuthStatus>   // resolves when signed in; rejects with a readable message on expiry/denial
commands.githubSignOut(): Promise<void>
```

### 3. Git panel

A **Publish** button in the title bar with a badge for the number of changed files opens the **Git panel**, shown as a tab in the left sidebar (**Files | Changes**), kept mounted per the rules. Not a git repo: the panel says so and offers nothing else.

**Changes tab:** current branch (menu: switch to a branch, **New branch…**), ahead/behind counts, **Sync** button, list of changed files with status icons (click → diff in the main area, read-only, unified view; binary files show "Image changed" with before/after thumbnails when they're images), a message box (pre-filled from the changed entries' titles, editable), and **Publish** (commit all + push), with the branch name beneath it. The app doesn't know what a branch deploys, so the label never promises "live".

**Fetching needs sign-in:** for github.com remotes, fetch/sync/publish use the signed-in token; when not signed in, the panel shows **Sign in with GitHub** instead of failing on every fetch. A 404/403 from GitHub becomes "Your GitHub account doesn't have access to this repository".

**Sync rules:** fetch; if behind and the working tree is clean or the incoming changes don't touch locally changed files → fast-forward (safe checkout). If diverged with a clean tree → merge commit, unless that conflicts → abort, leave everything as it was, show "Your changes and the changes on GitHub both edited <file>. Publish isn't possible until that's sorted out" with a link to open the repo on GitHub. Fetch on project open and every 5 minutes while the app is focused; never merge automatically on open, only fast-forward when clean.

**Publish rules:** commit all changes locally first, then fetch; if the upstream has new commits, merge them in (a clean merge is committed automatically). If the merge conflicts, abort it: the writer's commit stays safely in the local repo, nothing is pushed, and the message explains that the same lines were changed on GitHub. Then push. This also covers a previous push that failed offline (local commits are pushed with the next Publish). Commit author: the repo's/user's git config if set, else the GitHub profile name and `<id>+<login>@users.noreply.github.com`. Push the current branch, setting upstream `origin/<branch>` if missing.

**Keeping a preview branch current:** when the current branch is behind the default branch (for example a long-lived `staging` branch after a pull request was merged), the panel offers **Bring in changes from <default>** (merge the default branch into the current one, same conflict rules).

**Pull requests:** in the Changes tab, when the current branch isn't the default branch: **Open pull request** (title, description; base = default branch) and, when one is open for this branch, its status (checks summary, mergeable) with **Merge** (merge commit only, so a long-lived branch never drifts from the default branch) and **View on GitHub**. After a merge the app stays on the current branch and fetches. A **Pull requests** list (open ones for the repo) sits under the branch menu.

**History (commit graph):** a **History** view in the main area (from the panel and the command palette). Up to the latest 300 commits across local and remote branches. Each row: lane graphics (dots, coloured lines, merge curves), summary, branch/tag labels, author, relative date. Click → commit details panel: message, author, date, files changed, each opening its diff. Lane layout is a pure TS function in `src/lib/git/graph-layout.ts` with unit tests; rendering is SVG, colours from new tokens in `App.css`.

**Interface (Rust → TS, specta):**

```ts
type FileChange = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
interface ChangedFile { path: string; oldPath: string | null; change: FileChange }
interface GitStatus { isRepo: boolean; branch: string | null; defaultBranch: string | null; upstream: string | null; ahead: number; behind: number; files: ChangedFile[]; detached: boolean }
interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }
interface DiffHunk { header: string; lines: DiffLine[] }
interface FileDiff { path: string; binary: boolean; isImage: boolean; hunks: DiffHunk[] }
type SyncOutcome = 'upToDate' | 'fastForwarded' | 'merged' | 'blockedByLocalChanges' | 'conflict' | 'noUpstream'
interface SyncResult { outcome: SyncOutcome; message: string; status: GitStatus }
interface PublishResult { commitId: string; pushed: boolean; outcome: SyncOutcome; message: string; status: GitStatus }
interface BranchInfo { name: string; isRemote: boolean; isHead: boolean; upstream: string | null; ahead: number; behind: number; lastCommitTime: number }
type RefKind = 'head' | 'localBranch' | 'remoteBranch' | 'tag'
interface GraphCommit { id: string; shortId: string; parents: string[]; summary: string; authorName: string; time: number; refs: { name: string; kind: RefKind }[] }
interface CommitDetails extends GraphCommit { message: string; authorEmail: string; files: ChangedFile[] }
interface RepoInfo { owner: string; repo: string; defaultBranch: string; htmlUrl: string }
interface PullRequest { number: number; title: string; head: string; base: string; state: 'open' | 'closed' | 'merged'; draft: boolean; htmlUrl: string; mergeable: boolean | null; checks: 'pending' | 'success' | 'failure' | 'none' }
commands.gitStatus(projectPath): Promise<GitStatus>
commands.gitFileDiff(projectPath, path): Promise<FileDiff>              // working tree vs HEAD
commands.gitFetch(projectPath): Promise<GitStatus>
commands.gitSync(projectPath): Promise<SyncResult>
commands.gitPublish(projectPath, message): Promise<PublishResult>       // commit, merge incoming, push
commands.gitPush(projectPath): Promise<GitStatus>
commands.gitBranches(projectPath): Promise<BranchInfo[]>
commands.gitCheckout(projectPath, name, create): Promise<GitStatus>     // safe checkout; never discards changes
commands.gitLogGraph(projectPath, limit): Promise<GraphCommit[]>        // topological, newest first
commands.gitCommitDetails(projectPath, id): Promise<CommitDetails>
commands.gitCommitFileDiff(projectPath, id, path): Promise<FileDiff>    // commit vs first parent
commands.githubRepoInfo(projectPath): Promise<RepoInfo | null>          // null if origin isn't github.com
commands.githubListPullRequests(projectPath): Promise<PullRequest[]>
commands.githubCreatePullRequest(projectPath, title, body, base, head): Promise<PullRequest>
commands.githubMergePullRequest(projectPath, number): Promise<PullRequest>   // merge commit
commands.gitMergeDefaultBranch(projectPath): Promise<SyncResult>             // "Bring in changes from main"
```

Errors are `Result<_, String>` with plain-language messages (the frontend shows them as toasts; details go to the log).

### 4. Editor fixes found in end-to-end testing (each its own upstream pull request)

Found while editing a real site through the dev build's agent bridge:

1. **Re-clicking the open entry wipes it (data loss).** `editorStore.openFile` clears the content even when the file being opened is already open, and the loader doesn't reload it; the next keystroke saves a blank form over the file. Fix: return early when `currentFile?.id === file.id`. Regression test.
2. **The `content.config.ts` export parser** ignores `export const collections = { 'a-b': x, … }` (quoted keys) and trailing commas, falls back to a directory scan, and so loses `image()` fields. Accept quoted keys and trailing commas. Tests.
3. **New file writes empty required values** (`image: ""`, `width: 0`, `email: ""`), so the project's build fails immediately. Omit required fields that have no default instead of writing empty values, and ask for a name first so the file name follows the title (not today's date).
4. **No validation before save.** Check values against the schema (required, email/url format, min/max, integer, enum) when a field loses focus and before save; show the message under the field and a warning toast on save ("Saved, but 2 fields need attention"), never block saving.
5. **Order sort** starts descending and resets. Default to ascending, and remember the sort per collection in the project settings.
6. **Body editor for collections without body text**: a per-collection setting "This collection has no body text" that hides the editor; detected automatically when no entry has a body.
7. **Labels**: hide "Copy as slug" unless the collection has a URL pattern; hide an empty "Default:"; don't repeat a min–max hint that the description already gives; show collection names as words ("Floating" not "floating"), in the order of the config.

### 5. Fork-only changes (branch `kr`, never in upstream pull requests)

- App identity: product name **Astro Editor+**, identifier `is.gustavogomez.astroeditorplus`, so it installs beside the official app and keeps its own preferences.
- Signing: a stable self-signed code-signing certificate (kept as a repo secret) instead of a fresh ad-hoc signature per build, so the Keychain keeps trusting the app across updates and doesn't ask for the Mac password again.
- Updater: points at the fork's releases with the fork's own updater signing key (generated with `tauri signer`, private key as a repo secret); telemetry: off.
- The upstream website and release-notes workflows are removed; the release workflow builds an unsigned, ad-hoc-signed universal macOS app on a version tag (no Apple Developer ID is available) and publishes it with `latest.json`. The README's install section explains the one-time **Open anyway** step.
- `ASTRO_EDITOR_GITHUB_CLIENT_ID` comes from a repo variable at build time.
- The Git/preview preference defaults to on.

## Decided by the project owner

Sign in with GitHub (device flow); a public fork with release builds; first version includes commit & push, branches and pull requests, the commit graph, and pull/sync; finished features are offered upstream as pull requests.

## Left to the builder

Exact component structure and file names (following `ui-patterns.md`), icons (Lucide, as the app uses), polling intervals within the limits above, diff rendering details, and how the graph's lane colours map to tokens.

## Builder-level calls already made (the owner can overrule)

- `git2` (vendored) instead of shelling out to `git`, so it works on a Mac without developer tools.
- One commit with all changes (no partial staging).
- Merge commits only, for sync, "Bring in changes" and pull requests (no squash).
- Publish commits locally before merging incoming changes; conflicts abort the merge and keep the commit.
- Preview installs missing or stale dependencies itself.
- The dev server survives closing the window on macOS (the app is still running) and stops on quit or project switch.
- Stable self-signed signing so Keychain access survives updates.
- Diffs and the graph are read-only views; no conflict resolution in-app.
- A single preference switches everything on or off, off by default upstream.
