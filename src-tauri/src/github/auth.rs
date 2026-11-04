//! GitHub sign-in with the OAuth device flow, and the token in the OS credential
//! store. See `docs/developer/git-and-github.md`.

use super::http::GitHubClient;
use super::{DeviceCode, GitHubAuthStatus};
use reqwest::StatusCode;
use serde::Deserialize;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Where the token is kept. The app uses the Keychain; tests use memory.
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, token: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The signed-in GitHub user, as `/user` returns it
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GitHubUser {
    pub id: u64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

impl From<&GitHubUser> for GitHubAuthStatus {
    fn from(user: &GitHubUser) -> Self {
        Self {
            signed_in: true,
            login: Some(user.login.clone()),
            name: user.name.clone(),
            avatar_url: user.avatar_url.clone(),
        }
    }
}

/// A device code waiting for the writer to approve it on GitHub
#[derive(Debug, Clone)]
pub struct PendingDevice {
    pub device_code: String,
    pub interval: Duration,
    pub expires_at: Instant,
}

const EXPIRED: &str =
    "The sign-in code expired before it was approved. Start again to get a new code.";
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u32,
    interval: u32,
}

/// The token endpoint's answer: a token, or an `error` while the code is pending.
/// Any refresh token or expiry is ignored; the OAuth App's tokens don't expire.
#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn request_device_code(
    client: &GitHubClient,
    client_id: &str,
) -> Result<(DeviceCode, PendingDevice), String> {
    let response: DeviceCodeResponse = client
        .post_oauth_form(
            "/login/device/code",
            &[("client_id", client_id), ("scope", "repo")],
        )
        .await?;
    let pending = PendingDevice {
        device_code: response.device_code,
        interval: Duration::from_secs(response.interval.into()),
        expires_at: Instant::now() + Duration::from_secs(response.expires_in.into()),
    };
    let code = DeviceCode {
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        expires_in: response.expires_in,
        interval: response.interval,
    };
    Ok((code, pending))
}

/// Poll until the writer approves the code, then store the token and fetch the
/// profile. `sleep` waits between polls; `cancelled` is checked after each wait.
pub async fn poll_for_sign_in<S, F>(
    client: &GitHubClient,
    client_id: &str,
    store: &dyn TokenStore,
    pending: &PendingDevice,
    mut sleep: S,
    cancelled: impl Fn() -> bool,
) -> Result<GitHubUser, String>
where
    S: FnMut(Duration) -> F,
    F: Future<Output = ()>,
{
    let mut interval = pending.interval;
    let token = loop {
        if Instant::now() >= pending.expires_at {
            return Err(EXPIRED.to_string());
        }
        sleep(interval).await;
        if cancelled() {
            return Err("Sign-in was cancelled.".to_string());
        }
        let response: TokenResponse = client
            .post_oauth_form(
                "/login/oauth/access_token",
                &[
                    ("client_id", client_id),
                    ("device_code", &pending.device_code),
                    ("grant_type", GRANT_TYPE),
                ],
            )
            .await?;
        if let Some(token) = response.access_token {
            break token;
        }
        match response.error.as_deref() {
            Some("authorization_pending") => {}
            // GitHub asks for 5 more seconds between polls each time
            Some("slow_down") => interval += Duration::from_secs(5),
            Some("expired_token") => return Err(EXPIRED.to_string()),
            Some("access_denied") => return Err("Sign-in was cancelled on GitHub.".to_string()),
            other => {
                let detail = response
                    .error_description
                    .or_else(|| other.map(String::from))
                    .unwrap_or_else(|| "no token in the response".to_string());
                return Err(format!("GitHub sign-in failed: {detail}"));
            }
        }
    };
    // Signed out or restarted while the last request was in flight
    if cancelled() {
        return Err("Sign-in was cancelled.".to_string());
    }
    store.set(&token)?;
    fetch_user(client, &token).await
}

pub async fn fetch_user(client: &GitHubClient, token: &str) -> Result<GitHubUser, String> {
    Ok(client.get::<GitHubUser>(token, "/user").await?)
}

