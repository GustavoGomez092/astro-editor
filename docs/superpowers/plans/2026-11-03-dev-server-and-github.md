# Dev Server, GitHub Panel and Editor Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-button dev-server control, a GitHub panel (sign-in, clone, publish, sync, branches, pull requests, commit graph) and seven editor fixes to Astro Editor, as upstream-ready branches, plus a fork release build ("Astro Editor+").

**Architecture:** Rust owns processes, git (git2, vendored libgit2), GitHub HTTP (reqwest) and the Keychain (keyring); each area is a `commands/<area>.rs` module registered in `bindings.rs`, typed to TS by specta. React UI reads them through TanStack Query hooks and Zustand per the repo's rules. Five workstreams run in parallel on separate branches cut from upstream `main`; the fork branch `kr` merges them.

**Tech Stack:** Tauri 2, Rust (git2 with `vendored-libgit2`, `keyring`, existing reqwest/tokio), React 19, Zustand, TanStack Query, Vitest, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-11-03-dev-server-and-github-design.md` (read it first; its TS interfaces are binding).

## Global Constraints

- Follow the repo's `AGENTS.md` Rules verbatim (Zustand selectors only, `getState()` in callbacks, no React Hook Form, hooks in `hooks/`, colours only via `App.css` tokens, log via `@tauri-apps/plugin-log`, keep stateful panels mounted, React-Compiler-compatible, test in the app).
- `bun run check:all` passes on every branch before it's handed back. Add Vitest tests for `lib/` logic and Rust unit tests for command logic; update `docs/developer/` for any new pattern.
- Commands return `Result<T, String>` with plain-language messages; never log tokens.
- Names exactly as the spec's interfaces (camelCase in TS via specta `rename_all = "camelCase"`).
- Every workstream branch is cut from `upstream/main` (commit `974962a`), except W5 (`kr`). One concern per branch so each can become one upstream pull request.
- Feature visibility: preference `general.showPublishingTools: boolean`, default `false` (W3 adds it; W2 adds the identical field if its branch doesn't have it yet). All W2/W3 UI is hidden when it's false.
- Git safety: no operation discards uncommitted changes; checkouts and fast-forwards use libgit2 safe checkout; merges that conflict are aborted with the repo restored.
- GitHub client ID: `option_env!("ASTRO_EDITOR_GITHUB_CLIENT_ID")`, overridable by preference `advanced.githubClientId: string | null`. Scope `repo`. Token in Keychain service `<app identifier>.github`, account `token`.
- Testing harness: `bun run tauri:dev` + `bun run app …` (see `docs/developer/agent-tooling.md`, `.claude/skills/app-control/SKILL.md`). Each worktree uses its own `CARGO_TARGET_DIR` default (inside the worktree); only one dev app may run at a time per bridge port, so stop yours when done.

## Review Focus

1. **Offline / GitHub unreachable** while publishing or syncing → a plain message, the local commit kept, the app usable. (W1 Task 4 test `publish_keeps_commit_when_push_fails`.)
2. **Project folder isn't a git repo, or `origin` isn't github.com** → panel shows "not a git repository" / git works but PR buttons are hidden. (W1 Task 2 `status_non_repo`, Task 6 `repo_info_non_github_is_none`.)
3. **Dev server fails to start** (no `dev` script, Node missing, port in use, crash after start) → status `error` with the last output lines, Start available again, no orphan process. (W3 Task 2 tests.)
4. **App quit while the dev server is installing or starting** → whole process group killed. (W3 Task 3 `stop_kills_process_group`.)
5. **Switching branch with uncommitted edits** that conflict with the target → refused with a message; edits untouched. (W1 Task 5 `checkout_refuses_when_it_would_overwrite`.)

---

## W1 — Git and GitHub engine (Rust) · branch `feat/git-engine`

### Task 1: Command surface stubs + bindings (do first; W2 rebases on it)

**Files:** Create `src-tauri/src/commands/git.rs`, `src-tauri/src/commands/github.rs`, `src-tauri/src/git/mod.rs` (models); modify `src-tauri/Cargo.toml` (`git2 = { version = "0.20", features = ["vendored-libgit2", "https"] }`, `keyring = "3"` with macOS native backend), `src-tauri/src/commands/mod.rs`, `src-tauri/src/bindings.rs`, regenerate `src/lib/bindings.ts`.

**Produces:** every git/GitHub command and type in the spec (§2, §3), plus for clone (Option A):
`interface RepoSummary { fullName: string; owner: string; name: string; private: boolean; defaultBranch: string; cloneUrl: string; updatedAt: string }`,
`commands.githubListRepos(): Promise<RepoSummary[]>`,
`commands.gitClone(cloneUrl: string, parentDir: string): Promise<string>` (returns the new project path).
Stubs return `Err("not implemented")`.

- [ ] Step 1: Define the models with `#[derive(Serialize, Deserialize, specta::Type)] #[serde(rename_all = "camelCase")]`; enums serialize as the spec's string literals.
- [ ] Step 2: Register all commands in `bindings.rs`; run `cd src-tauri && cargo test export_bindings -- --ignored`; expected: `src/lib/bindings.ts` contains `gitStatus`, `githubDeviceStart`, `gitClone`, `githubListRepos`.
- [ ] Step 3: `bun run typecheck` passes. Commit `feat(git): command surface for git and GitHub`. **Report the commit SHA immediately** (W2 waits on it).

