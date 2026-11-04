//! GitHub sign-in with the OAuth device flow, and the token in the OS credential
//! store. See `docs/developer/git-and-github.md`.

use super::http::GitHubClient;
use super::{DeviceCode, GitHubAuthStatus};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Where the token is kept. The app uses the Keychain; tests use memory.
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, token: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub type SharedStore = Arc<dyn TokenStore>;

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

/// The profile as it's saved on disk: what commits need, nothing more
#[derive(Serialize, Deserialize)]
struct SavedProfile {
    id: u64,
    login: String,
    name: Option<String>,
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
    store: &SharedStore,
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
    let saved = token.clone();
    on_store(store, move |store| store.set(&saved)).await?;
    fetch_user(client, &token).await
}

pub async fn fetch_user(client: &GitHubClient, token: &str) -> Result<GitHubUser, String> {
    Ok(client.get::<GitHubUser>(token, "/user").await?)
}

/// Sign-in state for the app: the token store, the cached profile, and the device
/// code being polled. Polling stops when the writer signs out or starts again.
pub struct Auth {
    store: SharedStore,
    client: GitHubClient,
    user: Mutex<Option<GitHubUser>>,
    /// Where the profile is kept between launches (it isn't secret)
    profile_file: Option<PathBuf>,
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
    pub fn new(store: SharedStore, client: GitHubClient) -> Self {
        Self {
            store,
            client,
            user: Mutex::new(None),
            profile_file: None,
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
            wake: Notify::new(),
        }
    }

    /// Keeps the profile in `path` too, so commits can still be signed with it
    /// when GitHub can't be reached
    pub fn with_profile_file(mut self, path: PathBuf) -> Self {
        self.profile_file = Some(path);
        self
    }

    fn remember(&self, user: &GitHubUser) {
        *lock(&self.user) = Some(user.clone());
        let Some(path) = &self.profile_file else {
            return;
        };
        let profile = SavedProfile {
            id: user.id,
            login: user.login.clone(),
            name: user.name.clone(),
        };
        let written = serde_json::to_string(&profile)
            .map_err(|e| e.to_string())
            .and_then(|json| {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(path, json).map_err(|e| e.to_string())
            });
        if let Err(e) = written {
            log::warn!("Astro Editor [GITHUB] Couldn't save the GitHub profile: {e}");
        }
    }

    fn forget(&self) {
        *lock(&self.user) = None;
        if let Some(path) = &self.profile_file {
            let _ = std::fs::remove_file(path);
        }
    }

    fn saved_profile(&self) -> Option<GitHubUser> {
        let text = std::fs::read_to_string(self.profile_file.as_ref()?).ok()?;
        let profile: SavedProfile = serde_json::from_str(&text).ok()?;
        Some(GitHubUser {
            id: profile.id,
            login: profile.login,
            name: profile.name,
            avatar_url: None,
        })
    }

    pub fn client(&self) -> &GitHubClient {
        &self.client
    }

    /// The token, for git network operations and API calls. The first read may ask
    /// the Keychain, so call this from a blocking thread.
    pub fn token(&self) -> Option<String> {
        self.store.get().ok().flatten()
    }

    /// The profile fetched by the last successful [`Auth::status`] or sign-in,
    /// else the one saved on disk (when GitHub can't be reached)
    pub fn cached_user(&self) -> Option<GitHubUser> {
        lock(&self.user).clone().or_else(|| self.saved_profile())
    }

    /// Reads the token and, once, the profile. A revoked token signs out; when
    /// GitHub can't be reached the writer stays signed in (without a profile).
    pub async fn status(&self) -> Result<GitHubAuthStatus, String> {
        let Some(token) = on_store(&self.store, |store| store.get()).await? else {
            self.forget();
            return Ok(GitHubAuthStatus::signed_out());
        };
        if let Some(user) = lock(&self.user).as_ref() {
            return Ok(user.into());
        }
        match self.client.get::<GitHubUser>(&token, "/user").await {
            Ok(user) => {
                self.remember(&user);
                Ok(GitHubAuthStatus::from(&user))
            }
            Err(e) if e.status == Some(StatusCode::UNAUTHORIZED) => {
                log::info!("Astro Editor [GITHUB] Saved token was rejected; signing out");
                self.forget();
                on_store(&self.store, |store| store.delete()).await?;
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
            &self.store,
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
        self.remember(&user);
        Ok(GitHubAuthStatus::from(&user))
    }

    /// Stops waiting for the writer to approve a code. A stored token and the
    /// profile are kept, so closing the sign-in sheet never signs anyone out.
    pub fn cancel_sign_in(&self) {
        self.cancel_poll();
        *lock(&self.pending) = None;
    }

    pub async fn sign_out(&self) -> Result<(), String> {
        self.cancel_poll();
        *lock(&self.pending) = None;
        self.forget();
        on_store(&self.store, |store| store.delete()).await
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
/// `<app identifier>.github` and account `token`. Every call may block (and on a
/// build the Keychain doesn't trust yet, show a password prompt), so it's wrapped in
/// a [`CachedStore`] and only called from blocking threads.
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: String) -> Self {
        Self { service }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, "token")
            .map_err(|e| format!("Couldn't open the Keychain: {e}"))
    }
}

impl TokenStore for KeychainStore {
    fn get(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!(
                "Couldn't read the GitHub sign-in from the Keychain: {e}"
            )),
        }
    }

    fn set(&self, token: &str) -> Result<(), String> {
        self.entry()?
            .set_password(token)
            .map_err(|e| format!("Couldn't save the GitHub sign-in to the Keychain: {e}"))
    }

    fn delete(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!(
                "Couldn't remove the GitHub sign-in from the Keychain: {e}"
            )),
        }
    }
}

