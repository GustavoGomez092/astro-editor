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

The share image is the first of `og`, `opengraph-image`, `social` and `share` in `public/`, each as `.jpg`, `.jpeg`, `.png` or `.webp` (`share.rs`). It's decoded by content, not by extension, and a file that won't decode gives no preview rather than an error.

## Taking a screenshot

`capture.rs` is the flow, behind a `CaptureEnv` trait so it's tested without Tauri; `TauriEnv` (`mod.rs`) is the real one. `window.rs` is the window.

- **One at a time.** `CaptureGuard` (managed state) lets one capture run; a second Refresh is refused with a message, and an automatic one is skipped.
- **The server.** If it's running (or `external`), its URL is used and it's left alone. If the writer is starting it, the capture waits and leaves it running. Otherwise the capture starts it (installing first if needed, as Preview does, with the Dev command override), waits up to 5 minutes for it to be ready, and stops it afterwards, whether or not the picture worked. It stops it only if this capture's start made a new run and the run counter (`DevServers::run`) hasn't moved since, so a server the writer stopped and restarted meanwhile keeps running. The Preview control shows the server while it runs, since it's an ordinary start.
- **The page.** The printed URL's port and path on `localhost` (`page_url`). Anything that isn't local `http` is refused.
- **The window.** Label `site-preview`, 1440×900, never focusable, with non-persistent website data, the Astro dev toolbar hidden (an init script; it's on every Astro dev page and isn't part of the site) and background throttling off. It opens on `about:blank`, gets its request rules (see Security), is put on screen and only then loads the page. It waits for the page's load event, then snapshots it at 240 pt every 400 ms until four snapshots in a row match (fewer than 0.2 % of pixels change visibly, so a ticking clock doesn't count), at most 15 s after loading, then takes the picture at 800 pt and downscales it to 800 px. A page that never stops moving is taken when the 15 s are up. The whole capture has 30 s; the window is destroyed however it ends (a drop guard), and any leftover one is destroyed before a new capture.
- **On screen, but invisible.** A hidden or covered window makes WebKit treat its page as hidden (`visibilityState: hidden`): animation frames never fire, timers are throttled and CSS animations and transitions stay on their first frame, so a page that fades in would be captured blank and the settle check would see a still page at once. So the window is ordered in front without becoming key (`orderFrontRegardless`) with alpha 0, click-through, no shadow, out of the Window menu, window cycling and Mission Control (`show_without_showing`). The writer sees nothing and keeps focus. If the app is hidden or the screen is locked, the page may still be treated as hidden and the picture is whatever it first drew.
- **Snapshots** are `WKWebView.takeSnapshot` (`src-tauri/src/snapshot.rs`, shared with the debug-only agent bridge). Other platforms have no snapshot yet, so captures fail there with a message and the share image stays.

## Security

The window shows a local site the writer may not have written, so it gets nothing from the app:

- **No IPC.** The capabilities in `capabilities/` name only `main`, so Tauri's ACL refuses its plugin and app commands (it's a remote origin to Tauri), and the app's invoke handler (`lib.rs`) also rejects every command from the `site-preview` label before it reaches a command. Tauri still injects `__TAURI_INTERNALS__`; calls through it are refused.
- **No requests beyond the page's own port.** A WebKit content rule list (`request_rules`) blocks everything except `http://localhost:<port>/…` and `ws://localhost:<port>/…` (the dev server's live-reload socket) and inline `data:`, `blob:` and `about:` URLs. It's compiled and added before the page loads. So a site's analytics never count a capture, a firewall never asks about it, and remote fonts or images show as missing in the picture.
- **No leaving the page.** `on_navigation` allows only the page's origin (and `about:blank`), `on_new_window` denies every new window, `on_download` refuses every download.

These were checked with a probe page that tries each of them.

## When it captures

- **The open project's dev server becomes ready** (Preview, or any start): the dev server's state listener (`lib.rs`) calls `previews::on_server_state`, which captures on a thread of its own if the stored screenshot and the last automatic attempt are both over an hour old and no capture is running. It never starts or stops the server.
- **Open from GitHub has prepared a site**: the dialog calls `captureProjectPreview` without waiting, after opening the site, unless it isn't an Astro site or the writer skipped preparing. The site is added to the registry while its server starts.
- **Refresh preview** on a Home card: `captureProjectPreview`.

Every capture needs **Show preview and publishing tools** on (read from `global-settings.json`; on when unset). With it off, `captureProjectPreview` says so and nothing captures by itself; stored previews and share images still show.

## Gotchas

- **Never call `snapshot::take` or `window::capture_page` on the main thread.** They wait for WebKit, which answers on the main thread. The commands use `spawn_blocking`; the listener spawns a thread.
- **`localhost` is whatever answers first.** WebKit tries `::1` before `127.0.0.1`, so a server bound only to `127.0.0.1` while another program holds the same port on `::1` gets the other program's page. Astro and Vite listen on both, so this only bites hand-written dev commands. A page that never finishes loading fails after 30 s with "The site took too long to load."
- **Logs are tagged `Astro Editor [PREVIEWS]`**: each capture that fails and why, blocked navigations, and cleanups.
