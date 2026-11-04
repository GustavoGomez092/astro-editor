//! Sync, publish and "bring in changes from the default branch".
//!
//! Safety: nothing here discards uncommitted changes. Fast-forwards and merges are
//! checked out with libgit2's safe checkout, and merges happen in memory first, so a
//! conflict leaves the repository exactly as it was.

use super::remote::{fetch, has_origin, push_current_branch};
use super::status::{changed_files, current_branch_name, default_branch, repo_status, upstream_of};
use super::{
    checkout_safely, describe, name_files, CheckoutRefused, PublishResult, SyncOutcome, SyncResult,
};
use crate::github::auth::GitHubUser;
use crate::github::repos::parse_github_remote;
use git2::{BranchType, IndexAddOption, Oid, Repository, RepositoryState, Signature, Tree};
use std::collections::HashSet;

const DETACHED: &str = "You're not on a branch. Switch to a branch first.";
const NOT_PUBLISHED: &str = "Your changes are saved on this computer, but weren't published";

pub fn sync(
    repo: &Repository,
    token: Option<&str>,
    user: Option<&GitHubUser>,
) -> Result<SyncResult, String> {
    let branch = current_branch(repo)?;
    fetch(repo, token)?;
    let Some((upstream_name, upstream)) = upstream_of(repo, &branch) else {
        return Ok(SyncResult {
            outcome: SyncOutcome::NoUpstream,
            message: format!(
                "This branch isn't on {} yet. Publish to put it there.",
                remote_label(repo)
            ),
            status: repo_status(repo)?,
        });
    };
    let label = remote_label(repo);
    let integration = integrate(
        repo,
        &branch,
        upstream,
        &label,
        &combine_message(&label, &upstream_name),
        &|| commit_identity(repo, user),
    )?;
    Ok(SyncResult {
        outcome: integration.outcome,
        message: integration.message,
        status: repo_status(repo)?,
    })
}

/// Commit everything, fetch, merge incoming changes, push. Once the commit is made
/// it's kept whatever happens next; failures after it come back as `pushed: false`
/// with a message, not as an error.
pub fn publish(
    repo: &Repository,
    message: &str,
    token: Option<&str>,
    user: Option<&GitHubUser>,
) -> Result<PublishResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a short message describing your changes.".to_string());
    }
    let branch = current_branch(repo)?;
    let commit_id = commit_everything(repo, message, user)?.to_string();

    let not_published = |outcome: SyncOutcome, message: String| -> Result<PublishResult, String> {
        Ok(PublishResult {
            commit_id: commit_id.clone(),
            pushed: false,
            outcome,
            message,
            status: repo_status(repo)?,
        })
    };

    if !has_origin(repo) {
        return not_published(
            SyncOutcome::NoUpstream,
            format!("{NOT_PUBLISHED}: this repository has no remote to publish to."),
        );
    }
    let label = remote_label(repo);
    if let Err(e) = fetch(repo, token) {
        return not_published(SyncOutcome::UpToDate, format!("{NOT_PUBLISHED}. {e}"));
    }

    let mut outcome = SyncOutcome::UpToDate;
    if let Some((upstream_name, upstream)) = upstream_of(repo, &branch) {
        let integration = integrate(
            repo,
            &branch,
            upstream,
            &label,
            &combine_message(&label, &upstream_name),
            &|| commit_identity(repo, user),
        )?;
        match integration.outcome {
            SyncOutcome::Conflict => {
                let file = integration.conflict_file.unwrap_or_default();
                return not_published(
                    SyncOutcome::Conflict,
                    format!(
                        "{NOT_PUBLISHED}: the same lines of {file} were also changed on {label}. Publish isn't possible until that's sorted out."
                    ),
                );
            }
            SyncOutcome::BlockedByLocalChanges => {
                return not_published(
                    SyncOutcome::BlockedByLocalChanges,
                    format!("{NOT_PUBLISHED}. {}", integration.message),
                );
            }
            other => outcome = other,
        }
    }

    if let Err(e) = push_current_branch(repo, token) {
        return not_published(outcome, format!("{NOT_PUBLISHED}. {e}"));
    }
    Ok(PublishResult {
        commit_id,
        pushed: true,
        outcome,
        message: format!("Published to {branch}."),
        status: repo_status(repo)?,
    })
}

