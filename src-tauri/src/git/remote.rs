//! Fetch and push against `origin`. For github.com over HTTPS the signed-in token is
//! sent as `x-access-token`; other hosts use git's credential helper. A github.com
//! SSH origin is reached over HTTPS instead (git2 is built without SSH).

use super::status::current_branch_name;
use crate::github::http::NO_ACCESS;
use crate::github::repos::parse_github_remote;
use git2::{
    BranchType, Cred, CredentialType, ErrorClass, ErrorCode, FetchOptions, FetchPrune, PushOptions,
    RemoteCallbacks, Repository,
};
use std::cell::RefCell;

const SIGN_IN_NEEDED: &str = "Sign in with GitHub to sync this repository.";

/// Whether a remote URL is github.com over HTTPS, where the token can be used.
/// The check is for this function's callers and the URL libgit2 hands the
/// credentials callback alike.
pub(crate) fn is_github_https(url: &str) -> bool {
    let url = url.trim();
    // libgit2 reads the host after the last `@` (percent-decoding the user part)
    // while URL parsers read `\` as `/`, so `https://github.com\@evil.example/`
    // and `https://github.com%2F@evil.example/` look like github.com to one and
    // connect to evil.example in the other. GitHub owner and repository names
    // can't contain either character, so any URL with one is refused outright.
    if url.contains(['@', '\\']) {
        return false;
    }
    // HTTPS only: over plain HTTP the token would go out in the clear
    url::Url::parse(url)
        .is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some("github.com"))
}

/// The token to offer for `url`: only to github.com over HTTPS
fn github_token<'a>(url: &str, token: Option<&'a str>) -> Option<&'a str> {
    token.filter(|_| is_github_https(url))
}

/// Credentials for `origin`: the GitHub token for github.com, else git's credential
/// helper or the default (Kerberos/NTLM) credential. Each is offered once, so a
/// rejected credential fails instead of looping.
pub(crate) fn callbacks<'a>(
    config: Option<git2::Config>,
    token: Option<&'a str>,
) -> RemoteCallbacks<'a> {
    let mut attempts = 0;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, username, allowed| {
        attempts += 1;
        if is_github_https(url) {
            return match github_token(url, token) {
                Some(token) if attempts == 1 => Cred::userpass_plaintext("x-access-token", token),
                _ => Err(git2::Error::new(
                    ErrorCode::Auth,
                    ErrorClass::Http,
                    "GitHub didn't accept the credentials",
                )),
            };
        }
        if attempts == 1 && allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(config) = &config {
                if let Ok(cred) = Cred::credential_helper(config, url, username) {
                    return Ok(cred);
                }
            }
        }
        if attempts <= 2 && allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::new(
            ErrorCode::Auth,
            ErrorClass::Http,
            "the remote didn't accept the credentials",
        ))
    });
    callbacks
}

/// A plain-language message for a failed network operation
pub(crate) fn network_error(e: &git2::Error, url: &str, token: Option<&str>) -> String {
    let github = is_github_https(url);
    let place = if github { "GitHub" } else { "the remote" };
    log::warn!(
        "Astro Editor [GIT] Network operation failed: {}",
        e.message()
    );
    let message = e.message();
    if e.code() == ErrorCode::Auth || message.contains("401") {
        return if github && token.is_none() {
            SIGN_IN_NEEDED.to_string()
        } else if github {
            NO_ACCESS.to_string()
        } else {
            "The remote didn't accept your credentials.".to_string()
        };
    }
    if github && (message.contains("403") || message.contains("404")) {
        return if token.is_none() {
            SIGN_IN_NEEDED.to_string()
        } else {
            NO_ACCESS.to_string()
        };
    }
    match e.class() {
        ErrorClass::Net | ErrorClass::Http | ErrorClass::Ssl | ErrorClass::Os => {
            format!("Couldn't reach {place}. Check your internet connection and try again.")
        }
        _ => format!("Couldn't connect to {place}: {message}"),
    }
}

const SSH_UNSUPPORTED: &str = "This repository's remote uses SSH, which the app can't use. Only HTTPS remotes (and GitHub SSH remotes) are supported. Change the remote to its HTTPS address.";

