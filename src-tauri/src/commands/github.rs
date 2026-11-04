//! GitHub commands: device-flow sign-in, repository info, pull requests and the
//! repository list for cloning. The logic lives in `crate::github`.

use crate::git;
use crate::github::auth::{auth, resolve_client_id};
use crate::github::pulls::{self, RepoRef};
use crate::github::repos;
use crate::github::{DeviceCode, GitHubAuthStatus, PullRequest, RepoInfo, RepoSummary};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The token, read on a blocking thread (the first read may ask the Keychain)
async fn signed_in_token() -> Result<String, String> {
    let auth = auth()?;
    tokio::task::spawn_blocking(move || auth.token())
        .await
        .map_err(|e| format!("Reading the GitHub sign-in stopped unexpectedly: {e}"))?
        .ok_or_else(|| "Sign in with GitHub first.".to_string())
}

async fn repo_info_for(project_path: String) -> Result<Option<RepoInfo>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(git::open(&PathBuf::from(project_path))?.and_then(|repo| repos::repo_info(&repo)))
    })
    .await
    .map_err(|e| format!("Reading the repository stopped unexpectedly: {e}"))?
}

/// The project's GitHub repository and a token, or a readable reason there isn't one
async fn github_repo(project_path: String) -> Result<(RepoInfo, String), String> {
    let info = repo_info_for(project_path)
        .await?
        .ok_or_else(|| "This project isn't connected to a GitHub repository.".to_string())?;
    Ok((info, signed_in_token().await?))
}

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
    let status = auth()?.device_poll().await?;
    // Repositories opened so far get the profile's name for commits, if git
    // has none
    if let Some(user) = auth()?.cached_user() {
        let _ = tokio::task::spawn_blocking(move || {
            for git_dir in git::opened_repositories() {
                if let Ok(repo) = git2::Repository::open(&git_dir) {
                    let lock = git::repo_lock(repo.path());
                    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                    crate::commands::git::remember_identity(&repo, &user);
                }
            }
        })
        .await;
    }
    Ok(status)
}

/// Stops waiting for a device-flow sign-in. A stored token is kept.
#[tauri::command]
#[specta::specta]
pub async fn github_cancel_sign_in() -> Result<(), String> {
    auth()?.cancel_sign_in();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn github_sign_out() -> Result<(), String> {
    auth()?.sign_out().await
}

/// `None` when `origin` isn't a github.com remote
#[tauri::command]
#[specta::specta]
pub async fn github_repo_info(project_path: String) -> Result<Option<RepoInfo>, String> {
    repo_info_for(project_path).await
}

#[tauri::command]
#[specta::specta]
pub async fn github_list_pull_requests(project_path: String) -> Result<Vec<PullRequest>, String> {
    let (info, token) = github_repo(project_path).await?;
    let repo = RepoRef {
        owner: &info.owner,
        repo: &info.repo,
    };
    pulls::list_pull_requests(auth()?.client(), &token, &repo).await
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
    let (info, token) = github_repo(project_path).await?;
    let repo = RepoRef {
        owner: &info.owner,
        repo: &info.repo,
    };
    pulls::create_pull_request(auth()?.client(), &token, &repo, &title, &body, &base, &head).await
}

/// Merges with a merge commit
#[tauri::command]
#[specta::specta]
pub async fn github_merge_pull_request(
    project_path: String,
    number: u32,
) -> Result<PullRequest, String> {
    let (info, token) = github_repo(project_path).await?;
    let repo = RepoRef {
        owner: &info.owner,
        repo: &info.repo,
    };
    pulls::merge_pull_request(auth()?.client(), &token, &repo, number).await
}

/// Repositories the signed-in user owns or collaborates on, most recently updated first
#[tauri::command]
#[specta::specta]
pub async fn github_list_repos() -> Result<Vec<RepoSummary>, String> {
    let token = signed_in_token().await?;
    repos::list_repos(auth()?.client(), &token).await
}
