//! Conflicts between the checked-out branch and its upstream, and resolving them
//! by keeping one whole-file version of each.
//!
//! Both work from an in-memory merge of `HEAD` and the upstream as last fetched,
//! so listing writes nothing, and resolving changes the repository only once
//! every conflicted file has a choice. Resolving commits the merge and never
//! pushes; the next Publish does.

use super::status::changed_files;
use super::status::{repo_status, upstream_of};
use super::sync::{combine_message, current_branch, move_branch_or_undo, paths_between_trees};
use super::{
    checkout_safely, describe, name_files, CheckoutRefused, ConflictChoice, ConflictFile,
    ConflictResolution, SyncOutcome, SyncResult,
};
use git2::{BranchType, Commit, Index, IndexConflict, IndexEntry, Oid, Repository, Signature};

/// The local and upstream commits when both have commits the other doesn't
fn diverged(repo: &Repository) -> Result<Option<(Commit<'_>, Commit<'_>, String)>, String> {
    let branch = current_branch(repo)?;
    let Some((upstream_name, upstream)) = upstream_of(repo, &branch) else {
        return Ok(None);
    };
    let Some(local) = repo
        .find_branch(&branch, BranchType::Local)
        .ok()
        .and_then(|b| b.get().target())
    else {
        return Ok(None);
    };
    let (ahead, behind) = repo
        .graph_ahead_behind(local, upstream)
        .map_err(|e| describe("Couldn't compare the branches", &e))?;
    if ahead == 0 || behind == 0 {
        return Ok(None);
    }
    let read = |oid: Oid| {
        repo.find_commit(oid)
            .map_err(|e| describe("Couldn't read the changes", &e))
    };
    Ok(Some((read(local)?, read(upstream)?, upstream_name)))
}

fn merge_in_memory(repo: &Repository, local: &Commit, upstream: &Commit) -> Result<Index, String> {
    repo.merge_commits(local, upstream, None)
        .map_err(|e| describe("Couldn't combine the changes", &e))
}

/// The path a conflict is known by: this side's, else the other side's
fn conflict_path(conflict: &IndexConflict) -> Option<String> {
    conflict
        .our
        .as_ref()
        .or(conflict.their.as_ref())
        .or(conflict.ancestor.as_ref())
        .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
}

fn index_conflicts(index: &Index) -> Result<Vec<IndexConflict>, String> {
    index
        .conflicts()
        .and_then(|conflicts| conflicts.collect::<Result<Vec<_>, _>>())
        .map_err(|e| describe("Couldn't read the conflicting files", &e))
}