/// Sign-in state for the app: the token store, the cached profile, and the device
/// code being polled. Polling stops when the writer signs out or starts again.
pub struct Auth {
    store: Box<dyn TokenStore>,
    client: GitHubClient,
    user: Mutex<Option<GitHubUser>>,
    /// The client ID and device code from the last `device_start`
    pending: Mutex<Option<(String, PendingDevice)>>,
    /// Bumped to cancel a running poll
    generation: AtomicU64,
    wake: Notify,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Auth {
    pub fn new(store: Box<dyn TokenStore>, client: GitHubClient) -> Self {
        Self {
            store,
            client,
            user: Mutex::new(None),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
            wake: Notify::new(),
        }
    }

    /// The token, for git network operations and API calls
    #[allow(dead_code)] // used by the git remote and GitHub API modules
    pub fn token(&self) -> Option<String> {
        self.store.get().ok().flatten()
    }

    /// Reads the token and, once, the profile. A revoked token signs out; when
    /// GitHub can't be reached the writer stays signed in (without a profile).
    pub async fn status(&self) -> Result<GitHubAuthStatus, String> {
        let Some(token) = self.store.get()? else {
            *lock(&self.user) = None;
            return Ok(GitHubAuthStatus::signed_out());
        };
        if let Some(user) = lock(&self.user).as_ref() {
            return Ok(user.into());
        }
        match self.client.get::<GitHubUser>(&token, "/user").await {
            Ok(user) => {
                let status = GitHubAuthStatus::from(&user);
                *lock(&self.user) = Some(user);
                Ok(status)
            }
            Err(e) if e.status == Some(StatusCode::UNAUTHORIZED) => {
                log::info!("Astro Editor [GITHUB] Saved token was rejected; signing out");
                self.store.delete()?;
                Ok(GitHubAuthStatus::signed_out())
            }
            Err(_) => Ok(GitHubAuthStatus {
                signed_in: true,
                login: None,
                name: None,
                avatar_url: None,
            }),
        }
    }

    pub async fn device_start(&self, client_id: &str) -> Result<DeviceCode, String> {
        self.cancel_poll();
        let (code, pending) = request_device_code(&self.client, client_id).await?;
        *lock(&self.pending) = Some((client_id.to_string(), pending));
        Ok(code)
    }

    /// Resolves once the writer approves the code on GitHub
    pub async fn device_poll(&self) -> Result<GitHubAuthStatus, String> {
        let Some((client_id, pending)) = lock(&self.pending).clone() else {
            return Err("Start signing in with GitHub first.".to_string());
        };
        let generation = self.generation.load(Ordering::SeqCst);
        let result = poll_for_sign_in(
            &self.client,
            &client_id,
            self.store.as_ref(),
            &pending,
            |interval| async move {
                tokio::select! {
                    () = tokio::time::sleep(interval) => {}
                    () = self.wake.notified() => {}
                }
            },
            || self.generation.load(Ordering::SeqCst) != generation,
        )
        .await;
        if self.generation.load(Ordering::SeqCst) == generation {
            *lock(&self.pending) = None;
        }
        let user = result?;
        log::info!("Astro Editor [GITHUB] Signed in as {}", user.login);
        let status = GitHubAuthStatus::from(&user);
        *lock(&self.user) = Some(user);
        Ok(status)
    }

    pub fn sign_out(&self) -> Result<(), String> {
        self.cancel_poll();
        *lock(&self.pending) = None;
        *lock(&self.user) = None;
        self.store.delete()
    }

    fn cancel_poll(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
}

/// The client ID from preferences (`advanced.githubClientId`), else the one compiled in
pub fn resolve_client_id(global_settings: Option<&str>, compiled: Option<&str>) -> Option<String> {
    let from_prefs = global_settings
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| {
            v.get("advanced")?
                .get("githubClientId")?
                .as_str()
                .map(|s| s.trim().to_string())
        })
        .filter(|id| !id.is_empty());
    from_prefs.or_else(|| {
        compiled
            .map(|s| s.trim().to_string())
            .filter(|id| !id.is_empty())
    })
}

/// The token in the OS credential store (the Keychain on macOS), under the service
/// `<app identifier>.github` and account `token`. Cached after the first read so the
/// Keychain isn't asked on every git operation.
pub struct KeychainStore {
    service: String,
    cache: Mutex<Option<Option<String>>>,
}

impl KeychainStore {
    pub fn new(service: String) -> Self {
        Self {
            service,
            cache: Mutex::new(None),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, "token")
            .map_err(|e| format!("Couldn't open the Keychain: {e}"))
    }
}

impl TokenStore for KeychainStore {
    fn get(&self) -> Result<Option<String>, String> {
        if let Some(cached) = lock(&self.cache).clone() {
            return Ok(cached);
        }
        let token = match self.entry()?.get_password() {
            Ok(token) => Some(token),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                return Err(format!(
                    "Couldn't read the GitHub sign-in from the Keychain: {e}"
                ))
            }
        };
        *lock(&self.cache) = Some(token.clone());
        Ok(token)
    }