/// Caches a store's token in memory. The first read holds the lock while it asks
/// the store, so callers racing to read it wait for that one read instead of each
/// asking the Keychain (and each showing a prompt).
pub struct CachedStore<S> {
    inner: S,
    cache: Mutex<Option<Option<String>>>,
}

impl<S: TokenStore> CachedStore<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            cache: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn inner(&self) -> &S {
        &self.inner
    }
}

impl<S: TokenStore> TokenStore for CachedStore<S> {
    fn get(&self) -> Result<Option<String>, String> {
        let mut cache = lock(&self.cache);
        if let Some(cached) = cache.as_ref() {
            return Ok(cached.clone());
        }
        let token = self.inner.get()?;
        *cache = Some(token.clone());
        Ok(token)
    }

    fn set(&self, token: &str) -> Result<(), String> {
        let mut cache = lock(&self.cache);
        self.inner.set(token)?;
        *cache = Some(Some(token.to_string()));
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        let mut cache = lock(&self.cache);
        self.inner.delete()?;
        *cache = Some(None);
        Ok(())
    }
}

/// Run a store call on a blocking thread, off the async runtime
async fn on_store<T, F>(store: &SharedStore, call: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&dyn TokenStore) -> Result<T, String> + Send + 'static,
{
    let store = store.clone();
    tokio::task::spawn_blocking(move || call(store.as_ref()))
        .await
        .map_err(|e| format!("Reading the GitHub sign-in stopped unexpectedly: {e}"))?
}

static AUTH: OnceLock<Auth> = OnceLock::new();

/// Set up sign-in with the Keychain service for this app's identifier, keeping
/// the profile in `data_dir`. Called once from `setup` in `lib.rs`.
pub fn init(identifier: &str, data_dir: Option<PathBuf>) {
    let store = CachedStore::new(KeychainStore::new(format!("{identifier}.github")));
    let mut auth = Auth::new(Arc::new(store), GitHubClient::new());
    if let Some(dir) = data_dir {
        auth = auth.with_profile_file(dir.join(PROFILE_FILE));
    }
    let _ = AUTH.set(auth);
}

/// The signed-in profile's file in the app's data folder
pub const PROFILE_FILE: &str = "github-profile.json";

pub fn auth() -> Result<&'static Auth, String> {
    AUTH.get()
        .ok_or_else(|| "GitHub sign-in isn't ready yet. Try again in a moment.".to_string())
}

