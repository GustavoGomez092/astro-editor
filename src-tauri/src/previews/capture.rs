//! Taking a site's screenshot: one at a time, with the dev server started for
//! it when it isn't running (and stopped again after). The window and the
//! snapshot are in `window.rs`; this is the flow around them, kept apart from
//! Tauri so it can be tested.

use super::store::Store;
use super::ProjectPreview;
use crate::dev_server::{DevServerState, DevServerStatus};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// How often a server's screenshot is retaken by itself, when it becomes ready
pub const AUTO_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// What a capture needs from the app. `TauriEnv` (`mod.rs`) is the real one.
pub trait CaptureEnv {
    /// Whether **Show preview and publishing tools** is on
    fn tools_enabled(&self) -> bool;
    fn server_state(&self, project_path: &str) -> DevServerState;
    /// Starts the project's server for the preview (`DevServers::start_for_preview`):
    /// the run it started, or `None` if one was already on its way
    fn start_server_for_preview(&self, project_path: &str) -> Option<u64>;
    /// Stops the server if it's still the preview's run (`DevServers::stop_preview`)
    fn stop_preview_server(&self, project_path: &str, run: u64);
    /// A JPEG of the page at `url`, at most 800 px wide
    fn snapshot(&self, url: &str) -> Result<Vec<u8>, String>;
    fn project_id(&self, project_path: &str) -> Option<String>;
    fn store(&self) -> &Store;
    /// Tells the frontend the project's preview changed
    fn notify(&self, project_path: &str);
    /// How long to wait for a server to be ready, installing included
    fn server_limit(&self) -> Duration {
        Duration::from_secs(5 * 60)
    }
    fn poll_interval(&self) -> Duration {
        Duration::from_millis(250)
    }
}

/// Lets one capture run at a time, and remembers when each project was last
/// captured by itself. Kept in Tauri's managed state; cloning shares it.
#[derive(Clone, Default)]
pub struct CaptureGuard {
    busy: Arc<AtomicBool>,
    automatic: Arc<Mutex<HashMap<String, SystemTime>>>,
}

/// Held while a capture runs; dropping it lets the next one start
pub struct CaptureTicket {
    busy: Arc<AtomicBool>,
}

impl Drop for CaptureTicket {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

impl CaptureGuard {
    /// A ticket if no capture is running
    pub fn try_begin(&self) -> Option<CaptureTicket> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| CaptureTicket {
                busy: self.busy.clone(),
            })
    }

    #[cfg(test)]
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Records an automatic attempt now, and says whether it should go ahead:
    /// not if the stored screenshot or the last attempt is under an hour old
    fn claim_automatic(
        &self,
        project_path: &str,
        stored: Option<SystemTime>,
        now: SystemTime,
    ) -> bool {
        let mut automatic = crate::dev_server::lock(&self.automatic);
        let last = [stored, automatic.get(project_path).copied()]
            .into_iter()
            .flatten()
            .max();
        if !should_auto_capture(last, now) {
            return false;
        }
        automatic.insert(project_path.to_string(), now);
        true
    }
}

/// Whether a screenshot last taken at `last` is old enough to take again by itself
pub fn should_auto_capture(last: Option<SystemTime>, now: SystemTime) -> bool {
    match last {
        None => true,
        Some(last) => now
            .duration_since(last)
            .is_ok_and(|age| age >= AUTO_INTERVAL),
    }
}

/// The page to capture for a server's printed URL: the same port and path on
/// `localhost`. `None` unless it's a local `http` address with a port.
pub fn page_url(server_url: &str) -> Option<String> {
    let url = url::Url::parse(server_url).ok()?;
    let local = matches!(url.host()?, url::Host::Domain("localhost"))
        || url.host_str() == Some("127.0.0.1")
        || url.host_str() == Some("[::1]");
    if url.scheme() != "http" || !local {
        return None;
    }
    let port = url.port()?;
    Some(format!("http://localhost:{port}{}", url.path()))
}

fn ready_url(state: &DevServerState) -> Option<String> {
    match state.status {
        DevServerStatus::Running | DevServerStatus::External => {
            state.url.as_deref().and_then(page_url)
        }
        _ => None,
    }
}

