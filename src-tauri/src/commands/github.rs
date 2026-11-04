//! GitHub commands: device-flow sign-in, repository info, pull requests and the
//! repository list for cloning. The logic lives in `crate::github`.

use crate::github::{DeviceCode, GitHubAuthStatus, PullRequest, RepoInfo, RepoSummary};

const NOT_IMPLEMENTED: &str = "not implemented";

#[tauri::command]
#[specta::specta]
pub async fn github_auth_status() -> Result<GitHubAuthStatus, String> {
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn github_device_start() -> Result<DeviceCode, String> {
    Err(NOT_IMPLEMENTED.to_string())
}

/// Resolves when signed in; fails with a readable message on expiry or denial
#[tauri::command]
#[specta::specta]
pub async fn github_device_poll() -> Result<GitHubAuthStatus, String> {
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn github_sign_out() -> Result<(), String> {
    Err(NOT_IMPLEMENTED.to_string())
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
