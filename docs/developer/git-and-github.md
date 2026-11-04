# Git and GitHub

The Rust engine behind the Git panel: status and diffs, sync and publish, branches, the commit graph, GitHub sign-in, pull requests and cloning. Everything is behind the **Show Git and preview tools** preference in the UI; the commands themselves are always registered.

## Modules

- `src-tauri/src/git/`: git through libgit2 (`git2`, vendored), so it works on a Mac without the Xcode command-line tools.
  - `mod.rs`: the IPC types, `open` (finds the repository containing the project, so a project in a subfolder of a repo works), and shared helpers.
  - `status.rs`: branch, upstream, ahead/behind, default branch and changed files.
  - `diff.rs`: one file's diff, either the working tree against `HEAD` or a commit against its first parent (a root commit against the empty tree).
  - `remote.rs`: fetch and push, and the credentials callback.
  - `sync.rs`: sync, publish, "bring in changes from the default branch", and the commit author.
  - `branches.rs`: the branch list and safe checkout.
  - `log.rs`: the commit graph and commit details.
  - `clone.rs`: cloning into a new folder, with progress.
- `src-tauri/src/github/`: the GitHub REST API.
  - `http.rs`: the client. Base URLs are injectable for tests, and errors become plain sentences.
  - `auth.rs`: the device flow, the token store and the cached profile.
  - `repos.rs`: which repository `origin` is, and the user's repositories for cloning.
  - `pulls.rs`: list, open and merge pull requests.
- `src-tauri/src/commands/git.rs` and `github.rs`: thin Tauri commands. libgit2 calls are blocking, including the network ones, so every git command runs on `tokio::task::spawn_blocking`, inside `git::with_repo`, which holds a per-repository lock for the whole command. A timed sync and a Publish on the same repository therefore never interleave.

Paths in `ChangedFile` and the `path` argument of the diff commands are relative to the repository root, with forward slashes.

## Safety rules

The anti-goal is losing a writer's edits, so these hold everywhere:

- **No operation discards uncommitted changes.** There's no hard reset or forced checkout anywhere in the engine.
- **Checkouts and fast-forwards use libgit2's safe checkout, with `overwrite_ignored(false)`** (`git::checkout_safely`). Safe mode alone happily replaces an ignored file, such as a local `.env`, when the target tracks a file at that path. libgit2 checks every file before it writes any, so a refusal leaves the working tree as it was; the conflicting paths come from the checkout notify callback and are named in the message.
- **Fast-forwards are checked before they're tried.** Sync refuses (`blockedByLocalChanges`) when an incoming change touches a file that's changed locally, even if git could carry the edit across.
- **Merges happen in memory first** (`merge_commits`). If the result has conflicts, nothing has been written, so "abort and restore" is simply not continuing. Only a clean result is committed and checked out. Diverged branches are merged only when the working tree is clean.
- **Branches move only from where they were.** Fast-forwards and merges update the branch with `reference_matching` against the commit they started from, so a commit made meanwhile is never dropped (the per-repository lock makes this rare; this makes it impossible).
- **Publish commits before it touches the network.** Once the commit exists, every later failure (offline, conflict, rejected push) comes back as `pushed: false` with a message, not as an error, so the UI can say the work is saved on this computer.

Merges are always merge commits (sync, publish, bring in changes, pull requests), so a long-lived branch like `staging` never drifts from the default branch.

## Authentication

