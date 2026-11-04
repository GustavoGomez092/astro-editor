//! The commit graph for the History view, and one commit's details.

use super::diff::commit_diff;
use super::{describe, ChangedFile, CommitDetails, FileChange, GraphCommit, GraphRef, RefKind};
use git2::{Commit, Delta, Oid, Repository, Sort};
use std::collections::HashMap;

/// Up to `limit` commits reachable from any branch, remote branch or tag,
/// topologically ordered (children before parents), newest first
pub fn log_graph(repo: &Repository, limit: u32) -> Result<Vec<GraphCommit>, String> {
    let refs = refs_by_commit(repo);
    let walk_error = |e: git2::Error| describe("Couldn't read the history", &e);
    let mut walk = repo.revwalk().map_err(walk_error)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(walk_error)?;
    let mut pushed = false;
    for oid in refs.keys() {
        pushed |= walk.push(*oid).is_ok();
    }
    if !pushed {
        return Ok(Vec::new());
    }
    let mut commits = Vec::new();
    for oid in walk.take(limit as usize) {
        let oid = oid.map_err(walk_error)?;
        let commit = repo.find_commit(oid).map_err(walk_error)?;
        commits.push(graph_commit(&commit, &refs));
    }
    Ok(commits)
}

pub fn commit_details(repo: &Repository, id: &str) -> Result<CommitDetails, String> {
    let oid = Oid::from_str(id).map_err(|_| format!("\"{id}\" isn't a commit id"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| describe("Couldn't find that commit", &e))?;
    let mut diff = commit_diff(repo, id, None)?;
    diff.find_similar(None)
        .map_err(|e| describe("Couldn't compare that commit", &e))?;

    let mut files: Vec<ChangedFile> = diff
        .deltas()
        .map(|delta| {
            let path_of = |file: git2::DiffFile| {
                file.path_bytes()
                    .map(|p| String::from_utf8_lossy(p).into_owned())
                    .unwrap_or_default()
            };
            let (path, old_path, change) = match delta.status() {
                Delta::Added | Delta::Copied | Delta::Untracked => {
                    (path_of(delta.new_file()), None, FileChange::Added)
                }
                Delta::Deleted => (path_of(delta.old_file()), None, FileChange::Deleted),
                Delta::Renamed => (
                    path_of(delta.new_file()),
                    Some(path_of(delta.old_file())),
                    FileChange::Renamed,
                ),
                Delta::Conflicted => (path_of(delta.new_file()), None, FileChange::Conflicted),
                _ => (path_of(delta.new_file()), None, FileChange::Modified),
            };
            ChangedFile {
                path,
                old_path,
                change,
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let refs = refs_by_commit(repo);
    let author = commit.author();
    let author_email = String::from_utf8_lossy(author.email_bytes()).into_owned();
    Ok(CommitDetails {
        commit: graph_commit(&commit, &refs),
        message: String::from_utf8_lossy(commit.message_bytes())
            .trim_end()
            .to_string(),
        author_email,
        files,
    })
}

fn graph_commit(commit: &Commit, refs: &HashMap<Oid, Vec<GraphRef>>) -> GraphCommit {
    let id = commit.id().to_string();
    let short_id = commit
        .as_object()
        .short_id()
        .ok()
        .and_then(|buf| buf.as_str().map(String::from))
        .unwrap_or_else(|| id[..7].to_string());
    GraphCommit {
        short_id,
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        summary: String::from_utf8_lossy(commit.summary_bytes().unwrap_or_default()).into_owned(),
        author_name: String::from_utf8_lossy(commit.author().name_bytes()).into_owned(),
        time: commit.author().when().seconds(),
        refs: refs.get(&commit.id()).cloned().unwrap_or_default(),
        id,
    }
}

fn kind_order(kind: RefKind) -> u8 {
    match kind {
        RefKind::Head => 0,
        RefKind::LocalBranch => 1,
        RefKind::RemoteBranch => 2,
        RefKind::Tag => 3,
    }
}

/// Every commit a ref points at, with its labels: `HEAD`, local branches, remote
/// branches (not `origin/HEAD`) and tags (annotated ones peeled to their commit)
fn refs_by_commit(repo: &Repository) -> HashMap<Oid, Vec<GraphRef>> {
    let mut map: HashMap<Oid, Vec<GraphRef>> = HashMap::new();
    if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
        map.entry(head.id()).or_default().push(GraphRef {
            name: "HEAD".to_string(),
            kind: RefKind::Head,
        });
    }
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let kind = if reference.is_branch() {
                RefKind::LocalBranch
            } else if reference.is_remote() {
                RefKind::RemoteBranch
            } else if reference.is_tag() {
                RefKind::Tag
            } else {
                continue;
            };
            if reference.symbolic_target().is_some() {
                continue;
            }
            let Some(name) = reference.shorthand().map(String::from) else {
                continue;
            };
            let Ok(commit) = reference.peel_to_commit() else {
                continue;
            };
            map.entry(commit.id())
                .or_default()
                .push(GraphRef { name, kind });
        }
    }
    for refs in map.values_mut() {
        refs.sort_by(|a, b| {
            kind_order(a.kind)
                .cmp(&kind_order(b.kind))
                .then_with(|| a.name.cmp(&b.name))
        });
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;
    use crate::git::{ChangedFile, FileChange, GraphRef, RefKind};

    fn r(name: &str, kind: RefKind) -> GraphRef {
        GraphRef {
            name: name.to_string(),
            kind,
        }
    }

    #[test]
    fn log_graph_topological_with_refs() {
        let setup = repo_with_remote();
        let repo = &setup.local;
        let root = head_id(repo);
        repo.tag_lightweight("v1", &repo.find_object(root, None).unwrap(), false)
            .unwrap();

        // feature: one commit off the root
        let root_commit = repo.find_commit(root).unwrap();
        repo.branch("feature", &root_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(repo, "feature.md", "feature\n");
        let feature = commit_all(repo, "Feature work");

        // main: one commit, then merge feature
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write(repo, "main.md", "main\n");
        let on_main = commit_all(repo, "Main work");
        let merged_tree = {
            let mut index = repo
                .merge_commits(
                    &repo.find_commit(on_main).unwrap(),
                    &repo.find_commit(feature).unwrap(),
                    None,
                )
                .unwrap();
            repo.find_tree(index.write_tree_to(repo).unwrap()).unwrap()
        };
        let merge = repo
            .commit(
                Some("HEAD"),
                &sig(),
                &sig(),
                "Merge feature",
                &merged_tree,
                &[
                    &repo.find_commit(on_main).unwrap(),
                    &repo.find_commit(feature).unwrap(),
                ],
            )
            .unwrap();

        let graph = log_graph(repo, 300).unwrap();
        let ids: Vec<_> = graph.iter().map(|c| c.id.clone()).collect();
        assert_eq!(graph.len(), 4);
        assert_eq!(ids[0], merge.to_string());
        assert_eq!(ids[3], root.to_string());
        let first = &graph[0];
        assert_eq!(
            first.parents,
            vec![on_main.to_string(), feature.to_string()]
        );
        assert_eq!(first.summary, "Merge feature");
        assert_eq!(first.short_id.len(), 7);
        assert_eq!(first.author_name, "Test Writer");
        assert_eq!(
            first.refs,
            vec![r("HEAD", RefKind::Head), r("main", RefKind::LocalBranch)]
        );
        let feature_commit = graph.iter().find(|c| c.id == feature.to_string()).unwrap();
        assert_eq!(
            feature_commit.refs,
            vec![r("feature", RefKind::LocalBranch)]
        );
        let root_entry = &graph[3];
        assert_eq!(
            root_entry.refs,
            vec![
                r("origin/main", RefKind::RemoteBranch),
                r("v1", RefKind::Tag)
            ]
        );
        assert!(root_entry.parents.is_empty());
    }

    #[test]
    fn log_graph_includes_commits_only_on_remote_branches() {
        let setup = repo_with_remote();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        fetch(&setup.local);
        let graph = log_graph(&setup.local, 300).unwrap();
        assert_eq!(graph[0].id, theirs.to_string());
        assert_eq!(graph[0].refs, vec![r("origin/main", RefKind::RemoteBranch)]);
    }

    #[test]
    fn log_graph_limit() {
        let (_dir, repo) = init_repo();
        let mut ids = Vec::new();
        for n in 0..5 {
            write(&repo, "a.md", &format!("{n}\n"));
            ids.push(commit_all(&repo, &format!("Commit {n}")));
        }
        let graph = log_graph(&repo, 3).unwrap();
        assert_eq!(
            graph.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            vec![ids[4].to_string(), ids[3].to_string(), ids[2].to_string()]
        );
    }

    #[test]
    fn log_graph_of_a_repo_without_commits_is_empty() {
        let (_dir, repo) = init_repo();
        assert!(log_graph(&repo, 300).unwrap().is_empty());
    }

    #[test]
    fn commit_details_files() {
        let (_dir, repo) = init_repo();
        write(&repo, "keep.md", "keep\n");
        write(&repo, "gone.md", "gone\n");
        commit_all(&repo, "First");
        write(&repo, "keep.md", "kept and changed\n");
        remove(&repo, "gone.md");
        write(&repo, "new.md", "new\n");
        let id = commit_all(&repo, "Second\n\nWith a longer body.");

        let details = commit_details(&repo, &id.to_string()).unwrap();
        assert_eq!(details.commit.id, id.to_string());
        assert_eq!(details.commit.summary, "Second");
        assert_eq!(details.message, "Second\n\nWith a longer body.");
        assert_eq!(details.author_email, "writer@example.com");
        assert_eq!(
            details.commit.refs,
            vec![r("HEAD", RefKind::Head), r("main", RefKind::LocalBranch)]
        );
        assert_eq!(
            details.files,
            vec![
                ChangedFile {
                    path: "gone.md".to_string(),
                    old_path: None,
                    change: FileChange::Deleted
                },
                ChangedFile {
                    path: "keep.md".to_string(),
                    old_path: None,
                    change: FileChange::Modified
                },
                ChangedFile {
                    path: "new.md".to_string(),
                    old_path: None,
                    change: FileChange::Added
                },
            ]
        );
    }

    #[test]
    fn commit_details_unknown_id_is_an_error() {
        let (_dir, repo) = init_repo();
        write(&repo, "a.md", "a\n");
        commit_all(&repo, "First");
        assert!(commit_details(&repo, "0123456789012345678901234567890123456789").is_err());
        assert!(commit_details(&repo, "not an id").is_err());
    }
}
