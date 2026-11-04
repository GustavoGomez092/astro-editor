//! The HTTP client for GitHub's REST API and OAuth endpoints. Base URLs are
//! injectable so tests can point it at a mock server. Never log a token.

use reqwest::{Method, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use std::time::Duration;

const API_BASE: &str = "https://api.github.com";
const WEB_BASE: &str = "https://github.com";
const USER_AGENT: &str = "Astro-Editor";

pub const NO_ACCESS: &str = "Your GitHub account doesn't have access to this repository";
pub const SIGNED_OUT: &str = "Your GitHub sign-in has expired or was revoked. Sign in again.";
const UNREACHABLE: &str = "Couldn't reach GitHub. Check your internet connection and try again.";

/// An API failure: the HTTP status (when there was a response) and a sentence for
/// the writer
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: Option<StatusCode>,
    pub message: String,
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> Self {
        e.message
    }
}

#[derive(Clone)]
pub struct GitHubClient {
    http: reqwest::Client,
    api_base: String,
    web_base: String,
}

impl GitHubClient {
    pub fn new() -> Self {
        Self::with_base_urls(API_BASE, WEB_BASE)
    }

    /// `api_base` serves the REST API (`/user`, `/repos/…`); `web_base` serves the
    /// OAuth device flow (`/login/device/code`, `/login/oauth/access_token`)
    pub fn with_base_urls(api_base: &str, web_base: &str) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            http,
            api_base: api_base.trim_end_matches('/').to_string(),
            web_base: web_base.trim_end_matches('/').to_string(),
        }
    }

    /// A form POST to the OAuth endpoints, which answer in JSON when asked
    pub async fn post_oauth_form<T: DeserializeOwned>(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<T, ApiError> {
        let request = self
            .http
            .post(format!("{}{path}", self.web_base))
            .header("Accept", "application/json")
            .form(form);
        send_json(request).await
    }

    fn api_request(&self, method: Method, token: &str, path_or_url: &str) -> RequestBuilder {
        let url = if path_or_url.starts_with("http") {
            path_or_url.to_string()
        } else {
            format!("{}{path_or_url}", self.api_base)
        };
        self.http
            .request(method, url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
    }

    pub async fn get<T: DeserializeOwned>(&self, token: &str, path: &str) -> Result<T, ApiError> {
        send_json(self.api_request(Method::GET, token, path)).await
    }
}

impl Default for GitHubClient {
    fn default() -> Self {
        Self::new()
    }
}

fn unexpected_response(e: reqwest::Error) -> ApiError {
    log::warn!("Astro Editor [GITHUB] Unexpected response: {e}");
    ApiError {
        status: None,
        message: "GitHub sent a response the app didn't understand.".to_string(),
    }
}

async fn send(request: RequestBuilder) -> Result<reqwest::Response, ApiError> {
    let response = request.send().await.map_err(|e| {
        log::warn!("Astro Editor [GITHUB] Request failed: {e}");
        ApiError {
            status: None,
            message: UNREACHABLE.to_string(),
        }
    })?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let detail = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from));
    log::warn!(
        "Astro Editor [GITHUB] {status}: {}",
        detail.as_deref().unwrap_or("")
    );
    let message = match status {
        StatusCode::UNAUTHORIZED => SIGNED_OUT.to_string(),
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => NO_ACCESS.to_string(),
        _ => match detail {
            Some(detail) => format!("GitHub said: {detail}"),
            None => format!("GitHub returned an error ({status})."),
        },
    };
    Err(ApiError {
        status: Some(status),
        message,
    })
}

async fn send_json<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, ApiError> {
    send(request)
        .await?
        .json::<T>()
        .await
        .map_err(unexpected_response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn errors_become_plain_messages() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/missing")
            .with_status(404)
            .with_body(r#"{"message":"Not Found"}"#)
            .create_async()
            .await;
        server
            .mock("GET", "/revoked")
            .with_status(401)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());

        let e = client
            .get::<serde_json::Value>("t", "/missing")
            .await
            .unwrap_err();
        assert_eq!(e.status, Some(StatusCode::NOT_FOUND));
        assert_eq!(e.message, NO_ACCESS);

        let e = client
            .get::<serde_json::Value>("t", "/revoked")
            .await
            .unwrap_err();
        assert_eq!(e.message, SIGNED_OUT);
    }

    #[tokio::test]
    async fn unreachable_server_is_a_readable_error() {
        // Nothing listens on port 9 (discard) locally
        let client = GitHubClient::with_base_urls("http://127.0.0.1:9", "http://127.0.0.1:9");
        let e = client
            .get::<serde_json::Value>("t", "/user")
            .await
            .unwrap_err();
        assert_eq!(e.status, None);
        assert!(e.message.starts_with("Couldn't reach GitHub"));
    }
}
