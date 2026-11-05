//! The hidden window a screenshot is taken in. It loads one local page and
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
const LIMIT: Duration = Duration::from_secs(30);
/// How long to let the page settle after it loads before taking the
/// picture anyway (a page that never stops moving)
const SETTLE_LIMIT: Duration = Duration::from_secs(15);
/// The snapshots that tell whether the page has stopped moving
const SAMPLE_EVERY: Duration = Duration::from_millis(400);
const SAMPLE_WIDTH: f64 = 240.0;
/// The picture itself, in points; downscaled to `thumb::MAX_WIDTH` pixels
const PICTURE_WIDTH: f64 = 800.0;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);

/// Hides the toolbar every Astro dev server adds to its pages, which isn't
/// part of the site
const HIDE_DEV_TOOLBAR: &str = r#"
(() => {
  const style = document.createElement('style');
  style.textContent = 'astro-dev-toolbar { display: none !important; }';
  document.documentElement.appendChild(style);
})();
"#;

/// Closes the window however the capture ends
struct CloseOnDrop<R: Runtime>(WebviewWindow<R>);

impl<R: Runtime> Drop for CloseOnDrop<R> {
    fn drop(&mut self) {
        if let Err(e) = self.0.destroy() {
            log::warn!("Astro Editor [PREVIEWS] Couldn't close the capture window: {e}");
        }
    }
}

/// Loads `url` (a `http://localhost:<port>/` page) in a hidden window, waits
/// for it to load and settle, and returns a JPEG of it at most
/// `thumb::MAX_WIDTH` wide. Blocks; never call it on the main thread.
pub fn capture_page<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + LIMIT;
    let page = url::Url::parse(url).map_err(|e| format!("Can't open {url}: {e}"))?;
    if page.scheme() != "http" || page.host_str() != Some("localhost") {
        return Err(format!("Only pages on localhost are captured, not {url}"));
    }
    let origin = page.origin();

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
        .initialization_script(HIDE_DEV_TOOLBAR)
        // Keeps the page's timers and animations running while it's hidden,
        // so intro animations finish
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

    // Fonts, images and intro animations: wait until the page stops changing
    let loaded_at = Instant::now();
    let settle_until = (loaded_at + SETTLE_LIMIT).min(deadline - SNAPSHOT_TIMEOUT);
    let mut settle = Settle::default();
    loop {
        std::thread::sleep(SAMPLE_EVERY);
        let sample = snapshot::take(&window.0, Some(SAMPLE_WIDTH), SNAPSHOT_TIMEOUT)?;
        let frame = image::load_from_memory(&sample.png)
            .map_err(|e| format!("Couldn't read the snapshot: {e}"))?
            .to_luma8();
        if settle.observe(frame) {
            log::info!(
                "Astro Editor [PREVIEWS] The page settled {:.1} s after loading",
                loaded_at.elapsed().as_secs_f32()
            );
            break;
        }
        if Instant::now() >= settle_until {
            log::info!("Astro Editor [PREVIEWS] The page kept moving; taking it as it is");
            break;
        }
    }

    let picture = snapshot::take(&window.0, Some(PICTURE_WIDTH), SNAPSHOT_TIMEOUT)?;
    let image = image::load_from_memory(&picture.png)
        .map_err(|e| format!("Couldn't read the snapshot: {e}"))?;
    if Instant::now() > deadline {
        return Err("Taking the preview took too long.".into());
    }
    thumb::encode(&image)
}

/// WebKit content rules that block every request except to the page's own
/// port on `localhost` (its scripts, styles, images and live-reload socket)
/// and inline `data:`, `blob:` and `about:` URLs. WebKit's URL filters have no
/// alternation, so each allowed kind is its own rule.
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
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
    let (done, on_done) = mpsc::channel::<()>();
    app.run_on_main_thread(move || {
        // SAFETY: `ns_window` is this window's NSWindow, alive until the
        // window is destroyed, which happens after this returns; and this
        // runs on the main thread
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
        // On screen without becoming key or bringing the app forward
        ns_window.orderFrontRegardless();
        let _ = done.send(());
    })
    .map_err(|e| e.to_string())?;
    on_done
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "Couldn't set up the capture window.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn show_without_showing<R: Runtime>(
    _app: &AppHandle<R>,
    _window: &WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

/// How many snapshots in a row must look the same for the page to count as still
const STILL_FRAMES: u32 = 4;
/// Snapshots look the same when fewer than this share of pixels differ visibly
const MOVING_SHARE: f64 = 0.002;
/// A change in brightness smaller than this doesn't count (antialiasing, dithering)
const VISIBLE_CHANGE: u8 = 24;

/// Watches successive snapshots for the page to stop moving
#[derive(Default)]
pub struct Settle {
    last: Option<image::GrayImage>,
    still: u32,
}

impl Settle {
    /// Takes the next snapshot; true once the last `STILL_FRAMES` matched
    pub fn observe(&mut self, frame: image::GrayImage) -> bool {
        let same = self
            .last
            .as_ref()
            .is_some_and(|last| changed_share(last, &frame) < MOVING_SHARE);
        self.still = if same { self.still + 1 } else { 0 };
        self.last = Some(frame);
        self.still + 1 >= STILL_FRAMES
    }
}

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

    #[test]
    fn a_still_page_settles_after_four_matching_frames() {
        let mut settle = Settle::default();
        assert!(!settle.observe(frame(0)));
        assert!(!settle.observe(frame(0)));
        assert!(!settle.observe(frame(0)));
        assert!(settle.observe(frame(0)));
    }

    #[test]
    fn movement_starts_the_count_again() {
        let mut settle = Settle::default();
        for x in [0, 10, 20, 30] {
            assert!(!settle.observe(with_box(0, x)));
        }
        assert!(!settle.observe(with_box(0, 30)));
        assert!(!settle.observe(with_box(0, 30)));
        assert!(settle.observe(with_box(0, 30)));
        assert!(!settle.observe(with_box(0, 40)));
    }
}
