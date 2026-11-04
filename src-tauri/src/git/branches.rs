//! Branches: the list for the branch menu, and switching or creating a branch
//! without ever overwriting a local edit.

use super::status::{repo_status, upstream_and_counts};
use super::{checkout_safely, describe, name_files, BranchInfo, CheckoutRefused, GitStatus};
use git2::{Branch, BranchType, Commit, Repository};

/// Local branches (most recently changed first), then remote ones
pub fn branches(repo: &Repository) -> Result<Vec<BranchInfo>, String> {
    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    let list = repo
        .branches(None)
        .map_err(|e| describe("Couldn't list the branches", &e))?;
    for entry in list {
        let (branch, kind) = entry.map_err(|e| describe("Couldn't list the branches", &e))?;
        let Some(name) = branch.name().ok().flatten().map(String::from) else {
            continue;
        };
        // `origin/HEAD` is an alias, not a branch
        if branch.get().symbolic_target().is_some() || name.ends_with("/HEAD") {
            continue;
        }
        let tip = branch.get().peel_to_commit().ok();
        let last_commit_time = tip.as_ref().map_or(0, |c| c.author().when().seconds());
        let info = match kind {
            BranchType::Local => {
                let (upstream, ahead, behind) =
                    upstream_and_counts(repo, &name).unwrap_or((None, 0, 0));
                BranchInfo {
                    name,
                    is_remote: false,
                    is_head: branch.is_head(),
                    upstream,
                    ahead,
                    behind,
                    last_commit_time,
                }
            }
            BranchType::Remote => BranchInfo {
                name,
                is_remote: true,
                is_head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                last_commit_time,
            },
        };
        match kind {
            BranchType::Local => locals.push(info),
            BranchType::Remote => remotes.push(info),
        }
    }
    for list in [&mut locals, &mut remotes] {
        list.sort_by(|a, b| {
            b.last_commit_time
                .cmp(&a.last_commit_time)
                .then_with(|| a.name.cmp(&b.name))
        });
    }
    locals.extend(remotes);
    Ok(locals)
}

/// Switch to `name` (a local branch, a remote branch like `origin/feature`, or a
/// plain name that exists on `origin`), or with `create`, make a new branch at
/// `HEAD` and switch to it. Uncommitted edits come along; if switching would
/// overwrite one, nothing happens and the error names the files.
pub fn checkout(repo: &Repository, name: &str, create: bool) -> Result<GitStatus, String> {
    let name = name.trim();
    if create {
        return create_branch(repo, name);
    }
    if let Ok(branch) = repo.find_branch(name, BranchType::Local) {
        let commit = tip(&branch)?;
        checkout_commit(repo, &commit)?;
        set_head(repo, name)?;
        return repo_status(repo);
    }

    let remote = repo
        .find_branch(name, BranchType::Remote)
        .ok()
        .map(|b| (name.to_string(), b))
        .or_else(|| {
            let full = format!("origin/{name}");
            let branch = repo.find_branch(&full, BranchType::Remote).ok()?;
            Some((full, branch))
        });
    let Some((remote_name, remote_branch)) = remote else {
        return Err(format!("There's no branch called {name}."));
    };
    let local_name = remote_name
        .split_once('/')
        .map_or(remote_name.as_str(), |(_, rest)| rest)
        .to_string();

    // A local branch of that name already exists: switch to it
    if let Ok(branch) = repo.find_branch(&local_name, BranchType::Local) {
        let commit = tip(&branch)?;
        checkout_commit(repo, &commit)?;
        set_head(repo, &local_name)?;
        return repo_status(repo);
    }

    let commit = tip(&remote_branch)?;
    checkout_commit(repo, &commit)?;
    let mut local = repo
        .branch(&local_name, &commit, false)
        .map_err(|e| describe("Couldn't create the branch", &e))?;
    local
        .set_upstream(Some(&remote_name))
        .map_err(|e| describe("Couldn't track the remote branch", &e))?;
    set_head(repo, &local_name)?;
    repo_status(repo)
}