    fn set(&self, token: &str) -> Result<(), String> {
        self.entry()?
            .set_password(token)
            .map_err(|e| format!("Couldn't save the GitHub sign-in to the Keychain: {e}"))?;
        *lock(&self.cache) = Some(Some(token.to_string()));
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                return Err(format!(
                    "Couldn't remove the GitHub sign-in from the Keychain: {e}"
                ))
            }
        }
        *lock(&self.cache) = Some(None);
        Ok(())
    }
}

static AUTH: OnceLock<Auth> = OnceLock::new();

/// Set up sign-in with the Keychain service for this app's identifier. Called once
/// from `setup` in `lib.rs`.
pub fn init(identifier: &str) {
    let store = KeychainStore::new(format!("{identifier}.github"));
    let _ = AUTH.set(Auth::new(Box::new(store), GitHubClient::new()));
}

pub fn auth() -> Result<&'static Auth, String> {
    AUTH.get()
        .ok_or_else(|| "GitHub sign-in isn't ready yet. Try again in a moment.".to_string())
}

/// The signed-in token, for other modules (git network operations, the API)
#[allow(dead_code)] // used by the git remote and GitHub API modules
pub fn token() -> Option<String> {
    AUTH.get()?.token()
}

#[cfg(test)]
pub(crate) struct MemoryStore(pub Mutex<Option<String>>);

#[cfg(test)]
impl TokenStore for MemoryStore {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, token: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(token.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;
    use std::sync::Arc;

    const GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

    fn pending(expires_in: Duration) -> PendingDevice {
        PendingDevice {
            device_code: "dev-123".to_string(),
            interval: Duration::from_secs(5),
            expires_at: Instant::now() + expires_in,
        }
    }

    fn token_poll(server: &mut mockito::Server) -> mockito::Mock {
        server
            .mock("POST", "/login/oauth/access_token")
            .match_header("accept", "application/json")
            .match_body(Matcher::AllOf(vec![
                Matcher::UrlEncoded("client_id".into(), "client-abc".into()),
                Matcher::UrlEncoded("device_code".into(), "dev-123".into()),
                Matcher::UrlEncoded("grant_type".into(), GRANT.into()),
            ]))
            .expect(1)
    }

    #[tokio::test]
    async fn device_start_parses_code() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/login/device/code")
            .match_header("user-agent", "Astro-Editor")
            .match_header("accept", "application/json")
            .match_body(Matcher::AllOf(vec![
                Matcher::UrlEncoded("client_id".into(), "client-abc".into()),
                Matcher::UrlEncoded("scope".into(), "repo".into()),
            ]))
            .with_body(
                r#"{"device_code":"dev-123","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
            )
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());

