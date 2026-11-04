//! The Git panel's status: branch, upstream, ahead/behind and changed files.

use super::{describe, open, ChangedFile, FileChange, GitStatus};
use git2::{BranchType, DiffDelta, Oid, Repository, Status, StatusOptions};
use std::path::Path;

pub fn status(project_path: &Path) -> Result<GitStatus, String> {
    match open(project_path)? {
        Some(repo) => repo_status(&repo),
        None => Ok(GitStatus {
            is_repo: false,
            branch: None,
            default_branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            detached: false,
        }),
    }
}

pub(crate) fn repo_status(repo: &Repository) -> Result<GitStatus, String> {
    let detached = repo.head_detached().unwrap_or(false);
    let branch = if detached {
        None
    } else {
        current_branch_name(repo)
    };
    let (upstream, ahead, behind) = match &branch {
        Some(name) => upstream_and_counts(repo, name)?,
        None => (None, 0, 0),
    };
    Ok(GitStatus {
        is_repo: true,
        branch,
        default_branch: default_branch(repo),
        upstream,
        ahead,
        behind,
        files: changed_files(repo)?,
        detached,
    })
}

/// The checked-out branch's short name. Works before the first commit too, when
/// `HEAD` points at a branch that doesn't exist yet.
pub(crate) fn current_branch_name(repo: &Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    let target = head.symbolic_target()?;
    target.strip_prefix("refs/heads/").map(String::from)
}

/// `origin/HEAD`'s target, else `main`, else `master` (local or on `origin`)
pub(crate) fn default_branch(repo: &Repository) -> Option<String> {
    if let Ok(origin_head) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(name) = origin_head
            .symbolic_target()
            .and_then(|t| t.strip_prefix("refs/remotes/origin/"))
        {
            return Some(name.to_string());
        }
    }
    ["main", "master"]
        .into_iter()
        .find(|candidate| {
            repo.find_branch(candidate, BranchType::Local).is_ok()
                || repo
                    .find_branch(&format!("origin/{candidate}"), BranchType::Remote)
                    .is_ok()
        })
        .map(String::from)
}

pub(crate) fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The branch's upstream (short name and tip), or `origin/<branch>` when that exists
/// but isn't tracked yet. Status, Sync and Publish all compare against this.
pub(crate) fn upstream_of(repo: &Repository, branch: &str) -> Option<(String, Oid)> {
    if let Ok(local) = repo.find_branch(branch, BranchType::Local) {
        if let Ok(upstream) = local.upstream() {
            let name = upstream.name().ok().flatten()?.to_string();
            return Some((name, upstream.get().target()?));
        }
    }
    let name = format!("origin/{branch}");
    let oid = repo
        .find_branch(&name, BranchType::Remote)
        .ok()?
        .get()
        .target()?;
    Some((name, oid))
}

/// A local branch's upstream (see [`upstream_of`]) and how far ahead and behind it is
pub(crate) fn upstream_and_counts(
    repo: &Repository,
    branch: &str,
) -> Result<(Option<String>, u32, u32), String> {
    let Some((name, upstream)) = upstream_of(repo, branch) else {
        return Ok((None, 0, 0));
    };
    let local = repo
        .find_branch(branch, BranchType::Local)
        .ok()
        .and_then(|b| b.get().target());
    let (ahead, behind) = match local {
        Some(local) => repo
            .graph_ahead_behind(local, upstream)
            .map_err(|e| describe("Couldn't compare with the upstream branch", &e))?,
        None => (0, 0),
    };
    Ok((Some(name), to_u32(ahead), to_u32(behind)))
}

fn delta_path(delta: &DiffDelta, new: bool) -> Option<String> {
    let file = if new {
        delta.new_file()
    } else {
        delta.old_file()
    };
    file.path_bytes()
        .map(|p| String::from_utf8_lossy(p).into_owned())
}