/// An scp-like (`git@host:path`) or `ssh://` URL
fn is_ssh(url: &str) -> bool {
    if url.starts_with("ssh://") || url.starts_with("git+ssh://") {
        return true;
    }
    if url.contains("://") {
        return false;
    }
    // `host:path` or `user@host:path`, but not a Windows drive (`C:\…`)
    matches!(url.split_once(':'), Some((host, _)) if host.len() > 1 && !host.contains(['/', '\\']))
}

/// The SSH-free address to fetch from and push to instead of `origin`'s URL:
/// a github.com SSH origin is reached over HTTPS with the token (the config isn't
/// changed). `None` means use `origin` as it is. Other SSH hosts are refused.
pub(crate) fn https_override(url: &str) -> Result<Option<String>, String> {
    if !is_ssh(url) {
        return Ok(None);
    }
    match parse_github_remote(url) {
        Some((owner, repo)) => Ok(Some(format!("https://github.com/{owner}/{repo}.git"))),
        None => Err(SSH_UNSUPPORTED.to_string()),
    }
}

/// The message for a push the remote refused, from push_update_reference's status
fn rejection_message(reason: &str, place: &str) -> String {
    let lower = reason.to_ascii_lowercase();
    if lower.contains("non-fast-forward")
        || lower.contains("non-fastforward")
        || lower.contains("fetch first")
    {
        format!("{place} has changes that aren't on this computer yet. Sync, then publish again.")
    } else {
        format!("{place} refused the update: {reason}")
    }
}

fn origin_url(repo: &Repository) -> Result<String, String> {
    let remote = repo
        .find_remote("origin")
        .map_err(|_| "This repository has no remote called origin.".to_string())?;
    Ok(remote.url().unwrap_or("").to_string())
}

pub(crate) fn has_origin(repo: &Repository) -> bool {
    repo.find_remote("origin").is_ok()
}

/// `origin`, or an anonymous remote at `over` (never saved to the config), and the
/// URL to describe errors with
fn remote_for<'r>(
    repo: &'r Repository,
    over: Option<&str>,
) -> Result<(git2::Remote<'r>, String), String> {
    match over {
        Some(url) => {
            let remote = repo
                .remote_anonymous(url)
                .map_err(|e| super::describe("Couldn't read the remote", &e))?;
            Ok((remote, url.to_string()))
        }
        None => {
            let url = origin_url(repo)?;
            let remote = repo
                .find_remote("origin")
                .map_err(|e| super::describe("Couldn't read the remote", &e))?;
            Ok((remote, url))
        }
    }
}

/// Fetch `origin` (all branches, pruning deleted ones), and record `origin/HEAD` if
/// the repository doesn't know it yet
pub fn fetch(repo: &Repository, token: Option<&str>) -> Result<(), String> {
    let over = https_override(&origin_url(repo)?)?;
    fetch_from(repo, over.as_deref(), token)
}

pub(crate) fn fetch_from(
    repo: &Repository,
    over: Option<&str>,
    token: Option<&str>,
) -> Result<(), String> {
    let (mut remote, url) = remote_for(repo, over)?;
    let mut options = FetchOptions::new();
    options
        .remote_callbacks(callbacks(repo.config().ok(), token))
        .prune(FetchPrune::On);
    // An anonymous remote has no configured refspecs, so name them, so that
    // origin/* is updated just as a fetch of origin would
    let refspecs: &[&str] = if over.is_some() {
        &["+refs/heads/*:refs/remotes/origin/*"]
    } else {
        &[]
    };
    remote
        .fetch(refspecs, Some(&mut options), None)
        .map_err(|e| network_error(&e, &url, token))?;

    if repo.find_reference("refs/remotes/origin/HEAD").is_err() {
        if let Ok(default) = remote.default_branch() {
            if let Some(name) = default.as_str().and_then(|r| r.strip_prefix("refs/heads/")) {
                let target = format!("refs/remotes/origin/{name}");
                if repo.find_reference(&target).is_ok() {
                    let _ = repo.reference_symbolic(
                        "refs/remotes/origin/HEAD",
                        &target,
                        false,
                        "fetch: record origin/HEAD",
                    );
                }
            }
        }
    }
    Ok(())
}

