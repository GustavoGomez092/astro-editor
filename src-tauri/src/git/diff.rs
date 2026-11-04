//! Read-only diffs for one file: the working tree against `HEAD`, or a commit against
//! its first parent.

use super::{describe, DiffHunk, DiffLine, DiffLineKind, FileDiff};
use git2::{Diff, DiffOptions, Oid, Patch, Repository};
use std::path::Path;

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff",
];

/// Working tree (staged or not, untracked included) against `HEAD`
pub fn file_diff(repo: &Repository, path: &str) -> Result<FileDiff, String> {
    // Before the first commit there's no HEAD tree, so everything is added
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = path_options(path);
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(|e| describe("Couldn't compare the file", &e))?;
    to_file_diff(&diff, path)
}

/// A commit against its first parent; a root commit against the empty tree
pub fn commit_file_diff(repo: &Repository, id: &str, path: &str) -> Result<FileDiff, String> {
    let diff = commit_diff(repo, id, Some(path))?;
    to_file_diff(&diff, path)
}

/// The diff a commit introduces, limited to one path when given
pub(crate) fn commit_diff<'r>(
    repo: &'r Repository,
    id: &str,
    path: Option<&str>,
) -> Result<Diff<'r>, String> {
    let oid = Oid::from_str(id).map_err(|_| format!("\"{id}\" isn't a commit id"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| describe("Couldn't find that commit", &e))?;
    let tree = commit
        .tree()
        .map_err(|e| describe("Couldn't read that commit", &e))?;
    let parent_tree = match commit.parent(0) {
        Ok(parent) => Some(
            parent
                .tree()
                .map_err(|e| describe("Couldn't read that commit's parent", &e))?,
        ),
        Err(_) => None,
    };
    let mut opts = match path {
        Some(path) => path_options(path),
        None => DiffOptions::new(),
    };
    repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| describe("Couldn't compare that commit", &e))
}

/// Options limiting a diff to exactly one path (no glob matching)
fn path_options(path: &str) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.pathspec(path).disable_pathspec_match(true);
    opts
}

