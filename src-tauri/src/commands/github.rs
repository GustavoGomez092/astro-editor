//! GitHub commands: device-flow sign-in, repository info, pull requests and the
//! repository list for cloning. The logic lives in `crate::github`.

use crate::github::auth::{auth, resolve_client_id};
use crate::github::{DeviceCode, GitHubAuthStatus, PullRequest, RepoInfo, RepoSummary};
use tauri::{AppHandle, Manager};

const NOT_IMPLEMENTED: &str = "not implemented";

/// The OAuth App client ID: Preferences → Advanced, else the one compiled in
fn client_id(app: &AppHandle) -> Result<String, String> {
    let settings =
        app.path().app_local_data_dir().ok().and_then(|dir| {
            std::fs::read_to_string(dir.join("preferences/global-settings.json")).ok()
        });
    resolve_client_id(
        settings.as_deref(),
        option_env!("ASTRO_EDITOR_GITHUB_CLIENT_ID"),
    )
    .ok_or_else(|| {
        "This build has no GitHub client ID. Add one in Preferences → Advanced.".to_string()
    })
}

#[tauri::command]
#[specta::specta]
pub async fn github_auth_status() -> Result<GitHubAuthStatus, String> {
    auth()?.status().await
}

#[tauri::command]
#[specta::specta]
pub async fn github_device_start(app: AppHandle) -> Result<DeviceCode, String> {
    let client_id = client_id(&app)?;
    auth()?.device_start(&client_id).await
}

/// Resolves when signed in; fails with a readable message on expiry or denial
#[tauri::command]
#[specta::specta]
pub async fn github_device_poll() -> Result<GitHubAuthStatus, String> {
    auth()?.device_poll().await
}

#[tauri::command]
#[specta::specta]
pub async fn github_sign_out() -> Result<(), String> {
    auth()?.sign_out()
}

/// `None` when `origin` isn't a github.com remote
#[tauri::command]
#[specta::specta]
pub async fn github_repo_info(project_path: String) -> Result<Option<RepoInfo>, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn github_list_pull_requests(project_path: String) -> Result<Vec<PullRequest>, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn github_create_pull_request(
    project_path: String,
    title: String,
    body: String,
    base: String,
    head: String,
) -> Result<PullRequest, String> {
    let _ = (project_path, title, body, base, head);
    Err(NOT_IMPLEMENTED.to_string())
}

/// Merges with a merge commit
#[tauri::command]
#[specta::specta]
pub async fn github_merge_pull_request(
    project_path: String,
    number: u32,
) -> Result<PullRequest, String> {
    let _ = (project_path, number);
    Err(NOT_IMPLEMENTED.to_string())
}

/// Repositories the signed-in user owns or collaborates on, most recently updated first
#[tauri::command]
#[specta::specta]
pub async fn github_list_repos() -> Result<Vec<RepoSummary>, String> {
    Err(NOT_IMPLEMENTED.to_string())
}