/// The files that conflict between `HEAD` and its upstream. Empty when the
/// branch has no upstream, or the two haven't both moved on, or the merge is clean.
pub fn conflicts(repo: &Repository) -> Result<Vec<ConflictFile>, String> {
    let Some((local, upstream, _)) = diverged(repo)? else {
        return Ok(Vec::new());
    };
    let index = merge_in_memory(repo, &local, &upstream)?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let blob = |entry: &Option<IndexEntry>| -> Result<Option<git2::Blob<'_>>, String> {
        entry
            .as_ref()
            .map(|e| repo.find_blob(e.id))
            .transpose()
            .map_err(|e| describe("Couldn't read a conflicting file", &e))
    };
    let mut files = Vec::new();
    for conflict in index_conflicts(&index)? {
        let Some(path) = conflict_path(&conflict) else {
            continue;
        };
        let mine = blob(&conflict.our)?;
        let theirs = blob(&conflict.their)?;
        let binary = [&mine, &theirs]
            .iter()
            .any(|b| b.as_ref().is_some_and(|b| b.is_binary()));
        let text = |b: Option<git2::Blob>| {
            b.filter(|_| !binary)
                .map(|b| String::from_utf8_lossy(b.content()).into_owned())
        };
        files.push(ConflictFile {
            path,
            mine: text(mine),
            theirs: text(theirs),
            binary,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Merge the upstream into the checked-out branch, keeping the chosen whole-file
/// version of each conflicted file, and commit it. Refuses, changing nothing, if a
/// conflicted file has no choice, or if the result would overwrite edits that
/// aren't committed yet.
pub fn resolve_conflicts(
    repo: &Repository,
    choices: &[ConflictResolution],
    label: &str,
    identity: &dyn Fn() -> Result<Signature<'static>, String>,
) -> Result<SyncResult, String> {
    let branch = current_branch(repo)?;
    if repo.state() != git2::RepositoryState::Clean {
        return Err(
            "Git is in the middle of another operation (a merge or rebase) in this repository. Finish it in a git tool first."
                .to_string(),
        );
    }
    let Some((local, upstream, upstream_name)) = diverged(repo)? else {
        return Ok(SyncResult {
            outcome: SyncOutcome::UpToDate,
            message: "Nothing to resolve.".to_string(),
            status: repo_status(repo)?,
        });
    };
    let mut index = merge_in_memory(repo, &local, &upstream)?;
    let conflicts = index_conflicts(&index)?;

    let mut unchosen = Vec::new();
    let mut resolved = Vec::new();
    for conflict in conflicts {
        let Some(path) = conflict_path(&conflict) else {
            continue;
        };
        match choices.iter().find(|c| c.path == path) {
            None => unchosen.push(path),
            Some(c) => resolved.push((path, c.choice, conflict)),
        }
    }
    if !unchosen.is_empty() {
        return Err(format!(
            "Choose which version to keep of {} first. Nothing was changed.",
            name_files(&unchosen)
        ));
    }

    let index_error = |e: git2::Error| describe("Couldn't combine the changes", &e);
    for (_, choice, conflict) in resolved {
        // Every path the conflict touches, in case the sides named it differently
        for entry in [&conflict.ancestor, &conflict.our, &conflict.their]
            .into_iter()
            .flatten()
        {
            let path = std::path::PathBuf::from(String::from_utf8_lossy(&entry.path).as_ref());
            index
                .conflict_remove(&path)
                .or_else(|e| {
                    if e.code() == git2::ErrorCode::NotFound {
                        Ok(())
                    } else {
                        Err(e)
                    }
                })
                .map_err(index_error)?;
        }
        let chosen = match choice {
            ConflictChoice::Mine => conflict.our,
            ConflictChoice::Theirs => conflict.their,
        };
        if let Some(mut entry) = chosen {
            // Stage 0: an ordinary, resolved entry
            entry.flags &= !STAGE_MASK;
            index.add(&entry).map_err(index_error)?;
        }
    }
    if index.has_conflicts() {
        return Err("Couldn't combine the changes: some files still conflict.".to_string());
    }

    let tree_id = index.write_tree_to(repo).map_err(index_error)?;
    let tree = repo.find_tree(tree_id).map_err(index_error)?;

    // Safe checkout lets a file through when it already matches what it would
    // write, so a local edit (or untracked file) on any path the merge changes
    // is refused here, before anything is written
    let previous = local.tree().ok();
    let merge_paths = paths_between_trees(repo, previous.as_ref(), &tree)?;
    let touched: Vec<String> = changed_files(repo)?
        .into_iter()
        .filter(|f| {
            merge_paths.contains(&f.path)
                || f.old_path.as_ref().is_some_and(|p| merge_paths.contains(p))
        })
        .map(|f| f.path)
        .collect();
    if !touched.is_empty() {
        return Ok(SyncResult {
            outcome: SyncOutcome::BlockedByLocalChanges,
            message: format!(
                "Combining the changes would overwrite your edits to {}, so nothing was changed. Publish or discard them, then try again.",
                name_files(&touched)
            ),
            status: repo_status(repo)?,
        });
    }
    let signature = identity()?;
    let merge = repo
        .commit(
            None,
            &signature,
            &signature,
            &combine_message(label, &upstream_name),
            &tree,
            &[&local, &upstream],
        )
        .map_err(|e| describe("Couldn't save the combined changes", &e))?;
    if let Err(refused) = checkout_safely(repo, tree.as_object()) {
        let message = match refused {
            CheckoutRefused::Conflicts(files) => format!(
                "Combining the changes would overwrite your edits to {}, so nothing was changed. Publish or discard them, then try again.",
                name_files(&files)
            ),
            CheckoutRefused::Failed(e) => describe("Couldn't combine the changes", &e),
        };
        return Ok(SyncResult {
            outcome: SyncOutcome::BlockedByLocalChanges,
            message,
            status: repo_status(repo)?,
        });
    }
    move_branch_or_undo(
        repo,
        (&branch, merge, Some(local.id()), "merge"),
        &tree,
        previous.as_ref(),
    )?;
    Ok(SyncResult {
        outcome: SyncOutcome::Merged,
        message: format!(
            "Combined your changes with the changes from {label}. Publish to send them."
        ),
        status: repo_status(repo)?,
    })
}

/// The stage bits of an index entry's flags (`GIT_INDEX_ENTRY_STAGEMASK`)
const STAGE_MASK: u16 = 0x3000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::sync::commit_identity;
    use crate::git::test_support::*;

    /// README.md changed on both sides: "mine\n" here (committed), "theirs\n" on
    /// the remote (fetched)
    fn conflicted() -> (RemoteSetup, Oid, Oid) {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        write(&setup.local, "README.md", "mine\n");
        let mine = commit_all(&setup.local, "My change");
        fetch(&setup.local);
        (setup, mine, theirs)
    }

    fn choose(path: &str, choice: ConflictChoice) -> ConflictResolution {
        ConflictResolution {
            path: path.to_string(),
            choice,
        }
    }

    fn resolve(setup: &RemoteSetup, choices: &[ConflictResolution]) -> Result<SyncResult, String> {
        resolve_conflicts(&setup.local, choices, "GitHub", &|| {
            commit_identity(&setup.local, None)
        })
    }

    #[test]
    fn no_conflicts_when_level_or_only_behind() {
        let setup = repo_with_remote();
        assert_eq!(conflicts(&setup.local).unwrap(), vec![]);
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        fetch(&setup.local);
        assert_eq!(conflicts(&setup.local).unwrap(), vec![]);
    }

    #[test]
    fn no_conflicts_when_diverged_cleanly() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "mine.md", "mine\n");
        commit_all(&setup.local, "Mine");
        fetch(&setup.local);
        assert_eq!(conflicts(&setup.local).unwrap(), vec![]);
    }

    #[test]
    fn lists_text_conflicts_with_both_versions_and_writes_nothing() {
        let (setup, mine, _) = conflicted();
        let files = conflicts(&setup.local).unwrap();
        assert_eq!(
            files,
            vec![ConflictFile {
                path: "README.md".to_string(),
                mine: Some("mine\n".to_string()),
                theirs: Some("theirs\n".to_string()),
                binary: false,
            }]
        );
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        assert_eq!(setup.local.state(), git2::RepositoryState::Clean);
        assert!(!setup.local.index().unwrap().has_conflicts());
    }

    #[test]
    fn lists_binary_conflicts_without_text() {
        let setup = repo_with_remote();
        write_bytes(&setup.local, "photo.png", b"\x89PNG\r\n\x1a\n\0base");
        commit_all(&setup.local, "Photo");
        push(&setup.local, "main");
        let (_dir, other) = clone_of(setup.remote_dir.path());
        write_bytes(&other, "photo.png", b"\x89PNG\r\n\x1a\n\0theirs");
        commit_all(&other, "Their photo");
        other
            .find_remote("origin")
            .unwrap()
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();
        write_bytes(&setup.local, "photo.png", b"\x89PNG\r\n\x1a\n\0mine");
        commit_all(&setup.local, "My photo");
        fetch(&setup.local);

        let files = conflicts(&setup.local).unwrap();
        assert_eq!(
            files,
            vec![ConflictFile {
                path: "photo.png".to_string(),
                mine: None,
                theirs: None,
                binary: true,
            }]
        );
    }

    #[test]
    fn a_file_deleted_on_one_side_has_no_version_there() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        remove(&setup.local, "README.md");
        commit_all(&setup.local, "Remove the readme");
        fetch(&setup.local);
        let files = conflicts(&setup.local).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].mine, None);
        assert_eq!(files[0].theirs.as_deref(), Some("theirs\n"));
    }

    #[test]
    fn resolving_with_mine_commits_a_merge_and_pushes_nothing() {
        let (setup, mine, theirs) = conflicted();
        let result = resolve(&setup, &[choose("README.md", ConflictChoice::Mine)]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::Merged, "{}", result.message);
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_ids().collect::<Vec<_>>(), vec![mine, theirs]);
        assert_eq!(head.message(), Some("Combine changes from GitHub"));
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        let blob = head.tree().unwrap().get_name("README.md").unwrap().id();
        assert_eq!(setup.local.find_blob(blob).unwrap().content(), b"mine\n");
        assert_eq!(remote_tip(setup.remote_dir.path(), "main"), Some(theirs));
        assert!(result.status.files.is_empty(), "{:?}", result.status.files);
        assert_eq!((result.status.ahead, result.status.behind), (2, 0));
        assert_eq!(setup.local.state(), git2::RepositoryState::Clean);
        assert!(conflicts(&setup.local).unwrap().is_empty());
    }

    #[test]
    fn resolving_with_theirs_takes_their_version() {
        let (setup, mine, theirs) = conflicted();
        let result = resolve(&setup, &[choose("README.md", ConflictChoice::Theirs)]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::Merged, "{}", result.message);
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_ids().collect::<Vec<_>>(), vec![mine, theirs]);
        assert_eq!(read(&setup.local, "README.md"), "theirs\n");
        assert!(result.status.files.is_empty(), "{:?}", result.status.files);
        assert_eq!(remote_tip(setup.remote_dir.path(), "main"), Some(theirs));
    }

    #[test]
    fn resolving_keeps_clean_changes_from_both_sides() {
        let (setup, _, _) = conflicted();
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "mine.md", "mine\n");
        commit_all(&setup.local, "Another of mine");
        fetch(&setup.local);
        resolve(&setup, &[choose("README.md", ConflictChoice::Theirs)]).unwrap();
        assert_eq!(read(&setup.local, "news.md"), "news\n");
        assert_eq!(read(&setup.local, "mine.md"), "mine\n");
        assert_eq!(read(&setup.local, "README.md"), "theirs\n");
    }

    #[test]
    fn choosing_the_side_that_deleted_a_file_deletes_it() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        remove(&setup.local, "README.md");
        commit_all(&setup.local, "Remove the readme");
        fetch(&setup.local);
        resolve(&setup, &[choose("README.md", ConflictChoice::Mine)]).unwrap();
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert!(head.tree().unwrap().get_name("README.md").is_none());
        assert!(!setup.local.workdir().unwrap().join("README.md").exists());
    }

    #[test]
    fn refuses_when_a_conflicted_file_has_no_choice() {
        let (setup, mine, _) = conflicted();
        let e = resolve(&setup, &[choose("other.md", ConflictChoice::Mine)]).unwrap_err();
        assert!(e.contains("README.md"), "{e}");
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        assert_eq!(setup.local.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn refuses_to_overwrite_uncommitted_edits() {
        let (setup, mine, _) = conflicted();
        write(&setup.local, "README.md", "unsaved idea\n");
        let result = resolve(&setup, &[choose("README.md", ConflictChoice::Theirs)]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::BlockedByLocalChanges);
        assert!(result.message.contains("README.md"), "{}", result.message);
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "README.md"), "unsaved idea\n");
    }

    #[test]
    fn a_branch_that_is_only_behind_has_nothing_to_resolve() {
        let setup = repo_with_remote();
        let before = head_id(&setup.local);
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        fetch(&setup.local);
        let result = resolve(&setup, &[]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::UpToDate);
        assert_eq!(result.message, "Nothing to resolve.");
        assert_eq!(head_id(&setup.local), before);
    }

    #[test]
    fn a_branch_that_cant_move_puts_the_files_back() {
        let (setup, mine, _) = conflicted();
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        fetch(&setup.local);
        // Another git process is updating the branch
        let ref_lock = setup.local.path().join("refs/heads/main.lock");
        std::fs::write(&ref_lock, "").unwrap();
        assert!(resolve(&setup, &[choose("README.md", ConflictChoice::Theirs)]).is_err());
        std::fs::remove_file(ref_lock).unwrap();
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        assert!(!setup.local.workdir().unwrap().join("news.md").exists());
        let status = crate::git::status::repo_status(&setup.local).unwrap();
        assert!(status.files.is_empty(), "{:?}", status.files);
    }

    #[test]
    fn refuses_when_a_file_the_merge_changes_is_untracked_here() {
        let (setup, mine, _) = conflicted();
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        fetch(&setup.local);
        // The same content the merge would write, so a safe checkout lets it by
        write(&setup.local, "news.md", "news\n");
        let result = resolve(&setup, &[choose("README.md", ConflictChoice::Mine)]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::BlockedByLocalChanges);
        assert!(result.message.contains("news.md"), "{}", result.message);
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "news.md"), "news\n");
    }

    #[test]
    fn refuses_when_an_uncommitted_edit_equals_the_chosen_version() {
        let (setup, mine, _) = conflicted();
        write(&setup.local, "README.md", "theirs\n");
        let result = resolve(&setup, &[choose("README.md", ConflictChoice::Theirs)]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::BlockedByLocalChanges);
        assert!(result.message.contains("README.md"), "{}", result.message);
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "README.md"), "theirs\n");
    }

    #[test]
    fn nothing_to_resolve_is_up_to_date() {
        let setup = repo_with_remote();
        let before = head_id(&setup.local);
        let result = resolve(&setup, &[]).unwrap();
        assert_eq!(result.outcome, SyncOutcome::UpToDate);
        assert_eq!(head_id(&setup.local), before);
    }
}
