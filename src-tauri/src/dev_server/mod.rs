//! Runs a project's dev server so a writer can preview the site: one server per
//! project, started through the login shell in its own process group so it can
//! always be stopped as a whole. See `docs/developer/dev-server.md`.

// The process lifecycle that uses all of this comes in the next commit
#![allow(dead_code)]

pub mod detect;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

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

/// Called with the project path and its new state whenever a state changes.
/// The app emits `dev-server-state`; tests record the changes.
pub type StateListener = Arc<dyn Fn(&str, &DevServerState) + Send + Sync>;

/// One project's server
#[derive(Default)]
pub(crate) struct Server {
    pub(crate) inner: Mutex<ServerInner>,
}

pub(crate) struct ServerInner {
    pub(crate) state: DevServerState,
    pub(crate) logs: VecDeque<String>,
}

impl Default for ServerInner {
    fn default() -> Self {
        Self {
            state: DevServerState::stopped(),
            logs: VecDeque::new(),
        }
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
}

impl DevServers {
    pub fn new(listener: StateListener) -> Self {
        Self {
            shared: Arc::new(Shared {
                servers: Mutex::new(HashMap::new()),
                listener,
            }),
        }
    }

    pub(crate) fn server(&self, project_path: &str) -> Option<Arc<Server>> {
        self.shared
            .servers
            .lock()
            .unwrap()
            .get(project_path)
            .cloned()
    }

    pub fn state(&self, project_path: &str) -> DevServerState {
        self.server(project_path)
            .map(|server| server.inner.lock().unwrap().state.clone())
            .unwrap_or_else(DevServerState::stopped)
    }

    pub fn logs(&self, project_path: &str) -> Vec<String> {
        self.server(project_path)
            .map(|server| server.inner.lock().unwrap().logs.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn start(&self, project_path: &str, override_command: Option<&str>) -> DevServerState {
        let _ = override_command;
        self.state(project_path)
    }

    pub fn stop(&self, project_path: &str) -> DevServerState {
        self.state(project_path)
    }
}