/// Snapshots the page, stores it under the project's ID and tells the
/// frontend. `None` when the writer stopped the server meanwhile: the
/// capture ends quietly and the last preview stays.
fn take_and_store(
    env: &impl CaptureEnv,
    project_path: &str,
    url: &str,
) -> Result<Option<ProjectPreview>, String> {
    let snapshot = env.snapshot(url);
    if env.server_state(project_path).status == DevServerStatus::Stopped {
        log::info!("Astro Editor [PREVIEWS] The server was stopped; no preview of {project_path}");
        return Ok(None);
    }
    let jpeg = snapshot?;
    // Looked up after the snapshot: a site just opened from GitHub is added
    // to the list while its server starts
    let id = env
        .project_id(project_path)
        .ok_or("This site isn't in your list of sites, so its preview can't be kept.")?;
    let preview = env.store().save_screenshot(&id, &jpeg)?;
    env.notify(project_path);
    Ok(Some(preview))
}

/// Waits for the server to be ready and returns its page's URL; `None` if
/// the writer stopped it meanwhile
fn wait_until_ready(env: &impl CaptureEnv, project_path: &str) -> Result<Option<String>, String> {
    let deadline = Instant::now() + env.server_limit();
    loop {
        let state = env.server_state(project_path);
        if let Some(url) = ready_url(&state) {
            return Ok(Some(url));
        }
        match state.status {
            DevServerStatus::Error => {
                let why = state.error.unwrap_or_default();
                let first = why.lines().next().unwrap_or("it stopped");
                return Err(format!("The site couldn't start: {first}"));
            }
            DevServerStatus::Stopped => return Ok(None),
            DevServerStatus::Running | DevServerStatus::External => {
                return Err("The site isn't running on this computer's local address.".into())
            }
            DevServerStatus::Installing | DevServerStatus::Starting => {}
        }
        if Instant::now() >= deadline {
            return Err("The site took too long to start.".into());
        }
        std::thread::sleep(env.poll_interval());
    }
}

/// Refresh preview (and after Open from GitHub): starts the dev server if it
/// isn't running, takes the screenshot, and stops the server again only if
/// this started it
pub fn capture(
    env: &impl CaptureEnv,
    guard: &CaptureGuard,
    project_path: &str,
) -> Result<Option<ProjectPreview>, String> {
    if !env.tools_enabled() {
        return Err(
            "Turn on Show preview and publishing tools in Settings to take previews.".into(),
        );
    }
    if !Path::new(project_path).is_dir() {
        return Err(format!("The folder {project_path} isn't there."));
    }
    let _ticket = guard
        .try_begin()
        .ok_or("A preview is already being taken. Try again in a moment.")?;

    let before = env.server_state(project_path);
    if let Some(url) = ready_url(&before) {
        return take_and_store(env, project_path, &url);
    }
    if matches!(
        before.status,
        DevServerStatus::Installing | DevServerStatus::Starting
    ) {
        // The writer started it: wait for it, and leave it running
        let Some(url) = wait_until_ready(env, project_path)? else {
            return Ok(None);
        };
        return take_and_store(env, project_path, &url);
    }

    log::info!("Astro Editor [PREVIEWS] Starting {project_path} to take its preview");
    // Dropped however this ends, a panic included
    let _release = env
        .start_server_for_preview(project_path)
        .map(|run| Release {
            env,
            project_path,
            run,
        });
    let Some(url) = wait_until_ready(env, project_path)? else {
        return Ok(None);
    };
    take_and_store(env, project_path, &url)
}

/// Stops the server a capture started when the capture ends, however it
/// ends, unless the writer claimed it meanwhile (`stop_preview_server`)
struct Release<'a, E: CaptureEnv> {
    env: &'a E,
    project_path: &'a str,
    run: u64,
}

impl<E: CaptureEnv> Drop for Release<'_, E> {
    fn drop(&mut self) {
        self.env.stop_preview_server(self.project_path, self.run);
    }
}

