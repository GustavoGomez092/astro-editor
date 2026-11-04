# Git panel

The frontend of the optional publishing tools: the **Changes** tab in the left sidebar, **Publish** in the title bar, diffs and **History** in the main area, GitHub sign-in, pull requests and **Open from GitHub**. The Rust side (libgit2, the GitHub API, the Keychain, safety rules) is in `git-and-github.md`.

## Switched off by default

Everything here is behind the General preference **Show preview and publishing tools** (`general.showPublishingTools`, default `false`), read with `useShowPublishingTools()`. While it's off:

- no git or GitHub query runs (each query hook checks the preference in `enabled`);
- the sidebar has no tabs and renders the Files panel exactly as before;
- Publish, the GitHub preferences pane, the sign-in sheet, the Open from GitHub dialog and the palette's Publishing commands are absent.

Gate new UI the same way, so turning the preference off leaves the app as it was.

## State

- **`gitStore`** (`src/store/gitStore.ts`) holds what the panel shows: the sidebar tab (`files` | `changes`), the diff or History shown over the editor (one at a time), the selected commit and commit file, the sign-in sheet's state, and whether the new-branch and Open from GitHub dialogs are open. Layout calls `reset()` when the project changes; sign-in and Open from GitHub survive that.
- **Queries** live under one key prefix, `queryKeys.git(projectPath)` (`['project', path, 'git', …]`), so `refreshGit()` (`lib/git/cache.ts`) refreshes status, branches, history, diffs and pull requests together after any command that changes the repository. Index 4 of every git key is a constant, never a path or id, because `useFileChangeHandler` invalidates keys with `'files'` at index 4. Sign-in (`githubAuth`) and the repository list (`githubRepos`) aren't tied to a project.
- Command results go through `unwrap()` (`lib/git/unwrap.ts`): Rust returns plain-language messages, so an error's message is shown to the writer as is, in a toast or in the panel.

## Keeping the status current

`loadGitStatus()` (`lib/git/status.ts`) is the status query's function. When the writer is signed in, it fetches from the remote first if this project hasn't been fetched since it opened or the last fetch was five minutes ago; otherwise it only reads the local status, which is cheap enough to run after every save. A failed fetch (offline, GitHub down) logs a warning and falls back to the local status, so the panel never breaks on a network problem. The status query waits for the sign-in check, so the first load after opening a project fetches when it should.

`useGitStatusRefresh()` (mounted once, in Layout) reloads the status, and any open diff of a changed file, on `file-changed` (the watcher), on window `focus`, and every five minutes while `document.hasFocus()`. It's our own interval rather than TanStack's `refetchInterval`, because TanStack's focus manager follows page visibility, and a Mac app's page stays visible when the app is in the background.

## Components

In `src/components/git/`:

- **`ChangesPanel`** wires queries and mutations to **`ChangesView`**, which is presentational so the styleguide can show every state with fixtures. Keep new state in the container and new display in the view.
- The Publish message is pre-filled from the changed entries' titles (`defaultCommitMessage`, `changedFileTitle` in `lib/git/changes.ts`; titles come from the same per-collection file lists as the entry pickers) until the writer edits it, without an effect: the panel keeps a `draft` that's `null` until edited.
- A sync, publish or "Bring in changes" that ends in a conflict or is blocked by local changes shows a toast and also leaves a notice in the panel, with a link to the repository on GitHub, until it's dismissed.
- **`GitMainView`** draws the diff or History over the editor, which stays mounted underneath (see "Keep stateful panels mounted" in the architecture guide). Escape, the close button and opening a file return to the editor.
- **`CommitGraph`** lays rows out with `layoutGraph()` (`lib/git/graph-layout.ts`, pure and tested) and draws all lanes as one SVG behind the rows, so lines run unbroken between rows. Lane colours are the `--git-lane-0…7` tokens, used through full class names (`stroke-git-lane-3`) so Tailwind finds them.
- The palette's Publish and Sync are DOM events (`git-publish`, `git-sync`) that `ChangesPanel` handles with the same handlers as its buttons, because they need the panel's message and sign-in state.

The words are deliberately plain: Publish, Sync, Open pull request, Merge, "not on GitHub yet". Git terms appear only in History.

## Signing in

`lib/git/sign-in.ts` drives GitHub's device flow through the store, so the sheet can open from the panel, Preferences and Open from GitHub alike: it asks Rust for a code, shows it, and waits while Rust polls GitHub. Each start or cancel bumps an attempt counter, so a wait that's been cancelled can't touch the sheet when it finally returns. Cancelling while waiting calls `githubSignOut`, which stops the poll on the Rust side.

## Open from GitHub

`OpenFromGitHubDialog` lists the signed-in writer's repositories (search, or paste a GitHub link; SSH links become HTTPS so the sign-in is used), clones into `~/Sites` or a folder the writer picks, shows progress from the `git-clone-progress` event, and opens the result with `projectStore.setProject`. Dependencies aren't installed here: Preview installs them the first time it runs.

## Styleguide

`src/styleguide/GitSection.tsx` has the History view, diffs, the Changes tab in its main states, the sign-in sheet, the Open pull request dialog and Open from GitHub (`bun run app styleguide git-history git-diff git-changes git-changes-more git-sign-in git-open-pull-request git-open-from-github`).
