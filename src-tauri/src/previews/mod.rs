//! Site previews for the Home screen: a screenshot of the site's home page as
//! it runs locally, or the site's share image until there is one. See
//! `docs/developer/site-previews.md`.

pub mod capture;
pub mod share;
pub mod store;
pub mod thumb;
pub mod window;

use crate::dev_server::{detect, env_path, DevServerState, DevServers};
use capture::{CaptureEnv, CaptureGuard};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::SystemTime;
use store::Store;
use tauri::{AppHandle, Emitter, Manager};

/// The event sent with a `ProjectPreviewUpdated` whenever a stored preview changes
pub const UPDATED_EVENT: &str = "project-preview-updated";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewKind {
    /// A screenshot of the site's home page
    Screenshot,
    /// The site's share image from `public/`
    ShareImage,
}

/// A site's preview image
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreview {
    pub kind: PreviewKind,
    /// A `data:` URL of a JPEG, at most 800 px wide
    pub src: String,
    /// When the screenshot was taken (ISO 8601); null for a share image
    pub taken_at: Option<String>,
}

/// Payload of the `project-preview-updated` event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewUpdated {
    pub project_path: String,
}

/// Snapshots are only implemented for WKWebView (`crate::snapshot`)
const CAN_CAPTURE: bool = cfg!(target_os = "macos");

/// The app's side of a capture: its dev servers, its windows and its data folder
pub struct TauriEnv {
    app: AppHandle,
    store: Store,
    preferences: PathBuf,
}

impl TauriEnv {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let data = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Couldn't find the app's data folder: {e}"))?;
        Ok(Self {
            app: app.clone(),
            store: Store::new(data.join("previews")),
            preferences: data.join("preferences"),
        })
    }

    fn servers(&self) -> Option<DevServers> {
        self.app
            .try_state::<DevServers>()
            .map(|s| s.inner().clone())
    }

    /// The project's preview without taking one: see `store::lookup`
    pub fn lookup(&self, project_path: &str) -> Option<ProjectPreview> {
        store::lookup(&self.store, &self.preferences, project_path)
    }

    /// Removes the previews of projects no longer in the registry
    pub fn prune(&self) {
        if let Some(keep) = store::registry_ids(&self.preferences) {
            let removed = self.store.prune(&keep);
            if removed > 0 {
                log::info!(
                    "Astro Editor [PREVIEWS] Removed {removed} previews of removed projects"
                );
            }
        }
    }
}

impl CaptureEnv for TauriEnv {
    fn tools_enabled(&self) -> bool {
        let settings = std::fs::read_to_string(self.preferences.join("global-settings.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        // On unless turned off, like PUBLISHING_TOOLS_DEFAULT
        settings
            .as_ref()
            .and_then(|s| s.get("general")?.get("showPublishingTools")?.as_bool())
            .unwrap_or(true)
    }

    fn server_state(&self, project_path: &str) -> DevServerState {
        self.servers()
            .map(|servers| servers.state(project_path))
            .unwrap_or_else(DevServerState::stopped)
    }

    fn start_server_for_preview(&self, project_path: &str) -> Option<u64> {
        let servers = self.servers()?;
        env_path::warm_up();
        let command = detect::read_dev_command_override(&self.preferences, project_path);
        servers.start_for_preview(project_path, command.as_deref())
    }

    fn stop_preview_server(&self, project_path: &str, run: u64) {
        if let Some(servers) = self.servers() {
            servers.stop_preview(project_path, run);
        }
    }

    fn snapshot(&self, url: &str) -> Result<Vec<u8>, String> {
        window::capture_page(&self.app, url)
    }

    fn project_id(&self, project_path: &str) -> Option<String> {
        store::project_id(&self.preferences, project_path)
    }

    fn store(&self) -> &Store {
        &self.store
    }

    fn notify(&self, project_path: &str) {
        let payload = ProjectPreviewUpdated {
            project_path: project_path.to_string(),
        };
        let _ = self.app.emit(UPDATED_EVENT, payload);
    }
}

fn guard(app: &AppHandle) -> CaptureGuard {
    app.try_state::<CaptureGuard>()
        .map(|g| g.inner().clone())
        .unwrap_or_default()
}

/// A dev server's state changed: once it's ready, takes the project's
/// screenshot on a thread of its own if the last one is over an hour old
pub fn on_server_state(app: &AppHandle, project_path: &str, state: &DevServerState) {
    if !CAN_CAPTURE || capture::page_url(state.url.as_deref().unwrap_or("")).is_none() {
        return;
    }
    let app = app.clone();
    let project_path = project_path.to_string();
    let state = state.clone();
    std::thread::spawn(move || {
        let Ok(env) = TauriEnv::new(&app) else {
            return;
        };
        let result = capture::capture_when_ready(
            &env,
            &guard(&app),
            &project_path,
            &state,
            SystemTime::now(),
        );
        match result {
            Some(Ok(_)) => log::info!("Astro Editor [PREVIEWS] Took the preview of {project_path}"),
            Some(Err(e)) => log::warn!("Astro Editor [PREVIEWS] No preview of {project_path}: {e}"),
            None => {}
        }
    });
}

/// Refresh preview: see `capture::capture`. Blocks.
pub fn capture_now(app: &AppHandle, project_path: &str) -> Result<Option<ProjectPreview>, String> {
    if !CAN_CAPTURE {
        return Err("Previews can only be taken on macOS for now.".into());
    }
    let env = TauriEnv::new(app)?;
    let result = capture::capture(&env, &guard(app), project_path);
    if let Err(e) = &result {
        log::warn!("Astro Editor [PREVIEWS] No preview of {project_path}: {e}");
    }
    result
}

/// Removes previews of projects no longer in the registry, on a thread of its own
pub fn prune_in_background(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Ok(env) = TauriEnv::new(&app) {
            env.prune();
        }
    });
}