/// "Bring in changes from main": merge the default branch (as on the remote, when
/// there is one) into the current branch, with the same rules as sync
pub fn merge_default_branch(
    repo: &Repository,
    token: Option<&str>,
    user: Option<&GitHubUser>,
) -> Result<SyncResult, String> {
    let branch = current_branch(repo)?;
    let default = default_branch(repo)
        .ok_or_else(|| "Couldn't tell which branch is the default branch.".to_string())?;
    if has_origin(repo) {
        fetch(repo, token)?;
    }
    if branch == default {
        return Ok(SyncResult {
            outcome: SyncOutcome::UpToDate,
            message: format!("You're on {default} already."),
            status: repo_status(repo)?,
        });
    }
    let target = [
        (format!("origin/{default}"), BranchType::Remote),
        (default.clone(), BranchType::Local),
    ]
    .into_iter()
    .find_map(|(name, kind)| repo.find_branch(&name, kind).ok()?.get().target())
    .ok_or_else(|| format!("Couldn't find the {default} branch."))?;

    let integration = integrate(
        repo,
        &branch,
        target,
        &default,
        &format!("Bring in changes from {default}"),
        &|| commit_identity(repo, user),
    )?;
    // Publishing can't sort out a conflict with the default branch, so the
    // message doesn't point there
    let message = match (&integration.outcome, &integration.conflict_file) {
        (SyncOutcome::Conflict, Some(file)) => format!(
            "This branch and {default} both changed the same lines of {file}, so nothing was changed."
        ),
        _ => integration.message,
    };
    Ok(SyncResult {
        outcome: integration.outcome,
        message,
        status: repo_status(repo)?,
    })
}

/// How many commits the default branch (as last fetched from the remote, else
/// the local one) has that the checked-out branch doesn't: what "Bring in
/// changes from main" would bring in. 0 on the default branch itself.
pub fn commits_behind_default(repo: &Repository) -> Result<u32, String> {
    Ok(ahead_behind_default(repo)?.1)
}

/// How many commits the checked-out branch has that the default branch (as last
/// fetched from the remote, else the local one) doesn't: whether there's anything
/// for a pull request. 0 on the default branch itself.
pub fn commits_ahead_of_default(repo: &Repository) -> Result<u32, String> {
    Ok(ahead_behind_default(repo)?.0)
}

/// The checked-out branch against the default branch's tip (`origin/<default>`,
/// else the local one); `(0, 0)` on the default branch itself
fn ahead_behind_default(repo: &Repository) -> Result<(u32, u32), String> {
    let Some(default) = default_branch(repo) else {
        return Ok((0, 0));
    };
    if current_branch_name(repo).as_deref() == Some(default.as_str()) {
        return Ok((0, 0));
    }
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok((0, 0));
    };
    let tip = [
        (format!("origin/{default}"), BranchType::Remote),
        (default.clone(), BranchType::Local),
    ]
    .into_iter()
    .find_map(|(name, kind)| repo.find_branch(&name, kind).ok()?.get().target());
    let Some(tip) = tip else {
        return Ok((0, 0));
    };
    let (ahead, behind) = repo
        .graph_ahead_behind(head, tip)
        .map_err(|e| describe("Couldn't compare the branches", &e))?;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok((count(ahead), count(behind)))
}

/// The author for commits: git config's user.name and user.email if both are set,
/// else the GitHub profile with its no-reply address
pub fn commit_identity(
    repo: &Repository,
    user: Option<&GitHubUser>,
) -> Result<Signature<'static>, String> {
    let (name, email) = config_identity(repo);
    identity_from(name, email, user)
}

/// Puts the GitHub profile's name and no-reply address in the repository's own
/// config for whichever of user.name and user.email git config doesn't have, so
/// commits made in a git tool carry the same name. Returns whether it wrote any.
pub fn ensure_identity(repo: &Repository, user: &GitHubUser) -> Result<bool, String> {
    let existing = config_identity(repo);
    if matches!(existing, (Some(_), Some(_))) {
        return Ok(false);
    }
    let mut local = repo
        .config()
        .and_then(|c| c.open_level(git2::ConfigLevel::Local))
        .map_err(|e| describe("Couldn't open the repository's settings", &e))?;
    write_identity(&mut local, existing, user)
}

fn write_identity(
    config: &mut git2::Config,
    existing: (Option<String>, Option<String>),
    user: &GitHubUser,
) -> Result<bool, String> {
    let error = |e: git2::Error| describe("Couldn't save your name for commits", &e);
    let mut wrote = false;
    if existing.0.is_none() {
        let name = user.name.as_deref().unwrap_or(&user.login);
        config.set_str("user.name", name).map_err(error)?;
        wrote = true;
    }
    if existing.1.is_none() {
        let email = noreply_email(user);
        config.set_str("user.email", &email).map_err(error)?;
        wrote = true;
    }
    Ok(wrote)
}

/// GitHub's no-reply address for the account, which links commits to it
fn noreply_email(user: &GitHubUser) -> String {
    format!("{}+{}@users.noreply.github.com", user.id, user.login)
}

pub fn has_config_identity(repo: &Repository) -> bool {
    matches!(config_identity(repo), (Some(_), Some(_)))
}

fn config_identity(repo: &Repository) -> (Option<String>, Option<String>) {
    let config = repo.config().ok();
    let get = |key: &str| {
        config
            .as_ref()
            .and_then(|c| c.get_string(key).ok())
            .filter(|v| !v.trim().is_empty())
    };
    (get("user.name"), get("user.email"))
}