fn is_image(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn to_file_diff(diff: &Diff, path: &str) -> Result<FileDiff, String> {
    let mut result = FileDiff {
        path: path.to_string(),
        binary: false,
        is_image: is_image(path),
        hunks: Vec::new(),
    };
    if diff.deltas().len() == 0 {
        return Ok(result);
    }
    let patch = Patch::from_diff(diff, 0).map_err(|e| describe("Couldn't read the diff", &e))?;
    // libgit2 gives no patch for a binary file
    let Some(patch) = patch.filter(|p| !p.delta().flags().is_binary()) else {
        result.binary = true;
        return Ok(result);
    };
    for hunk_index in 0..patch.num_hunks() {
        let (hunk, line_count) = patch
            .hunk(hunk_index)
            .map_err(|e| describe("Couldn't read the diff", &e))?;
        let mut lines = Vec::with_capacity(line_count);
        for line_index in 0..line_count {
            let line = patch
                .line_in_hunk(hunk_index, line_index)
                .map_err(|e| describe("Couldn't read the diff", &e))?;
            let kind = match line.origin() {
                '+' => DiffLineKind::Add,
                '-' => DiffLineKind::Del,
                ' ' => DiffLineKind::Ctx,
                // "No newline at end of file" markers
                _ => continue,
            };
            let text = String::from_utf8_lossy(line.content());
            lines.push(DiffLine {
                kind,
                text: text.trim_end_matches(['\n', '\r']).to_string(),
                old_no: line.old_lineno(),
                new_no: line.new_lineno(),
            });
        }
        result.hunks.push(DiffHunk {
            header: String::from_utf8_lossy(hunk.header())
                .trim_end()
                .to_string(),
            lines,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;
    use crate::git::{DiffLine, DiffLineKind};

    fn line(kind: DiffLineKind, text: &str, old_no: Option<u32>, new_no: Option<u32>) -> DiffLine {
        DiffLine {
            kind,
            text: text.to_string(),
            old_no,
            new_no,
        }
    }

    #[test]
    fn file_diff_text_hunks() {
        let (_dir, repo) = init_repo();
        write(&repo, "post.md", "one\ntwo\nthree\n");
        commit_all(&repo, "Initial commit");
        write(&repo, "post.md", "one\n2\nthree\nfour\n");

        let diff = file_diff(&repo, "post.md").unwrap();
        assert_eq!(diff.path, "post.md");
        assert!(!diff.binary);
        assert!(!diff.is_image);
        assert_eq!(diff.hunks.len(), 1);
        let hunk = &diff.hunks[0];
        assert!(
            hunk.header.starts_with("@@ -1,3 +1,4 @@"),
            "{}",
            hunk.header
        );
        assert_eq!(
            hunk.lines,
            vec![
                line(DiffLineKind::Ctx, "one", Some(1), Some(1)),
                line(DiffLineKind::Del, "two", Some(2), None),
                line(DiffLineKind::Add, "2", None, Some(2)),
                line(DiffLineKind::Ctx, "three", Some(3), Some(3)),
                line(DiffLineKind::Add, "four", None, Some(4)),
            ]
        );
    }

    #[test]
    fn file_diff_untracked_file_is_all_added() {
        let (_dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        commit_all(&repo, "Initial commit");
        write(&repo, "new.md", "hello\nworld\n");

        let diff = file_diff(&repo, "new.md").unwrap();
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(
            diff.hunks[0].lines,
            vec![
                line(DiffLineKind::Add, "hello", None, Some(1)),
                line(DiffLineKind::Add, "world", None, Some(2)),
            ]
        );
    }

    #[test]
    fn file_diff_deleted_file_is_all_removed() {
        let (_dir, repo) = init_repo();
        write(&repo, "gone.md", "bye\n");
        commit_all(&repo, "Initial commit");
        remove(&repo, "gone.md");

        let diff = file_diff(&repo, "gone.md").unwrap();
        assert_eq!(
            diff.hunks[0].lines,
            vec![line(DiffLineKind::Del, "bye", Some(1), None)]
        );
    }

    #[test]
    fn file_diff_binary_image() {
        let (_dir, repo) = init_repo();
        let png_header: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0];
        write_bytes(&repo, "images/cover.png", png_header);
        commit_all(&repo, "Initial commit");
        let mut changed = png_header.to_vec();
        changed.extend_from_slice(&[1, 0, 2, 0]);
        write_bytes(&repo, "images/cover.png", &changed);

        let diff = file_diff(&repo, "images/cover.png").unwrap();
        assert!(diff.binary);
        assert!(diff.is_image);
        assert!(diff.hunks.is_empty());
    }

    #[test]
    fn file_diff_outside_a_repo_is_an_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let e = crate::git::with_repo(dir.path(), |repo| file_diff(repo, "a.md")).unwrap_err();
        assert_eq!(e, "This folder isn't a git repository");
    }

    #[test]
    fn commit_file_diff_against_first_parent() {
        let (_dir, repo) = init_repo();
        write(&repo, "post.md", "one\n");
        commit_all(&repo, "First");
        write(&repo, "post.md", "one\ntwo\n");
        let second = commit_all(&repo, "Second");

        let diff = commit_file_diff(&repo, &second.to_string(), "post.md").unwrap();
        assert_eq!(
            diff.hunks[0].lines,
            vec![
                line(DiffLineKind::Ctx, "one", Some(1), Some(1)),
                line(DiffLineKind::Add, "two", None, Some(2)),
            ]
        );
    }

    #[test]
    fn commit_file_diff_root_commit_against_empty_tree() {
        let (_dir, repo) = init_repo();
        write(&repo, "post.md", "one\n");
        let root = commit_all(&repo, "First");

        let diff = commit_file_diff(&repo, &root.to_string(), "post.md").unwrap();
        assert_eq!(
            diff.hunks[0].lines,
            vec![line(DiffLineKind::Add, "one", None, Some(1))]
        );
    }
}