### Task 2: Status and diffs

**Files:** `src-tauri/src/git/status.rs`, `src-tauri/src/git/diff.rs`, tests in the same files (`#[cfg(test)]`, temp repos via `tempfile` + git2).

- [ ] Tests: `status_non_repo` (plain dir → `isRepo: false`), `status_lists_added_modified_deleted_untracked`, `status_reports_ahead_behind` (local repo with a bare "remote"), `file_diff_text_hunks` (line kinds and numbers), `file_diff_binary_image` (`binary: true, isImage: true` for `.png`).
- [ ] Implement `git_status`, `git_file_diff`, `git_commit_file_diff` (vs first parent; root commit vs empty tree). `defaultBranch` = `origin/HEAD` target, else `main`, else `master`.
- [ ] Tests pass (`bun run rust:test`); commit.

### Task 3: GitHub auth (device flow + Keychain)

**Files:** `src-tauri/src/github/auth.rs`, `src-tauri/src/github/http.rs` (reqwest client, `User-Agent: Astro-Editor`, base URL injectable for tests).

- [ ] Tests (mock server, e.g. `mockito`): `device_start_parses_code`, `device_poll_handles_pending_slowdown_and_success` (`authorization_pending` → keep polling, `slow_down` → interval +5s, success → token stored and `/user` fetched), `device_poll_expired_is_readable_error`.
- [ ] Implement `github_device_start`, `github_device_poll` (polls inside the command until success/expiry; cancellable when `github_sign_out` is called), `github_auth_status` (reads Keychain, `/user`, cached), `github_sign_out` (deletes Keychain entry). Token helper `github::auth::token() -> Option<String>` for other modules.
- [ ] Commit.

### Task 4: Fetch, sync, publish, merge default branch

**Files:** `src-tauri/src/git/remote.rs` (credentials callback: `x-access-token` + token for `github.com` HTTPS; other hosts use git2 default credential helper), `src-tauri/src/git/sync.rs`.

- [ ] Tests with a bare local remote: `sync_up_to_date`, `sync_fast_forwards_clean_tree`, `sync_blocked_when_incoming_touches_local_changes` (outcome `blockedByLocalChanges`, files untouched), `sync_merges_diverged_clean`, `sync_conflict_aborts_and_restores`, `publish_commits_merges_and_pushes`, `publish_keeps_commit_when_push_fails` (remote unreachable → `pushed: false`, commit present, readable message), `publish_sets_upstream_when_missing`, `merge_default_branch_into_staging`.
- [ ] Implement `git_fetch`, `git_sync`, `git_publish(message)` (stage all incl. deletions, commit with git config identity else GitHub profile `name <id+login@users.noreply.github.com>`, fetch, merge incoming per sync rules, push), `git_push`, `git_merge_default_branch`. Run network ops on `tokio::task::spawn_blocking`.
- [ ] Commit.

### Task 5: Branches, checkout, log graph, commit details

**Files:** `src-tauri/src/git/branches.rs`, `src-tauri/src/git/log.rs`.

- [ ] Tests: `branches_lists_local_and_remote_with_ahead_behind`, `checkout_creates_tracking_branch_from_remote`, `checkout_refuses_when_it_would_overwrite` (error message names the file), `checkout_carries_non_conflicting_changes`, `log_graph_topological_with_refs` (merge commit has 2 parents; refs include `head`, local, remote, tag), `log_graph_limit`, `commit_details_files`.
- [ ] Implement `git_branches`, `git_checkout(name, create)`, `git_log_graph(limit)` (revwalk all refs, `TOPOLOGICAL | TIME`, newest first), `git_commit_details(id)`.
- [ ] Commit.

