# Site previews

Each site on the Home screen shows a picture of itself: a screenshot of its home page as it runs locally, or its share image until there is one. The engine is Rust (`src-tauri/src/previews/`); the frontend only asks for a preview and listens for changes.

## The commands and the event

- **`projectPreview(projectPath)`** is fast and never touches the network or a server: the stored screenshot if there is one, else a thumbnail of the share image, else `null`. Home calls it for every card.
- **`captureProjectPreview(projectPath)`** takes a new screenshot (Refresh preview), starting the dev server when it isn't running. It takes seconds, or minutes if dependencies have to be installed first.
- **`project-preview-updated`** (`{ projectPath }`) is emitted whenever a stored screenshot changes, however it was taken.

Both return `ProjectPreview`: `kind` (`screenshot` or `share-image`), `src` (a `data:` URL of a JPEG at most 800 px wide) and `takenAt` (ISO time, `null` for a share image).

## Where they're kept

`previews/` in the app's local data folder (`store.rs`):

- `<project id>.jpg`: the screenshot. Its modified time is when it was taken.
- `<project id>.share-<modified ms>-<size>.jpg`: the share image's thumbnail. A changed image gets a new name, so the old one is replaced rather than served stale.

The ID is the registry's (`project-registry.json`, looked up by path, as the Dev command override is). A project that isn't in the registry gets its share image uncached and no stored screenshot, so nothing is left behind that cleanup couldn't match. Previews of projects no longer in the registry are removed at startup and after every write of the registry (`write_app_data_file`), so Remove from list takes the preview with it. If the registry can't be read, nothing is removed.

The share image is the first of `og`, `opengraph-image`, `social` and `share` in `public/`, each as `.jpg`, `.jpeg`, `.png` or `.webp` (`share.rs`). It's decoded by content, not by extension. A file over 32 MB isn't read, and decoding stops at 8192 px a side or 128 MB (`thumb.rs`), so a broken or hostile file can't take the memory. Transparent parts are put on white. A file that won't decode gives no preview rather than an error. Saves write a temporary file of their own and rename it into place (`write_atomically`, shared with the preferences), so two at once never mix.

## Taking a screenshot

`capture.rs` is the flow, behind a `CaptureEnv` trait so it's tested without Tauri; `TauriEnv` (`mod.rs`) is the real one. `window.rs` is the window.

