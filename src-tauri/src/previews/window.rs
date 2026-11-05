//! The invisible window a screenshot is taken in (on screen, transparent and
//! click-through; see `show_without_showing`). It loads one local page and
//! nothing else: it has no capabilities (`capabilities/` names only `main`),
//! the app's invoke handler refuses it (`lib.rs`), every request that isn't
//! to the page's own `localhost` port is blocked before the page loads (so a
//! site's analytics never count a capture), navigation away from the page's
//! origin is blocked, and so are new windows and downloads. Its website data
//! isn't kept.

use super::thumb;
use crate::snapshot;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The capture window's label
pub const LABEL: &str = "site-preview";

/// The window's size: a laptop screen, so the page shows its desktop layout
const WIDTH: f64 = 1440.0;
const HEIGHT: f64 = 900.0;
/// The whole capture, from opening the window to the finished picture
const LIMIT: Duration = Duration::from_secs(45);
/// The page is always given this long after it's ready (its load event, then
/// its fonts), so intros and preloaders have finished before the picture
const READY_WAIT: Duration = Duration::from_secs(5);
/// After `READY_WAIT`, how much longer a page that's still moving is watched
/// before it's taken as it is
const MOVING_WAIT: Duration = Duration::from_secs(10);
/// The longest wait after the load event, for a page whose fonts never say
/// they've loaded
const SETTLE_LIMIT: Duration = Duration::from_secs(20);
/// The snapshots that tell whether the page has stopped moving
const SAMPLE_EVERY: Duration = Duration::from_millis(400);
const SAMPLE_WIDTH: f64 = 240.0;
/// The picture itself, in points; downscaled to `thumb::MAX_WIDTH` pixels
const PICTURE_WIDTH: f64 = 800.0;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the home page gets to answer the check before the window opens
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Asks the page whether its fonts have loaded, whether it's showing the dev
/// server's error overlay (Vite's, which Astro uses too), how many animation
/// frames it has drawn (the counter `PAGE_SCRIPT` keeps) and whether a
/// finite animation or transition is running (an endless one, like a
/// spinner, doesn't count)
const PAGE_STATE_JS: &str = "(() => { const fonts = !document.fonts || document.fonts.status === 'loaded'; const error = !!document.querySelector('vite-error-overlay'); const frames = typeof window.__astroEditorFrames === 'number' ? window.__astroEditorFrames : -1; let animating = false; try { animating = document.getAnimations().some(a => a.playState === 'running' && a.effect && a.effect.getTiming().iterations !== Infinity); } catch (e) {} return 'fonts:' + (fonts ? 'loaded' : 'loading') + ' error:' + (error ? 'yes' : 'no') + ' frames:' + frames + ' animating:' + (animating ? 'yes' : 'no'); })()";

/// What the page says about itself, from `PAGE_STATE_JS`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageState {
    pub fonts_loaded: bool,
    pub error_overlay: bool,
    /// Animation frames drawn so far; `None` when the page didn't say
    pub frames: Option<u64>,
    pub animating: bool,
}

impl PageState {
    /// An answer it can't read has no frame count, so it never counts as a
    /// page that's drawing (and is never taken as settled)
    pub fn parse(answer: &str) -> Self {
        let frames = answer
            .split_whitespace()
            .find_map(|part| part.strip_prefix("frames:"))
            .and_then(|count| count.parse::<u64>().ok());
        Self {
            fonts_loaded: !answer.contains("fonts:loading"),
            error_overlay: answer.contains("error:yes"),
            frames,
            animating: answer.contains("animating:yes"),
        }
    }
}

/// What to do after a sample
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    Longer,
    /// Ready for `READY_WAIT`, then the same picture for `STILL_FOR`, drawing all along
    Settled,
    /// Waited as long as it gets; taken as it is (still drawing)
    KeptMoving,
}

/// One sample of the page
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub frames: Option<u64>,
    /// The snapshot matches the one before
    pub same_picture: bool,
    pub animating: bool,
    pub fonts_loaded: bool,
}

/// How long the picture must stay the same, with frames being drawn, to count as still
const STILL_FOR: Duration = Duration::from_secs(2);