### Task 6: Pull requests, repos, clone

**Files:** `src-tauri/src/github/pulls.rs`, `src-tauri/src/github/repos.rs`, `src-tauri/src/git/clone.rs`.

- [ ] Tests (mock server; local bare repo for clone): `repo_info_parses_https_and_ssh_origins`, `repo_info_non_github_is_none`, `list_prs_maps_checks_and_mergeable`, `create_pr_returns_pr`, `merge_pr_uses_merge_method`, `not_found_becomes_access_message` (404/403 → "Your GitHub account doesn't have access to this repository"), `list_repos_paginates`, `clone_into_parent_dir_returns_path` (refuses if the target folder exists and isn't empty).
- [ ] Implement `github_repo_info`, `github_list_pull_requests` (open; checks = combined status + check-runs of head SHA), `github_create_pull_request`, `github_merge_pull_request` (`merge_method: merge`), `github_list_repos` (`/user/repos?affiliation=owner,collaborator&sort=updated`), `git_clone` (token auth, progress events `git-clone-progress { received, total }`).
- [ ] `bun run check:all` passes; update `docs/developer/` with a `git-and-github.md` (modules, auth, safety rules). Commit.

## W2 — Git panel UI · branch `feat/git-panel-ui`

Start with Tasks 1–2 (pure); before Task 3 rebase onto W1 Task 1's commit (the lead will message you the SHA) so `commands.git*` exist.

### Task 1: Graph lane layout (pure)

**Files:** Create `src/lib/git/graph-layout.ts`, `src/lib/git/graph-layout.test.ts`.

**Produces:** `layoutGraph(commits: GraphCommit[]): GraphRow[]` with `interface GraphRow { commit: GraphCommit; lane: number; colorIndex: number; edges: { fromLane: number; toLane: number; colorIndex: number; kind: 'straight' | 'merge' | 'branch' }[]; laneCount: number }`. (`GraphCommit` from bindings; until rebased, a local copy in `src/lib/git/types.ts` matching the spec exactly, deleted after rebase.)

- [ ] Tests: linear history uses lane 0 only; a branch-and-merge produces a second lane and a `merge` edge back; two parallel branches keep stable lanes and colours across rows; lanes are reused after a branch ends; 300 commits lay out in < 20 ms.
- [ ] Implement (classic "active lanes" algorithm: each lane holds the expected next commit id; a commit takes the lane expecting it or the first free one; its first parent continues the lane, other parents open/merge lanes). Commit.

### Task 2: Diff and commit-graph views (fixture-driven)

**Files:** `src/components/git/DiffView.tsx`, `src/components/git/CommitGraph.tsx` (SVG rows: lane lines, dots, merge curves, ref labels, summary, author, relative date via `lib/dates.ts`), `src/components/git/CommitDetails.tsx`; tokens `--git-lane-0 … --git-lane-7`, `--git-add-bg`, `--git-del-bg` in `src/App.css` (light and dark); styleguide section in `src/styleguide/sections.tsx`.

- [ ] Component tests (Vitest + Testing Library): DiffView renders add/del/ctx with line numbers and "Image changed" for binary images; CommitGraph renders one row per commit and a ref label per ref.
- [ ] Shoot the styleguide section in both themes (`bun run app styleguide`), look at it. Commit.

### Task 3: Git queries and store

**Files:** `src/hooks/queries/useGitStatusQuery.ts`, `useGitBranchesQuery.ts`, `useGitLogQuery.ts`, `usePullRequestsQuery.ts`, `useGitHubAuthQuery.ts`; `src/hooks/mutations/useGitPublishMutation.ts`, `useGitSyncMutation.ts`, `useGitCheckoutMutation.ts`, `useCreatePullRequestMutation.ts`, `useMergePullRequestMutation.ts`, `useMergeDefaultBranchMutation.ts`; keys in `src/lib/query-keys.ts`; `src/store/gitStore.ts` (panel tab `'files' | 'changes'`, selected diff path, history view open, selected commit id).

- [ ] Tests: query keys; mutations invalidate status/branches/log; status refetches every 5 min while focused and on project open (fetch first when signed in, status only otherwise).
- [ ] Commit.

### Task 4: Changes tab, branch menu, pull requests, sign-in sheet

**Files:** `src/components/git/ChangesPanel.tsx`, `BranchMenu.tsx`, `PullRequestCard.tsx`, `OpenPullRequestDialog.tsx`, `SignInSheet.tsx` (large code, Copy code & open GitHub, waiting state, errors); tab switch **Files | Changes** in `src/components/layout/LeftSidebar.tsx` (keep both mounted); **Publish** button with change-count badge in `src/components/layout/unified-title-bar/TitleBarToolbar.tsx`; GitHub pane `src/components/preferences/panes/GitHubPane.tsx` (sign in/out, client ID override); command-palette entries (Publish, Sync, History, New branch) in `src/lib/commands/`.

- [ ] Copy exactly: **Publish** (branch name beneath), **Sync**, **Open pull request**, **Merge**, **View on GitHub**, **Bring in changes from {defaultBranch}**, **Sign in with GitHub**, not-a-repo: "This project isn't a git repository." Message box pre-filled `Update {titles of changed entries, comma-separated, max 3, then "and N more"}`.
- [ ] Drive it in the dev app against a temp copy of `test/dummy-astro-project` pushed to a local bare remote; screenshot each state (clean, changes, behind, conflict message, PR open). Commit.

### Task 5: Open from GitHub (clone)

**Files:** `src/components/git/OpenFromGitHubDialog.tsx` (repo list with search, destination folder default `~/Sites`, progress from `git-clone-progress`), entry points on the welcome/no-project screen and in the project menu/command palette; after clone, open the project (existing open-project action) and, if a dev server exists (W3), install dependencies on first Preview.

- [ ] Test the flow in the dev app against a local bare repo. `bun run check:all`; update `docs/developer/`. Commit.

## W3 — Dev server · branch `feat/dev-server`

### Task 1: Preference and command surface

**Files:** `src-tauri/src/commands/dev_server.rs`, `src-tauri/src/dev_server/{mod,detect,process}.rs`, register in `bindings.rs`, preference `general.showPublishingTools` (General pane toggle "Show preview and publishing tools") and project setting `devCommand: string | null` (Project Settings pane field "Dev command").

**Produces:** spec §1 interface (`devServerStart/Stop/State/Logs`, event `dev-server-state`, statuses incl. `installing`).

- [ ] Tests (`detect.rs`): package manager from lockfile (bun.lock / bun.lockb / pnpm-lock.yaml / yarn.lock / package-lock.json / none → npm); command = override else `<pm> run dev`; `needs_install` when `node_modules` missing or lockfile newer than the install marker (`node_modules/.package-lock.json`, `node_modules/.yarn-state.yml`, `node_modules/.modules.yaml`, `node_modules/.bun-tag` or dir mtime fallback); URL parsing from Astro/Vite lines with ANSI codes; "Another astro dev server is already running" + URL → `external`.
- [ ] Commit.

### Task 2: Process lifecycle

- [ ] Tests (`process.rs`, using small shell scripts as fake servers): `start_reaches_running_on_url_line`, `exit_before_ready_is_error_with_last_lines`, `missing_dev_script_is_readable_error`, `node_not_found_message`, `logs_capped_at_200_lines`, `stop_kills_process_group` (fake server spawns a child; both gone after stop), `stop_escalates_to_sigkill_after_3s`.
- [ ] Implement: spawn `$SHELL -lc "<command>"` (fallback `/bin/zsh`) in the project root with its own process group (`CommandExt::process_group(0)` on unix; Job Object on Windows), stream stdout/stderr lines, emit `dev-server-state` on change; install step first when `needs_install` (status `installing`). One server per project path in managed state.
- [ ] Commit.

### Task 3: Stop on quit and project switch

- [ ] Stop all servers in the quit flow (`commands/quit.rs` before `quit_app` completes) and in `RunEvent::Exit`; `Drop` on the managed state kills remaining groups; stop the previous project's server in `projectStore.setProject` flow; on Windows/Linux real window close. Not on macOS window hide.
- [ ] Verify in the dev app: start the server on a temp Astro project, Cmd+Q, confirm no `astro dev` process remains (`pgrep -f "astro dev"`). Commit.

### Task 4: Title-bar control and output popover

**Files:** `src/components/dev-server/PreviewButton.tsx`, `DevServerOutput.tsx`, `src/hooks/useDevServer.ts` (listens to `dev-server-state`), placed in `TitleBarToolbar.tsx`; styleguide section.

- [ ] Copy: **Preview**, **Installing…**, **Starting…**, **Open site**, **Stop**, error tooltip = first error line; popover title "Server output" with **Copy**. External state tooltip "Running in another window or terminal".
- [ ] Drive in the dev app (start, open, stop, error case with a project whose `dev` script exits 1). `bun run check:all`; update `docs/developer/`. Commit.

## W4 — Editor fixes · one branch each, from `upstream/main`

Each task is its own branch and commit, with a regression test, `check:all`, and a short upstream-style PR description (problem first) saved to `docs/superpowers/prs/<branch>.md` on the branch.

- [ ] **Task 1 `fix/reopen-open-file-wipes-content`:** `editorStore.openFile` returns early when `currentFile?.id === file.id`. Test: opening the already-open file keeps `editorContent` and `frontmatter` unchanged and doesn't mark dirty.
- [ ] **Task 2 `fix/collections-export-parsing`:** the `content.config.ts` export parser accepts quoted keys (`'a-b': x`, `"a-b": x`) and trailing commas, and multi-line objects. Tests in the parser's Rust tests with each form; `image()` detection survives.
- [ ] **Task 3 `fix/new-file-required-fields`:** new files omit required fields without defaults instead of writing `""`/`0`, and include defaults; a name step sets the file name from the title (slugified, unique). Tests for the frontmatter builder; dev-app check on a collection with `image()` and an int field.
- [ ] **Task 4 `feat/field-validation`:** validate against the schema on blur and before save (required, email/url, min/max, int, enum); message under the field; save still happens, with a warning toast "Saved, but N fields need attention". Tests for the validator in `lib/`.
- [ ] **Task 5 `fix/order-sort-direction`:** Order sort defaults to ascending; sort choice persists per collection in project settings. Tests.
- [ ] **Task 6 `feat/collections-without-body`:** hide the body editor when a collection has no body (auto when no entry has body text; per-collection override in Collection Settings). Tests for detection.
- [ ] **Task 7 `fix/frontmatter-label-polish`:** hide "Copy as slug" unless the collection has a URL pattern; hide empty "Default:"; skip the min–max hint when the description already contains both numbers; collection names shown in config order and as words (`floating` → "Floating", `sketch-strip` → "Sketch strip"). Tests.

## W5 — Fork packaging · branch `kr`

### Task 1: Identity, updater, telemetry

- [ ] `tauri.conf.json`: `productName` "Astro Editor+", `identifier` `is.gustavogomez.astroeditorplus`; updater endpoint `https://github.com/GustavoGomez092/astro-editor/releases/latest/download/latest.json` with a new updater public key (generate with `bun tauri signer generate -w ~/.tauri/astro-editor-plus.key` and give the lead the private key path; never commit it); telemetry disabled (skip the startup send). Dev identity overlay updated to match. `general.showPublishingTools` default `true` in the fork via a `cfg`/env flag, not by changing upstream's default in shared code paths.
- [ ] Commit.

### Task 2: Release workflow and signing

- [ ] Remove `deploy-website.yml` and `publish-release-notes.yml`; rewrite `release.yml` to build a universal macOS app on tag `v*-plus.*`, sign it with a self-signed certificate from secrets `MACOS_CERT_P12_BASE64` / `MACOS_CERT_PASSWORD` (identity name "Astro Editor+ Self-Signed"), no notarization, updater signature from `TAURI_SIGNING_PRIVATE_KEY`, publish the GitHub release with `latest.json`, and pass `ASTRO_EDITOR_GITHUB_CLIENT_ID` from repo variable. Provide `scripts/make-self-signed-cert.sh` that creates the certificate and prints the base64 for the secret.
- [ ] README: a short "Astro Editor+" section (what it adds, install, the one-time **Open anyway** step in System Settings → Privacy & Security). Commit.

## W6 — Integration (lead)

- [ ] Merge into `kr`: W1, W2 (rebased on W1), W3, W4 branches; resolve `bindings.rs` / `commands/mod.rs` / `lib.rs` / `bindings.ts` / `TitleBarToolbar.tsx` / preferences conflicts (append-only lists); regenerate bindings; `bun run check:all`.
- [ ] End to end in the dev app on a copy of Kevin's site cloned through **Open from GitHub**: Preview, edit, Publish, Sync, branch `staging`, open PR, merge, History; quit and confirm no dev server remains.
- [ ] Tag a release, install it, repeat the smoke test on the installed app.
- [ ] Prepare upstream PR texts (W1+W2 as one "GitHub panel" PR on top of W3's preference, W3, each W4 fix) for Gus to review before opening.