/// The signed-in token, for other modules (git network operations, the API). The
/// first read may ask the Keychain, so call this from a blocking thread.
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
        let store: SharedStore = Arc::new(MemoryStore(Mutex::new(None)));
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
        let store: SharedStore = Arc::new(MemoryStore(Mutex::new(None)));

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
        let store: SharedStore = Arc::new(MemoryStore(Mutex::new(None)));
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
        let store: SharedStore = Arc::new(MemoryStore(Mutex::new(None)));
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
        let store: SharedStore = Arc::new(MemoryStore(Mutex::new(None)));
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
            Arc::new(MemoryStore(Mutex::new(token.map(String::from)))),
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
            Arc::new(MemoryStore(Mutex::new(Some("gho_saved".to_string())))),
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
        auth.sign_out().await.unwrap();

        let result = tokio::time::timeout(Duration::from_secs(2), poll)
            .await
            .expect("poll should stop promptly")
            .unwrap();
        assert_eq!(result.unwrap_err(), "Sign-in was cancelled.");
        assert_eq!(auth.store.get().unwrap(), None);
        assert!(!auth.status().await.unwrap().signed_in);
    }

    #[tokio::test]
    async fn cancel_sign_in_stops_the_poll_and_keeps_the_token() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/login/device/code")
            .with_body(r#"{"device_code":"dev-123","user_code":"AAAA-BBBB","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#)
            .create_async()
            .await;
        let auth = Arc::new(auth_with(&server, Some("gho_kept")));
        auth.device_start("client-abc").await.unwrap();

        let polling = auth.clone();
        let poll = tokio::spawn(async move { polling.device_poll().await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        auth.cancel_sign_in();

        let result = tokio::time::timeout(Duration::from_secs(2), poll)
            .await
            .expect("poll should stop promptly")
            .unwrap();
        assert_eq!(result.unwrap_err(), "Sign-in was cancelled.");
        assert_eq!(auth.store.get().unwrap().as_deref(), Some("gho_kept"));
        // Nothing left to poll
        assert!(auth.device_poll().await.is_err());
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

    /// A slow store that counts reads, standing in for the Keychain
    struct SlowStore {
        reads: std::sync::atomic::AtomicUsize,
        delay: Duration,
        token: Option<String>,
    }

    impl TokenStore for SlowStore {
        fn get(&self) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            Ok(self.token.clone())
        }
        fn set(&self, _token: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    fn slow(delay_ms: u64, token: Option<&str>) -> SlowStore {
        SlowStore {
            reads: std::sync::atomic::AtomicUsize::new(0),
            delay: Duration::from_millis(delay_ms),
            token: token.map(String::from),
        }
    }

    #[test]
    fn cached_store_reads_the_keychain_once() {
        let store = Arc::new(CachedStore::new(slow(50, Some("gho_saved"))));
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || store.get().unwrap())
            })
            .collect();
        for reader in readers {
            assert_eq!(reader.join().unwrap().as_deref(), Some("gho_saved"));
        }
        assert_eq!(store.inner().reads.load(Ordering::SeqCst), 1);

        store.set("gho_new").unwrap();
        assert_eq!(store.get().unwrap().as_deref(), Some("gho_new"));
        store.delete().unwrap();
        assert_eq!(store.get().unwrap(), None);
        assert_eq!(store.inner().reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn keychain_access_does_not_block_the_async_runtime() {
        let server = mockito::Server::new_async().await;
        let auth = Auth::new(
            Arc::new(slow(300, None)),
            GitHubClient::with_base_urls(&server.url(), &server.url()),
        );
        let started = Instant::now();
        let (status, ticked_at) = tokio::join!(auth.status(), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            started.elapsed()
        });
        assert!(!status.unwrap().signed_in);
        assert!(
            ticked_at < Duration::from_millis(200),
            "the runtime was blocked for {ticked_at:?}"
        );
    }

    fn profile_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("github-profile.json");
        (dir, file)
    }

    fn offline_auth(token: Option<&str>, profile: &std::path::Path) -> Auth {
        Auth::new(
            Arc::new(MemoryStore(Mutex::new(token.map(String::from)))),
            GitHubClient::with_base_urls("http://127.0.0.1:9", "http://127.0.0.1:9"),
        )
        .with_profile_file(profile.to_path_buf())
    }

    #[tokio::test]
    async fn the_profile_is_kept_on_disk_for_offline_use() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/user")
            .with_body(r#"{"id":42,"login":"kevin","name":"Kevin Robinson","avatar_url":"https://avatars/42"}"#)
            .create_async()
            .await;
        let (_dir, file) = profile_file();
        let auth = auth_with(&server, Some("gho_saved")).with_profile_file(file.clone());
        assert!(auth.status().await.unwrap().signed_in);
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            saved,
            serde_json::json!({"id": 42, "login": "kevin", "name": "Kevin Robinson"})
        );

        // Next launch, offline
        let offline = offline_auth(Some("gho_saved"), &file);
        assert!(offline.status().await.unwrap().signed_in);
        let user = offline.cached_user().unwrap();
        assert_eq!((user.id, user.login.as_str()), (42, "kevin"));
        assert_eq!(user.name.as_deref(), Some("Kevin Robinson"));
    }

    #[tokio::test]
    async fn signing_in_saves_the_profile() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/login/device/code")
            .with_body(r#"{"device_code":"dev-123","user_code":"AAAA-BBBB","verification_uri":"https://github.com/login/device","expires_in":900,"interval":0}"#)
            .create_async()
            .await;
        server
            .mock("POST", "/login/oauth/access_token")
            .with_body(r#"{"access_token":"gho_new"}"#)
            .create_async()
            .await;
        server
            .mock("GET", "/user")
            .with_body(r#"{"id":7,"login":"ada","name":null,"avatar_url":null}"#)
            .create_async()
            .await;
        let (_dir, file) = profile_file();
        let auth = auth_with(&server, None).with_profile_file(file.clone());
        auth.device_start("client-abc").await.unwrap();
        auth.device_poll().await.unwrap();
        let offline = offline_auth(Some("gho_new"), &file);
        assert_eq!(offline.cached_user().unwrap().login, "ada");
    }

    #[tokio::test]
    async fn signing_out_forgets_the_saved_profile() {
        let (_dir, file) = profile_file();
        std::fs::write(&file, r#"{"id":1,"login":"kevin","name":null}"#).unwrap();
        let auth = offline_auth(Some("gho_saved"), &file);
        assert!(auth.cached_user().is_some());
        auth.sign_out().await.unwrap();
        assert!(auth.cached_user().is_none());
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn a_saved_profile_is_ignored_without_a_token() {
        let (_dir, file) = profile_file();
        std::fs::write(&file, r#"{"id":1,"login":"kevin","name":null}"#).unwrap();
        let auth = offline_auth(None, &file);
        assert!(!auth.status().await.unwrap().signed_in);
        assert!(auth.cached_user().is_none());
    }
}
