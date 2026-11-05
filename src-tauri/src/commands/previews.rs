//! Site previews for the Home screen. The work is in `crate::previews`.

use crate::previews::{self, ProjectPreview, TauriEnv};
use tauri::AppHandle;

/// The stored screenshot of the site if there is one, else its share image
/// from `public/`, else null. Fast: no network and no dev server.
#[tauri::command]
#[specta::specta]
pub async fn project_preview(
    app: AppHandle,
    project_path: String,
) -> Result<Option<ProjectPreview>, String> {
    let env = TauriEnv::new(&app)?;
    tauri::async_runtime::spawn_blocking(move || env.lookup(&project_path))
        .await
        .map_err(|e| format!("Couldn't read the preview: {e}"))
}

/// Takes a new screenshot of the site's home page as it runs locally, starting
/// its dev server if it isn't running (and stopping it again after), stores it
/// and returns it.
#[tauri::command]
#[specta::specta]
pub async fn capture_project_preview(
    app: AppHandle,
    project_path: String,
) -> Result<Option<ProjectPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || previews::capture_now(&app, &project_path))
        .await
        .map_err(|e| format!("Couldn't take the preview: {e}"))?
}