- **One at a time.** `CaptureGuard` (managed state) lets one capture run; a second Refresh is refused with a message, and an automatic one is skipped.
- **The server.** If it's running (or `external`), its URL is used and it's left alone. If the writer is starting it, the capture waits and leaves it running. Otherwise the capture starts it with `DevServers::start_for_preview` (installing first if needed, as Preview does, with the Dev command override), which marks that run `forPreview`, and waits up to 5 minutes for it to be ready. A drop guard (`Release`) hands it back however the capture ends, a panic included: if the site is open in the editor (its files are watched, `watcher::is_watching`) the writer is using it, so it's claimed and keeps running; otherwise `stop_preview` stops it, but only while it's still that run and still `forPreview`.
- **The writer's server is never stopped.** While `forPreview` is set, the title bar's Preview control reads "Taking a preview…" instead of Open site and Stop. The writer starting the server (`devServerStart` on it), opening the site (`devServerClaim`, which Open site calls first) or having the site open in the editor when the capture ends makes it an ordinary server (`DevServers::claim`), and the change is announced with `dev-server-state`. A run the writer stopped and started again is a new run, so it's left alone too.
- **The page.** The printed URL's port and path on `localhost` (`page_url`). Anything that isn't local `http` is refused. Before the window opens, Rust asks for the page itself (`check_page`, no redirects followed, no proxy): a status of 400 or more is an error page (a missing home page, or a 500 from a broken one), so the capture fails and the last preview stays.
- **The window.** Label `site-preview`, 1440×900, borderless and never focusable, with non-persistent website data, the Astro dev toolbar hidden (an init script; it's on every Astro dev page and isn't part of the site) and background throttling off. It opens on `about:blank`, gets its request rules (see Security), is put on screen and only then loads the page. After the load event it samples the page every 400 ms: it asks the page whether its fonts have loaded (`document.fonts.status`) and whether it shows the dev server's error overlay (`vite-error-overlay`, which Astro uses too; then the capture fails and the last preview stays), and takes a 240 pt snapshot. The page counts as ready once it has loaded and its fonts are in, and the picture is never taken sooner than **5 s after that** (`READY_WAIT`), so intros and preloaders have finished: a slower picture is a better one. After the 5 s it's taken as soon as four snapshots in a row match (fewer than 0.2 % of pixels change visibly, so a ticking clock doesn't count); a page still moving is watched 10 s more and then taken as it is, and one whose fonts never report loaded is taken 20 s after loading (`decide`). The picture is taken at 800 pt and downscaled to 800 px. The whole capture has 45 s, and 5 s of it are always kept for the picture: each sample gets only the time that leaves (`sample_timeout`); if time runs out before the 5 s are up, the capture fails rather than take an early picture. The window is destroyed however it ends (a drop guard), and any leftover one is destroyed before a new capture.
- **On screen, but invisible.** A hidden or covered window makes WebKit treat its page as hidden (`visibilityState: hidden`): animation frames never fire, timers are throttled and CSS animations and transitions stay on their first frame, so a page that fades in would be captured blank and the settle check would see a still page at once. So the window isn't hidden in WebKit's sense: on the main thread it's ordered in front without becoming key (`orderFrontRegardless`) with alpha 0, click-through, no shadow, out of the Window menu, window cycling and Mission Control, and out of screenshots and screen sharing (`setSharingType(None)`) (`show_without_showing`). The writer sees nothing and keeps focus. Because the window is on screen, the Dock's reopen checks the main window's own visibility rather than `has_visible_windows`. The window-state plugin is told to leave it alone (`with_denylist`), and a small plugin registered before it (`forget_saved_state_plugin`) removes any entry a file saved before that still has, since a saved `site-preview` would come back visible, white and taking focus. If the app is hidden or the screen is locked, the page may still be treated as hidden and the picture is whatever it first drew.
- **Snapshots** are `WKWebView.takeSnapshot` (`src-tauri/src/snapshot.rs`, shared with the debug-only agent bridge). Other platforms have no snapshot yet, so captures fail there with a message and the share image stays.

## Security

The window shows a local site the writer may not have written, so it gets nothing from the app:

- **No IPC.** The capabilities in `capabilities/` name only `main`, so Tauri's ACL refuses its plugin and app commands (it's a remote origin to Tauri), and the app's invoke handler (`lib.rs`) also rejects every command from the `site-preview` label before it reaches a command. Tauri still injects `__TAURI_INTERNALS__`; calls through it are refused.
- **No requests beyond the page's own port.** A WebKit content rule list (`request_rules`) blocks everything except `http://localhost:<port>/…` and `ws://localhost:<port>/…` (the dev server's live-reload socket) and inline `data:`, `blob:` and `about:` URLs; `asset://` (the app's own file protocol) is blocked with the rest. It's compiled and added before the page loads. So a site's analytics never count a capture, a firewall never asks about it, and remote fonts or images show as missing in the picture.
- **No leaving the page.** `on_navigation` allows only the page's origin (and `about:blank`), `on_new_window` denies every new window, `on_download` refuses every download.

These were checked with a probe page that tries each of them.

## When it captures

- **The open project's dev server becomes ready** (Preview, or any start): the dev server's state listener (`lib.rs`) calls `previews::on_server_state`, which captures on a thread of its own if the stored screenshot and the last automatic attempt are both over an hour old and no capture is running. It never starts or stops the server.
- **Open from GitHub has prepared a site**: the dialog calls `captureProjectPreview` without waiting, after opening the site, unless it isn't an Astro site or the writer skipped preparing. The site is added to the registry while its server starts.
- **Refresh preview** on a Home card: `captureProjectPreview`.

Every capture needs **Show preview and publishing tools** on (read from `global-settings.json`; on when unset). With it off, `captureProjectPreview` says so and nothing captures by itself; stored previews and share images still show.

## Gotchas

- **Never call `snapshot::take` or `window::capture_page` on the main thread.** They wait for WebKit, which answers on the main thread. The commands use `spawn_blocking`; the listener spawns a thread.
- **`localhost` is whatever answers first.** WebKit tries `::1` before `127.0.0.1`, so a server bound only to `127.0.0.1` while another program holds the same port on `::1` gets the other program's page. Astro and Vite listen on both, so this only bites hand-written dev commands. A page that never finishes loading fails after 45 s with "The site took too long to load."
- **Logs are tagged `Astro Editor [PREVIEWS]`**: each capture that fails and why, blocked navigations, and cleanups.