        let (code, pending) = request_device_code(&client, "client-abc").await.unwrap();
        mock.assert_async().await;
        assert_eq!(
            code,
            DeviceCode {
                user_code: "WDJB-MJHT".to_string(),
                verification_uri: "https://github.com/login/device".to_string(),
                expires_in: 900,
                interval: 5,
            }
        );
        assert_eq!(pending.device_code, "dev-123");
        assert_eq!(pending.interval, Duration::from_secs(5));
        assert!(pending.expires_at > Instant::now() + Duration::from_secs(890));
    }

    #[tokio::test]
    async fn device_poll_handles_pending_slowdown_and_success() {
        let mut server = mockito::Server::new_async().await;
        let pending_mock = token_poll(&mut server)
            .with_body(r#"{"error":"authorization_pending"}"#)
            .create_async()
            .await;
        let slow_mock = token_poll(&mut server)
            .with_body(r#"{"error":"slow_down","interval":10}"#)
            .create_async()
            .await;
        // A refresh token and expiry, if GitHub ever sends them, are ignored
        let success_mock = token_poll(&mut server)
            .with_body(r#"{"access_token":"gho_secret","token_type":"bearer","scope":"repo","refresh_token":"r","expires_in":28800}"#)
            .create_async()
            .await;
        let user_mock = server
            .mock("GET", "/user")
            .match_header("authorization", "Bearer gho_secret")
            .match_header("user-agent", "Astro-Editor")
            .with_body(r#"{"id":42,"login":"kevin","name":"Kevin Robinson","avatar_url":"https://avatars/42"}"#)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let store = MemoryStore(Mutex::new(None));
        let sleeps = Arc::new(Mutex::new(Vec::new()));
        let recorded = sleeps.clone();

        let user = poll_for_sign_in(
            &client,
            "client-abc",
            &store,
            &pending(Duration::from_secs(900)),
            move |d| {
                recorded.lock().unwrap().push(d.as_secs());
                async {}
            },
            || false,
        )
        .await
        .unwrap();

        pending_mock.assert_async().await;
        slow_mock.assert_async().await;
        success_mock.assert_async().await;
        user_mock.assert_async().await;
        assert_eq!(*sleeps.lock().unwrap(), vec![5, 5, 10]);
        assert_eq!(store.get().unwrap().as_deref(), Some("gho_secret"));
        assert_eq!(user.login, "kevin");
        assert_eq!(user.id, 42);
        assert_eq!(
            GitHubAuthStatus::from(&user),
            GitHubAuthStatus {
                signed_in: true,
                login: Some("kevin".to_string()),
                name: Some("Kevin Robinson".to_string()),
                avatar_url: Some("https://avatars/42".to_string()),
            }
        );
    }

    #[tokio::test]
    async fn device_poll_expired_is_readable_error() {
        let mut server = mockito::Server::new_async().await;
        token_poll(&mut server)
            .with_body(r#"{"error":"expired_token"}"#)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let store = MemoryStore(Mutex::new(None));

        let e = poll_for_sign_in(
            &client,
            "client-abc",
            &store,
            &pending(Duration::from_secs(900)),
            |_| async {},
            || false,
        )
        .await
        .unwrap_err();
        assert_eq!(
            e,
            "The sign-in code expired before it was approved. Start again to get a new code."
        );
        assert_eq!(store.get().unwrap(), None);
    }

    #[tokio::test]
    async fn device_poll_stops_when_the_code_has_expired_locally() {
        let server = mockito::Server::new_async().await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let store = MemoryStore(Mutex::new(None));
        let e = poll_for_sign_in(
            &client,
            "client-abc",
            &store,
            &pending(Duration::ZERO),
            |_| async {},
            || false,
        )
        .await
        .unwrap_err();
        assert!(e.starts_with("The sign-in code expired"), "{e}");
    }

    #[tokio::test]
    async fn device_poll_denied_is_readable_error() {
        let mut server = mockito::Server::new_async().await;
        token_poll(&mut server)
            .with_body(r#"{"error":"access_denied"}"#)
            .create_async()
            .await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let store = MemoryStore(Mutex::new(None));
        let e = poll_for_sign_in(
            &client,
            "client-abc",
            &store,
            &pending(Duration::from_secs(900)),
            |_| async {},
            || false,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "Sign-in was cancelled on GitHub.");
    }

    #[tokio::test]
    async fn device_poll_can_be_cancelled() {
        let server = mockito::Server::new_async().await;
        let client = GitHubClient::with_base_urls(&server.url(), &server.url());
        let store = MemoryStore(Mutex::new(None));
        let e = poll_for_sign_in(
            &client,
            "client-abc",
            &store,
            &pending(Duration::from_secs(900)),
            |_| async {},
            || true,
        )
        .await
        .unwrap_err();
        assert_eq!(e, "Sign-in was cancelled.");
    }

    fn auth_with(server: &mockito::Server, token: Option<&str>) -> Auth {
        Auth::new(
            Box::new(MemoryStore(Mutex::new(token.map(String::from)))),
            GitHubClient::with_base_urls(&server.url(), &server.url()),
        )
    }

    #[tokio::test]
    async fn auth_status_without_token_is_signed_out() {
        let server = mockito::Server::new_async().await;
        let auth = auth_with(&server, None);
        assert!(!auth.status().await.unwrap().signed_in);
    }

    #[tokio::test]
    async fn auth_status_fetches_the_profile_once() {
        let mut server = mockito::Server::new_async().await;
        let user_mock = server
            .mock("GET", "/user")
            .match_header("authorization", "Bearer gho_saved")
            .with_body(r#"{"id":7,"login":"kevin","name":null,"avatar_url":null}"#)
            .expect(1)
            .create_async()
            .await;
        let auth = auth_with(&server, Some("gho_saved"));
        let first = auth.status().await.unwrap();
        let second = auth.status().await.unwrap();
        user_mock.assert_async().await;
        assert!(first.signed_in);
        assert_eq!(first.login.as_deref(), Some("kevin"));
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn auth_status_revoked_token_signs_out() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/user")
            .with_status(401)
            .create_async()
            .await;
        let auth = auth_with(&server, Some("gho_revoked"));
        assert!(!auth.status().await.unwrap().signed_in);
        assert_eq!(auth.store.get().unwrap(), None);
    }

    #[tokio::test]
    async fn auth_status_offline_keeps_the_sign_in() {
        let auth = Auth::new(
            Box::new(MemoryStore(Mutex::new(Some("gho_saved".to_string())))),
            GitHubClient::with_base_urls("http://127.0.0.1:9", "http://127.0.0.1:9"),
        );
        let status = auth.status().await.unwrap();
        assert!(status.signed_in);
        assert_eq!(status.login, None);
    }

    #[tokio::test]
    async fn sign_out_deletes_the_token_and_cancels_a_running_poll() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/login/device/code")
            .with_body(r#"{"device_code":"dev-123","user_code":"AAAA-BBBB","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#)
            .create_async()
            .await;
        let auth = Arc::new(auth_with(&server, Some("gho_old")));
        auth.device_start("client-abc").await.unwrap();

        let polling = auth.clone();
        let poll = tokio::spawn(async move { polling.device_poll().await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        auth.sign_out().unwrap();

        let result = tokio::time::timeout(Duration::from_secs(2), poll)
            .await
            .expect("poll should stop promptly")
            .unwrap();
        assert_eq!(result.unwrap_err(), "Sign-in was cancelled.");
        assert_eq!(auth.store.get().unwrap(), None);
        assert!(!auth.status().await.unwrap().signed_in);
    }

    #[tokio::test]
    async fn device_poll_without_start_is_an_error() {
        let server = mockito::Server::new_async().await;
        let auth = auth_with(&server, None);
        assert!(auth.device_poll().await.is_err());
    }

    #[test]
    fn client_id_prefers_the_preference() {
        let prefs = r#"{"advanced":{"githubClientId":"from-prefs"}}"#;
        assert_eq!(
            resolve_client_id(Some(prefs), Some("compiled")).as_deref(),
            Some("from-prefs")
        );
        let blank = r#"{"advanced":{"githubClientId":"  "}}"#;
        assert_eq!(
            resolve_client_id(Some(blank), Some("compiled")).as_deref(),
            Some("compiled")
        );
        let null = r#"{"advanced":{"githubClientId":null}}"#;
        assert_eq!(
            resolve_client_id(Some(null), Some("compiled")).as_deref(),
            Some("compiled")
        );
        assert_eq!(
            resolve_client_id(Some("not json"), Some("compiled")).as_deref(),
            Some("compiled")
        );
        assert_eq!(resolve_client_id(None, Some("")), None);
        assert_eq!(resolve_client_id(None, None), None);
    }
}