/// Every file that differs from `HEAD`, staged or not, including untracked files
pub(crate) fn changed_files(repo: &Repository) -> Result<Vec<ChangedFile>, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| describe("Couldn't read the changed files", &e))?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        let path = String::from_utf8_lossy(entry.path_bytes()).into_owned();
        // Added and then deleted again: nothing differs from HEAD
        if s.contains(Status::INDEX_NEW) && s.contains(Status::WT_DELETED) {
            continue;
        }
        let file = if s.is_conflicted() {
            ChangedFile {
                path,
                old_path: None,
                change: FileChange::Conflicted,
            }
        } else if s.is_index_renamed() || s.is_wt_renamed() {
            let delta = entry
                .head_to_index()
                .filter(|_| s.is_index_renamed())
                .or_else(|| entry.index_to_workdir());
            let (new_path, old_path) = match delta {
                Some(d) => (delta_path(&d, true), delta_path(&d, false)),
                None => (None, None),
            };
            ChangedFile {
                path: new_path.unwrap_or(path),
                old_path,
                change: FileChange::Renamed,
            }
        } else {
            let change = if s.is_index_deleted() || s.is_wt_deleted() {
                FileChange::Deleted
            } else if s.is_index_new() {
                FileChange::Added
            } else if s.is_wt_new() {
                FileChange::Untracked
            } else {
                FileChange::Modified
            };
            ChangedFile {
                path,
                old_path: None,
                change,
            }
        };
        files.push(file);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;
    use crate::git::{ChangedFile, FileChange};
    use tempfile::TempDir;

    fn change_of(files: &[ChangedFile], path: &str) -> Option<FileChange> {
        files.iter().find(|f| f.path == path).map(|f| f.change)
    }

    #[test]
    fn status_non_repo() {
        let dir = TempDir::new().unwrap();
        let status = status(dir.path()).unwrap();
        assert!(!status.is_repo);
        assert!(status.files.is_empty());
        assert_eq!(status.branch, None);
    }

    #[test]
    fn status_lists_added_modified_deleted_untracked() {
        let (dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        write(&repo, "b.md", "b\n");
        commit_all(&repo, "Initial commit");

        write(&repo, "a.md", "a changed\n");
        remove(&repo, "b.md");
        write(&repo, "src/content/new.md", "new\n");
        write(&repo, "staged.md", "staged\n");
        stage(&repo, "staged.md");

        let status = status(dir.path()).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.detached);
        assert_eq!(change_of(&status.files, "a.md"), Some(FileChange::Modified));
        assert_eq!(change_of(&status.files, "b.md"), Some(FileChange::Deleted));
        assert_eq!(
            change_of(&status.files, "src/content/new.md"),
            Some(FileChange::Untracked)
        );
        assert_eq!(
            change_of(&status.files, "staged.md"),
            Some(FileChange::Added)
        );
        assert_eq!(status.files.len(), 4);
    }

    #[test]
    fn status_reports_a_moved_file_as_renamed() {
        let (dir, repo) = init_repo();
        write(
            &repo,
            "old-name.md",
            "a post with enough text to be recognised\n",
        );
        commit_all(&repo, "Initial commit");
        remove(&repo, "old-name.md");
        write(
            &repo,
            "new-name.md",
            "a post with enough text to be recognised\n",
        );

        let status = status(dir.path()).unwrap();
        assert_eq!(
            status.files,
            vec![ChangedFile {
                path: "new-name.md".to_string(),
                old_path: Some("old-name.md".to_string()),
                change: FileChange::Renamed,
            }]
        );
    }

    #[test]
    fn status_of_a_new_repo_without_commits() {
        let (dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        let status = status(dir.path()).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(
            change_of(&status.files, "a.md"),
            Some(FileChange::Untracked)
        );
    }

    #[test]
    fn status_reports_ahead_behind() {
        let setup = repo_with_remote();

        // Someone else pushes a commit
        let (_other_dir, other) = clone_of(setup.remote_dir.path());
        write(&other, "theirs.md", "theirs\n");
        commit_all(&other, "Their change");
        let mut remote = other.find_remote("origin").unwrap();
        remote
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();

        // We commit locally and fetch
        write(&setup.local, "ours.md", "ours\n");
        commit_all(&setup.local, "Our change");
        fetch(&setup.local);

        let status = status(setup.local_dir.path()).unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 1);
        assert_eq!(status.default_branch.as_deref(), Some("main"));
    }

    #[test]
    fn default_branch_falls_back_to_master() {
        let dir = TempDir::new().unwrap();
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("master");
        let repo = git2::Repository::init_opts(dir.path(), &opts).unwrap();
        set_identity(&repo);
        write(&repo, "a.md", "a\n");
        commit_all(&repo, "Initial commit");
        let status = status(dir.path()).unwrap();
        assert_eq!(status.default_branch.as_deref(), Some("master"));
        assert_eq!(status.upstream, None);
    }

    #[test]
    fn status_detached_head() {
        let (dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        let first = commit_all(&repo, "First");
        write(&repo, "a.md", "b\n");
        commit_all(&repo, "Second");
        repo.set_head_detached(first).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        let status = status(dir.path()).unwrap();
        assert!(status.detached);
        assert_eq!(status.branch, None);
    }

    #[test]
    fn status_uses_the_origin_branch_when_no_upstream_is_configured() {
        let setup = repo_with_remote();
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &head, false).unwrap();
        // On the remote, but not tracked: what Sync and Publish compare against
        push(&setup.local, "staging");
        setup.local.set_head("refs/heads/staging").unwrap();
        write(&setup.local, "draft.md", "draft\n");
        commit_all(&setup.local, "Draft");

        let status = status(setup.local_dir.path()).unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/staging"));
        assert_eq!((status.ahead, status.behind), (1, 0));
    }
}
