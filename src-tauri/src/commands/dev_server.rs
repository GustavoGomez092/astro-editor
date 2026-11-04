//! The project's dev server, for previewing the site. The work is in
//! `crate::dev_server`; these commands find the project's settings and keep
//! waiting off the main thread.

use crate::dev_server::{detect, DevServerState, DevServers};
use std::path::Path;
use tauri::{AppHandle, Manager, State};

/// Stops every project's dev server, waiting until they're gone. Quitting
/// calls it (`commands/quit.rs` and `RunEvent::Exit`), so no server outlives
/// the app.
pub fn stop_dev_servers(app: &AppHandle) {
    if let Some(servers) = app.try_state::<DevServers>() {
        servers.stop_all();
    }
}

/// The event sent with a `DevServerState` whenever a server's state changes
pub const STATE_EVENT: &str = "dev-server-state";

fn check_project(project_path: &str) -> Result<(), String> {
    if Path::new(project_path).is_dir() {
        Ok(())
    } else {
        Err(format!("The project folder {project_path} doesn't exist."))
    }
}

/// The Dev command set in the project's settings, if any
fn dev_command_override(app: &AppHandle, project_path: &str) -> Option<String> {
    let data_dir = app.path().app_local_data_dir().ok()?;
    detect::read_dev_command_override(&data_dir.join("preferences"), project_path)
}

/// Starts the project's dev server, installing dependencies first if needed.
/// Returns at once with the new state; later changes arrive as events.
#[tauri::command]
#[specta::specta]
pub async fn dev_server_start(
    app: AppHandle,
    servers: State<'_, DevServers>,
    project_path: String,
) -> Result<DevServerState, String> {
    check_project(&project_path)?;
    let override_command = dev_command_override(&app, &project_path);
    let servers = servers.inner().clone();
    // The first start waits for the user's PATH (env_path.rs), up to 8 s
    tauri::async_runtime::spawn_blocking(move || {
        servers.start(&project_path, override_command.as_deref())
    })
    .await
    .map_err(|e| format!("Couldn't start the dev server: {e}"))
}

/// Stops the project's dev server and everything it started. Waits until it's
/// gone (at most a few seconds).
#[tauri::command]
#[specta::specta]
pub async fn dev_server_stop(
    servers: State<'_, DevServers>,
    project_path: String,
) -> Result<DevServerState, String> {
    let servers = servers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || servers.stop(&project_path))
        .await
        .map_err(|e| format!("Couldn't stop the dev server: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn dev_server_state(
    servers: State<'_, DevServers>,
    project_path: String,
) -> Result<DevServerState, String> {
    Ok(servers.state(&project_path))
}

/// The server's recent output, oldest first
#[tauri::command]
#[specta::specta]
pub async fn dev_server_logs(
    servers: State<'_, DevServers>,
    project_path: String,
) -> Result<Vec<String>, String> {
    Ok(servers.logs(&project_path))
}
