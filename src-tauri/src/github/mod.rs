//! GitHub for the Git panel: sign-in with the OAuth device flow (token in the OS
//! credential store), repository info, pull requests and the repository list for
//! cloning. The Tauri commands in `commands/github.rs` are thin wrappers.
//! See `docs/developer/git-and-github.md`.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthStatus {
    pub signed_in: bool,
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

impl GitHubAuthStatus {
    pub fn signed_out() -> Self {
        Self {
            signed_in: false,
            login: None,
            name: None,
            avatar_url: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until the code expires
    pub expires_in: u32,
    /// Seconds to wait between polls
    pub interval: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub owner: String,
    pub repo: String,
    pub default_branch: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

/// Summary of a pull request's checks (combined status and check runs)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChecksSummary {
    Pending,
    Success,
    Failure,
    #[serde(rename = "none")]
    NoChecks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub head: String,
    pub base: String,
    pub state: PullRequestState,
    pub draft: bool,
    pub html_url: String,
    pub mergeable: Option<bool>,
    pub checks: ChecksSummary,
}

/// A repository the signed-in user can clone
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub default_branch: String,
    pub clone_url: String,
    /// ISO 8601, as GitHub returns it
    pub updated_at: String,
}

pub mod auth;
pub mod http;
pub mod pulls;
pub mod repos;
