//! Git for the Git panel: status, diffs, sync, publish, branches and the commit graph,
//! all through libgit2 (`git2`), so it works without a `git` binary. The Tauri commands
//! in `commands/git.rs` are thin wrappers around these modules.
//!
//! Safety rule for everything here: no operation discards uncommitted changes.
//! Checkouts and fast-forwards use libgit2's safe checkout, and a merge that conflicts
//! is aborted with the repository restored. See `docs/developer/git-and-github.md`.

use git2::{ErrorCode, Repository};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

/// How a file differs from `HEAD`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Path relative to the repository root, with forward slashes
    pub path: String,
    /// The previous path, for renames
    pub old_path: Option<String>,
    pub change: FileChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    /// The upstream branch's short name, e.g. `origin/main`
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ChangedFile>,
    pub detached: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Add,
    Del,
    Ctx,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// The line without its trailing newline
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub binary: bool,
    pub is_image: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncOutcome {
    UpToDate,
    FastForwarded,
    Merged,
    BlockedByLocalChanges,
    Conflict,
    NoUpstream,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub outcome: SyncOutcome,
    /// A plain-language sentence for the writer
    pub message: String,
    pub status: GitStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub commit_id: String,
    pub pushed: bool,
    pub outcome: SyncOutcome,
    pub message: String,
    pub status: GitStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Short name: `main` for a local branch, `origin/main` for a remote one
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Unix seconds of the branch's tip commit
    pub last_commit_time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Head,
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    pub name: String,
    pub kind: RefKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub author_name: String,
    /// Unix seconds
    pub time: i64,
    pub refs: Vec<GraphRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    #[serde(flatten)]
    pub commit: GraphCommit,
    pub message: String,
    pub author_email: String,
    pub files: Vec<ChangedFile>,
}

/// Payload of the `git-clone-progress` event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub received: u32,
    pub total: u32,
}

pub mod diff;
pub mod remote;
pub mod status;
pub mod sync;
#[cfg(test)]
pub(crate) mod test_support;

const NOT_A_REPO: &str = "This folder isn't a git repository";

/// The repository containing `project_path`, or `None` if there isn't one.
/// A project can live in a subfolder of its repository.
pub(crate) fn open(project_path: &Path) -> Result<Option<Repository>, String> {
    match Repository::discover(project_path) {
        Ok(repo) if repo.is_bare() => Ok(None),
        Ok(repo) => Ok(Some(repo)),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't open the git repository: {}", e.message())),
    }
}

/// Like [`open`], but a folder without a repository is an error
pub(crate) fn open_required(project_path: &Path) -> Result<Repository, String> {
    open(project_path)?.ok_or_else(|| NOT_A_REPO.to_string())
}

/// Plain-language text for a libgit2 error, prefixed with what was being done
pub(crate) fn describe(action: &str, e: &git2::Error) -> String {
    format!("{action}: {}", e.message())
}