- **Sign-in is the OAuth device flow** for an OAuth App, which needs no client secret. The client ID is compiled in from `ASTRO_EDITOR_GITHUB_CLIENT_ID` (`option_env!`, so builds without it still compile) and overridden by `advanced.githubClientId` in `global-settings.json`, which Rust reads directly. The scope is `repo`. Tokens from this app don't expire; a refresh token or expiry in the response is ignored.
- **`githubDevicePoll` polls inside the command** at the interval GitHub gives, adding 5 seconds on `slow_down`, until the code is approved, denied or expired. Signing out or starting again cancels it (a generation counter plus a `Notify` that wakes the sleep).
- **The token lives in the OS credential store** (`keyring`: Keychain on macOS), service `<app identifier>.github`, account `token`, so dev and release builds keep separate sign-ins. It's never written to preferences or logs. `CachedStore` keeps it in memory after the first read and holds its lock during that read, so two callers racing at startup cause one Keychain read (one prompt on a build the Keychain doesn't trust yet), not two.
- **Keychain access can block,** so it never runs on the async runtime: `Auth` goes through `spawn_blocking`, and the git commands call `auth::token()` inside their blocking work.
- **The profile is cached** after the first `/user` call. A 401 deletes the token and reports signed out. When GitHub can't be reached, status reports signed in without a profile, so being offline doesn't look like being signed out.
- **Git network operations** send the token as `x-access-token` for github.com over HTTPS only (never `http://`, where it would go out in the clear). Other hosts use git's credential helper. Each credential is offered once, because libgit2 asks again after a rejection and would otherwise loop.
- **The commit author** is git config's `user.name` and `user.email` when both are set, else the GitHub profile with its no-reply address (`<id>+<login>@users.noreply.github.com`). The profile is fetched only when the config has no identity.

`github::auth::token()` is the token for any module that needs it. Logic functions take the token as an argument, so tests never touch the Keychain.

## Gotchas

- **No SSH.** git2 is built without its `ssh` feature, which would link OpenSSL dynamically on macOS and break the app on Macs without Homebrew's OpenSSL. A github.com SSH origin (`git@github.com:owner/repo.git`) is fetched and pushed over `https://github.com/owner/repo.git` with the token, through an anonymous remote with explicit refspecs, so `origin/*` still updates and the configured URL is never changed. Any other SSH host gets a plain message saying only HTTPS remotes (and GitHub SSH remotes) are supported.
- **Network timeouts** are set once at startup (`git::init_network_timeouts`: 15 s to connect, 60 s per read), so a stalled connection can't hang Publish.
- **One idea of "upstream".** `status::upstream_of` is the configured upstream, else `origin/<branch>` when it exists. Status, the branch list, Sync and Publish all use it, so the panel's ahead/behind matches what Sync and Publish will do. Publish still writes the upstream to the config on first push.
- **Push rejections:** a remote's refusal comes through `push_update_reference`. Only a non-fast-forward ("non-fast-forward", "fetch first", or libgit2's `NotFastForward` from a local remote) says GitHub has changes to sync first; anything else (protected branches, hooks) is shown as "GitHub refused the update: <reason>".
- **Repository info is worked out locally** from `origin`'s URL and the default branch (`origin/HEAD`, else `main`, else `master`), so it works offline and before sign-in. Fetch records `origin/HEAD` when a repository doesn't have it.
- **A 404 or 403 from GitHub means "no access"**: GitHub answers 404 for private repositories the token can't see. Both become "Your GitHub account doesn't have access to this repository".
- **Pull request checks are best effort.** The list combines the head commit's combined status and its check runs; if either request fails, that part counts as no checks rather than failing the list. The list endpoint leaves out `mergeable`, so each open pull request is fetched once more.
- **Pagination only follows `Link` URLs on the API's own origin,** because the token goes with the request.
- **Clone refuses a folder that already has files** and removes what it created if it fails. Progress arrives as `git-clone-progress` events (`CloneProgress { received, total }`, at most about 100 per clone).

## Testing

Tests sit beside the code. Git tests build temp repositories and bare "remotes" with git2 and `tempfile` (`git/test_support.rs`), with a fixed identity in each repo's own config, so they don't need a `git` binary or the developer's config. GitHub tests use `mockito` through the injectable base URLs and an in-memory token store; nothing talks to the real network or Keychain. An unreachable remote is `http://127.0.0.1:9`.
