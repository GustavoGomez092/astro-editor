//! Helpers for git tests: temp repos, commits and bare "remotes", all through git2 so
//! the tests don't need a `git` binary or the developer's git config.

use git2::{build::RepoBuilder, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

pub fn sig() -> Signature<'static> {
    Signature::now("Test Writer", "writer@example.com").unwrap()
}

/// A new repo on `main` in a temp dir, with a fixed identity in its own config
pub fn init_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().unwrap();
    let repo = init_repo_at(dir.path());
    (dir, repo)
}

pub fn init_repo_at(path: &Path) -> Repository {
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head("main");
    let repo = Repository::init_opts(path, &opts).unwrap();
    set_identity(&repo);
    repo
}

pub fn set_identity(repo: &Repository) {
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test Writer").unwrap();
    config.set_str("user.email", "writer@example.com").unwrap();
}

pub fn write(repo: &Repository, path: &str, contents: &str) {
    write_bytes(repo, path, contents.as_bytes());
}

pub fn write_bytes(repo: &Repository, path: &str, contents: &[u8]) {
    let full = repo.workdir().unwrap().join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(full, contents).unwrap();
}

pub fn remove(repo: &Repository, path: &str) {
    fs::remove_file(repo.workdir().unwrap().join(path)).unwrap();
}

/// Stage everything (including deletions) and commit on HEAD
pub fn commit_all(repo: &Repository, message: &str) -> Oid {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .unwrap();
    index.update_all(["*"].iter(), None).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(head) => vec![head.peel_to_commit().unwrap()],
        Err(_) => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(Some("HEAD"), &sig(), &sig(), message, &tree, &parent_refs)
        .unwrap()
}

/// Stage one path without committing
pub fn stage(repo: &Repository, path: &str) {
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
}

/// A bare repo to act as `origin`
pub fn bare_remote() -> (TempDir, Repository) {
    let dir = TempDir::new().unwrap();
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).initial_head("main");
    let repo = Repository::init_opts(dir.path(), &opts).unwrap();
    (dir, repo)
}

/// A local repo with one commit on `main`, pushed to a new bare `origin`, with
/// `main` tracking `origin/main`
pub struct RemoteSetup {
    pub remote_dir: TempDir,
    pub local_dir: TempDir,
    pub local: Repository,
}

pub fn repo_with_remote() -> RemoteSetup {
    let (remote_dir, _bare) = bare_remote();
    let (local_dir, local) = init_repo();
    write(&local, "README.md", "hello\n");
    commit_all(&local, "Initial commit");
    local
        .remote("origin", remote_dir.path().to_str().unwrap())
        .unwrap();
    push(&local, "main");
    set_upstream(&local, "main");
    // origin/HEAD, like a real clone has
    local
        .reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test",
        )
        .unwrap();
    RemoteSetup {
        remote_dir,
        local_dir,
        local,
    }
}

pub fn push(repo: &Repository, branch: &str) {
    let mut remote = repo.find_remote("origin").unwrap();
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[refspec.as_str()], None).unwrap();
    // Update the remote-tracking ref the way a push through git does
    let oid = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .target()
        .unwrap();
    repo.reference(
        &format!("refs/remotes/origin/{branch}"),
        oid,
        true,
        "test push",
    )
    .unwrap();
}

pub fn set_upstream(repo: &Repository, branch: &str) {
    let mut local_branch = repo.find_branch(branch, git2::BranchType::Local).unwrap();
    local_branch
        .set_upstream(Some(&format!("origin/{branch}")))
        .unwrap();
}

pub fn fetch(repo: &Repository) {
    let mut remote = repo.find_remote("origin").unwrap();
    remote
        .fetch(&["+refs/heads/*:refs/remotes/origin/*"], None, None)
        .unwrap();
}

/// A second working copy of `remote_dir`, as another computer would have
pub fn clone_of(remote_dir: &Path) -> (TempDir, Repository) {
    let dir = TempDir::new().unwrap();
    let repo = RepoBuilder::new()
        .clone(remote_dir.to_str().unwrap(), dir.path())
        .unwrap();
    set_identity(&repo);
    (dir, repo)
}

pub fn read(repo: &Repository, path: &str) -> String {
    fs::read_to_string(repo.workdir().unwrap().join(path)).unwrap()
}

/// Another computer commits `path` on `branch` and pushes it to the remote
pub fn push_from_elsewhere(remote_dir: &Path, branch: &str, path: &str, contents: &str) -> Oid {
    let (_dir, other) = clone_of(remote_dir);
    if branch != "main" {
        let remote_branch = other
            .find_reference(&format!("refs/remotes/origin/{branch}"))
            .unwrap()
            .peel_to_commit()
            .unwrap();
        other.branch(branch, &remote_branch, true).unwrap();
        other.set_head(&format!("refs/heads/{branch}")).unwrap();
        other
            .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }
    write(&other, path, contents);
    let oid = commit_all(&other, &format!("Change {path} elsewhere"));
    let mut remote = other.find_remote("origin").unwrap();
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[refspec.as_str()], None).unwrap();
    oid
}

/// The commit a branch points at in the bare remote
pub fn remote_tip(remote_dir: &Path, branch: &str) -> Option<Oid> {
    let bare = Repository::open_bare(remote_dir).unwrap();
    let reference = bare.find_reference(&format!("refs/heads/{branch}")).ok()?;
    reference.target()
}

pub fn head_id(repo: &Repository) -> Oid {
    repo.head().unwrap().target().unwrap()
}

/// Ignore `path` on this computer only (`.git/info/exclude`)
pub fn exclude_locally(repo: &Repository, path: &str) {
    let info = repo.path().join("info");
    fs::create_dir_all(&info).unwrap();
    fs::write(info.join("exclude"), format!("{path}\n")).unwrap();
}