/// Watches the samples and says when to take the picture. Never sooner than
/// `READY_WAIT` after the page is ready (loaded, then fonts in), and never
/// while its animation frames have stopped: a page whose frames stall looks
/// still while it's frozen mid-intro, so it's waited on until the capture's
/// time runs out.
pub struct Watch {
    ready: bool,
    still_since: Option<Instant>,
    last: Option<(Instant, Sample)>,
    ticking: bool,
    /// Time spent drawing (between samples whose frame counts advanced)
    /// since loading and since the page was ready. The waits count this, not
    /// the clock, so a page that froze mid-intro and comes back gets its full
    /// waits again rather than being taken as soon as it draws
    drawn_since_load: Duration,
    drawn_since_ready: Duration,
}

impl Watch {
    pub fn new() -> Self {
        Self {
            ready: false,
            still_since: None,
            last: None,
            ticking: false,
            drawn_since_load: Duration::ZERO,
            drawn_since_ready: Duration::ZERO,
        }
    }

    /// Whether the page's frames stopped between the last two samples
    pub fn frozen(&self) -> bool {
        self.last.is_some() && !self.ticking
    }

    pub fn observe(&mut self, now: Instant, sample: Sample) -> Wait {
        let previous = self.last.replace((now, sample));
        let was_ready = self.ready;
        self.ready |= sample.fonts_loaded;
        let (previous_at, previous_sample) = match previous {
            Some(previous) => previous,
            None => {
                self.ticking = false;
                return Wait::Longer;
            }
        };
        self.ticking = matches!(
            (previous_sample.frames, sample.frames),
            (Some(before), Some(after)) if after > before
        );
        if !self.ticking {
            self.still_since = None;
            return Wait::Longer;
        }
        let drawn = now.duration_since(previous_at);
        self.drawn_since_load += drawn;
        if was_ready {
            self.drawn_since_ready += drawn;
        }
        // The same picture since the last sample, with frames drawn between:
        // still since then (or since now, if that sample was mid-animation)
        let quiet = sample.same_picture && !sample.animating;
        self.still_since = quiet.then(|| {
            self.still_since.unwrap_or(if previous_sample.animating {
                now
            } else {
                previous_at
            })
        });
        let still_for = self.still_since.map(|since| now.duration_since(since));
        if self.ready {
            let drawn = self.drawn_since_ready;
            if drawn >= READY_WAIT && still_for.is_some_and(|still| still >= STILL_FOR) {
                return Wait::Settled;
            }
            if drawn >= READY_WAIT + MOVING_WAIT {
                return Wait::KeptMoving;
            }
            return Wait::Longer;
        }
        // Fonts that never report loaded: taken after this much drawing
        if self.drawn_since_load >= SETTLE_LIMIT {
            Wait::KeptMoving
        } else {
            Wait::Longer
        }
    }
}

/// How long the next sample may take, keeping `SNAPSHOT_TIMEOUT` for the
/// picture itself; `None` when there's no time left for samples
pub fn sample_timeout(now: Instant, deadline: Instant) -> Option<Duration> {
    let left = deadline
        .saturating_duration_since(now)
        .checked_sub(SNAPSHOT_TIMEOUT)?;
    (!left.is_zero()).then(|| left.min(SNAPSHOT_TIMEOUT))
}

/// Asks the dev server for the page first, so an error page (a 404, or a 500
/// from a broken page) is never stored over a good preview. Redirects aren't
/// followed, since one could lead off the computer; the window allows only
/// the page's own origin.
pub async fn check_page(url: &str, timeout: Duration) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "The site isn't answering.".to_string())?;
    let status = response.status();
    if status.as_u16() >= 400 {
        return Err(format!(
            "The site's home page shows an error ({}), so the last preview was kept.",
            status.as_u16()
        ));
    }
    Ok(())
}

/// Run in the page before its own scripts: counts animation frames, so the
/// capture can tell a page that's drawing from one that's frozen, and hides
/// the toolbar every Astro dev server adds (it isn't part of the site)
const PAGE_SCRIPT: &str = r#"
(() => {
  // The frame counter first, so nothing after it can keep it from starting
  window.__astroEditorFrames = 0;
  const tick = () => { window.__astroEditorFrames += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    const style = document.createElement('style');
    style.textContent = 'astro-dev-toolbar { display: none !important; }';
    document.documentElement.appendChild(style);
  } catch (e) {}
})();
"#;

