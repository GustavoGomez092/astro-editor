//! Git commands for the Git panel. Each one runs its libgit2 work on a blocking
//! thread so the UI never waits on disk or network. The logic lives in `crate::git`.

use crate::git::{
    BranchInfo, CommitDetails, FileDiff, GitStatus, GraphCommit, PublishResult, SyncResult,
};

const NOT_IMPLEMENTED: &str = "not implemented";

#[tauri::command]
#[specta::specta]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

/// Working tree vs `HEAD` for one file
#[tauri::command]
#[specta::specta]
pub async fn git_file_diff(project_path: String, path: String) -> Result<FileDiff, String> {
    let _ = (project_path, path);
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn git_fetch(project_path: String) -> Result<GitStatus, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn git_sync(project_path: String) -> Result<SyncResult, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

/// Commit everything, merge incoming changes, push
#[tauri::command]
#[specta::specta]
pub async fn git_publish(project_path: String, message: String) -> Result<PublishResult, String> {
    let _ = (project_path, message);
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn git_push(project_path: String) -> Result<GitStatus, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn git_branches(project_path: String) -> Result<Vec<BranchInfo>, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

/// Safe checkout; never discards changes
#[tauri::command]
#[specta::specta]
pub async fn git_checkout(
    project_path: String,
    name: String,
    create: bool,
) -> Result<GitStatus, String> {
    let _ = (project_path, name, create);
    Err(NOT_IMPLEMENTED.to_string())
}

/// Topological, newest first
#[tauri::command]
#[specta::specta]
pub async fn git_log_graph(project_path: String, limit: u32) -> Result<Vec<GraphCommit>, String> {
    let _ = (project_path, limit);
    Err(NOT_IMPLEMENTED.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn git_commit_details(project_path: String, id: String) -> Result<CommitDetails, String> {
    let _ = (project_path, id);
    Err(NOT_IMPLEMENTED.to_string())
}

/// A commit vs its first parent, for one file
#[tauri::command]
#[specta::specta]
pub async fn git_commit_file_diff(
    project_path: String,
    id: String,
    path: String,
) -> Result<FileDiff, String> {
    let _ = (project_path, id, path);
    Err(NOT_IMPLEMENTED.to_string())
}

/// "Bring in changes from main": merge the default branch into the current one
#[tauri::command]
#[specta::specta]
pub async fn git_merge_default_branch(project_path: String) -> Result<SyncResult, String> {
    let _ = project_path;
    Err(NOT_IMPLEMENTED.to_string())
}

/// Clone into a new folder inside `parent_dir`; returns the new project path
#[tauri::command]
#[specta::specta]
pub async fn git_clone(clone_url: String, parent_dir: String) -> Result<String, String> {
    let _ = (clone_url, parent_dir);
    Err(NOT_IMPLEMENTED.to_string())
}