pub(crate) fn identity_from(
    name: Option<String>,
    email: Option<String>,
    user: Option<&GitHubUser>,
) -> Result<Signature<'static>, String> {
    let signature = match (name, email, user) {
        (Some(name), Some(email), _) => Signature::now(&name, &email),
        (_, _, Some(user)) => Signature::now(
            user.name.as_deref().unwrap_or(&user.login),
            &noreply_email(user),
        ),
        _ => {
            return Err(
                "Git doesn't know whose name to put on your changes. Sign in with GitHub, or set your name and email in git."
                    .to_string(),
            )
        }
    };
    signature.map_err(|e| describe("Couldn't use that name for commits", &e))
}

pub(crate) fn current_branch(repo: &Repository) -> Result<String, String> {
    if repo.head_detached().unwrap_or(false) {
        return Err(DETACHED.to_string());
    }
    current_branch_name(repo).ok_or_else(|| DETACHED.to_string())
}

/// "GitHub" for a github.com origin, else "the remote"
pub(crate) fn remote_label(repo: &Repository) -> String {
    let github = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|url| parse_github_remote(url).is_some()))
        .unwrap_or(false);
    if github { "GitHub" } else { "the remote" }.to_string()
}

/// The message for a merge commit that brings in the upstream: "Combine changes
/// from GitHub", else from the remote's name (`origin`)
pub(crate) fn combine_message(label: &str, upstream_name: &str) -> String {
    if label == "GitHub" {
        return "Combine changes from GitHub".to_string();
    }
    let remote = upstream_name.split('/').next().unwrap_or("origin");
    format!("Combine changes from {remote}")
}

/// The label as the subject of a sentence: "GitHub", "The remote", or, for a
/// branch (bringing in the default branch), "The main branch", so a branch
/// name is never capitalised
fn subject(label: &str) -> String {
    match label {
        "GitHub" => "GitHub".to_string(),
        "the remote" => "The remote".to_string(),
        branch => format!("The {branch} branch"),
    }
}

/// Stage everything (deletions included) and commit it. With nothing new to commit,
/// returns the current commit.
fn commit_everything(
    repo: &Repository,
    message: &str,
    user: Option<&GitHubUser>,
) -> Result<Oid, String> {
    if repo.state() != RepositoryState::Clean {
        return Err(
            "Git is in the middle of another operation (a merge or rebase) in this repository. Finish it in a git tool first."
                .to_string(),
        );
    }
    let stage_error = |e: git2::Error| describe("Couldn't prepare your changes", &e);
    let mut index = repo.index().map_err(stage_error)?;
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .map_err(stage_error)?;
    index.update_all(["*"], None).map_err(stage_error)?;
    index.write().map_err(stage_error)?;
    let tree_id = index.write_tree().map_err(stage_error)?;

    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    match &head {
        Some(head) if head.tree_id() == tree_id => return Ok(head.id()),
        None if index.is_empty() => return Err("There's nothing to publish yet.".to_string()),
        _ => {}
    }
    let signature = commit_identity(repo, user)?;
    let tree = repo.find_tree(tree_id).map_err(stage_error)?;
    let parents: Vec<_> = head.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .map_err(|e| describe("Couldn't save your changes", &e))
}

/// [`move_branch`] after checking out `written`; if the branch can't move, the
/// files are put back as they were in `previous`, so nothing is left half done
pub(crate) fn move_branch_or_undo(
    repo: &Repository,
    (branch, to, expected, why): (&str, Oid, Option<Oid>, &str),
    written: &Tree,
    previous: Option<&Tree>,
) -> Result<(), String> {
    let moved = move_branch(repo, branch, to, expected, why);
    if moved.is_err() {
        if let Some(previous) = previous {
            super::undo_checkout(repo, written, previous);
        }
    }
    moved
}

/// A checkout that failed for a reason other than local changes
fn checkout_failed(label: &str, e: &git2::Error) -> String {
    format!(
        "Couldn't bring in the changes from {label}: {}",
        e.message()
    )
}

struct Integration {
    outcome: SyncOutcome,
    message: String,
    conflict_file: Option<String>,
}

impl Integration {
    fn new(outcome: SyncOutcome, message: String) -> Self {
        Self {
            outcome,
            message,
            conflict_file: None,
        }
    }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// Paths that differ between two commits (either side of a rename)
fn paths_between(repo: &Repository, from: Option<Oid>, to: Oid) -> Result<HashSet<String>, String> {
    let tree_of = |oid: Oid| -> Result<Tree, String> {
        repo.find_commit(oid)
            .and_then(|c| c.tree())
            .map_err(|e| describe("Couldn't read the incoming changes", &e))
    };
    let from_tree = from.map(tree_of).transpose()?;
    let to_tree = tree_of(to)?;
    let diff = repo
        .diff_tree_to_tree(from_tree.as_ref(), Some(&to_tree), None)
        .map_err(|e| describe("Couldn't read the incoming changes", &e))?;
    let mut paths = HashSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(path) = file.path_bytes() {
                paths.insert(String::from_utf8_lossy(path).into_owned());
            }
        }
    }
    Ok(paths)
}