/// The window-state plugin's saved windows (`.window-state.json`) without the
/// capture window's, or `None` when there's none to remove. The plugin is told
/// to leave this window alone (`lib.rs`), but a file saved before that would
/// still bring it back visible.
pub fn without_saved_state(saved: &str) -> Option<String> {
    let mut windows: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(saved).ok()?;
    windows.remove(LABEL)?;
    serde_json::to_string_pretty(&windows).ok()
}

/// A plugin that only removes the capture window from the window-state
/// plugin's file. Register it before that plugin, which reads the file once
/// when it's set up and writes back what it read.
pub fn forget_saved_state_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("site-preview-window-state")
        .setup(|app, _| {
            let Ok(dir) = app.path().app_config_dir() else {
                return Ok(());
            };
            let path = dir.join(tauri_plugin_window_state::DEFAULT_FILENAME);
            if let Some(cleaned) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|saved| without_saved_state(&saved))
            {
                if let Err(e) = crate::commands::files::write_atomically(&path, cleaned.as_bytes())
                {
                    log::warn!(
                        "Astro Editor [PREVIEWS] Couldn't update {}: {e}",
                        path.display()
                    );
                }
            }
            Ok(())
        })
        .build()
}

/// Closes the window however the capture ends
struct CloseOnDrop<R: Runtime>(WebviewWindow<R>);

impl<R: Runtime> Drop for CloseOnDrop<R> {
    fn drop(&mut self) {
        if let Err(e) = self.0.destroy() {
            log::warn!("Astro Editor [PREVIEWS] Couldn't close the capture window: {e}");
        }
    }
}

/// Loads `url` (a `http://localhost:<port>/` page) in an invisible window, waits
/// for it to load and settle, and returns a JPEG of it at most
/// `thumb::MAX_WIDTH` wide. Blocks; never call it on the main thread.
pub fn capture_page<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + LIMIT;
    let page = url::Url::parse(url).map_err(|e| format!("Can't open {url}: {e}"))?;
    if page.scheme() != "http" || page.host_str() != Some("localhost") {
        return Err(format!("Only pages on localhost are captured, not {url}"));
    }
    let origin = page.origin();
    tauri::async_runtime::block_on(check_page(url, CHECK_TIMEOUT))?;

    // A window left over from a capture that panicked
    if let Some(old) = app.get_webview_window(LABEL) {
        let _ = old.destroy();
    }
    let port = page.port().ok_or("The page has no port")?;
    let blank = url::Url::parse("about:blank").map_err(|e| e.to_string())?;
    let (loaded, on_loaded) = mpsc::channel::<()>();
    let load_origin = origin.clone();
    // Opened blank: the request blocker is in place before the page loads
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(blank))
        .title("Site preview")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        // Borderless: a titled window is shrunk to fit a smaller screen
        .decorations(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .incognito(true)
        .initialization_script(PAGE_SCRIPT)
        // Doesn't throttle the page before it's put on screen; on screen
        // (`show_without_showing`) its animations run as they would for a reader
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |to| {
            let allowed = to.origin() == origin || to.as_str() == "about:blank";
            if !allowed {
                log::info!("Astro Editor [PREVIEWS] Blocked a navigation to {to}");
            }
            allowed
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().origin() == load_origin {
                let _ = loaded.send(());
            }
        })
        .build()
        .map_err(|e| format!("Couldn't open the capture window: {e}"))?;
    let window = CloseOnDrop(window);
    block_other_requests(&window.0, port)?;
    show_without_showing(app, &window.0)?;
    window
        .0
        .navigate(page)
        .map_err(|e| format!("Couldn't open the page: {e}"))?;

    on_loaded
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "The site took too long to load.".to_string())?;

    // Intros, preloaders and fonts: always five seconds after the page is
    // ready, then until it's still
    let loaded_at = Instant::now();
    let mut watch = Watch::new();
    let mut previous: Option<image::GrayImage> = None;
    let mut page_state;
    loop {
        std::thread::sleep(SAMPLE_EVERY);
        let Some(timeout) = sample_timeout(Instant::now(), deadline) else {
            // Never a frozen page, or one that wasn't ready for long enough
            if watch.frozen() {
                return Err("The site stopped drawing, so the last preview was kept.".into());
            }
            return Err("The site took too long to be ready, so the last preview was kept.".into());
        };
        page_state = PageState::parse(
            &snapshot::eval_text(&window.0, PAGE_STATE_JS, timeout).unwrap_or_default(),
        );
        if page_state.error_overlay {
            break;
        }
        let shot = snapshot::take(&window.0, Some(SAMPLE_WIDTH), timeout)?;
        let frame = image::load_from_memory(&shot.png)
            .map_err(|e| format!("Couldn't read the snapshot: {e}"))?
            .to_luma8();
        let same_picture = previous
            .as_ref()
            .is_some_and(|last| changed_share(last, &frame) < MOVING_SHARE);
        previous = Some(frame);
        let sample = Sample {
            frames: page_state.frames,
            same_picture,
            animating: page_state.animating,
            fonts_loaded: page_state.fonts_loaded,
        };
        let wait = watch.observe(Instant::now(), sample);
        log::debug!(
            "Astro Editor [PREVIEWS] {:.1} s: frames {:?}, same {same_picture}, animating {}, fonts {}, {wait:?}",
            loaded_at.elapsed().as_secs_f32(),
            sample.frames,
            sample.animating,
            sample.fonts_loaded,
        );
        match wait {
            Wait::Longer => {}
            Wait::Settled => {
                log::info!(
                    "Astro Editor [PREVIEWS] The page settled {:.1} s after loading",
                    loaded_at.elapsed().as_secs_f32()
                );
                break;
            }
            Wait::KeptMoving => {
                log::info!("Astro Editor [PREVIEWS] The page kept moving; taking it as it is");
                break;
            }
        }
    }
    // Asked once more right before the picture, so it's never taken without
    // having looked for an error overlay (the loop may have run out of time)
    let left = deadline.saturating_duration_since(Instant::now());
    let answer = snapshot::eval_text(&window.0, PAGE_STATE_JS, (left / 2).min(SNAPSHOT_TIMEOUT))
        .map_err(|e| format!("Couldn't check the page: {e}"))?;
    if page_state.error_overlay || PageState::parse(&answer).error_overlay {
        return Err("The site shows an error, so the last preview was kept.".into());
    }

    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err("Taking the preview took too long.".into());
    }
    let picture = snapshot::take(&window.0, Some(PICTURE_WIDTH), left)?;
    let image = image::load_from_memory(&picture.png)
        .map_err(|e| format!("Couldn't read the snapshot: {e}"))?;
    thumb::encode(&image)
}

