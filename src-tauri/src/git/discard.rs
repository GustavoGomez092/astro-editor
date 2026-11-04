//! Throwing away the local changes to one file, which the Changes tab offers
//! after asking. Only that file is touched: a tracked file is restored from
//! `HEAD`, a new one is deleted, and anything outside the repository (or inside
//! `.git`) is refused.

use super::status::{changed_files, repo_status};
use super::{describe, FileChange, GitStatus};
use git2::{build::CheckoutBuilder, Repository};
use std::path::{Component, Path, PathBuf};

const OUTSIDE: &str = "That file isn't part of this repository, so nothing was changed.";

/// `path` (relative to the repository root) as a clean relative path, or a
/// refusal if it could reach outside the repository or into `.git`
fn checked_path(repo: &Repository, path: &str) -> Result<PathBuf, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "This repository has no working folder.".to_string())?;
    let relative = Path::new(path);
    let mut clean = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(OUTSIDE.to_string()),
        }
    }
    let first = clean.components().next();
    if first.is_none() || first == Some(Component::Normal(".git".as_ref())) {
        return Err(OUTSIDE.to_string());
    }
    // A symlinked folder on the way could still lead outside
    if let Some(parent) = workdir.join(&clean).parent() {
        if let (Ok(parent), Ok(root)) = (parent.canonicalize(), workdir.canonicalize()) {
            if !parent.starts_with(&root) {
                return Err(OUTSIDE.to_string());
            }
        }
    }
    Ok(clean)
}

/// Restore `path` in the working tree and the index from `HEAD`, touching nothing
/// else (the path is matched literally, so a `*` in a name is just a `*`)
fn restore_from_head(repo: &Repository, path: &Path) -> Result<(), String> {
    let error = |e: git2::Error| describe("Couldn't restore the file", &e);
    let mut checkout = CheckoutBuilder::new();
    checkout.force().disable_pathspec_match(true).path(path);
    repo.checkout_head(Some(&mut checkout)).map_err(error)?;
    // The working file is HEAD's again, so staging it puts HEAD's in the index
    let mut index = repo.index().map_err(error)?;
    index.add_path(path).map_err(error)?;
    index.write().map_err(error)
}

/// Remove a file that isn't in `HEAD` from the index and the working tree
fn delete_new_file(repo: &Repository, path: &Path) -> Result<(), String> {
    let mut index = repo
        .index()
        .map_err(|e| describe("Couldn't remove the file", &e))?;
    if index.get_path(path, 0).is_some() {
        index
            .remove_path(path)
            .and_then(|()| index.write())
            .map_err(|e| describe("Couldn't remove the file", &e))?;
    }
    let full = repo.workdir().unwrap_or(Path::new(".")).join(path);
    match std::fs::remove_file(&full) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't remove the file: {e}")),
    }
}

