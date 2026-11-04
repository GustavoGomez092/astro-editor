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
    let integration = integrate(
        repo,
        &branch,
        &upstream_name,
        upstream,
        &remote_label(repo),
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
        let integration = integrate(repo, &branch, &upstream_name, upstream, &label, &|| {
            commit_identity(repo, user)
        })?;
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
    let (name, target) = [
        (format!("origin/{default}"), BranchType::Remote),
        (default.clone(), BranchType::Local),
    ]
    .into_iter()
    .find_map(|(name, kind)| {
        let oid = repo.find_branch(&name, kind).ok()?.get().target()?;
        Some((name, oid))
    })
    .ok_or_else(|| format!("Couldn't find the {default} branch."))?;

    let integration = integrate(repo, &branch, &name, target, &default, &|| {
        commit_identity(repo, user)
    })?;
    Ok(SyncResult {
        outcome: integration.outcome,
        message: integration.message,
        status: repo_status(repo)?,
    })
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
            &format!("{}+{}@users.noreply.github.com", user.id, user.login),
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

fn current_branch(repo: &Repository) -> Result<String, String> {
    if repo.head_detached().unwrap_or(false) {
        return Err(DETACHED.to_string());
    }
    current_branch_name(repo).ok_or_else(|| DETACHED.to_string())
}

/// "GitHub" for a github.com origin, else "the remote"
fn remote_label(repo: &Repository) -> String {
    let github = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|url| parse_github_remote(url).is_some()))
        .unwrap_or(false);
    if github { "GitHub" } else { "the remote" }.to_string()
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
fn move_branch(
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

/// Bring the commit `incoming` (named `incoming_name`, from `label`) into `branch`,
/// the checked-out branch: fast-forward when only it has new commits and that won't
/// touch locally changed files; merge when both have new commits and there are no
/// local changes; otherwise leave everything as it is and say why.
fn integrate(
    repo: &Repository,
    branch: &str,
    incoming_name: &str,
    incoming: Oid,
    label: &str,
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
                    "{label} has changes to {} that you're also editing here. Publish your edits first; that combines both.",
                    if files.is_empty() { "files".to_string() } else { name_files(files) }
                ),
            )
        };
        if !touched.is_empty() {
            return Ok(blocked(&touched));
        }
        match checkout_safely(repo, incoming_tree.as_object()) {
            Ok(()) => {}
            Err(CheckoutRefused::Conflicts(files)) => return Ok(blocked(&files)),
            Err(CheckoutRefused::Failed(_)) => return Ok(blocked(&[])),
        }
        move_branch(repo, branch, incoming, local, "fast-forward")?;
        return Ok(Integration::new(
            SyncOutcome::FastForwarded,
            format!("Brought in {} from {label}.", plural(behind, "change")),
        ));
    }

    if !local_changes.is_empty() {
        return Ok(Integration::new(
            SyncOutcome::BlockedByLocalChanges,
            format!(
                "{label} has new changes, and you have edits that aren't published yet. Publish your edits first; that combines both."
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
                "Your changes and the changes on {label} both edited {file}. Publish isn't possible until that's sorted out."
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
            &format!("Merge {incoming_name} into {branch}"),
            &tree,
            &[&local_commit, &incoming_commit],
        )
        .map_err(|e| describe("Couldn't save the combined changes", &e))?;
    if let Err(refused) = checkout_safely(repo, tree.as_object()) {
        let what = match refused {
            CheckoutRefused::Conflicts(files) => name_files(&files),
            CheckoutRefused::Failed(_) => "a file on this computer".to_string(),
        };
        return Ok(Integration::new(
            SyncOutcome::BlockedByLocalChanges,
            format!("Combining the changes would overwrite {what}, so nothing was changed."),
        ));
    }
    move_branch(repo, branch, merge, local, "merge")?;
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
        assert_eq!(read(&setup.local, ".env"), "SECRET=mine\n");
        assert_eq!(head_id(&setup.local), before);
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
