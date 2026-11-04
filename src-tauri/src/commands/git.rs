//! Git commands for the Git panel. Each one runs its libgit2 work on a blocking
//! thread so the UI never waits on disk or network, and holds the repository's lock
//! (`git::with_repo`) so commands on one repository never interleave. The token is
//! read inside the blocking work too, since the first read may ask the Keychain.
//! The logic lives in `crate::git`.

use crate::git::{
    self, BranchInfo, CloneProgress, CommitDetails, ConflictFile, ConflictResolution, FileDiff,
    GitStatus, GraphCommit, PublishResult, SyncResult,
};
use crate::github::auth::{self, GitHubUser};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

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
    signed_in_profile().await
}

/// The signed-in GitHub profile: fetched once a launch, else the one saved on
/// disk when GitHub can't be reached
pub(crate) async fn signed_in_profile() -> Option<GitHubUser> {
    let auth = auth::auth().ok()?;
    let _ = auth.status().await;
    auth.cached_user().await
}

/// [`remember_identity`] for the profile `author_fallback` found, which it finds
/// only when git has no identity
fn remember_identity_of(repo: &git2::Repository, user: Option<&GitHubUser>) {
    if let Some(user) = user {
        remember_identity(repo, user);
    }
}

/// Write the profile's name and no-reply address into the repository's own
/// config when git has none, so every tool commits with the same name. Best
/// effort: commits still fall back to the profile without it.
pub(crate) fn remember_identity(repo: &git2::Repository, user: &GitHubUser) {
    match git::sync::ensure_identity(repo, user) {
        Ok(true) => log::info!(
            "Astro Editor [GIT] Set this repository's commit name to the GitHub profile's"
        ),
        Ok(false) => {}
        Err(e) => log::warn!("Astro Editor [GIT] {e}"),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    blocking(move || {
        let path = PathBuf::from(project_path);
        if git::open(&path)?.is_none() {
            return git::status::status(&path);
        }
        git::with_repo(&path, git::status::repo_status)
    })
    .await
}

/// Working tree vs `HEAD` for one file
#[tauri::command]
#[specta::specta]
pub async fn git_file_diff(project_path: String, path: String) -> Result<FileDiff, String> {
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::diff::file_diff(repo, &path)
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_fetch(project_path: String) -> Result<GitStatus, String> {
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::remote::fetch(repo, auth::token().as_deref())?;
            git::status::repo_status(repo)
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_sync(project_path: String) -> Result<SyncResult, String> {
    let user = author_fallback(&project_path).await;
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            remember_identity_of(repo, user.as_ref());
            git::sync::sync(repo, auth::token().as_deref(), user.as_ref())
        })
    })
    .await
}

/// Commit everything, merge incoming changes, push
#[tauri::command]
#[specta::specta]
pub async fn git_publish(project_path: String, message: String) -> Result<PublishResult, String> {
    let user = author_fallback(&project_path).await;
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            remember_identity_of(repo, user.as_ref());
            git::sync::publish(repo, &message, auth::token().as_deref(), user.as_ref())
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_push(project_path: String) -> Result<GitStatus, String> {
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::remote::push_current_branch(repo, auth::token().as_deref())?;
            git::status::repo_status(repo)
        })
    })
    .await
}

/// How many commits "Bring in changes from main" would bring in: the default
/// branch's commits (as last fetched) that the current branch doesn't have
#[tauri::command]
#[specta::specta]
pub async fn git_commits_behind_default(project_path: String) -> Result<u32, String> {
    blocking(move || {
        git::with_repo(
            &PathBuf::from(project_path),
            git::sync::commits_behind_default,
        )
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_branches(project_path: String) -> Result<Vec<BranchInfo>, String> {
    blocking(move || git::with_repo(&PathBuf::from(project_path), git::branches::branches)).await
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
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::branches::checkout(repo, &name, create)
        })
    })
    .await
}

/// Topological, newest first
#[tauri::command]
#[specta::specta]
pub async fn git_log_graph(project_path: String, limit: u32) -> Result<Vec<GraphCommit>, String> {
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::log::log_graph(repo, limit)
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn git_commit_details(project_path: String, id: String) -> Result<CommitDetails, String> {
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::log::commit_details(repo, &id)
        })
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
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::diff::commit_file_diff(repo, &id, &path)
        })
    })
    .await
}

/// "Bring in changes from main": merge the default branch into the current one
#[tauri::command]
#[specta::specta]
pub async fn git_merge_default_branch(project_path: String) -> Result<SyncResult, String> {
    let user = author_fallback(&project_path).await;
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            remember_identity_of(repo, user.as_ref());
            git::sync::merge_default_branch(repo, auth::token().as_deref(), user.as_ref())
        })
    })
    .await
}

/// Clone into a new folder inside `parent_dir`; returns the new project path
#[tauri::command]
#[specta::specta]
pub async fn git_clone(
    app: AppHandle,
    clone_url: String,
    parent_dir: String,
) -> Result<String, String> {
    let user = signed_in_profile().await;
    blocking(move || {
        let token = auth::token();
        let path = git::clone::clone_into(
            &clone_url,
            &PathBuf::from(parent_dir),
            token.as_deref(),
            |received, total| {
                let _ = app.emit("git-clone-progress", CloneProgress { received, total });
            },
        )?;
        if let (Some(user), Ok(Some(repo))) = (&user, git::open(&path)) {
            remember_identity(&repo, user);
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// The files that conflict between `HEAD` and its upstream, from an in-memory
/// merge (nothing is written). Empty when nothing conflicts.
#[tauri::command]
#[specta::specta]
pub async fn git_conflicts(project_path: String) -> Result<Vec<ConflictFile>, String> {
    blocking(move || git::with_repo(&PathBuf::from(project_path), git::conflicts::conflicts)).await
}

/// Merge the upstream taking the chosen whole-file version of each conflicted
/// file, and commit it. Never pushes; the next Publish does.
#[tauri::command]
#[specta::specta]
pub async fn git_resolve_conflicts(
    project_path: String,
    choices: Vec<ConflictResolution>,
) -> Result<SyncResult, String> {
    let user = author_fallback(&project_path).await;
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            remember_identity_of(repo, user.as_ref());
            let label = git::sync::remote_label(repo);
            git::conflicts::resolve_conflicts(repo, &choices, &label, &|| {
                git::sync::commit_identity(repo, user.as_ref())
            })
        })
    })
    .await
}

/// Throw away local changes to one file: restore it from `HEAD`, or delete it if
/// it's untracked. Refuses paths outside the repository.
#[tauri::command]
#[specta::specta]
pub async fn git_discard_file(project_path: String, path: String) -> Result<GitStatus, String> {
    blocking(move || {
        git::with_repo(&PathBuf::from(project_path), |repo| {
            git::discard::discard_file(repo, &path)
        })
    })
    .await
}

/// Commits on the current branch that the default branch (as last fetched)
/// doesn't have: whether there's anything for a pull request. 0 on the default
/// branch itself.
#[tauri::command]
#[specta::specta]
pub async fn git_commits_ahead_of_default(project_path: String) -> Result<u32, String> {
    blocking(move || {
        git::with_repo(
            &PathBuf::from(project_path),
            git::sync::commits_ahead_of_default,
        )
    })
    .await
}