/// WebKit content rules that block every request except to the page's own
/// port on `localhost` (its scripts, styles, images and live-reload socket)
/// and inline `data:`, `blob:` and `about:` URLs. WebKit's URL filters have no
/// alternation, so each allowed kind is its own rule.
#[cfg(any(target_os = "macos", test))]
pub fn request_rules(port: u16) -> String {
    let allow = |filter: String| serde_json::json!({ "trigger": { "url-filter": filter }, "action": { "type": "ignore-previous-rules" } });
    serde_json::json!([
        { "trigger": { "url-filter": ".*" }, "action": { "type": "block" } },
        allow(format!("^http://localhost:{port}/")),
        allow(format!("^ws://localhost:{port}/")),
        allow("^data:".to_string()),
        allow("^blob:".to_string()),
        allow("^about:".to_string()),
    ])
    .to_string()
}

/// Compiles `request_rules` and adds them to the window's webview, waiting
/// until they're in place
#[cfg(target_os = "macos")]
fn block_other_requests<R: Runtime>(window: &WebviewWindow<R>, port: u16) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};

    let (done, on_done) = mpsc::channel::<Result<(), String>>();
    let rules = request_rules(port);
    window
        .with_webview(move |webview| {
            let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
            // SAFETY: on macOS, `inner()` is the WKWebView that wry created for this window
            let wk_webview: &WKWebView = unsafe { &*webview.inner().cast() };
            let controller = unsafe { wk_webview.configuration().userContentController() };
            let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
                let _ = done.send(Err("no content rule store".into()));
                return;
            };
            let handler = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
                // SAFETY: WebKit passes either a valid list or a valid error
                let result = match unsafe { list.as_ref() } {
                    Some(list) => {
                        unsafe { controller.addContentRuleList(list) };
                        Ok(())
                    }
                    None => Err(unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "couldn't compile the request rules".to_string())),
                };
                let _ = done.send(result);
            });
            unsafe {
                store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                    Some(&NSString::from_str("site-preview")),
                    Some(&NSString::from_str(&rules)),
                    Some(&handler),
                )
            };
        })
        .map_err(|e| e.to_string())?;
    on_done
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "Couldn't set up the capture window.".to_string())?
        .map_err(|e| format!("Couldn't set up the capture window: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn block_other_requests<R: Runtime>(_window: &WebviewWindow<R>, _port: u16) -> Result<(), String> {
    Err("Previews are only taken on macOS".to_string())
}

/// Puts the window on screen, fully transparent, click-through, never key and
/// out of window cycling, Mission Control and the Window menu. A window that's
/// hidden (or covered) makes WebKit treat its page as hidden: animation frames
/// never fire and CSS animations stay on their first frame, so a page that
/// fades in would be captured blank.
#[cfg(target_os = "macos")]
fn show_without_showing<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowSharingType};
    let (done, on_done) = mpsc::channel::<Result<(), String>>();
    let window = window.clone();
    app.run_on_main_thread(move || {
        let ns_window = match window.ns_window() {
            Ok(ns_window) => ns_window,
            Err(e) => {
                let _ = done.send(Err(e.to_string()));
                return;
            }
        };
        // SAFETY: read on the main thread, where AppKit objects live, and
        // this window isn't destroyed until the capture is over
        let ns_window = unsafe { &*(ns_window as *const NSWindow) };
        ns_window.setAlphaValue(0.0);
        ns_window.setIgnoresMouseEvents(true);
        ns_window.setHasShadow(false);
        ns_window.setExcludedFromWindowsMenu(true);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::FullScreenNone,
        );
        // Left out of screenshots and screen sharing
        ns_window.setSharingType(NSWindowSharingType::None);
        // On screen without becoming key or bringing the app forward
        ns_window.orderFrontRegardless();
        let _ = done.send(Ok(()));
    })
    .map_err(|e| e.to_string())?;
    on_done
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "Couldn't set up the capture window.".to_string())?
        .map_err(|e| format!("Couldn't set up the capture window: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn show_without_showing<R: Runtime>(
    _app: &AppHandle<R>,
    _window: &WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

/// Snapshots look the same when fewer than this share of pixels differ visibly
const MOVING_SHARE: f64 = 0.002;
/// A change in brightness smaller than this doesn't count (antialiasing, dithering)
const VISIBLE_CHANGE: u8 = 24;

/// The share of pixels whose brightness differs visibly between two frames;
/// frames of different sizes differ completely
pub fn changed_share(a: &image::GrayImage, b: &image::GrayImage) -> f64 {
    if a.dimensions() != b.dimensions() || a.is_empty() {
        return 1.0;
    }
    let changed = a
        .as_raw()
        .iter()
        .zip(b.as_raw())
        .filter(|(x, y)| x.abs_diff(**y) >= VISIBLE_CHANGE)
        .count();
    changed as f64 / a.as_raw().len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma};

    fn frame(shade: u8) -> GrayImage {
        GrayImage::from_pixel(100, 60, Luma([shade]))
    }

    fn with_box(shade: u8, x: u32) -> GrayImage {
        let mut image = frame(shade);
        for dx in 0..10 {
            for y in 0..10 {
                image.put_pixel(x + dx, y, Luma([255 - shade]));
            }
        }
        image
    }

    #[test]
    fn an_error_status_is_never_captured() {
        let mut server = mockito::Server::new();
        let _ok = server
            .mock("GET", "/")
            .with_status(200)
            .with_body("<html>")
            .create();
        let _missing = server.mock("GET", "/missing").with_status(404).create();
        let _broken = server.mock("GET", "/broken").with_status(500).create();
        let _moved = server
            .mock("GET", "/moved")
            .with_status(302)
            .with_header("location", "https://example.com/")
            .create();
        let base = server.url();
        let check = |path: &str| {
            tauri::async_runtime::block_on(check_page(
                &format!("{base}{path}"),
                Duration::from_secs(5),
            ))
        };
        assert_eq!(check("/"), Ok(()));
        assert!(check("/missing").unwrap_err().contains("404"));
        assert!(check("/broken").unwrap_err().contains("500"));
        // Not followed (it could lead off the computer); the window decides
        assert_eq!(check("/moved"), Ok(()));
        drop(server);
        assert!(check("/").is_err(), "nothing answering");
    }

    #[test]
    fn reads_what_the_page_reports() {
        let state = PageState::parse("fonts:loaded error:no frames:120 animating:no");
        assert_eq!(
            state,
            PageState {
                fonts_loaded: true,
                error_overlay: false,
                frames: Some(120),
                animating: false
            }
        );
        let state = PageState::parse("fonts:loading error:yes frames:7 animating:yes");
        assert_eq!(
            state,
            PageState {
                fonts_loaded: false,
                error_overlay: true,
                frames: Some(7),
                animating: true
            }
        );
        // Nothing usable: no frame count, so it never counts as drawing
        let state = PageState::parse("");
        assert_eq!(state.frames, None);
        assert!(!state.error_overlay);
    }

    /// Feeds `Watch` a sample every 400 ms from `start`, `n` times
    fn run(
        watch: &mut Watch,
        start: Instant,
        from: usize,
        n: usize,
        sample: impl Fn(usize) -> Sample,
    ) -> Vec<Wait> {
        (from..from + n)
            .map(|i| watch.observe(start + SAMPLE_EVERY * (i as u32 + 1), sample(i)))
            .collect()
    }

    fn ticking(i: usize, same: bool) -> Sample {
        Sample {
            frames: Some(100 + i as u64 * 48),
            same_picture: same,
            animating: false,
            fonts_loaded: true,
        }
    }

    #[test]
    fn settles_after_five_seconds_and_two_seconds_of_the_same_picture() {
        let start = Instant::now();
        let mut watch = Watch::new();
        // Still from the start: not before 5 s after ready (ready at the first sample)
        let waits = run(&mut watch, start, 0, 40, |i| ticking(i, i > 0));
        let settled = waits.iter().position(|w| *w == Wait::Settled).unwrap();
        let at = SAMPLE_EVERY * (settled as u32 + 1);
        assert!(at >= SAMPLE_EVERY + READY_WAIT, "{at:?}");
        assert!(at < SAMPLE_EVERY + READY_WAIT + SAMPLE_EVERY * 2, "{at:?}");
    }

    #[test]
    fn needs_two_seconds_of_the_same_picture() {
        let start = Instant::now();
        let mut watch = Watch::new();
        // Moving for 6 s, then still: settles 2 s after it stops, not 1.2 s
        let stops = 15; // sample 15 is the first that matches the one before
        let waits = run(&mut watch, start, 0, 40, |i| ticking(i, i >= stops));
        let settled = waits.iter().position(|w| *w == Wait::Settled).unwrap();
        let still_for = SAMPLE_EVERY * (settled as u32 + 1) - SAMPLE_EVERY * stops as u32;
        assert!(still_for >= STILL_FOR, "{still_for:?}");
        assert!(still_for < STILL_FOR + SAMPLE_EVERY, "{still_for:?}");
    }

    #[test]
    fn never_shoots_a_page_whose_frames_have_stopped() {
        let start = Instant::now();
        let mut watch = Watch::new();
        // The same picture for 40 s, but the frame counter never moves
        let waits = run(&mut watch, start, 0, 100, |_| Sample {
            frames: Some(500),
            same_picture: true,
            animating: false,
            fonts_loaded: true,
        });
        assert!(waits.iter().all(|w| *w == Wait::Longer));
        assert!(watch.frozen());
        // Nor one that gives no count at all
        let mut watch = Watch::new();
        let waits = run(&mut watch, start, 0, 100, |_| Sample {
            frames: None,
            same_picture: true,
            animating: false,
            fonts_loaded: true,
        });
        assert!(waits.iter().all(|w| *w == Wait::Longer));
    }

    #[test]
    fn a_stall_starts_the_still_time_again() {
        let start = Instant::now();
        let mut watch = Watch::new();
        let waits = run(&mut watch, start, 0, 13, |i| ticking(i, i > 0));
        assert!(waits.iter().all(|w| *w == Wait::Longer));
        // Frames stop for two samples (the same count), then tick again
        let stalled = run(&mut watch, start, 13, 2, |_| Sample {
            frames: Some(100 + 12 * 48),
            ..ticking(0, true)
        });
        assert!(
            stalled.iter().all(|w| *w == Wait::Longer),
            "never on a frozen page"
        );
        let waits = run(&mut watch, start, 15, 10, |i| ticking(i, true));
        // The still time starts again at the last stalled sample (14), so it
        // settles exactly 2 s later, not on the time it was still before the stall
        let settled = waits.iter().position(|w| *w == Wait::Settled).unwrap();
        let settled_at = SAMPLE_EVERY * (15 + settled as u32 + 1);
        assert_eq!(settled_at, SAMPLE_EVERY * 15 + STILL_FOR, "{settled}");
        assert!(waits[..settled].iter().all(|w| *w == Wait::Longer));
    }

    #[test]
    fn after_a_long_freeze_it_waits_while_drawing_again() {
        // Seen on Kevin's site: frames stopped 3 s in and came back 26 s later
        let start = Instant::now();
        let frozen = |_: usize| Sample {
            frames: Some(100 + 7 * 48),
            ..ticking(0, true)
        };
        // Moving when it thaws: not taken on the first sample back
        let mut watch = Watch::new();
        run(&mut watch, start, 0, 8, |i| ticking(i, false));
        let during = run(&mut watch, start, 8, 66, frozen);
        assert!(during.iter().all(|w| *w == Wait::Longer));
        let after = run(&mut watch, start, 74, 40, |i| ticking(i, false));
        let taken = after.iter().position(|w| *w != Wait::Longer).unwrap();
        assert_eq!(after[taken], Wait::KeptMoving);
        // 15 s of drawing after ready in all: ~2.8 s before the freeze, the rest after
        assert!(
            SAMPLE_EVERY * (taken as u32 + 1) >= Duration::from_secs(12),
            "{taken}"
        );
        // Still when it thaws: settled only after 2 s of drawing the same picture
        let mut watch = Watch::new();
        run(&mut watch, start, 0, 8, |i| ticking(i, false));
        run(&mut watch, start, 8, 66, frozen);
        let after = run(&mut watch, start, 74, 40, |i| ticking(i, true));
        let settled = after.iter().position(|w| *w != Wait::Longer).unwrap();
        assert_eq!(after[settled], Wait::Settled);
        assert!(
            SAMPLE_EVERY * (settled as u32 + 1) >= STILL_FOR,
            "{settled}"
        );
    }

    #[test]
    fn fonts_ready_late_still_get_their_five_seconds() {
        let start = Instant::now();
        let mut watch = Watch::new();
        // Fonts report loaded only at 18 s; moving all along
        let ready_from = 44; // sample 44 is at 18 s
        let waits = run(&mut watch, start, 0, 100, |i| Sample {
            fonts_loaded: i >= ready_from,
            ..ticking(i, false)
        });
        let taken = waits.iter().position(|w| *w != Wait::Longer).unwrap();
        let ready_at = SAMPLE_EVERY * (ready_from as u32 + 1);
        let taken_at = SAMPLE_EVERY * (taken as u32 + 1);
        assert_eq!(waits[taken], Wait::KeptMoving);
        assert!(
            taken_at >= ready_at + READY_WAIT + MOVING_WAIT,
            "{taken_at:?}"
        );
        // Still once ready: settled 5 s after the fonts, never at the 20 s cap
        let mut watch = Watch::new();
        let waits = run(&mut watch, start, 0, 100, |i| Sample {
            fonts_loaded: i >= ready_from,
            ..ticking(i, true)
        });
        let taken = waits.iter().position(|w| *w != Wait::Longer).unwrap();
        assert_eq!(waits[taken], Wait::Settled);
        assert!(SAMPLE_EVERY * (taken as u32 + 1) >= ready_at + READY_WAIT);
    }

    #[test]
    fn a_running_animation_counts_as_moving() {
        let start = Instant::now();
        let mut watch = Watch::new();
        let waits = run(&mut watch, start, 0, 40, |i| Sample {
            animating: i < 25,
            ..ticking(i, true)
        });
        let settled = waits.iter().position(|w| *w == Wait::Settled).unwrap();
        assert!(settled >= 25 + 5, "{settled}");
    }

    #[test]
    fn a_page_that_keeps_moving_is_taken_after_fifteen_seconds() {
        let start = Instant::now();
        let mut watch = Watch::new();
        let waits = run(&mut watch, start, 0, 60, |i| ticking(i, false));
        let taken =
            SAMPLE_EVERY * (waits.iter().position(|w| *w == Wait::KeptMoving).unwrap() as u32 + 1);
        let earliest = SAMPLE_EVERY + READY_WAIT + MOVING_WAIT;
        assert!(
            taken >= earliest && taken < earliest + SAMPLE_EVERY,
            "{taken:?}"
        );
        // Fonts that never load: taken at the limit, still only while drawing
        let mut watch = Watch::new();
        let waits = run(&mut watch, start, 0, 60, |i| Sample {
            fonts_loaded: false,
            ..ticking(i, true)
        });
        let taken =
            SAMPLE_EVERY * (waits.iter().position(|w| *w == Wait::KeptMoving).unwrap() as u32 + 1);
        assert!(
            taken >= SETTLE_LIMIT && taken <= SETTLE_LIMIT + SAMPLE_EVERY,
            "{taken:?}"
        );
    }

    #[test]
    fn the_whole_capture_has_45_seconds() {
        assert_eq!(LIMIT, Duration::from_secs(45));
        // Room for loading, the five seconds, the longest settle and the picture
        assert!(LIMIT > SETTLE_LIMIT + SNAPSHOT_TIMEOUT);
    }

    #[test]
    fn keeps_time_for_the_picture() {
        let now = Instant::now();
        let deadline = now + LIMIT;
        assert_eq!(sample_timeout(now, deadline), Some(SNAPSHOT_TIMEOUT));
        let late = deadline - SNAPSHOT_TIMEOUT - Duration::from_secs(2);
        assert_eq!(sample_timeout(late, deadline), Some(Duration::from_secs(2)));
        assert_eq!(sample_timeout(deadline - SNAPSHOT_TIMEOUT, deadline), None);
        assert_eq!(sample_timeout(deadline, deadline), None);
    }

    #[test]
    fn forgets_a_saved_state_for_the_capture_window_only() {
        let saved = r#"{"main":{"width":1400,"visible":true},"site-preview":{"width":1440,"visible":true}}"#;
        let cleaned: serde_json::Value =
            serde_json::from_str(&without_saved_state(saved).unwrap()).unwrap();
        assert!(cleaned.get("site-preview").is_none());
        assert_eq!(cleaned["main"]["width"], 1400);
        // Nothing to remove, or not readable: left as it is
        assert_eq!(without_saved_state(r#"{"main":{}}"#), None);
        assert_eq!(without_saved_state("not json"), None);
    }

    #[test]
    fn allows_only_the_pages_own_port_and_inline_urls() {
        let rules: serde_json::Value = serde_json::from_str(&request_rules(4321)).unwrap();
        let rules = rules.as_array().unwrap();
        assert_eq!(rules[0]["trigger"]["url-filter"], ".*");
        assert_eq!(rules[0]["action"]["type"], "block");
        let allowed: Vec<&str> = rules[1..]
            .iter()
            .inspect(|rule| assert_eq!(rule["action"]["type"], "ignore-previous-rules"))
            .map(|rule| rule["trigger"]["url-filter"].as_str().unwrap())
            .collect();
        assert_eq!(
            allowed,
            [
                "^http://localhost:4321/",
                "^ws://localhost:4321/",
                "^data:",
                "^blob:",
                "^about:"
            ]
        );
    }

    #[test]
    fn measures_how_much_changed() {
        assert_eq!(changed_share(&frame(10), &frame(10)), 0.0);
        assert_eq!(
            changed_share(&frame(10), &frame(20)),
            0.0,
            "below the visible change"
        );
        assert_eq!(changed_share(&frame(10), &frame(200)), 1.0);
        let moved = changed_share(&with_box(0, 0), &with_box(0, 50));
        assert!((moved - 200.0 / 6000.0).abs() < 1e-9, "{moved}");
        assert_eq!(changed_share(&frame(0), &GrayImage::new(10, 10)), 1.0);
    }
}