/// Throw away the local changes to `path`. A file without changes (or an ignored
/// one, which never shows as a change) is left alone.
pub fn discard_file(repo: &Repository, path: &str) -> Result<GitStatus, String> {
    let clean = checked_path(repo, path)?;
    let path = clean.to_string_lossy().replace('\\', "/");
    let changes = changed_files(repo)?;
    let Some(change) = changes
        .iter()
        .find(|f| f.path == path || f.old_path.as_deref() == Some(path.as_str()))
    else {
        return repo_status(repo);
    };
    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
    let in_head = |p: &Path| {
        head_tree
            .as_ref()
            .is_some_and(|tree| tree.get_path(p).is_ok())
    };
    // A rename is undone on both sides: the new name goes, the old one comes back
    let paths = [Some(change.path.as_str()), change.old_path.as_deref()];
    for p in paths.into_iter().flatten() {
        let p = Path::new(p);
        if in_head(p) {
            restore_from_head(repo, p)?;
        } else if change.change != FileChange::Conflicted {
            delete_new_file(repo, p)?;
        }
    }
    log::info!("Astro Editor [GIT] Discarded the changes to {path}");
    repo_status(repo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    fn committed() -> (tempfile::TempDir, Repository) {
        let (dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        write(&repo, "b.md", "b\n");
        commit_all(&repo, "Base");
        (dir, repo)
    }

    #[test]
    fn restores_a_modified_file_and_nothing_else() {
        let (_dir, repo) = committed();
        write(&repo, "a.md", "changed\n");
        write(&repo, "b.md", "also changed\n");
        let status = discard_file(&repo, "a.md").unwrap();
        assert_eq!(read(&repo, "a.md"), "a\n");
        assert_eq!(read(&repo, "b.md"), "also changed\n");
        let paths: Vec<_> = status.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["b.md"]);
    }

    #[test]
    fn restores_a_staged_change() {
        let (_dir, repo) = committed();
        write(&repo, "a.md", "staged\n");
        stage(&repo, "a.md");
        let status = discard_file(&repo, "a.md").unwrap();
        assert_eq!(read(&repo, "a.md"), "a\n");
        assert!(status.files.is_empty(), "{:?}", status.files);
    }

    #[test]
    fn restores_a_deleted_file() {
        let (_dir, repo) = committed();
        remove(&repo, "a.md");
        let status = discard_file(&repo, "a.md").unwrap();
        assert_eq!(read(&repo, "a.md"), "a\n");
        assert!(status.files.is_empty());
    }

    #[test]
    fn deletes_an_untracked_file() {
        let (_dir, repo) = committed();
        write(&repo, "new.md", "new\n");
        write(&repo, "keep.md", "keep\n");
        let status = discard_file(&repo, "new.md").unwrap();
        assert!(!repo.workdir().unwrap().join("new.md").exists());
        assert_eq!(read(&repo, "keep.md"), "keep\n");
        let paths: Vec<_> = status.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["keep.md"]);
    }

    #[test]
    fn deletes_a_new_staged_file() {
        let (_dir, repo) = committed();
        write(&repo, "new.md", "new\n");
        stage(&repo, "new.md");
        let status = discard_file(&repo, "new.md").unwrap();
        assert!(!repo.workdir().unwrap().join("new.md").exists());
        assert!(status.files.is_empty(), "{:?}", status.files);
    }

    #[test]
    fn a_name_with_wildcards_touches_only_that_file() {
        let (_dir, repo) = committed();
        write(&repo, "a.md", "changed\n");
        write(&repo, "*.md", "star\n");
        commit_all(&repo, "Star");
        write(&repo, "*.md", "star changed\n");
        write(&repo, "a.md", "changed again\n");
        discard_file(&repo, "*.md").unwrap();
        assert_eq!(read(&repo, "*.md"), "star\n");
        assert_eq!(read(&repo, "a.md"), "changed again\n");
    }

    #[test]
    fn leaves_ignored_files_alone() {
        let (_dir, repo) = committed();
        exclude_locally(&repo, ".env");
        write(&repo, ".env", "SECRET=1\n");
        discard_file(&repo, ".env").unwrap();
        assert_eq!(read(&repo, ".env"), "SECRET=1\n");
    }

    #[test]
    fn refuses_paths_outside_the_repository() {
        let (dir, repo) = committed();
        let outside = dir.path().parent().unwrap().join("outside-discard-test.md");
        std::fs::write(&outside, "keep\n").unwrap();
        for path in [
            "../outside-discard-test.md",
            outside.to_str().unwrap(),
            "sub/../../outside-discard-test.md",
            ".git/config",
            "",
        ] {
            let e = discard_file(&repo, path).unwrap_err();
            assert_eq!(e, OUTSIDE, "{path}");
        }
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep\n");
        std::fs::remove_file(outside).unwrap();
        assert!(repo.path().join("config").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_path_through_a_symlink_out_of_the_repository() {
        let (_dir, repo) = committed();
        let elsewhere = tempfile::TempDir::new().unwrap();
        std::fs::write(elsewhere.path().join("x.md"), "keep\n").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), repo.workdir().unwrap().join("link")).unwrap();
        assert_eq!(discard_file(&repo, "link/x.md").unwrap_err(), OUTSIDE);
        assert_eq!(
            std::fs::read_to_string(elsewhere.path().join("x.md")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn discarding_a_rename_restores_the_old_file() {
        let (_dir, repo) = committed();
        std::fs::rename(
            repo.workdir().unwrap().join("a.md"),
            repo.workdir().unwrap().join("renamed.md"),
        )
        .unwrap();
        stage(&repo, "renamed.md");
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("a.md")).unwrap();
        index.write().unwrap();
        let status = discard_file(&repo, "renamed.md").unwrap();
        assert_eq!(read(&repo, "a.md"), "a\n");
        assert!(!repo.workdir().unwrap().join("renamed.md").exists());
        assert!(status.files.is_empty(), "{:?}", status.files);
    }
}
