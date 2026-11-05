//! Webview snapshots, for the site previews and the debug-only agent bridge.
//!
//! On macOS this uses `WKWebView.takeSnapshot`, which needs no Screen Recording
//! permission, doesn't raise or focus the window, and works for a hidden one.
//! It only captures the webview, so the vibrancy behind transparent areas comes
//! out transparent. Never call it on the main thread: it waits for WebKit,
//! which answers there.

use std::time::Duration;
use tauri::{Runtime, WebviewWindow};

/// A PNG of the webview and its size in pixels
pub struct Snapshot {
    pub png: Vec<u8>,
    pub width: isize,
    pub height: isize,
}

/// Snapshots the webview. `width` is in points (the image is that times the
/// screen's scale); `None` takes it at its own size.
#[cfg(target_os = "macos")]
pub fn take<R: Runtime>(
    window: &WebviewWindow<R>,
    width: Option<f64>,
    timeout: Duration,
) -> Result<Snapshot, String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Result<Snapshot, String>>();
    window
        .with_webview(move |webview| {
            let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
            // SAFETY: on macOS, `inner()` is the WKWebView that wry created for this window
            let wk_webview: &WKWebView = unsafe { &*webview.inner().cast() };
            let config = unsafe { WKSnapshotConfiguration::new(mtm) };
            if let Some(width) = width {
                unsafe { config.setSnapshotWidth(Some(&NSNumber::new_f64(width))) };
            }
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                // SAFETY: WebKit passes either a valid image or a valid error
                let result = match unsafe { image.as_ref() } {
                    Some(image) => png_data(image),
                    None => Err(unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "snapshot failed".to_string())),
                };
                let _ = tx.send(result);
            });
            unsafe {
                wk_webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler)
            };
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(timeout)
        .map_err(|_| "snapshot timed out".to_string())?
}

#[cfg(target_os = "macos")]
fn png_data(image: &objc2_app_kit::NSImage) -> Result<Snapshot, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let tiff = image
        .TIFFRepresentation()
        .ok_or("snapshot has no image data")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("couldn't read snapshot")?;
    // SAFETY: an empty properties dictionary is valid for every file type
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("couldn't encode PNG")?;
    Ok(Snapshot {
        png: png.to_vec(),
        width: rep.pixelsWide(),
        height: rep.pixelsHigh(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn take<R: Runtime>(
    _window: &WebviewWindow<R>,
    _width: Option<f64>,
    _timeout: Duration,
) -> Result<Snapshot, String> {
    Err("snapshots are only implemented on macOS".to_string())
}
