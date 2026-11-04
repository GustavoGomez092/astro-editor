//! Git commands for the Git panel. Each one runs its libgit2 work on a blocking
//! thread so the UI never waits on disk or network. The logic lives in `crate::git`.

use crate::git::{
    self, BranchInfo, CommitDetails, FileDiff, GitStatus, GraphCommit, PublishResult, SyncResult,
};
use crate::github::auth::{self, GitHubUser};
use std::path::PathBuf;

const NOT_IMPLEMENTED: &str = "not implemented";

/// Run libgit2 work on a blocking thread
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("The git operation stopped unexpectedly: {e}"))?
}

/// The signed-in GitHub profile, for the commit author when git config has no
/// name and email. Only asks GitHub when it's needed.
async fn author_fallback(project_path: &str) -> Option<GitHubUser> {
    let path = PathBuf::from(project_path);
    let has_identity = blocking(move || {
        Ok(git::open(&path)?
            .map(|repo| git::sync::has_config_identity(&repo))
            .unwrap_or(true))
    })
    .await
    .unwrap_or(true);
    if has_identity {
        return None;
    }
    let auth = auth::auth().ok()?;
    let _ = auth.status().await;
    auth.cached_user()
}

#[tauri::command]
#[specta::specta]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    blocking(move || git::status::status(&PathBuf::from(project_path))).await
}

/// Working tree vs `HEAD` for one file
#[tauri::command]
#[specta::specta]
pub async fn git_file_diff(project_path: String, path: String) -> Result<FileDiff, String> {
    blocking(move || git::diff::file_diff(&PathBuf::from(project_path), &path)).await
}

#[tauri::command]
#[specta::specta]
pub async fn git_fetch(project_path: String) -> Result<GitStatus, String> {
    let token = auth::token();
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::remote::fetch(&repo, token.as_deref())?;
        git::status::repo_status(&repo)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_sync(project_path: String) -> Result<SyncResult, String> {
    let token = auth::token();
    let user = author_fallback(&project_path).await;
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::sync::sync(&repo, token.as_deref(), user.as_ref())
    })
    .await
}

/// Commit everything, merge incoming changes, push
#[tauri::command]
#[specta::specta]
pub async fn git_publish(project_path: String, message: String) -> Result<PublishResult, String> {
    let token = auth::token();
    let user = author_fallback(&project_path).await;
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::sync::publish(&repo, &message, token.as_deref(), user.as_ref())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_push(project_path: String) -> Result<GitStatus, String> {
    let token = auth::token();
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::remote::push_current_branch(&repo, token.as_deref())?;
        git::status::repo_status(&repo)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_branches(project_path: String) -> Result<Vec<BranchInfo>, String> {
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::branches::branches(&repo)
    })
    .await
}

/// Safe checkout; never discards changes
#[tauri::command]
#[specta::specta]
pub async fn git_checkout(
    project_path: String,
    name: String,
    create: bool,
) -> Result<GitStatus, String> {
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::branches::checkout(&repo, &name, create)
    })
    .await
}

/// Topological, newest first
#[tauri::command]
#[specta::specta]
pub async fn git_log_graph(project_path: String, limit: u32) -> Result<Vec<GraphCommit>, String> {
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::log::log_graph(&repo, limit)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_commit_details(project_path: String, id: String) -> Result<CommitDetails, String> {
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::log::commit_details(&repo, &id)
    })
    .await
}

/// A commit vs its first parent, for one file
#[tauri::command]
#[specta::specta]
pub async fn git_commit_file_diff(
    project_path: String,
    id: String,
    path: String,
) -> Result<FileDiff, String> {
    blocking(move || git::diff::commit_file_diff(&PathBuf::from(project_path), &id, &path)).await
}

/// "Bring in changes from main": merge the default branch into the current one
#[tauri::command]
#[specta::specta]
pub async fn git_merge_default_branch(project_path: String) -> Result<SyncResult, String> {
    let token = auth::token();
    let user = author_fallback(&project_path).await;
    blocking(move || {
        let repo = git::open_required(&PathBuf::from(project_path))?;
        git::sync::merge_default_branch(&repo, token.as_deref(), user.as_ref())
    })
    .await
}

/// Clone into a new folder inside `parent_dir`; returns the new project path
#[tauri::command]
#[specta::specta]
pub async fn git_clone(clone_url: String, parent_dir: String) -> Result<String, String> {
    let _ = (clone_url, parent_dir);
    Err(NOT_IMPLEMENTED.to_string())
}
