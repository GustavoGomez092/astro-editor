//! Clone a repository into a new folder, with progress.

use super::remote::{callbacks, network_error};
use git2::{build::RepoBuilder, FetchOptions};
use std::fs;
use std::path::{Path, PathBuf};

/// The folder name a clone of `url` gets: its last path segment without `.git`
pub fn folder_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches(['/', '\\']);
    // What follows the host: `https://host/<path>`, `git@host:<path>`, or a local path
    let path = if let Some((_, rest)) = trimmed.split_once("://") {
        rest.split_once('/')?.1
    } else {
        match trimmed.split_once(':') {
            // Not a Windows drive letter
            Some((host, rest)) if host.len() > 1 && !host.contains(['/', '\\']) => rest,
            _ => trimmed,
        }
    };
    let last = path.rsplit(['/', '\\']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty() && name != "." && name != "..").then(|| name.to_string())
}

/// Clone `url` into a new folder inside `parent_dir` and return its path.
/// `progress(received, total)` reports objects as they arrive. Refuses a folder
/// that already has something in it; a failed clone leaves no folder behind.
pub fn clone_into(
    url: &str,
    parent_dir: &Path,
    token: Option<&str>,
    mut progress: impl FnMut(u32, u32),
) -> Result<PathBuf, String> {
    if !parent_dir.is_dir() {
        return Err(format!(
            "The folder {} doesn't exist.",
            parent_dir.display()
        ));
    }
    let name = folder_name(url)
        .ok_or_else(|| "That doesn't look like a repository address.".to_string())?;
    let target = parent_dir.join(&name);
    let existed = target.exists();
    if existed {
        let empty = fs::read_dir(&target)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err(format!(
                "There's already a folder called {name} in {} with files in it. Choose another folder.",
                parent_dir.display()
            ));
        }
    }

    let mut remote_callbacks = callbacks(git2::Config::open_default().ok(), token);
    let mut last_reported = None;
    remote_callbacks.transfer_progress(|stats| {
        let received = u32::try_from(stats.received_objects()).unwrap_or(u32::MAX);
        let total = u32::try_from(stats.total_objects()).unwrap_or(u32::MAX);
        // About 100 updates at most, plus the last one
        let step = (total / 100).max(1);
        let report = match last_reported {
            None => true,
            Some(last) => received >= last + step || received == total,
        };
        if report && last_reported != Some(received) {
            last_reported = Some(received);
            progress(received, total);
        }
        true
    });
    let mut options = FetchOptions::new();
    options.remote_callbacks(remote_callbacks);
    let result = RepoBuilder::new()
        .fetch_options(options)
        .clone(url, &target);

    match result {
        Ok(_) => Ok(target),
        Err(e) => {
            // Leave things as they were: remove what the clone created
            if existed {
                if let Ok(entries) = fs::read_dir(&target) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let _ = if path.is_dir() {
                            fs::remove_dir_all(&path)
                        } else {
                            fs::remove_file(&path)
                        };
                    }
                }
            } else if target.exists() {
                let _ = fs::remove_dir_all(&target);
            }
            Err(network_error(&e, url, token))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn folder_name_from_urls() {
        assert_eq!(
            folder_name("https://github.com/kevin/site.git").as_deref(),
            Some("site")
        );
        assert_eq!(
            folder_name("https://github.com/kevin/site/").as_deref(),
            Some("site")
        );
        assert_eq!(
            folder_name("git@github.com:kevin/my-site.git").as_deref(),
            Some("my-site")
        );
        assert_eq!(
            folder_name("/tmp/remotes/blog.git").as_deref(),
            Some("blog")
        );
        assert_eq!(folder_name("https://github.com/").as_deref(), None);
        assert_eq!(folder_name("https://github.com/kevin/..").as_deref(), None);
    }

    #[test]
    fn clone_into_parent_dir_returns_path() {
        let setup = repo_with_remote();
        let parent = TempDir::new().unwrap();
        let url = setup.remote_dir.path().to_str().unwrap();
        let name = folder_name(url).unwrap();
        let mut reports = Vec::new();

        let path = clone_into(url, parent.path(), None, |received, total| {
            reports.push((received, total))
        })
        .unwrap();
        assert_eq!(
            path.canonicalize().unwrap(),
            parent.path().join(&name).canonicalize().unwrap()
        );
        assert_eq!(
            fs::read_to_string(path.join("README.md")).unwrap(),
            "hello\n"
        );
        let cloned = git2::Repository::open(&path).unwrap();
        assert_eq!(
            crate::git::status::current_branch_name(&cloned).as_deref(),
            Some("main")
        );
        if let Some((received, total)) = reports.last() {
            assert_eq!(received, total);
        }

        // Refuses a folder that exists and has something in it
        let e = clone_into(url, parent.path(), None, |_, _| {}).unwrap_err();
        assert!(e.contains(&name), "{e}");
        assert_eq!(
            fs::read_to_string(path.join("README.md")).unwrap(),
            "hello\n"
        );
    }

    #[test]
    fn clone_into_an_existing_empty_folder() {
        let setup = repo_with_remote();
        let parent = TempDir::new().unwrap();
        let url = setup.remote_dir.path().to_str().unwrap();
        fs::create_dir(parent.path().join(folder_name(url).unwrap())).unwrap();
        let path = clone_into(url, parent.path(), None, |_, _| {}).unwrap();
        assert!(path.join("README.md").exists());
    }

    #[test]
    fn failed_clone_leaves_no_folder() {
        let parent = TempDir::new().unwrap();
        let e = clone_into(
            "http://127.0.0.1:9/kevin/site.git",
            parent.path(),
            None,
            |_, _| {},
        )
        .unwrap_err();
        assert!(e.contains("Couldn't reach"), "{e}");
        assert!(!parent.path().join("site").exists());
    }

    #[test]
    fn clone_needs_an_existing_parent_folder() {
        let parent = TempDir::new().unwrap();
        let missing = parent.path().join("missing");
        assert!(clone_into(
            "https://github.com/kevin/site.git",
            &missing,
            None,
            |_, _| {}
        )
        .is_err());
    }
}
