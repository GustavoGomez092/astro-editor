//! Fetch and push against `origin`. For github.com over HTTPS the signed-in token is
//! sent as `x-access-token`; other hosts use git's credential helper.

use super::status::{current_branch_name, upstream_and_counts};
use crate::github::http::NO_ACCESS;
use git2::{
    BranchType, Cred, CredentialType, ErrorClass, ErrorCode, FetchOptions, FetchPrune, PushOptions,
    RemoteCallbacks, Repository,
};
use std::cell::RefCell;

const SIGN_IN_NEEDED: &str = "Sign in with GitHub to sync this repository.";

/// Whether a remote URL is github.com over HTTPS, where the token can be used
pub(crate) fn is_github_https(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    host.eq_ignore_ascii_case("github.com") || host.eq_ignore_ascii_case("www.github.com")
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
            return match token {
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

fn origin_url(repo: &Repository) -> Result<String, String> {
    let remote = repo
        .find_remote("origin")
        .map_err(|_| "This repository has no remote called origin.".to_string())?;
    Ok(remote.url().unwrap_or("").to_string())
}

pub(crate) fn has_origin(repo: &Repository) -> bool {
    repo.find_remote("origin").is_ok()
}

/// Fetch `origin` (all branches, pruning deleted ones), and record `origin/HEAD` if
/// the repository doesn't know it yet
pub fn fetch(repo: &Repository, token: Option<&str>) -> Result<(), String> {
    let url = origin_url(repo)?;
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| super::describe("Couldn't read the remote", &e))?;
    let mut options = FetchOptions::new();
    options
        .remote_callbacks(callbacks(repo.config().ok(), token))
        .prune(FetchPrune::On);
    remote
        .fetch::<&str>(&[], Some(&mut options), None)
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
    let Some(branch) = current_branch_name(repo).filter(|_| !repo.head_detached().unwrap_or(false))
    else {
        return Err("You're not on a branch. Switch to a branch before publishing.".to_string());
    };
    let url = origin_url(repo)?;
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| super::describe("Couldn't read the remote", &e))?;

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

    let rejected = rejection.into_inner().or_else(|| match &pushed {
        Err(e) if e.message().contains("fast-forward") || e.message().contains("fastforward") => {
            Some(e.message().to_string())
        }
        _ => None,
    });
    if let Some(reason) = rejected {
        log::warn!("Astro Editor [GIT] Push rejected: {reason}");
        return Err(
            "GitHub has changes that aren't on this computer yet. Sync, then publish again."
                .to_string(),
        );
    }
    pushed.map_err(|e| network_error(&e, &url, token))?;

    // Record what the remote now has, and track it if this is the first push
    let local = repo
        .find_branch(&branch, BranchType::Local)
        .map_err(|e| super::describe("Couldn't read the branch", &e))?;
    if let Some(oid) = local.get().target() {
        repo.reference(&format!("refs/remotes/origin/{branch}"), oid, true, "push")
            .map_err(|e| super::describe("Couldn't record the push", &e))?;
    }
    if upstream_and_counts(repo, &branch)?.0.is_none() {
        let mut local = local;
        local
            .set_upstream(Some(&format!("origin/{branch}")))
            .map_err(|e| super::describe("Couldn't set the branch's upstream", &e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_https_urls_are_recognised() {
        assert!(is_github_https("https://github.com/owner/repo.git"));
        assert!(is_github_https(
            "https://x-access-token@github.com/owner/repo"
        ));
        assert!(is_github_https("https://GitHub.com/owner/repo"));
        assert!(!is_github_https("git@github.com:owner/repo.git"));
        assert!(!is_github_https("https://gitlab.com/owner/repo.git"));
        assert!(!is_github_https(
            "https://github.com.evil.example/owner/repo"
        ));
        assert!(!is_github_https("/tmp/remote"));
    }
}