fn create_branch(repo: &Repository, name: &str) -> Result<GitStatus, String> {
    if !Branch::name_is_valid(name).unwrap_or(false) {
        return Err(format!("\"{name}\" can't be used as a branch name."));
    }
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(format!("A branch called {name} already exists."));
    }
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| "Make a first commit before creating a branch.".to_string())?;
    repo.branch(name, &head, false)
        .map_err(|e| describe("Couldn't create the branch", &e))?;
    // Same commit, so the working tree stays exactly as it is
    set_head(repo, name)?;
    repo_status(repo)
}

fn tip<'r>(branch: &Branch<'r>) -> Result<Commit<'r>, String> {
    branch
        .get()
        .peel_to_commit()
        .map_err(|e| describe("Couldn't read the branch", &e))
}

fn set_head(repo: &Repository, name: &str) -> Result<(), String> {
    repo.set_head(&format!("refs/heads/{name}"))
        .map_err(|e| describe("Couldn't switch branches", &e))
}

fn checkout_commit(repo: &Repository, commit: &Commit) -> Result<(), String> {
    checkout_safely(repo, commit.as_object()).map_err(|refused| match refused {
        CheckoutRefused::Conflicts(files) => format!(
            "Switching would overwrite your edits to {}, so you're still on this branch. Publish them first, then switch.",
            name_files(&files)
        ),
        CheckoutRefused::Failed(e) => describe("Couldn't switch branches", &e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    fn branch_named<'a>(list: &'a [BranchInfo], name: &str) -> &'a BranchInfo {
        list.iter()
            .find(|b| b.name == name)
            .unwrap_or_else(|| panic!("no branch {name} in {list:?}"))
    }

    /// `main` with a.md and b.md, and a branch `other` where a.md differs
    fn repo_with_other_branch() -> (tempfile::TempDir, git2::Repository) {
        let (dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        write(&repo, "b.md", "b\n");
        let base = commit_all(&repo, "Base");
        repo.branch("other", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/other").unwrap();
        write(&repo, "a.md", "a on other\n");
        commit_all(&repo, "Change a on other");
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        (dir, repo)
    }

    #[test]
    fn branches_lists_local_and_remote_with_ahead_behind() {
        let setup = repo_with_remote();
        write(&setup.local, "mine.md", "mine\n");
        commit_all(&setup.local, "Mine");
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &head, false).unwrap();
        push(&setup.local, "staging");

        let list = branches(&setup.local).unwrap();
        let main = branch_named(&list, "main");
        assert!(main.is_head);
        assert!(!main.is_remote);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!((main.ahead, main.behind), (1, 0));
        assert_eq!(main.last_commit_time, head.author().when().seconds());

        // Not tracked, but on the remote: compared with origin/staging, as Sync does
        let staging = branch_named(&list, "staging");
        assert!(!staging.is_head);
        assert_eq!(staging.upstream.as_deref(), Some("origin/staging"));
        assert_eq!((staging.ahead, staging.behind), (0, 0));

        let origin_main = branch_named(&list, "origin/main");
        assert!(origin_main.is_remote);
        assert!(!origin_main.is_head);
        assert!(list
            .iter()
            .any(|b| b.name == "origin/staging" && b.is_remote));
        assert!(!list.iter().any(|b| b.name == "origin/HEAD"));
        // Local branches first
        assert!(!list[0].is_remote);
        assert!(list.last().unwrap().is_remote);
    }

    #[test]
    fn checkout_switches_to_a_local_branch() {
        let (dir, repo) = repo_with_other_branch();
        let status = checkout(&repo, "other", false).unwrap();
        assert_eq!(status.branch.as_deref(), Some("other"));
        assert_eq!(read(&repo, "a.md"), "a on other\n");
        assert!(status.files.is_empty());
        drop(dir);
    }

    #[test]
    fn checkout_creates_tracking_branch_from_remote() {
        let setup = repo_with_remote();
        // Someone else pushes a new branch
        let (_other_dir, other) = clone_of(setup.remote_dir.path());
        let base = other.head().unwrap().peel_to_commit().unwrap();
        other.branch("feature", &base, false).unwrap();
        other.set_head("refs/heads/feature").unwrap();
        write(&other, "feature.md", "feature\n");
        commit_all(&other, "Feature");
        other
            .find_remote("origin")
            .unwrap()
            .push(&["refs/heads/feature:refs/heads/feature"], None)
            .unwrap();
        fetch(&setup.local);

        let status = checkout(&setup.local, "origin/feature", false).unwrap();
        assert_eq!(status.branch.as_deref(), Some("feature"));
        assert_eq!(status.upstream.as_deref(), Some("origin/feature"));
        assert_eq!((status.ahead, status.behind), (0, 0));
        assert_eq!(read(&setup.local, "feature.md"), "feature\n");
    }

    #[test]
    fn checkout_by_plain_name_uses_the_remote_branch() {
        let setup = repo_with_remote();
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &head, false).unwrap();
        push(&setup.local, "staging");
        setup
            .local
            .find_branch("staging", git2::BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();

        let status = checkout(&setup.local, "staging", false).unwrap();
        assert_eq!(status.branch.as_deref(), Some("staging"));
        assert_eq!(status.upstream.as_deref(), Some("origin/staging"));
    }

    #[test]
    fn checkout_refuses_when_it_would_overwrite() {
        let (dir, repo) = repo_with_other_branch();
        write(&repo, "a.md", "my unsaved words\n");

        let e = checkout(&repo, "other", false).unwrap_err();
        assert!(e.contains("a.md"), "{e}");
        assert!(!e.contains("a.md."), "{e}");
        assert_eq!(read(&repo, "a.md"), "my unsaved words\n");
        let status = crate::git::status::status(dir.path()).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
    }

    #[test]
    fn checkout_carries_non_conflicting_changes() {
        let (_dir, repo) = repo_with_other_branch();
        write(&repo, "b.md", "edited b\n");
        write(&repo, "new.md", "new\n");

        let status = checkout(&repo, "other", false).unwrap();
        assert_eq!(status.branch.as_deref(), Some("other"));
        assert_eq!(read(&repo, "b.md"), "edited b\n");
        assert_eq!(read(&repo, "new.md"), "new\n");
        assert_eq!(read(&repo, "a.md"), "a on other\n");
    }

    #[test]
    fn checkout_create_makes_a_branch_from_head_keeping_edits() {
        let (_dir, repo) = repo_with_other_branch();
        let main = head_id(&repo);
        write(&repo, "a.md", "draft\n");

        let status = checkout(&repo, "drafts", true).unwrap();
        assert_eq!(status.branch.as_deref(), Some("drafts"));
        assert_eq!(head_id(&repo), main);
        assert_eq!(read(&repo, "a.md"), "draft\n");

        assert!(checkout(&repo, "drafts", true).is_err());
        assert!(checkout(&repo, "bad name..", true).is_err());
    }

    #[test]
    fn checkout_unknown_branch_is_an_error() {
        let (_dir, repo) = repo_with_other_branch();
        let e = checkout(&repo, "nope", false).unwrap_err();
        assert!(e.contains("nope"), "{e}");
    }

    #[test]
    fn checkout_does_not_overwrite_ignored_file() {
        let (dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        let base = commit_all(&repo, "Base");
        repo.branch("other", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/other").unwrap();
        write(&repo, ".env", "SECRET=theirs\n");
        commit_all(&repo, "Track .env on other");
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(
            git2::build::CheckoutBuilder::new()
                .force()
                .remove_untracked(true),
        ))
        .unwrap();
        exclude_locally(&repo, ".env");
        write(&repo, ".env", "SECRET=mine\n");

        let e = checkout(&repo, "other", false).unwrap_err();
        assert!(e.contains(".env"), "{e}");
        assert_eq!(read(&repo, ".env"), "SECRET=mine\n");
        let status = crate::git::status::status(dir.path()).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
    }
}
