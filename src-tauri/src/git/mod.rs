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
use std::sync::{Arc, Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant};

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

/// The `.git` folders of every repository a git command has opened since launch
pub(crate) fn opened_repositories() -> Vec<PathBuf> {
    REPO_LOCKS
        .get()
        .map(|locks| {
            locks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .keys()
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// How long quitting waits, in all, for git commands that are still running
pub const QUIT_WAIT: Duration = Duration::from_secs(30);

/// Repositories whose lock quitting has taken
static HELD_FOR_QUIT: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Waits (at most `timeout` in all) for every running git command to finish, and
/// keeps each repository's lock so no new one starts: quitting calls it, so the
/// process never dies part-way through a write, holding `.git/index.lock`.
/// Calling it again returns at once for locks it already holds. Returns whether
/// it got every lock.
pub fn hold_all_repo_locks(timeout: Duration) -> bool {
    let locks: Vec<(PathBuf, Arc<Mutex<()>>)> = REPO_LOCKS
        .get()
        .map(|locks| {
            locks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .map(|(path, lock)| (path.clone(), lock.clone()))
                .collect()
        })
        .unwrap_or_default();
    let mut held = HELD_FOR_QUIT.lock().unwrap_or_else(|e| e.into_inner());
    let all = hold_locks(&locks, &mut held, Instant::now() + timeout);
    if !all {
        ::log::warn!(
            "Astro Editor [GIT] A git command was still running after {}s; quitting anyway",
            timeout.as_secs()
        );
    }
    all
}

fn hold_locks(
    locks: &[(PathBuf, Arc<Mutex<()>>)],
    held: &mut Vec<PathBuf>,
    deadline: Instant,
) -> bool {
    let mut all = true;
    for (path, lock) in locks {
        if held.contains(path) {
            continue;
        }
        loop {
            match lock.try_lock() {
                // Never unlocked: the app is quitting
                Ok(guard) => std::mem::forget(guard),
                Err(TryLockError::Poisoned(poisoned)) => std::mem::forget(poisoned.into_inner()),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(TryLockError::WouldBlock) => {
                    all = false;
                    break;
                }
            }
            held.push(path.clone());
            break;
        }
    }
    all
}

/// A `.git/index.lock` older than this, with no command of ours running, was
/// left by a git process that died
const STALE_INDEX_LOCK: Duration = Duration::from_secs(60);

/// Removes a stale `index.lock` from `git_dir`. Returns whether it did.
fn remove_stale_index_lock(git_dir: &Path, max_age: Duration) -> bool {
    let lock = git_dir.join("index.lock");
    let age = std::fs::metadata(&lock)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok());
    if !age.is_some_and(|age| age > max_age) {
        return false;
    }
    match std::fs::remove_file(&lock) {
        Ok(()) => {
            ::log::warn!(
                "Astro Editor [GIT] Removed a stale {} left by a git process that stopped",
                lock.display()
            );
            true
        }
        Err(e) => {
            ::log::warn!(
                "Astro Editor [GIT] Couldn't remove the stale {}: {e}",
                lock.display()
            );
            false
        }
    }
}

/// Open the project's repository and run `work` while holding its lock
pub(crate) fn with_repo<T>(
    project_path: &Path,
    work: impl FnOnce(&Repository) -> Result<T, String>,
) -> Result<T, String> {
    let repo = open_required(project_path)?;
    let lock = repo_lock(repo.path());
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    // No command of ours is running on it now, so an old index.lock is a leftover
    remove_stale_index_lock(repo.path(), STALE_INDEX_LOCK);
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
    fn opened_repositories_lists_each_locked_repository() {
        repo_lock(Path::new("/tmp/opened-test/.git"));
        assert!(opened_repositories().contains(&PathBuf::from("/tmp/opened-test/.git")));
    }

    fn named_lock(name: &str) -> (PathBuf, Arc<Mutex<()>>) {
        (PathBuf::from(name), Arc::new(Mutex::new(())))
    }

    #[test]
    fn quitting_waits_for_a_running_command_and_keeps_the_lock() {
        let (path, lock) = named_lock("/tmp/quit-a/.git");
        let running = lock.clone();
        let (started_tx, started) = std::sync::mpsc::channel();
        let command = std::thread::spawn(move || {
            let _guard = running.lock().unwrap();
            started_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        started.recv().unwrap();
        let begun = Instant::now();
        let mut held = Vec::new();
        let locks = [(path.clone(), lock.clone())];
        assert!(hold_locks(
            &locks,
            &mut held,
            begun + Duration::from_secs(5)
        ));
        assert!(begun.elapsed() >= Duration::from_millis(150));
        command.join().unwrap();
        assert!(lock.try_lock().is_err(), "a new command could start");
        assert_eq!(held, vec![path]);

        // Asking again doesn't wait on the lock it already has
        let again = Instant::now();
        assert!(hold_locks(
            &locks,
            &mut held,
            again + Duration::from_secs(5)
        ));
        assert!(again.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn quitting_gives_up_waiting_at_the_deadline() {
        let (path, lock) = named_lock("/tmp/quit-b/.git");
        let _guard = lock.lock().unwrap();
        let begun = Instant::now();
        let mut held = Vec::new();
        let locks = [(path, lock.clone())];
        assert!(!hold_locks(
            &locks,
            &mut held,
            begun + Duration::from_millis(200)
        ));
        let took = begun.elapsed();
        assert!(
            took >= Duration::from_millis(200) && took < Duration::from_secs(2),
            "{took:?}"
        );
        assert!(held.is_empty());
    }

    fn age(path: &Path, seconds: i64) {
        let then = filetime::FileTime::from_unix_time(
            filetime::FileTime::now().unix_seconds() - seconds,
            0,
        );
        filetime::set_file_mtime(path, then).unwrap();
    }

    #[test]
    fn a_stale_index_lock_is_removed_and_a_fresh_one_kept() {
        let (_dir, repo) = test_support::init_repo();
        let lock = repo.path().join("index.lock");
        std::fs::write(&lock, "").unwrap();
        assert!(!remove_stale_index_lock(repo.path(), STALE_INDEX_LOCK));
        assert!(lock.exists());
        age(&lock, 120);
        assert!(remove_stale_index_lock(repo.path(), STALE_INDEX_LOCK));
        assert!(!lock.exists());
        assert!(!remove_stale_index_lock(repo.path(), STALE_INDEX_LOCK));
    }

    #[test]
    fn opening_a_repository_clears_a_stale_index_lock() {
        let (dir, repo) = test_support::init_repo();
        test_support::write(&repo, "a.md", "a\n");
        let lock = repo.path().join("index.lock");
        std::fs::write(&lock, "").unwrap();
        age(&lock, 120);
        with_repo(dir.path(), |_| Ok(())).unwrap();
        assert!(!lock.exists());
        // And git can write the index again
        test_support::commit_all(&repo, "First");
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