/// Point `branch` at `to`, but only if it's still at `expected` (or doesn't exist
/// yet, when `expected` is `None`), so a commit made meanwhile is never dropped
pub(crate) fn move_branch(
    repo: &Repository,
    branch: &str,
    to: Oid,
    expected: Option<Oid>,
    why: &str,
) -> Result<(), String> {
    let name = format!("refs/heads/{branch}");
    let result = match expected {
        Some(expected) => repo.reference_matching(&name, to, true, expected, why),
        None => repo.reference(&name, to, false, why),
    };
    result.map(|_| ()).map_err(|e| {
        log::warn!(
            "Astro Editor [GIT] Branch moved underneath us: {}",
            e.message()
        );
        format!("{branch} changed while this was running, so nothing was moved. Try again.")
    })
}

/// Bring the commit `incoming` (from `label`) into `branch`,
/// the checked-out branch: fast-forward when only it has new commits and that won't
/// touch locally changed files; merge when both have new commits and there are no
/// local changes; otherwise leave everything as it is and say why.
fn integrate(
    repo: &Repository,
    branch: &str,
    incoming: Oid,
    label: &str,
    merge_message: &str,
    identity: &dyn Fn() -> Result<Signature<'static>, String>,
) -> Result<Integration, String> {
    let local = repo
        .find_branch(branch, BranchType::Local)
        .ok()
        .and_then(|b| b.get().target());
    let (ahead, behind) = match local {
        Some(local) => repo
            .graph_ahead_behind(local, incoming)
            .map_err(|e| describe("Couldn't compare the branches", &e))?,
        None => (0, 1),
    };
    if behind == 0 {
        return Ok(Integration::new(
            SyncOutcome::UpToDate,
            "Everything is up to date.".to_string(),
        ));
    }
    let incoming_commit = repo
        .find_commit(incoming)
        .map_err(|e| describe("Couldn't read the incoming changes", &e))?;
    let incoming_tree = incoming_commit
        .tree()
        .map_err(|e| describe("Couldn't read the incoming changes", &e))?;
    let local_changes = changed_files(repo)?;

    if ahead == 0 {
        let incoming_paths = paths_between(repo, local, incoming)?;
        let touched: Vec<String> = local_changes
            .iter()
            .filter(|f| {
                incoming_paths.contains(&f.path)
                    || f.old_path
                        .as_ref()
                        .is_some_and(|p| incoming_paths.contains(p))
            })
            .map(|f| f.path.clone())
            .collect();
        let blocked = |files: &[String]| {
            Integration::new(
                SyncOutcome::BlockedByLocalChanges,
                format!(
                    "{} has changes to {} that you're also editing here. Publish your edits first; that combines both.",
                    subject(label),
                    if files.is_empty() { "files".to_string() } else { name_files(files) }
                ),
            )
        };
        if !touched.is_empty() {
            return Ok(blocked(&touched));
        }
        match checkout_safely(repo, incoming_tree.as_object()) {
            Ok(()) => {}
            Err(CheckoutRefused::Conflicts(files)) => {
                // Files git would overwrite that aren't changes of the site's
                // (ignored ones, like .env): publishing can't help with those
                let outside: Vec<String> = files
                    .iter()
                    .filter(|path| !local_changes.iter().any(|c| &c.path == *path))
                    .cloned()
                    .collect();
                if !outside.is_empty() {
                    return Ok(Integration::new(
                        SyncOutcome::BlockedByLocalChanges,
                        format!(
                            "Bringing in the changes from {label} would overwrite {}, a file on this computer that isn't part of the site, so nothing was changed. Move or rename it, then try again.",
                            name_files(&outside)
                        ),
                    ));
                }
                return Ok(blocked(&files));
            }
            Err(CheckoutRefused::Failed(e)) => {
                return Ok(Integration::new(
                    SyncOutcome::BlockedByLocalChanges,
                    checkout_failed(label, &e),
                ))
            }
        }
        let previous = local
            .and_then(|oid| repo.find_commit(oid).ok())
            .and_then(|commit| commit.tree().ok());
        move_branch_or_undo(
            repo,
            (branch, incoming, local, "fast-forward"),
            &incoming_tree,
            previous.as_ref(),
        )?;
        return Ok(Integration::new(
            SyncOutcome::FastForwarded,
            format!("Brought in {} from {label}.", plural(behind, "change")),
        ));
    }

    if !local_changes.is_empty() {
        return Ok(Integration::new(
            SyncOutcome::BlockedByLocalChanges,
            format!(
                "{} has new changes, and you have edits that aren't published yet. Publish your edits first; that combines both.",
                subject(label)
            ),
        ));
    }
    let local_commit = repo
        .find_commit(local.unwrap_or(incoming))
        .map_err(|e| describe("Couldn't read the branch", &e))?;
    let mut merged = repo
        .merge_commits(&local_commit, &incoming_commit, None)
        .map_err(|e| describe("Couldn't combine the changes", &e))?;
    if merged.has_conflicts() {
        let file = merged
            .conflicts()
            .ok()
            .and_then(|mut conflicts| conflicts.next())
            .and_then(|c| c.ok())
            .and_then(|c| c.our.or(c.their).or(c.ancestor))
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .unwrap_or_else(|| "a file".to_string());
        return Ok(Integration {
            outcome: SyncOutcome::Conflict,
            message: format!(
                "Your changes and the changes on {label} both edited {file}, so they can't be combined automatically."
            ),
            conflict_file: Some(file),
        });
    }
    let tree_id = merged
        .write_tree_to(repo)
        .map_err(|e| describe("Couldn't combine the changes", &e))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| describe("Couldn't combine the changes", &e))?;
    let signature = identity()?;
    let merge = repo
        .commit(
            None,
            &signature,
            &signature,
            merge_message,
            &tree,
            &[&local_commit, &incoming_commit],
        )
        .map_err(|e| describe("Couldn't save the combined changes", &e))?;
    if let Err(refused) = checkout_safely(repo, tree.as_object()) {
        let what = match refused {
            CheckoutRefused::Conflicts(files) => name_files(&files),
            CheckoutRefused::Failed(e) => {
                return Ok(Integration::new(
                    SyncOutcome::BlockedByLocalChanges,
                    checkout_failed(label, &e),
                ))
            }
        };
        return Ok(Integration::new(
            SyncOutcome::BlockedByLocalChanges,
            format!("Combining the changes would overwrite {what}, so nothing was changed."),
        ));
    }
    let previous = local_commit.tree().ok();
    move_branch_or_undo(
        repo,
        (branch, merge, local, "merge"),
        &tree,
        previous.as_ref(),
    )?;
    Ok(Integration::new(
        SyncOutcome::Merged,
        format!(
            "Combined your changes with {} from {label}.",
            plural(behind, "change")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;
    use crate::git::SyncOutcome;

    #[test]
    fn sync_up_to_date() {
        let setup = repo_with_remote();
        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::UpToDate);
        assert!(result.status.is_repo);
    }

    #[test]
    fn sync_without_upstream_says_so() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("draft", &main, false).unwrap();
        setup.local.set_head("refs/heads/draft").unwrap();
        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::NoUpstream);
    }

    #[test]
    fn sync_fast_forwards_clean_tree() {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");

        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::FastForwarded);
        assert_eq!(head_id(&setup.local), theirs);
        assert_eq!(read(&setup.local, "news.md"), "news\n");
        assert_eq!(result.status.behind, 0);
        assert!(result.status.files.is_empty());
    }

    #[test]
    fn sync_fast_forwards_keeping_unrelated_local_edits() {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "README.md", "my edit\n");

        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::FastForwarded);
        assert_eq!(head_id(&setup.local), theirs);
        assert_eq!(read(&setup.local, "README.md"), "my edit\n");
        assert_eq!(read(&setup.local, "news.md"), "news\n");
    }

    #[test]
    fn sync_blocked_when_incoming_touches_local_changes() {
        let setup = repo_with_remote();
        let before = head_id(&setup.local);
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        write(&setup.local, "README.md", "mine\n");

        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::BlockedByLocalChanges);
        assert!(result.message.contains("README.md"), "{}", result.message);
        assert!(
            result.message.starts_with("The remote has changes"),
            "starts a sentence: {}",
            result.message
        );
        assert_eq!(head_id(&setup.local), before);
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        assert_eq!(result.status.behind, 1);
    }

    #[test]
    fn sync_merges_diverged_clean() {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "mine.md", "mine\n");
        let mine = commit_all(&setup.local, "My change");

        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::Merged);
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_ids().collect::<Vec<_>>(), vec![mine, theirs]);
        assert_eq!(head.message(), Some("Combine changes from origin"));
        assert_eq!(read(&setup.local, "news.md"), "news\n");
        assert_eq!(read(&setup.local, "mine.md"), "mine\n");
        assert!(result.status.files.is_empty());
        assert_eq!(result.status.ahead, 2);
        assert_eq!(result.status.behind, 0);
    }

    #[test]
    fn sync_conflict_aborts_and_restores() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        write(&setup.local, "README.md", "mine\n");
        let mine = commit_all(&setup.local, "My change");

        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::Conflict);
        assert!(result.message.contains("README.md"), "{}", result.message);
        // The frontend swaps the path for a quoted title, which brings its own stop
        assert!(!result.message.contains("README.md."), "{}", result.message);
        assert_eq!(head_id(&setup.local), mine);
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        assert_eq!(setup.local.state(), git2::RepositoryState::Clean);
        assert!(result.status.files.is_empty());
    }

    #[test]
    fn publish_commits_merges_and_pushes() {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "README.md", "updated\n");
        write(&setup.local, "new-post.md", "new\n");

        let result = publish(&setup.local, "Update the readme", None, None).unwrap();
        assert!(result.pushed, "{}", result.message);
        assert_eq!(result.outcome, SyncOutcome::Merged);
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(remote_tip(setup.remote_dir.path(), "main"), Some(head.id()));
        let mine = setup
            .local
            .find_commit(result.commit_id.parse().unwrap())
            .unwrap();
        assert_eq!(mine.message(), Some("Update the readme"));
        assert_eq!(mine.author().name(), Some("Test Writer"));
        assert_eq!(
            head.parent_ids().collect::<Vec<_>>(),
            vec![mine.id(), theirs]
        );
        assert!(result.status.files.is_empty());
        assert_eq!(result.status.ahead, 0);
        assert_eq!(result.status.behind, 0);
    }

    #[test]
    fn publish_stages_deletions() {
        let setup = repo_with_remote();
        remove(&setup.local, "README.md");
        let result = publish(&setup.local, "Remove the readme", None, None).unwrap();
        assert!(result.pushed);
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert!(head.tree().unwrap().get_name("README.md").is_none());
    }

    #[test]
    fn publish_keeps_commit_when_push_fails() {
        let setup = repo_with_remote();
        setup
            .local
            .remote_set_url("origin", "http://127.0.0.1:9/nowhere.git")
            .unwrap();
        write(&setup.local, "README.md", "offline edit\n");

        let result = publish(&setup.local, "Offline edit", None, None).unwrap();
        assert!(!result.pushed);
        assert!(
            result.message.contains("Couldn't reach"),
            "{}",
            result.message
        );
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id().to_string(), result.commit_id);
        assert_eq!(head.message(), Some("Offline edit"));
        assert!(result.status.files.is_empty());
        assert_eq!(result.status.ahead, 1);
    }

    #[test]
    fn publish_pushes_earlier_unpublished_commits() {
        let setup = repo_with_remote();
        write(&setup.local, "README.md", "committed earlier\n");
        let earlier = commit_all(&setup.local, "Earlier");

        let result = publish(&setup.local, "Nothing new", None, None).unwrap();
        assert!(result.pushed, "{}", result.message);
        assert_eq!(result.commit_id, earlier.to_string());
        assert_eq!(remote_tip(setup.remote_dir.path(), "main"), Some(earlier));
    }

    #[test]
    fn publish_conflict_keeps_commit_and_pushes_nothing() {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        write(&setup.local, "README.md", "mine\n");

        let result = publish(&setup.local, "My edit", None, None).unwrap();
        assert!(!result.pushed);
        assert_eq!(result.outcome, SyncOutcome::Conflict);
        assert!(result.message.contains("README.md"), "{}", result.message);
        assert!(!result.message.contains("README.md."), "{}", result.message);
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message(), Some("My edit"));
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
        assert_eq!(remote_tip(setup.remote_dir.path(), "main"), Some(theirs));
        assert_eq!(setup.local.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn publish_sets_upstream_when_missing() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        write(&setup.local, "draft.md", "draft\n");

        let result = publish(&setup.local, "Draft", None, None).unwrap();
        assert!(result.pushed, "{}", result.message);
        assert_eq!(result.status.branch.as_deref(), Some("staging"));
        assert_eq!(result.status.upstream.as_deref(), Some("origin/staging"));
        assert_eq!(
            remote_tip(setup.remote_dir.path(), "staging"),
            Some(head_id(&setup.local))
        );
    }

    #[test]
    fn publish_needs_a_message() {
        let setup = repo_with_remote();
        write(&setup.local, "README.md", "edit\n");
        assert!(publish(&setup.local, "  ", None, None).is_err());
    }

    #[test]
    fn merge_default_branch_into_staging() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        write(&setup.local, "draft.md", "draft\n");
        let draft = commit_all(&setup.local, "Draft");
        push(&setup.local, "staging");
        set_upstream(&setup.local, "staging");
        // A pull request was merged into main on GitHub
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "merged.md", "merged\n");

        let result = merge_default_branch(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::Merged, "{}", result.message);
        assert_eq!(result.status.branch.as_deref(), Some("staging"));
        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_ids().collect::<Vec<_>>(), vec![draft, theirs]);
        assert_eq!(head.message(), Some("Bring in changes from main"));
        assert_eq!(read(&setup.local, "merged.md"), "merged\n");
        assert_eq!(read(&setup.local, "draft.md"), "draft\n");
    }

    #[test]
    fn merge_default_branch_fast_forwards_a_branch_with_nothing_new() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "merged.md", "merged\n");

        let result = merge_default_branch(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::FastForwarded);
        assert_eq!(head_id(&setup.local), theirs);
        assert_eq!(result.status.branch.as_deref(), Some("staging"));
    }

    #[test]
    fn commit_identity_falls_back_to_the_github_profile() {
        let user = GitHubUser {
            id: 42,
            login: "kevin".to_string(),
            name: Some("Kevin Robinson".to_string()),
            avatar_url: None,
        };
        let sig = identity_from(None, None, Some(&user)).unwrap();
        assert_eq!(sig.name(), Some("Kevin Robinson"));
        assert_eq!(sig.email(), Some("42+kevin@users.noreply.github.com"));

        let sig = identity_from(
            Some("Ada".into()),
            Some("ada@example.com".into()),
            Some(&user),
        )
        .unwrap();
        assert_eq!(sig.email(), Some("ada@example.com"));

        assert!(identity_from(None, None, None).is_err());
    }

    fn kevin() -> GitHubUser {
        GitHubUser {
            id: 42,
            login: "kevin".to_string(),
            name: Some("Kevin Robinson".to_string()),
            avatar_url: None,
        }
    }

    fn config_file() -> (tempfile::TempDir, git2::Config) {
        let dir = tempfile::TempDir::new().unwrap();
        let config = git2::Config::open(&dir.path().join("config")).unwrap();
        (dir, config)
    }

    #[test]
    fn identity_is_written_when_git_has_none() {
        let (_dir, mut config) = config_file();
        assert!(write_identity(&mut config, (None, None), &kevin()).unwrap());
        let snapshot = config.snapshot().unwrap();
        assert_eq!(snapshot.get_str("user.name").unwrap(), "Kevin Robinson");
        assert_eq!(
            snapshot.get_str("user.email").unwrap(),
            "42+kevin@users.noreply.github.com"
        );
    }

    #[test]
    fn identity_fills_only_what_is_missing() {
        let (_dir, mut config) = config_file();
        assert!(write_identity(&mut config, (Some("Ada".into()), None), &kevin()).unwrap());
        let snapshot = config.snapshot().unwrap();
        assert!(snapshot.get_str("user.name").is_err());
        assert_eq!(
            snapshot.get_str("user.email").unwrap(),
            "42+kevin@users.noreply.github.com"
        );

        let (_dir, mut config) = config_file();
        let both = (Some("Ada".into()), Some("ada@example.com".into()));
        assert!(!write_identity(&mut config, both, &kevin()).unwrap());
        assert!(config.snapshot().unwrap().get_str("user.email").is_err());
    }

    #[test]
    fn identity_without_a_profile_name_uses_the_login() {
        let (_dir, mut config) = config_file();
        let user = GitHubUser {
            name: None,
            ..kevin()
        };
        write_identity(&mut config, (None, None), &user).unwrap();
        assert_eq!(
            config.snapshot().unwrap().get_str("user.name").unwrap(),
            "kevin"
        );
    }

    #[test]
    fn identity_is_left_alone_when_git_has_one() {
        let setup = repo_with_remote();
        assert!(!ensure_identity(&setup.local, &kevin()).unwrap());
        let config = setup.local.config().unwrap().snapshot().unwrap();
        assert_eq!(config.get_str("user.name").unwrap(), "Test Writer");
    }

    #[test]
    fn sync_does_not_overwrite_ignored_file() {
        let setup = repo_with_remote();
        exclude_locally(&setup.local, ".env");
        write(&setup.local, ".env", "SECRET=mine\n");
        let before = head_id(&setup.local);
        push_from_elsewhere(setup.remote_dir.path(), "main", ".env", "SECRET=theirs\n");

        let result = sync(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::BlockedByLocalChanges);
        assert!(result.message.contains(".env"), "{}", result.message);
        // Publishing can't help with a file that isn't part of the site
        assert!(
            result.message.contains("isn't part of the site"),
            "{}",
            result.message
        );
        assert!(!result.message.contains("Publish"), "{}", result.message);
        assert_eq!(read(&setup.local, ".env"), "SECRET=mine\n");
        assert_eq!(head_id(&setup.local), before);
    }

    #[test]
    fn merge_default_branch_conflict_does_not_point_at_publish() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        setup
            .local
            .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write(&setup.local, "README.md", "staging\n");
        commit_all(&setup.local, "Staging edit");
        let before = head_id(&setup.local);
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "main\n");

        let result = merge_default_branch(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::Conflict, "{}", result.message);
        assert!(result.message.contains("README.md"), "{}", result.message);
        assert!(result.message.contains("main"), "{}", result.message);
        assert!(!result.message.contains("Publish"), "{}", result.message);
        assert!(!result.message.contains("README.md."), "{}", result.message);
        assert_eq!(head_id(&setup.local), before);
        assert_eq!(read(&setup.local, "README.md"), "staging\n");
    }

    #[test]
    fn merge_default_branch_blocked_names_the_branch_in_lowercase() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "main\n");
        write(&setup.local, "README.md", "mine\n");

        let result = merge_default_branch(&setup.local, None, None).unwrap();
        assert_eq!(result.outcome, SyncOutcome::BlockedByLocalChanges);
        assert!(
            result
                .message
                .starts_with("The main branch has changes to README.md"),
            "{}",
            result.message
        );
        assert_eq!(read(&setup.local, "README.md"), "mine\n");
    }

    #[test]
    fn commits_behind_default_counts_what_bring_in_would_bring() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        assert_eq!(commits_behind_default(&setup.local).unwrap(), 0);

        push_from_elsewhere(setup.remote_dir.path(), "main", "a.md", "a\n");
        push_from_elsewhere(setup.remote_dir.path(), "main", "b.md", "b\n");
        crate::git::test_support::fetch(&setup.local);
        assert_eq!(commits_behind_default(&setup.local).unwrap(), 2);

        // Staging's own commits don't count
        write(&setup.local, "draft.md", "draft\n");
        commit_all(&setup.local, "Draft");
        assert_eq!(commits_behind_default(&setup.local).unwrap(), 2);
    }

    #[test]
    fn commits_behind_default_is_zero_on_the_default_branch() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "a.md", "a\n");
        crate::git::test_support::fetch(&setup.local);
        assert_eq!(commits_behind_default(&setup.local).unwrap(), 0);
    }

    #[test]
    fn commits_ahead_of_default_counts_what_a_pull_request_would_hold() {
        let setup = repo_with_remote();
        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        assert_eq!(commits_ahead_of_default(&setup.local).unwrap(), 0);

        write(&setup.local, "draft.md", "draft\n");
        commit_all(&setup.local, "Draft");
        write(&setup.local, "more.md", "more\n");
        commit_all(&setup.local, "More");
        assert_eq!(commits_ahead_of_default(&setup.local).unwrap(), 2);

        // Main moving on doesn't change what staging has that main doesn't
        push_from_elsewhere(setup.remote_dir.path(), "main", "a.md", "a\n");
        crate::git::test_support::fetch(&setup.local);
        assert_eq!(commits_ahead_of_default(&setup.local).unwrap(), 2);
    }

    #[test]
    fn commits_ahead_of_default_is_zero_once_merged_and_on_the_default_branch() {
        let setup = repo_with_remote();
        write(&setup.local, "mine.md", "mine\n");
        commit_all(&setup.local, "Mine on main");
        assert_eq!(commits_ahead_of_default(&setup.local).unwrap(), 0);

        let main = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("staging", &main, false).unwrap();
        setup.local.set_head("refs/heads/staging").unwrap();
        // origin/main doesn't have "Mine on main" yet
        assert_eq!(commits_ahead_of_default(&setup.local).unwrap(), 1);
        push(&setup.local, "main");
        assert_eq!(commits_ahead_of_default(&setup.local).unwrap(), 0);
    }

    #[test]
    fn merge_messages_name_where_the_changes_came_from() {
        assert_eq!(
            combine_message("GitHub", "origin/main"),
            "Combine changes from GitHub"
        );
        assert_eq!(
            combine_message("the remote", "origin/main"),
            "Combine changes from origin"
        );
        assert_eq!(
            combine_message("the remote", "upstream/main"),
            "Combine changes from upstream"
        );
    }

    #[test]
    fn a_failed_checkout_says_what_went_wrong_without_pointing_at_publish() {
        let e = git2::Error::from_str("failed to stat 'src/x.md'");
        let message = checkout_failed("GitHub", &e);
        assert!(!message.contains("Publish"), "{message}");
        // Some files may have been written before it failed
        assert!(!message.contains("nothing was changed"), "{message}");
        assert!(message.contains("failed to stat 'src/x.md'"), "{message}");
        assert!(message.contains("GitHub"), "{message}");
    }

    fn lock_branch(repo: &Repository) -> std::path::PathBuf {
        let ref_lock = repo.path().join("refs/heads/main.lock");
        std::fs::write(&ref_lock, "").unwrap();
        ref_lock
    }

    #[test]
    fn a_merge_whose_branch_cant_move_puts_the_files_back() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "mine.md", "mine\n");
        let mine = commit_all(&setup.local, "My change");
        let ref_lock = lock_branch(&setup.local);
        assert!(sync(&setup.local, None, None).is_err());
        std::fs::remove_file(ref_lock).unwrap();
        assert_eq!(head_id(&setup.local), mine);
        assert!(!setup.local.workdir().unwrap().join("news.md").exists());
        assert!(repo_status(&setup.local).unwrap().files.is_empty());
    }

    #[test]
    fn a_fast_forward_whose_branch_cant_move_puts_the_files_back() {
        let setup = repo_with_remote();
        let before = head_id(&setup.local);
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        push_from_elsewhere(setup.remote_dir.path(), "main", "README.md", "theirs\n");
        write(&setup.local, "draft.md", "unpublished\n");
        let ref_lock = lock_branch(&setup.local);
        assert!(sync(&setup.local, None, None).is_err());
        std::fs::remove_file(ref_lock).unwrap();
        assert_eq!(head_id(&setup.local), before);
        assert_eq!(read(&setup.local, "README.md"), "hello\n");
        assert!(!setup.local.workdir().unwrap().join("news.md").exists());
        assert_eq!(read(&setup.local, "draft.md"), "unpublished\n");
        let files: Vec<_> = repo_status(&setup.local)
            .unwrap()
            .files
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(files, ["draft.md"]);
    }

    #[test]
    fn move_branch_refuses_when_the_branch_moved() {
        let (_dir, repo) = init_repo();
        write(&repo, "a.md", "1\n");
        let first = commit_all(&repo, "First");
        write(&repo, "a.md", "2\n");
        // Another operation committed while we were working from `first`
        let second = commit_all(&repo, "Second");

        assert!(move_branch(&repo, "main", first, Some(first), "test").is_err());
        assert_eq!(head_id(&repo), second);
        move_branch(&repo, "main", first, Some(second), "test").unwrap();
        assert_eq!(head_id(&repo), first);
    }
}
