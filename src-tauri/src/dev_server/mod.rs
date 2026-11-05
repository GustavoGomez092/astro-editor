//! Runs a project's dev server so a writer can preview the site: one server per
//! project, started with the user's `PATH` in its own process group so it can
//! always be stopped as a whole. See `docs/developer/dev-server.md`.

pub mod detect;
pub mod env_path;
mod process;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// How many lines of output each server keeps for the output popover
pub const LOG_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DevServerStatus {
    Stopped,
    /// Installing dependencies before starting
    Installing,
    Starting,
    Running,
    /// Another server for the project was already running, started elsewhere
    External,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevServerState {
    pub status: DevServerStatus,
    pub url: Option<String>,
    pub command: Option<String>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

impl DevServerState {
    pub fn stopped() -> Self {
        Self {
            status: DevServerStatus::Stopped,
            url: None,
            command: None,
            pid: None,
            error: None,
        }
    }
}

/// Locks a mutex even if a thread panicked holding it: the state inside is
/// still usable, and stopping servers (on quit, say) must never fail on it
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Called with the project path and its new state whenever a state changes.
/// The app emits `dev-server-state`; tests record the changes.
pub type StateListener = Arc<dyn Fn(&str, &DevServerState) + Send + Sync>;

/// One project's server
#[derive(Default)]
pub(crate) struct Server {
    pub(crate) inner: Mutex<ServerInner>,
    /// Held for the whole of a prepare, so two never overlap
    pub(crate) preparing: Mutex<()>,
}

pub(crate) struct ServerInner {
    pub(crate) state: DevServerState,
    pub(crate) logs: VecDeque<String>,
    /// Counts starts, so a finished run's threads can't change a newer run's state
    pub(crate) run: u64,
    pub(crate) stop_requested: bool,
    /// The running process (install or server), which leads its process group
    pub(crate) pgid: Option<u32>,
    /// A prepare's `astro sync`, which leads its own process group. Stopping
    /// (and quitting) ends it too.
    pub(crate) sync_pgid: Option<u32>,
    pub(crate) parser: detect::OutputParser,
}

impl Default for ServerInner {
    fn default() -> Self {
        Self {
            state: DevServerState::stopped(),
            logs: VecDeque::new(),
            run: 0,
            stop_requested: false,
            pgid: None,
            sync_pgid: None,
            parser: detect::OutputParser::default(),
        }
    }
}

impl ServerInner {
    pub(crate) fn push_log(&mut self, line: String) {
        if self.logs.len() == LOG_LIMIT {
            self.logs.pop_front();
        }
        self.logs.push_back(line);
    }

    pub(crate) fn is_active(&self) -> bool {
        matches!(
            self.state.status,
            DevServerStatus::Installing | DevServerStatus::Starting | DevServerStatus::Running
        )
    }
}

/// Every project's server, kept in Tauri's managed state. Cloning shares it.
#[derive(Clone)]
pub struct DevServers {
    pub(crate) shared: Arc<Shared>,
}

pub(crate) struct Shared {
    pub(crate) servers: Mutex<HashMap<String, Arc<Server>>>,
    pub(crate) listener: StateListener,
    pub(crate) config: Config,
}

/// How servers are launched. The defaults suit the app; tests swap the shell
/// for one that doesn't read the user's profile.
#[derive(Default, Clone)]
pub struct Config {
    /// The PATH servers run with. `None` uses the user's, resolved from
    /// their shell (`env_path.rs`).
    pub path: Option<String>,
    /// Extra environment variables for the server
    pub env: Vec<(String, String)>,
}

impl DevServers {
    pub fn new(listener: StateListener) -> Self {
        Self::with_config(listener, Config::default())
    }

    pub fn with_config(listener: StateListener, config: Config) -> Self {
        Self {
            shared: Arc::new(Shared {
                servers: Mutex::new(HashMap::new()),
                listener,
                config,
            }),
        }
    }

    pub(crate) fn server(&self, project_path: &str) -> Option<Arc<Server>> {
        self.shared
            .servers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(project_path)
            .cloned()
    }

    pub fn state(&self, project_path: &str) -> DevServerState {
        self.server(project_path)
            .map(|server| lock(&server.inner).state.clone())
            .unwrap_or_else(DevServerState::stopped)
    }

    /// Counts the project's starts, so a caller that started a server can
    /// tell whether it's still that run (the site previews stop only their own)
    pub fn run(&self, project_path: &str) -> u64 {
        self.server(project_path)
            .map(|server| lock(&server.inner).run)
            .unwrap_or(0)
    }

    pub fn logs(&self, project_path: &str) -> Vec<String> {
        self.server(project_path)
            .map(|server| lock(&server.inner).logs.iter().cloned().collect())
            .unwrap_or_default()
    }
}

impl Drop for Shared {
    /// A backstop for quitting without `stop_all`: kills any server still running
    fn drop(&mut self) {
        let servers = self
            .servers
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        for server in servers.values() {
            let inner = lock(&server.inner);
            if let (true, Some(pgid)) = (inner.is_active(), inner.pgid) {
                process::kill_group(pgid);
            }
            if let Some(pgid) = inner.sync_pgid {
                process::kill_group(pgid);
            }
        }
    }
}
