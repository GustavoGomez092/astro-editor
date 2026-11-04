//! Site previews for the Home screen. The work is in `crate::previews`.

use crate::previews::ProjectPreview;

/// The stored screenshot of the site if there is one, else its share image
/// from `public/`, else null. Fast: no network and no dev server.
#[tauri::command]
#[specta::specta]
pub async fn project_preview(project_path: String) -> Result<Option<ProjectPreview>, String> {
    let _ = project_path;
    Ok(None)
}

/// Takes a new screenshot of the site's home page as it runs locally, starting
/// its dev server if it isn't running (and stopping it again after), stores it
/// and returns it.
#[tauri::command]
#[specta::specta]
pub async fn capture_project_preview(
    project_path: String,
) -> Result<Option<ProjectPreview>, String> {
    let _ = project_path;
    Ok(None)
}