/// Push the current branch to `origin`, setting its upstream if it has none
pub fn push_current_branch(repo: &Repository, token: Option<&str>) -> Result<(), String> {
    let over = https_override(&origin_url(repo)?)?;
    push_to(repo, over.as_deref(), token)
}

pub(crate) fn push_to(
    repo: &Repository,
    over: Option<&str>,
    token: Option<&str>,
) -> Result<(), String> {
    let Some(branch) = current_branch_name(repo).filter(|_| !repo.head_detached().unwrap_or(false))
    else {
        return Err("You're not on a branch. Switch to a branch before publishing.".to_string());
    };
    let (mut remote, url) = remote_for(repo, over)?;
    let place = if is_github_https(&url) {
        "GitHub"
    } else {
        "The remote"
    };

    let rejection = RefCell::new(None::<String>);
    let mut push_callbacks = callbacks(repo.config().ok(), token);
    push_callbacks.push_update_reference(|_refname, status| {
        if let Some(status) = status {
            *rejection.borrow_mut() = Some(status.to_string());
        }
        Ok(())
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(push_callbacks);
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let pushed = remote.push(&[refspec.as_str()], Some(&mut options));
    drop(options);

    // A remote's refusal comes through push_update_reference; libgit2's own local
    // transport reports a non-fast-forward as an error instead
    let rejected = rejection.into_inner().or_else(|| match &pushed {
        Err(e) if e.code() == ErrorCode::NotFastForward => Some("non-fast-forward".to_string()),
        _ => None,
    });
    if let Some(reason) = rejected {
        log::warn!("Astro Editor [GIT] Push rejected: {reason}");
        return Err(rejection_message(&reason, place));
    }
    pushed.map_err(|e| network_error(&e, &url, token))?;

    // Record what the remote now has, and track it if this is the first push
    let mut local = repo
        .find_branch(&branch, BranchType::Local)
        .map_err(|e| super::describe("Couldn't read the branch", &e))?;
    if let Some(oid) = local.get().target() {
        repo.reference(&format!("refs/remotes/origin/{branch}"), oid, true, "push")
            .map_err(|e| super::describe("Couldn't record the push", &e))?;
    }
    if local.upstream().is_err() {
        local
            .set_upstream(Some(&format!("origin/{branch}")))
            .map_err(|e| super::describe("Couldn't set the branch's upstream", &e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{
        commit_all, push_from_elsewhere, remote_tip, repo_with_remote, write,
    };

    #[test]
    fn github_https_urls_are_recognised() {
        assert!(is_github_https("https://github.com/owner/repo.git"));
        assert!(is_github_https("https://GitHub.com/owner/repo"));
        assert!(!is_github_https("git@github.com:owner/repo.git"));
        assert!(!is_github_https("https://gitlab.com/owner/repo.git"));
        assert!(!is_github_https(
            "https://github.com.evil.example/owner/repo"
        ));
        assert!(!is_github_https("/tmp/remote"));
        // Plain HTTP would send the token in the clear
        assert!(!is_github_https("http://github.com/owner/repo.git"));
        // The host is exactly github.com, however the URL is dressed up
        assert!(!is_github_https(
            "https://evil.example\\@github.com/owner/repo"
        ));
        assert!(!is_github_https(
            "https://github.com@evil.example/owner/repo"
        ));
        assert!(!is_github_https("https://www.github.com/owner/repo"));
        assert!(!is_github_https("https://api.github.com/owner/repo"));
        assert!(is_github_https("https://github.com:443/owner/repo"));
        assert!(!is_github_https("not a url"));
    }

    #[test]
    fn the_token_never_goes_to_a_host_libgit2_reads_differently() {
        // libgit2 takes the host after the last `@` (and percent-decodes the user
        // part), while URL parsers read `\\` as `/`: both of these connect to
        // evil.example
        for url in [
            "https://github.com\\@evil.example/o/r",
            "https://github.com%2F@evil.example/o/r",
            "https://github.com%2f@evil.example/o/r.git",
            "https://x-access-token@github.com/o/r",
        ] {
            assert!(!is_github_https(url), "{url}");
            assert_eq!(github_token(url, Some("gho_secret")), None, "{url}");
        }
        assert_eq!(
            github_token("https://github.com/o/r.git", Some("gho_secret")),
            Some("gho_secret")
        );
        assert_eq!(github_token("https://github.com/o/r.git", None), None);
    }

    #[test]
    fn github_ssh_origins_are_reached_over_https() {
        assert_eq!(
            https_override("git@github.com:kevin/site.git")
                .unwrap()
                .as_deref(),
            Some("https://github.com/kevin/site.git")
        );
        assert_eq!(
            https_override("ssh://git@github.com/kevin/site")
                .unwrap()
                .as_deref(),
            Some("https://github.com/kevin/site.git")
        );
        assert_eq!(
            https_override("https://github.com/kevin/site.git").unwrap(),
            None
        );
        assert_eq!(https_override("/tmp/remote").unwrap(), None);
        assert_eq!(https_override("file:///tmp/remote").unwrap(), None);
    }

    #[test]
    fn other_ssh_hosts_are_refused_plainly() {
        for url in [
            "git@gitlab.com:kevin/site.git",
            "ssh://git@example.com/site.git",
        ] {
            let e = https_override(url).unwrap_err();
            assert!(e.contains("HTTPS"), "{e}");
        }
        let setup = repo_with_remote();
        setup
            .local
            .remote_set_url("origin", "git@gitlab.com:kevin/site.git")
            .unwrap();
        let e = fetch(&setup.local, None).unwrap_err();
        assert!(e.contains("HTTPS"), "{e}");
        let e = push_current_branch(&setup.local, None).unwrap_err();
        assert!(e.contains("HTTPS"), "{e}");
    }

    #[test]
    fn fetch_and_push_through_an_https_override_keep_origin_config() {
        let setup = repo_with_remote();
        let ssh = "git@github.com:kevin/site.git";
        setup.local.remote_set_url("origin", ssh).unwrap();
        let remote_url = setup.remote_dir.path().to_str().unwrap().to_string();
        let theirs = push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");

        fetch_from(&setup.local, Some(&remote_url), None).unwrap();
        assert_eq!(
            setup
                .local
                .find_reference("refs/remotes/origin/main")
                .unwrap()
                .target(),
            Some(theirs)
        );

        let head = setup.local.head().unwrap().peel_to_commit().unwrap();
        setup.local.branch("draft", &head, false).unwrap();
        setup.local.set_head("refs/heads/draft").unwrap();
        write(&setup.local, "draft.md", "draft\n");
        let draft = commit_all(&setup.local, "Draft");
        push_to(&setup.local, Some(&remote_url), None).unwrap();
        assert_eq!(remote_tip(setup.remote_dir.path(), "draft"), Some(draft));
        let status = crate::git::status::repo_status(&setup.local).unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/draft"));

        let config = setup.local.config().unwrap().snapshot().unwrap();
        assert_eq!(config.get_str("remote.origin.url").unwrap(), ssh);
    }

    #[test]
    fn push_rejections_say_why() {
        for reason in [
            "non-fast-forward",
            "fetch first",
            "cannot push non-fastforwardable reference",
        ] {
            assert_eq!(
                rejection_message(reason, "GitHub"),
                "GitHub has changes that aren't on this computer yet. Sync, then publish again."
            );
        }
        assert_eq!(
            rejection_message("protected branch hook declined", "GitHub"),
            "GitHub refused the update: protected branch hook declined"
        );
    }

    #[test]
    fn a_non_fast_forward_push_is_refused_with_the_sync_message() {
        let setup = repo_with_remote();
        push_from_elsewhere(setup.remote_dir.path(), "main", "news.md", "news\n");
        write(&setup.local, "mine.md", "mine\n");
        commit_all(&setup.local, "Mine");
        let e = push_current_branch(&setup.local, None).unwrap_err();
        assert!(e.contains("Sync, then publish again"), "{e}");
    }
}