/// When a server becomes ready: takes its screenshot if the last one is over
/// an hour old and no capture is running. Never starts or stops the server.
pub fn capture_when_ready(
    env: &impl CaptureEnv,
    guard: &CaptureGuard,
    project_path: &str,
    state: &DevServerState,
    now: SystemTime,
) -> Option<Result<ProjectPreview, String>> {
    let url = ready_url(state)?;
    if !env.tools_enabled() {
        return None;
    }
    // The ticket first, so an hour is used up only by a capture that runs
    let _ticket = guard.try_begin()?;
    let id = env.project_id(project_path)?;
    if !guard.claim_automatic(project_path, env.store().taken_at(&id), now) {
        return None;
    }
    take_and_store(env, project_path, &url).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tempfile::TempDir;

    fn state(status: DevServerStatus, url: Option<&str>, pid: Option<u32>) -> DevServerState {
        DevServerState {
            status,
            url: url.map(str::to_string),
            command: None,
            pid,
            error: None,
            for_preview: false,
        }
    }

    const URL: &str = "http://localhost:4321/";

    /// A fake app: `states` are what the server reports, one per call, the
    /// last repeating; `start_server` and `stop_server` are recorded
    struct FakeEnv {
        dir: TempDir,
        store: Store,
        tools: bool,
        id: Option<&'static str>,
        states: RefCell<Vec<DevServerState>>,
        after_start: RefCell<Vec<DevServerState>>,
        /// What `start_server_for_preview` returns: `None` when one was on its way
        starts: Option<u64>,
        snapshot: Result<Vec<u8>, String>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeEnv {
        fn new(states: Vec<DevServerState>) -> Self {
            let dir = TempDir::new().unwrap();
            Self {
                store: Store::new(dir.path().join("previews")),
                dir,
                tools: true,
                id: Some("blog"),
                states: RefCell::new(states),
                after_start: RefCell::new(Vec::new()),
                starts: Some(7),
                snapshot: Ok(vec![0xff, 0xd8, 0xff]),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn project(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl CaptureEnv for FakeEnv {
        fn tools_enabled(&self) -> bool {
            self.tools
        }
        fn server_state(&self, _: &str) -> DevServerState {
            let mut states = self.states.borrow_mut();
            if states.len() > 1 {
                states.remove(0)
            } else {
                states[0].clone()
            }
        }
        fn start_server_for_preview(&self, _: &str) -> Option<u64> {
            self.calls.borrow_mut().push("start".into());
            let next = std::mem::take(&mut *self.after_start.borrow_mut());
            *self.states.borrow_mut() = next;
            self.starts
        }
        fn stop_preview_server(&self, _: &str, run: u64) {
            self.calls.borrow_mut().push(format!("stop {run}"));
        }
        fn snapshot(&self, url: &str) -> Result<Vec<u8>, String> {
            self.calls.borrow_mut().push(format!("snapshot {url}"));
            self.snapshot.clone()
        }
        fn project_id(&self, _: &str) -> Option<String> {
            self.id.map(str::to_string)
        }
        fn store(&self) -> &Store {
            &self.store
        }
        fn notify(&self, _: &str) {
            self.calls.borrow_mut().push("notify".into());
        }
        fn server_limit(&self) -> Duration {
            Duration::from_millis(200)
        }
        fn poll_interval(&self) -> Duration {
            Duration::from_millis(1)
        }
    }

    fn stopped() -> DevServerState {
        DevServerState::stopped()
    }

    #[test]
    fn one_capture_at_a_time() {
        let guard = CaptureGuard::default();
        let ticket = guard.try_begin().unwrap();
        assert!(guard.is_busy());
        assert!(guard.try_begin().is_none());
        let env = FakeEnv::new(vec![state(DevServerStatus::Running, Some(URL), Some(1))]);
        let error = capture(&env, &guard, &env.project()).unwrap_err();
        assert!(error.contains("already being taken"), "{error}");
        assert!(env.calls().is_empty());
        drop(ticket);
        assert!(!guard.is_busy());
        assert!(guard.try_begin().is_some());
    }

    #[test]
    fn uses_a_running_server_and_leaves_it_running() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![state(DevServerStatus::Running, Some(URL), Some(1))]);
        let preview = capture(&env, &guard, &env.project()).unwrap().unwrap();
        assert_eq!(preview.kind, super::super::PreviewKind::Screenshot);
        assert_eq!(env.calls(), [format!("snapshot {URL}"), "notify".into()]);
        assert!(env.store.screenshot("blog").is_some());
        assert!(!guard.is_busy());
    }

    #[test]
    fn starts_a_stopped_server_and_stops_it_after() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![stopped()]);
        *env.after_start.borrow_mut() = vec![
            state(DevServerStatus::Installing, None, Some(7)),
            state(DevServerStatus::Starting, None, Some(7)),
            state(
                DevServerStatus::Running,
                Some("http://localhost:4322/"),
                Some(7),
            ),
        ];
        capture(&env, &guard, &env.project()).unwrap().unwrap();
        assert_eq!(
            env.calls(),
            [
                "start",
                "snapshot http://localhost:4322/",
                "notify",
                "stop 7"
            ]
        );
    }

    #[test]
    fn stops_the_server_it_started_even_when_the_snapshot_fails() {
        let guard = CaptureGuard::default();
        let mut env = FakeEnv::new(vec![stopped()]);
        env.snapshot = Err("snapshot timed out".into());
        *env.after_start.borrow_mut() = vec![state(DevServerStatus::Running, Some(URL), Some(7))];
        let error = capture(&env, &guard, &env.project()).unwrap_err();
        assert_eq!(error, "snapshot timed out");
        assert_eq!(
            env.calls(),
            [
                "start".to_string(),
                format!("snapshot {URL}"),
                "stop 7".into()
            ]
        );
        assert!(env.store.screenshot("blog").is_none());
        assert!(!guard.is_busy());
    }

    #[test]
    fn reports_a_server_that_fails_to_start() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![stopped()]);
        let mut failed = state(DevServerStatus::Error, None, None);
        failed.error = Some("Node.js isn't installed.\nmore".into());
        *env.after_start.borrow_mut() =
            vec![state(DevServerStatus::Starting, None, Some(7)), failed];
        let error = capture(&env, &guard, &env.project()).unwrap_err();
        assert_eq!(error, "The site couldn't start: Node.js isn't installed.");
        assert_eq!(env.calls(), ["start", "stop 7"]);
    }

    #[test]
    fn gives_up_on_a_server_that_never_gets_ready() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![stopped()]);
        *env.after_start.borrow_mut() = vec![state(DevServerStatus::Starting, None, Some(7))];
        let error = capture(&env, &guard, &env.project()).unwrap_err();
        assert!(error.contains("too long"), "{error}");
        assert_eq!(env.calls(), ["start", "stop 7"]);
    }

    #[test]
    fn the_writer_stopping_its_server_while_it_starts_ends_quietly() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![stopped()]);
        *env.after_start.borrow_mut() =
            vec![state(DevServerStatus::Installing, None, Some(7)), stopped()];
        assert_eq!(capture(&env, &guard, &env.project()), Ok(None));
        assert_eq!(env.calls(), ["start", "stop 7"]);
        assert!(env.store.screenshot("blog").is_none());
    }

    #[test]
    fn the_writer_stopping_its_server_mid_picture_keeps_the_last_preview() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![stopped()]);
        *env.after_start.borrow_mut() = vec![
            state(DevServerStatus::Running, Some(URL), Some(7)),
            stopped(),
        ];
        assert_eq!(capture(&env, &guard, &env.project()), Ok(None));
        assert_eq!(
            env.calls(),
            [
                "start".to_string(),
                format!("snapshot {URL}"),
                "stop 7".into()
            ]
        );
        assert!(
            env.store.screenshot("blog").is_none(),
            "nothing stored, no notify"
        );
    }

    #[test]
    fn never_stops_a_server_it_didnt_start() {
        let guard = CaptureGuard::default();
        let mut env = FakeEnv::new(vec![stopped()]);
        env.starts = None;
        *env.after_start.borrow_mut() = vec![state(DevServerStatus::Running, Some(URL), Some(7))];
        capture(&env, &guard, &env.project()).unwrap();
        assert_eq!(
            env.calls(),
            [
                "start".to_string(),
                format!("snapshot {URL}"),
                "notify".into()
            ]
        );
    }

    #[test]
    fn stops_the_server_it_started_even_after_a_panic() {
        struct Panicking(FakeEnv);
        impl CaptureEnv for Panicking {
            fn tools_enabled(&self) -> bool {
                true
            }
            fn server_state(&self, p: &str) -> DevServerState {
                self.0.server_state(p)
            }
            fn start_server_for_preview(&self, p: &str) -> Option<u64> {
                self.0.start_server_for_preview(p)
            }
            fn stop_preview_server(&self, p: &str, run: u64) {
                self.0.stop_preview_server(p, run)
            }
            fn snapshot(&self, _: &str) -> Result<Vec<u8>, String> {
                panic!("WebKit went away")
            }
            fn project_id(&self, p: &str) -> Option<String> {
                self.0.project_id(p)
            }
            fn store(&self) -> &Store {
                self.0.store()
            }
            fn notify(&self, p: &str) {
                self.0.notify(p)
            }
            fn poll_interval(&self) -> Duration {
                Duration::from_millis(1)
            }
        }
        let env = Panicking(FakeEnv::new(vec![stopped()]));
        *env.0.after_start.borrow_mut() = vec![state(DevServerStatus::Running, Some(URL), Some(7))];
        let guard = CaptureGuard::default();
        let project = env.0.project();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            capture(&env, &guard, &project)
        }));
        assert!(outcome.is_err());
        assert_eq!(env.0.calls(), ["start", "stop 7"]);
        assert!(!guard.is_busy());
    }

    #[test]
    fn waits_for_a_server_the_writer_is_starting_and_leaves_it_running() {
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![
            state(DevServerStatus::Starting, None, Some(3)),
            state(DevServerStatus::Starting, None, Some(3)),
            state(DevServerStatus::Running, Some(URL), Some(3)),
        ]);
        capture(&env, &guard, &env.project()).unwrap();
        assert_eq!(env.calls(), [format!("snapshot {URL}"), "notify".into()]);
    }

    #[test]
    fn refuses_when_the_tools_are_off_or_the_site_isnt_listed() {
        let guard = CaptureGuard::default();
        let mut env = FakeEnv::new(vec![state(DevServerStatus::Running, Some(URL), Some(1))]);
        env.tools = false;
        assert!(capture(&env, &guard, &env.project())
            .unwrap_err()
            .contains("Settings"));
        env.tools = true;
        env.id = None;
        assert!(capture(&env, &guard, &env.project())
            .unwrap_err()
            .contains("list of sites"));
        assert!(env.store.screenshot("blog").is_none());
        assert!(capture(&env, &guard, "/no/such/folder")
            .unwrap_err()
            .contains("isn't there"));
    }

    #[test]
    fn captures_by_itself_at_most_once_an_hour() {
        let now = SystemTime::now();
        assert!(should_auto_capture(None, now));
        assert!(!should_auto_capture(
            Some(now - Duration::from_secs(59 * 60)),
            now
        ));
        assert!(should_auto_capture(
            Some(now - Duration::from_secs(60 * 60)),
            now
        ));
        assert!(!should_auto_capture(
            Some(now + Duration::from_secs(5)),
            now
        ));

        let guard = CaptureGuard::default();
        let running = state(DevServerStatus::Running, Some(URL), Some(1));
        let env = FakeEnv::new(vec![running.clone()]);
        let project = env.project();
        assert!(capture_when_ready(&env, &guard, &project, &running, now)
            .unwrap()
            .is_ok());
        // Just taken: not again
        assert!(capture_when_ready(&env, &guard, &project, &running, now).is_none());
        // A failed attempt counts too
        let mut failing = FakeEnv::new(vec![running.clone()]);
        failing.snapshot = Err("failed".into());
        let project = failing.project();
        assert!(
            capture_when_ready(&failing, &guard, &project, &running, now)
                .unwrap()
                .is_err()
        );
        assert!(capture_when_ready(&failing, &guard, &project, &running, now).is_none());
        let later = now + AUTO_INTERVAL;
        assert!(capture_when_ready(&failing, &guard, &project, &running, later).is_some());
    }

    #[test]
    fn automatic_captures_wait_for_a_ready_server_and_a_free_guard() {
        let now = SystemTime::now();
        let guard = CaptureGuard::default();
        let env = FakeEnv::new(vec![state(DevServerStatus::Running, Some(URL), Some(1))]);
        let project = env.project();
        let starting = state(DevServerStatus::Starting, None, Some(1));
        assert!(capture_when_ready(&env, &guard, &project, &starting, now).is_none());
        let running = state(DevServerStatus::Running, Some(URL), Some(1));
        let ticket = guard.try_begin().unwrap();
        assert!(capture_when_ready(&env, &guard, &project, &running, now).is_none());
        drop(ticket);
        // Skipping while busy didn't use up the hour
        assert!(capture_when_ready(&env, &guard, &project, &running, now).is_some());
        assert_eq!(env.calls(), [format!("snapshot {URL}"), "notify".into()]);
    }

    #[test]
    fn captures_only_local_http_pages() {
        assert_eq!(
            page_url("http://localhost:4321/").as_deref(),
            Some("http://localhost:4321/")
        );
        assert_eq!(
            page_url("http://localhost:4321").as_deref(),
            Some("http://localhost:4321/")
        );
        assert_eq!(
            page_url("http://127.0.0.1:3000/blog/").as_deref(),
            Some("http://localhost:3000/blog/")
        );
        assert_eq!(
            page_url("http://[::1]:4321/").as_deref(),
            Some("http://localhost:4321/")
        );
        assert_eq!(page_url("https://example.com:443/"), None);
        assert_eq!(page_url("http://example.com:4321/"), None);
        assert_eq!(page_url("http://192.168.1.5:4321/"), None);
        assert_eq!(page_url("not a url"), None);
    }
}
