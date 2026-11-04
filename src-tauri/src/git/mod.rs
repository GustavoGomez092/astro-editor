//! Git for the Git panel: status, diffs, sync, publish, branches and the commit graph,
//! all through libgit2 (`git2`), so it works without a `git` binary. The Tauri commands
//! in `commands/git.rs` are thin wrappers around these modules.
//!
//! Safety rule for everything here: no operation discards uncommitted changes.
//! Checkouts and fast-forwards use libgit2's safe checkout, and a merge that conflicts
//! is aborted with the repository restored. See `docs/developer/git-and-github.md`.

use git2::{build::CheckoutBuilder, CheckoutNotificationType, ErrorCode, Repository};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

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

/// A file that conflicts between the current branch and its upstream, with both
/// whole-file versions for the writer to choose between
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// Path relative to the repository root, with forward slashes
    pub path: String,
    /// This computer's version; `None` if it was deleted here, or is binary
    pub mine: Option<String>,
    /// The upstream's version; `None` if it was deleted there, or is binary
    pub theirs: Option<String>,
    pub binary: bool,
}

/// Which whole-file version to keep for a conflicted file
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Mine,
    Theirs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub path: String,
    pub choice: ConflictChoice,
}

/// Payload of the `git-clone-progress` event
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub received: u32,
    pub total: u32,
}

pub mod branches;
pub mod clone;
pub mod conflicts;
pub mod diff;
pub mod discard;
pub mod log;
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

/// libgit2's network timeouts, so a stalled connection can't hang Publish.
/// Called once at startup.
pub fn init_network_timeouts() {
    // SAFETY: these set process-wide libgit2 options; called before any git work
    // starts (and in tests, with the same values every time)
    unsafe {
        let _ = git2::opts::set_server_connect_timeout_in_milliseconds(15_000);
        let _ = git2::opts::set_server_timeout_in_milliseconds(60_000);
    }
}

static REPO_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

/// One lock per repository (keyed by its `.git` folder), held for the whole of each
/// git command so a timed sync can't interleave with a publish
pub(crate) fn repo_lock(git_dir: &Path) -> Arc<Mutex<()>> {
    let locks = REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|e| e.into_inner());
    locks.entry(git_dir.to_path_buf()).or_default().clone()
}

/// Open the project's repository and run `work` while holding its lock
pub(crate) fn with_repo<T>(
    project_path: &Path,
    work: impl FnOnce(&Repository) -> Result<T, String>,
) -> Result<T, String> {
    let repo = open_required(project_path)?;
    let lock = repo_lock(repo.path());
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    work(&repo)
}

/// Why a safe checkout didn't happen
pub(crate) enum CheckoutRefused {
    /// These files have local changes, or are ignored files, that it would overwrite
    Conflicts(Vec<String>),
    Failed(git2::Error),
}

/// libgit2's safe checkout, which also refuses to overwrite ignored files (a local
/// `.env`, say). libgit2 checks every file before writing any, so a refusal leaves
/// the working tree untouched.
pub(crate) fn checkout_safely(
    repo: &Repository,
    target: &git2::Object,
) -> Result<(), CheckoutRefused> {
    let conflicts = RefCell::new(Vec::<String>::new());
    let mut checkout = CheckoutBuilder::new();
    checkout
        .safe()
        .overwrite_ignored(false)
        .notify_on(CheckoutNotificationType::CONFLICT)
        .notify(|_, path, _, _, _| {
            if let Some(path) = path {
                conflicts
                    .borrow_mut()
                    .push(path.to_string_lossy().replace('\\', "/"));
            }
            true
        });
    let result = repo.checkout_tree(target, Some(&mut checkout));
    drop(checkout);
    result.map_err(|e| {
        ::log::warn!("Astro Editor [GIT] Safe checkout refused: {}", e.message());
        let files = conflicts.into_inner();
        if files.is_empty() {
            CheckoutRefused::Failed(e)
        } else {
            CheckoutRefused::Conflicts(files)
        }
    })
}

/// Plain-language text for a libgit2 error, prefixed with what was being done
pub(crate) fn describe(action: &str, e: &git2::Error) -> String {
    format!("{action}: {}", e.message())
}

/// Names a few files for a message: "a.md", "a.md and b.md", "a.md, b.md and 3 more"
pub(crate) fn name_files(files: &[String]) -> String {
    match files {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more", rest.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_timeouts_are_set() {
        init_network_timeouts();
        unsafe {
            assert_eq!(
                git2::opts::get_server_connect_timeout_in_milliseconds().unwrap(),
                15_000
            );
            assert_eq!(
                git2::opts::get_server_timeout_in_milliseconds().unwrap(),
                60_000
            );
        }
    }

    #[test]
    fn one_lock_per_repository() {
        let a = repo_lock(Path::new("/tmp/a/.git"));
        let again = repo_lock(Path::new("/tmp/a/.git"));
        let b = repo_lock(Path::new("/tmp/b/.git"));
        assert!(std::sync::Arc::ptr_eq(&a, &again));
        assert!(!std::sync::Arc::ptr_eq(&a, &b));
    }
}
