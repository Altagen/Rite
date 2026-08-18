//! rite-server — Axum HTTP/WebSocket server exposing rite-core.
//!
//! The same server runs in two places (ADR 0004): embedded in the desktop
//! client over a Unix socket (local, offline) and standalone over TCP+TLS (a
//! shared team server). Phase 2: server state on rite-core, an HTTP API for the
//! command surface, and a `/ws` WebSocket that streams session events. The
//! embedded frontend and the UDS binding come next.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Extension, Json, Router};
use base64::Engine as _;
use rite_core::auth::{AuthManager, ChangeMasterOutcome, UnlockResult};
use rite_core::connection::{
    AuthMethod, Connection, ConnectionInfo, ConnectionMetadata, CreateConnectionInput, Protocol,
    UpdateConnectionInput,
};
use rite_core::connections_manager::ConnectionsManager;
use rite_core::db::Database;
use rite_core::ssh_config::SshConfigEntry;
use rite_core::terminal::SessionManager;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;

mod assets;
mod probe;
mod tls_pin;
mod vault_conn;
mod ws_events;
use ws_events::{KbdRegistry, WsInteractiveAuth, WsSessionEvents};

/// Shared server state: the rite-core managers plus a broadcast of session
/// events to connected WebSocket clients.
#[derive(Clone)]
pub struct ServerState {
    pub db: Database,
    pub auth: Arc<AuthManager>,
    pub connections: Arc<ConnectionsManager>,
    pub sessions: Arc<SessionManager>,
    pub events_tx: broadcast::Sender<String>,
    /// In-flight keyboard-interactive challenges (2FA/PAM) awaiting a client
    /// answer, keyed by a random challenge id (owner-checked on respond).
    kbd_challenges: KbdRegistry,
    /// When set (local desktop shell), API/WS requests require this bearer token
    /// and a loopback Host — the ADR 0009 local-transport guard. `None` in
    /// dev/container mode.
    pub token: Option<Arc<String>>,
    /// Server mode (ADR 0010): API/WS require a valid session (login-issued
    /// bearer token) instead of the loopback launch token. Mutually exclusive
    /// with `token` in practice (local shell vs shared server).
    pub accounts: bool,
    /// Which served surfaces this deployment exposes (rite-admin-console-split
    /// runtime gating). Both default on; a deployment can serve the client
    /// workspace, the admin console, both, or neither. The API `/api/admin/*`
    /// guard stays the hard boundary — these gate the UI surface only.
    pub serve_admin: bool,
    pub serve_webui: bool,
    /// This server's own TLS leaf-cert SHA-256 fingerprint (hex), shown in the admin
    /// console so operators can publish it for out-of-band pinning (ADR 0012 TOFU).
    /// Set only when rite-server terminates TLS itself; `None` behind a reverse proxy.
    pub host_key: Option<Arc<String>>,
    /// Per-account login rate limiter (brute-force protection, server mode).
    login_limiter: Arc<LoginLimiter>,
    /// Self-service signup rate limiter (anti-abuse on /api/server/register).
    register_limiter: Arc<RegisterLimiter>,
    /// True when rite-server terminates TLS itself (adds HSTS). Behind a reverse
    /// proxy this stays false and the proxy owns HSTS.
    pub tls: bool,
    /// Active context for the native client's multiplexer (ADR 0012): the local
    /// vault, or one remote server. RAM only — resets to Local each launch. The
    /// roster (saved servers) persists in the local vault settings.
    context: Arc<std::sync::Mutex<ActiveContext>>,
    /// The active remote's session token (ADR 0012 §4): held here, **never** sent
    /// to the webview. RAM only.
    remote_token: Arc<std::sync::Mutex<Option<String>>>,
    /// HTTP client for proxying to the active remote (uses the pinned verifier).
    http_client: reqwest::Client,
    /// The active remote's pinned cert fingerprint (SHA-256 hex), if any. Shared
    /// with the rustls verifier behind `http_client`/`tls_config` (ADR 0012 §4).
    cert_pin: Arc<std::sync::Mutex<Option<String>>>,
    /// rustls config carrying the pinned verifier, reused for the WS proxy.
    tls_config: Arc<rustls::ClientConfig>,
    /// The active remote's unwrapped vault key (ADR 0011), held by this trusted
    /// local server across webview reloads; zeroized on lock/logout/idle.
    vault: Arc<std::sync::Mutex<VaultKeyHolder>>,
    /// Terminal session → owning user id (server/accounts mode only). Seals a
    /// session to its creator: only the owner may drive it or receive its events.
    /// Empty in local/desktop mode (single implicit user — no scoping needed).
    session_owners: Arc<std::sync::Mutex<HashMap<String, String>>>,
    /// Per-user last active-probe timestamp (ADR 0017). A short cooldown between
    /// probe *requests* keeps the governed endpoint from being turned into a
    /// scanner; keyed by user id (or `"local"` off accounts mode).
    probe_throttle: Arc<std::sync::Mutex<HashMap<String, std::time::Instant>>>,
}

/// A saved remote server in the roster (ADR 0012). No token here — the remote
/// session lives in RAM only (see the proxy phase).
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServer {
    pub id: String,
    pub url: String,
    pub label: String,
    /// Pinned cert fingerprint (SHA-256 hex) for a self-signed remote (TOFU,
    /// ADR 0012 §4). `None` = validate via webpki roots (a real cert).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_fingerprint: Option<String>,
    /// Optional device-local icon (ADR 0014): an emoji or a `data:` image URI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// The one active context (ADR 0006 single active context).
#[derive(Clone)]
enum ActiveContext {
    Local,
    Remote(RemoteServer),
}

/// The unwrapped per-user vault key (ADR 0011 phase 3), held by the trusted local
/// server so it survives webview reloads. Zeroized on explicit lock, on logout,
/// and after `timeout` of inactivity (server-side enforcement — the whole point
/// of "lock": the key must actually leave RAM, not just the UI).
struct VaultKeyHolder {
    key: Option<zeroize::Zeroizing<[u8; 32]>>,
    last_active: std::time::Instant,
    timeout: Option<std::time::Duration>,
}

impl VaultKeyHolder {
    fn new() -> Self {
        Self {
            key: None,
            last_active: std::time::Instant::now(),
            timeout: None,
        }
    }

    fn unlock(&mut self, key: [u8; 32], timeout: Option<std::time::Duration>) {
        self.key = Some(zeroize::Zeroizing::new(key));
        self.timeout = timeout;
        self.last_active = std::time::Instant::now();
    }

    /// Zeroize the key if idle past the timeout; report whether still unlocked.
    fn check_expiry(&mut self) -> bool {
        if let Some(t) = self.timeout
            && self.key.is_some()
            && self.last_active.elapsed() > t
        {
            self.key = None; // Zeroizing drops → memory zeroized
        }
        self.key.is_some()
    }

    fn lock(&mut self) {
        self.key = None;
    }

    /// Fetch the key for use, refreshing the idle timer. `None` if locked/expired.
    fn get(&mut self) -> Option<[u8; 32]> {
        if !self.check_expiry() {
            return None;
        }
        self.last_active = std::time::Instant::now();
        self.key.as_ref().map(|k| **k)
    }
}

/// In-memory per-username login throttle: after `MAX_FAILURES` failures within
/// `WINDOW`, the account is locked for `LOCKOUT`. Resets on server restart
/// (acceptable — an attacker who can restart the server has bigger leverage).
#[derive(Default)]
struct LoginLimiter {
    inner: std::sync::Mutex<HashMap<String, Attempt>>,
}

struct Attempt {
    failures: u32,
    window_start: std::time::Instant,
    locked_until: Option<std::time::Instant>,
}

impl LoginLimiter {
    const MAX_FAILURES: u32 = 5;
    const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
    const LOCKOUT: std::time::Duration = std::time::Duration::from_secs(60);

    /// Seconds to wait if currently locked, else `None`.
    fn locked_for(&self, username: &str) -> Option<u64> {
        let map = self.inner.lock().unwrap();
        let until = map.get(username)?.locked_until?;
        until
            .checked_duration_since(std::time::Instant::now())
            .map(|d| d.as_secs() + 1)
    }

    fn record_failure(&self, username: &str) {
        let now = std::time::Instant::now();
        let mut map = self.inner.lock().unwrap();
        let a = map.entry(username.to_string()).or_insert(Attempt {
            failures: 0,
            window_start: now,
            locked_until: None,
        });
        if now.duration_since(a.window_start) > Self::WINDOW {
            a.failures = 0;
            a.window_start = now;
            a.locked_until = None;
        }
        a.failures += 1;
        if a.failures >= Self::MAX_FAILURES {
            a.locked_until = Some(now + Self::LOCKOUT);
        }
    }

    fn record_success(&self, username: &str) {
        self.inner.lock().unwrap().remove(username);
    }
}

/// In-memory fixed-window rate limit for self-service signup (`/api/server/register`): at most
/// `MAX` attempts per `WINDOW` per client key. Keyed on the `X-Forwarded-For` client IP behind a
/// reverse proxy, else a single `global` bucket (a directly-exposed server can't trust the peer,
/// and open registration is opt-in + off by default anyway). Caps ALL attempts (incl. failed/dup),
/// so it also blunts account-enumeration probing. Resets on restart, like the login limiter.
#[derive(Default)]
struct RegisterLimiter {
    inner: std::sync::Mutex<HashMap<String, (u32, std::time::Instant)>>,
}

impl RegisterLimiter {
    const MAX: u32 = 10;
    const WINDOW: std::time::Duration = std::time::Duration::from_secs(600);

    /// Records one attempt for `key`. Returns `Some(retry_after_secs)` if the key is already at the
    /// limit for the current window (the caller should 429), else `None`.
    fn check_and_record(&self, key: &str) -> Option<u64> {
        let now = std::time::Instant::now();
        let mut map = self.inner.lock().unwrap();
        let e = map.entry(key.to_string()).or_insert((0, now));
        if now.duration_since(e.1) > Self::WINDOW {
            *e = (0, now);
        }
        if e.0 >= Self::MAX {
            let retry = Self::WINDOW
                .checked_sub(now.duration_since(e.1))
                .map(|d| d.as_secs() + 1)
                .unwrap_or(1);
            return Some(retry);
        }
        e.0 += 1;
        None
    }
}

/// Best-effort client key for rate limiting: the first `X-Forwarded-For` hop (set by a trusted
/// reverse proxy), else a single shared `global` bucket.
fn client_key(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "global".to_string())
}

/// A boolean env flag: returns `default` when unset, else off for `0/false/off/no`
/// (case-insensitive) and on for anything else. Used by the serve-surface flags.
fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => default,
    }
}

impl ServerState {
    /// Open the vault at `db_path` and build the rite-core managers.
    pub async fn new(db_path: &std::path::Path) -> Result<Self> {
        let db = Database::new(db_path).await?;
        let auth = Arc::new(AuthManager::new(db.clone()));
        let connections = Arc::new(ConnectionsManager::new(db.clone(), auth.as_ref().clone()));
        let sessions = Arc::new(SessionManager::new(db.clone(), auth.as_ref().clone()));
        let (events_tx, _) = broadcast::channel(1024);
        let cert_pin = Arc::new(std::sync::Mutex::new(None));
        let tls_config = Arc::new(tls_pin::client_config(tls_pin::PinnedVerifier::new(
            cert_pin.clone(),
        )));
        let http_client = reqwest::Client::builder()
            .use_preconfigured_tls((*tls_config).clone())
            .build()
            .map_err(|e| anyhow::anyhow!("build http client: {e}"))?;
        Ok(Self {
            db,
            auth,
            connections,
            sessions,
            events_tx,
            token: None,
            accounts: false,
            serve_admin: env_flag("RITE_SERVE_ADMIN", true),
            serve_webui: env_flag("RITE_SERVE_WEBUI", true),
            host_key: None,
            login_limiter: Arc::new(LoginLimiter::default()),
            register_limiter: Arc::new(RegisterLimiter::default()),
            tls: false,
            context: Arc::new(std::sync::Mutex::new(ActiveContext::Local)),
            remote_token: Arc::new(std::sync::Mutex::new(None)),
            http_client,
            cert_pin,
            tls_config,
            vault: Arc::new(std::sync::Mutex::new(VaultKeyHolder::new())),
            session_owners: Arc::new(std::sync::Mutex::new(HashMap::new())),
            probe_throttle: Arc::new(std::sync::Mutex::new(HashMap::new())),
            kbd_challenges: Arc::new(std::sync::Mutex::new(HashMap::new())),
        })
    }

    /// Enable the local-transport guard: API/WS then require this bearer token
    /// (loopback Host enforced too). Set by the desktop shell.
    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(Arc::new(token.into()));
        self
    }

    /// Enable server mode (accounts + sessions, ADR 0010).
    pub fn with_accounts(mut self) -> Self {
        self.accounts = true;
        self
    }

    /// Mark that rite-server terminates TLS itself (so it emits HSTS).
    pub fn with_tls(mut self) -> Self {
        self.tls = true;
        self
    }

    /// Record this server's own TLS leaf fingerprint (hex) for the admin console.
    pub fn with_host_key(mut self, fingerprint: String) -> Self {
        self.host_key = Some(Arc::new(fingerprint));
        self
    }

    /// A `SessionEvents` sink that broadcasts session output to WebSocket clients.
    fn events_sink(&self) -> Arc<WsSessionEvents> {
        Arc::new(WsSessionEvents::new(self.events_tx.clone()))
    }

    /// A keyboard-interactive prompt provider bound to the connecting user: it
    /// broadcasts challenges over the WS and awaits the answer they POST back.
    fn interactive_provider(
        &self,
        user: Option<&User>,
    ) -> Option<rite_core::events::SharedInteractive> {
        let owner = user
            .map(|u| u.id.clone())
            .unwrap_or_else(|| "local".to_string());
        Some(Arc::new(WsInteractiveAuth::new(
            self.events_tx.clone(),
            self.kbd_challenges.clone(),
            owner,
        )))
    }

    /// The proxy HTTP client (pinned-TLS), for the vault-connection transform.
    pub(crate) fn http_client(&self) -> &reqwest::Client {
        &self.http_client
    }

    /// The active remote's session token, if any.
    pub(crate) fn remote_token(&self) -> Option<String> {
        self.remote_token.lock().unwrap().clone()
    }

    /// The active remote server, if the context is remote.
    fn remote_context(&self) -> Option<RemoteServer> {
        match &*self.context.lock().unwrap() {
            ActiveContext::Remote(s) => Some(s.clone()),
            ActiveContext::Local => None,
        }
    }

    /// The held vault key if currently unlocked (refreshes the idle timer).
    fn vault_key(&self) -> Option<[u8; 32]> {
        self.vault.lock().unwrap().get()
    }

    /// Record the owner of a freshly-created terminal session (accounts mode only;
    /// `user` is `None` in local/desktop mode, where sessions aren't scoped).
    fn record_session_owner(&self, session_id: &str, user: Option<&User>) {
        if let Some(u) = user {
            self.session_owners
                .lock()
                .unwrap()
                .insert(session_id.to_string(), u.id.clone());
        }
    }

    /// Drop a closed session's ownership record.
    fn forget_session(&self, session_id: &str) {
        self.session_owners.lock().unwrap().remove(session_id);
    }

    /// May `user` drive/receive `session_id`? Local mode (no accounts): always yes
    /// (single implicit user). Accounts mode: only the recorded owner.
    fn owns_session(&self, session_id: &str, user: Option<&User>) -> bool {
        if !self.accounts {
            return true;
        }
        match user {
            Some(u) => self.session_owners.lock().unwrap().get(session_id) == Some(&u.id),
            None => false,
        }
    }
}

/// The authenticated user behind an optional `Extension` (present in accounts mode).
fn as_user(ext: &Option<Extension<Arc<User>>>) -> Option<&User> {
    ext.as_ref().map(|e| e.0.as_ref())
}

/// A 403 response for a session the caller does not own.
fn not_your_session() -> Response {
    (StatusCode::FORBIDDEN, "not your session").into_response()
}

/// Whether a broadcast event should reach a given user's WebSocket (accounts mode
/// scoping). Session-scoped events (those carrying a `sessionId`) go only to the
/// owner; events without a `sessionId` (e.g. host-key prompts) are not yet scoped
/// and still broadcast — see the multi-user follow-up in product-model.md.
fn event_visible_to(
    accounts: bool,
    owners: &std::sync::Mutex<HashMap<String, String>>,
    user_id: Option<&str>,
    event_json: &str,
) -> bool {
    if !accounts {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(event_json) else {
        return true;
    };
    match value
        .get("payload")
        .and_then(|p| p.get("sessionId"))
        .and_then(|s| s.as_str())
    {
        Some(session_id) => owners.lock().unwrap().get(session_id).map(String::as_str) == user_id,
        None => true, // non-session event (host-key, etc.) — follow-up
    }
}

/// Build the HTTP/WebSocket router. The desktop shell and the standalone server
/// share it.
pub fn build_router(state: ServerState) -> Router {
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/capabilities", get(capabilities))
        .route("/api/server/mode", get(server_mode))
        .route("/api/server/prelogin", post(server_prelogin))
        .route("/api/server/login", post(server_login))
        .route("/api/server/logout", post(server_logout))
        .route("/api/server/bootstrap", post(server_bootstrap))
        .route("/api/server/register", post(server_register))
        .route("/api/server/me", get(server_me))
        .route("/api/server/change-password", post(change_password))
        .route(
            "/api/admin/users",
            get(admin_list_users).post(admin_create_user),
        )
        .route("/api/admin/users/{id}", delete(admin_delete_user))
        .route("/api/admin/users/{id}/status", patch(admin_set_status))
        .route("/api/admin/users/{id}/role", patch(admin_set_role))
        .route("/api/admin/users/{id}/reset", post(admin_reset_user))
        .route("/api/admin/instance", patch(set_instance_name))
        .route(
            "/api/admin/session-persistence",
            patch(set_session_persistence),
        )
        .route("/api/admin/default-shell", patch(set_default_shell))
        .route("/api/admin/quick-ssh", patch(set_quick_ssh))
        .route("/api/admin/registration", patch(set_open_registration))
        .route("/api/admin/invitations", patch(set_allow_invitations))
        .route(
            "/api/admin/confirm-role-change",
            patch(set_confirm_role_change),
        )
        .route(
            "/api/admin/enrollment-tokens",
            get(admin_list_tokens).post(admin_create_token),
        )
        .route(
            "/api/admin/enrollment-tokens/{id}",
            delete(admin_revoke_token),
        )
        .route("/api/admin/collection-policy", patch(set_collection_policy))
        .route("/api/admin/healthcheck", patch(set_healthcheck))
        .route("/api/healthcheck/probe", post(healthcheck_probe))
        // Teams / RBAC (product-model.md). Org-admin manages teams (/api/admin/*,
        // guard-gated to admin); team management is per-team authorized in-handler.
        .route(
            "/api/admin/teams",
            get(admin_list_teams).post(admin_create_team),
        )
        .route("/api/admin/teams/{id}", delete(admin_delete_team))
        // Collections governance (admin): list all, force-delete, inspect + remove
        // members. No key needed (names stay encrypted); adding a member needs the
        // collection key, so it stays a member action.
        .route("/api/admin/collections", get(admin_list_collections))
        .route(
            "/api/admin/collections/{id}",
            delete(admin_delete_collection),
        )
        .route(
            "/api/admin/collections/{id}/members",
            get(admin_collection_members).patch(admin_add_collection_member),
        )
        .route(
            "/api/admin/collections/{id}/members/{userId}",
            delete(admin_remove_collection_member),
        )
        // Admin-group escrow (ADR 0016 split-key): the group X25519 keypair (versioned
        // by epoch) whose private key is sealed to each admin, so admins can read
        // collection names + govern rosters without ever holding item keys.
        .route(
            "/api/admin/group-key",
            get(admin_group_key_ep).post(set_admin_group_ep),
        )
        .route(
            "/api/admin/group-grant",
            get(admin_group_grant_ep).post(add_admin_group_grant_ep),
        )
        .route("/api/admin/admins", get(admin_list_admins_ep))
        .route(
            "/api/admin/collections/{id}/escrow",
            patch(admin_set_escrow_ep),
        )
        .route("/api/teams", get(my_teams))
        .route(
            "/api/teams/{id}/members",
            get(team_members).post(add_team_member),
        )
        .route(
            "/api/teams/{id}/members/{userId}",
            delete(remove_team_member),
        )
        // Collections (ADR 0016): the sharing primitive. Members hold the sealed
        // collection key; roles (owner/editor/viewer) gate manage vs write. The
        // server stores only opaque blobs (names + items encrypted).
        .route("/api/directory", get(directory_ep))
        // The Admin-group PUBLIC key (member-readable — it is public): a creator seals
        // a new collection's metaKey to it so admins can later read the name.
        .route("/api/collections/group-key", get(collections_group_key_ep))
        .route(
            "/api/collections",
            get(my_collections).post(create_collection_ep),
        )
        .route(
            "/api/collections/{id}",
            patch(update_collection_ep).delete(delete_collection_ep),
        )
        .route(
            "/api/collections/{id}/members",
            get(collection_members_ep).post(add_collection_member_ep),
        )
        .route(
            "/api/collections/{id}/members/{userId}",
            patch(set_collection_role_ep).delete(remove_collection_member_ep),
        )
        .route(
            "/api/collections/{id}/items",
            get(collection_items_ep).post(create_collection_item_ep),
        )
        .route(
            "/api/collections/{id}/items/{itemId}",
            put(update_collection_item_ep).delete(delete_collection_item_ep),
        )
        // Offer-to-team discovery (ADR 0016): owner offers a collection to a team; members
        // of that team see the plaintext label and can request access.
        .route("/api/collections/offered", get(offered_collections_ep))
        .route(
            "/api/collections/{id}/offer",
            put(set_collection_offer_ep).delete(clear_collection_offer_ep),
        )
        // Access requests: a discovering member requests; an owner/editor grants (re-seal,
        // via the member endpoint) or dismisses. The inbox lists what the caller can grant.
        .route("/api/collections/requests", get(incoming_requests_ep))
        .route(
            "/api/collections/{id}/request",
            post(request_access_ep).delete(resolve_access_request_ep),
        )
        .route("/api/context", get(get_context))
        .route("/api/context/servers", post(add_server))
        .route(
            "/api/context/servers/{id}",
            delete(remove_server).patch(update_server),
        )
        .route("/api/context/servers/{id}/pin", post(pin_server))
        .route("/api/context/servers/{id}/icon", post(set_server_icon))
        .route("/api/context/probe", post(probe_remote))
        .route("/api/context/active", post(set_active_context))
        // Local-only vault-key control plane (ADR 0011): the webview posts the
        // unwrapped user key here after login; the local server holds it.
        .route("/api/context/vault/unlock", post(vault_unlock))
        .route("/api/context/vault/status", get(vault_status))
        .route("/api/context/vault/lock", post(vault_lock))
        .route("/api/auth/first-run", get(first_run))
        .route("/api/auth/locked", get(locked))
        .route("/api/auth/unlock", post(unlock))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/lock", post(lock))
        .route("/api/auth/reset", post(reset))
        .route(
            "/api/auth/change-master-password",
            post(change_master_password_local),
        )
        .route("/api/auth/validate-password", post(validate_password))
        .route("/api/settings", get(settings))
        .route("/api/settings/{key}", get(get_setting).put(set_setting))
        .route(
            "/api/connections",
            get(get_connections).post(create_connection),
        )
        .route(
            "/api/connections/{id}",
            put(update_connection).delete(delete_connection),
        )
        // Per-user zero-knowledge connection store (ADR 0011): opaque ciphertext
        // blobs, scoped to the authenticated user; the server never reads them.
        .route(
            "/api/vault/connections",
            get(vault_list_connections).post(vault_create_connection),
        )
        .route(
            "/api/vault/connections/{id}",
            put(vault_update_connection).delete(vault_delete_connection),
        )
        .route("/api/user/library", get(get_library).put(set_library))
        .route("/api/ssh-config/default-path", get(default_ssh_config_path))
        .route("/api/ssh-config/parse", post(parse_ssh_config))
        .route("/api/ssh-config/import", post(import_ssh_config))
        .route("/api/ssh/host-key/accept", post(accept_host_key))
        .route("/api/ssh/host-key/reject", post(reject_host_key))
        .route("/api/ssh/agent-identities", get(agent_identities))
        .route(
            "/api/ssh/kbd-interactive/respond",
            post(kbd_interactive_respond),
        )
        .route("/api/shells", post(installed_shells))
        .route("/api/terminal", get(list_sessions))
        .route("/api/terminal/ssh", post(connect_ssh))
        .route("/api/terminal/quick-ssh", post(quick_ssh))
        .route("/api/terminal/local", post(create_local))
        .route("/api/terminal/{id}/input", post(send_input))
        .route("/api/terminal/{id}/claim", post(claim))
        .route("/api/terminal/{id}/resize", post(resize))
        .route("/api/terminal/{id}", delete(close))
        .route("/ws", get(ws_handler));

    // RITE_WEB_DIR (dev harness) serves the frontend from disk so it can be
    // rebuilt without recompiling the server; default is the compile-time embed.
    let router = match std::env::var("RITE_WEB_DIR") {
        Ok(dir) if !dir.is_empty() => {
            let base = std::path::PathBuf::from(dir);
            router.fallback(move |uri| assets::dir_handler(base.clone(), uri))
        }
        _ => router.fallback(assets::static_handler),
    };

    router
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state)
}

/// Defence-in-depth response headers on every response. Adds HSTS only when
/// rite-server terminates TLS itself (behind a proxy, the proxy owns HSTS).
async fn security_headers(State(state): State<ServerState>, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    h.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    // Strict CSP — the frontend is fully self-contained (ADR 0012 §5 hardening).
    // Skipped in local desktop mode (`token` set) where the wry shell injects its
    // init script; applied for shared servers and the browser.
    if state.token.is_none() {
        h.insert(
            "Content-Security-Policy",
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
                 style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
                 font-src 'self' data:; connect-src 'self'; object-src 'none'; \
                 base-uri 'self'; frame-ancestors 'none'",
            ),
        );
    }
    if state.tls {
        h.insert(
            "Strict-Transport-Security",
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    res
}

/// Bind `addr`, report the bound port (useful when `addr` uses port 0), then
/// serve forever. The desktop shell uses this to learn the random local port for
/// its webview.
pub async fn serve(state: ServerState, addr: &str, on_bound: impl FnOnce(u16)) -> Result<()> {
    serve_with_shutdown(state, addr, on_bound, std::future::pending::<()>()).await
}

/// Like [`serve`], but stops gracefully once `shutdown` resolves. The desktop shell
/// (ADR 0014 in-place context switch) fires this to tear a window's server down so
/// the dropped [`ServerState`] zeroizes the vault key — i.e. the previous vault locks.
pub async fn serve_with_shutdown(
    state: ServerState,
    addr: &str,
    on_bound: impl FnOnce(u16),
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    on_bound(listener.local_addr()?.port());
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

/// Serve over TLS (rustls) with PEM cert/key files. For the standalone server;
/// the loopback desktop client never needs TLS. Sets HSTS via `with_tls`.
pub async fn serve_tls(
    state: ServerState,
    addr: &str,
    cert: &std::path::Path,
    key: &std::path::Path,
) -> Result<()> {
    let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
    let socket: std::net::SocketAddr = addr.parse()?;
    // Compute our own leaf fingerprint so the admin console can publish it for pinning.
    let mut state = state.with_tls();
    if let Some(fp) = leaf_fingerprint_from_pem(cert) {
        state = state.with_host_key(fp);
    }
    axum_server::bind_rustls(socket, config)
        .serve(build_router(state).into_make_service())
        .await?;
    Ok(())
}

/// The SHA-256 fingerprint (hex) of the first certificate in a PEM file, matching the
/// TOFU pin format (ADR 0012). Returns `None` if the file can't be read or parsed.
fn leaf_fingerprint_from_pem(path: &std::path::Path) -> Option<String> {
    use base64::Engine;
    let pem = std::fs::read_to_string(path).ok()?;
    let begin = "-----BEGIN CERTIFICATE-----";
    let end = "-----END CERTIFICATE-----";
    let start = pem.find(begin)? + begin.len();
    let stop = pem[start..].find(end)? + start;
    let b64: String = pem[start..stop]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(tls_pin::cert_fingerprint(
        &rustls_pki_types::CertificateDer::from(der),
    ))
}

/// ADR 0009 local-transport guard. When a token is configured (local desktop
/// shell), API and WebSocket requests must come from a loopback Host and carry
/// the bearer token (query param `token` for `/ws`, since browsers can't set
/// WebSocket headers). Static assets and dev/container mode (no token) pass
/// through. Defends the loopback port against DNS rebinding and other local
/// processes.
async fn guard(State(state): State<ServerState>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let is_api = path.starts_with("/api") || path == "/ws";

    // Local desktop shell (ADR 0009): loopback Host + launch token.
    if is_api && let Some(token) = state.token.as_deref() {
        if !host_is_loopback(&req) {
            return (StatusCode::FORBIDDEN, "non-loopback host rejected").into_response();
        }
        if extract_token(&req).as_deref() != Some(token) {
            return (StatusCode::UNAUTHORIZED, "missing or invalid token").into_response();
        }
    }

    // Reject cross-site WebSocket upgrades in server mode (ADR 0012 §5 hardening;
    // the bearer token already gates it — this is defence in depth).
    if path == "/ws" && state.accounts && !ws_origin_same(&req) {
        return (StatusCode::FORBIDDEN, "cross-origin websocket rejected").into_response();
    }

    // Shared server (ADR 0010): a valid session is required, except for the
    // public auth endpoints (prelogin/login/bootstrap/logout/mode) and health.
    if is_api && state.accounts && !is_public_server_path(&path) {
        let user = match extract_token(&req) {
            Some(token) => {
                match rite_core::server_auth::validate_session(state.db.pool(), &token).await {
                    Ok(Some(user)) => user,
                    Ok(None) => {
                        return (StatusCode::UNAUTHORIZED, "invalid or expired session")
                            .into_response();
                    }
                    Err(e) => return AppError(e).into_response(),
                }
            }
            None => return (StatusCode::UNAUTHORIZED, "authentication required").into_response(),
        };
        // Admin endpoints require the admin role — except org management (teams, users, enrollment
        // tokens), which a `manager` may also reach. Everything else under /api/admin (instance
        // config, collection oversight/escrow, group keys) stays admin-only.
        if path.starts_with("/api/admin") {
            let org = path.starts_with("/api/admin/teams")
                || path.starts_with("/api/admin/users")
                || path.starts_with("/api/admin/enrollment-tokens");
            let allowed = user.role == Role::Admin || (org && user.role == Role::Manager);
            if !allowed {
                return (StatusCode::FORBIDDEN, "insufficient role").into_response();
            }
        }
        req.extensions_mut().insert(Arc::new(user));
    }

    // Multiplexer (ADR 0012): when a remote context is active, proxy /api/* to it
    // (except the local /api/context/* control plane and /api/health for the
    // harness). `/api/connections` is handled locally instead — the vault-conn
    // transform (ADR 0011) decrypts the remote's ciphertext blobs there. /ws is
    // proxied separately in ws_handler.
    if is_api
        && path != "/ws"
        && path != "/api/health"
        && !path.starts_with("/api/context")
        && !path.starts_with("/api/connections")
    {
        let active = { state.context.lock().unwrap().clone() };
        if let ActiveContext::Remote(server) = active
            && !terminal_stays_local(&state, &path).await
        {
            return proxy_to_remote(&state, &server, req).await;
        }
    }

    next.run(req).await
}

/// In a remote context, decide whether a `/api/terminal/*` request is handled by
/// the LOCAL server (client-execute) rather than proxied (ADR 0011 §4):
/// - `ssh` / `quick-ssh` creates open SSH locally from the client's network;
/// - a control request (`/{id}/…`) is local iff we own that session;
/// - everything else (`local` shell on the remote, session list) is proxied.
async fn terminal_stays_local(state: &ServerState, path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/terminal") else {
        return false;
    };
    match rest {
        "/ssh" | "/quick-ssh" => true,
        "" | "/" | "/local" => false,
        _ => {
            let id = rest.trim_start_matches('/').split('/').next().unwrap_or("");
            !id.is_empty() && state.sessions.has_session(id).await
        }
    }
}

/// Reverse-proxy one request to the active remote (ADR 0012). Injects the stored
/// remote session token; captures it from a login/bootstrap response and rewrites
/// it to a placeholder so the real token never reaches the webview.
async fn proxy_to_remote(state: &ServerState, server: &RemoteServer, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let target = format!("{}{}{}", server.url, path, query);
    let method = req.method().clone();
    let content_type = req.headers().get(header::CONTENT_TYPE).cloned();

    let body = match axum::body::to_bytes(req.into_body(), 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "request body too large").into_response(),
    };

    // login/bootstrap/register all return a fresh session token to capture for the mux.
    let is_login = path == "/api/server/login"
        || path == "/api/server/bootstrap"
        || path == "/api/server/register";

    let mut rb = state
        .http_client
        .request(method, &target)
        .body(body.to_vec());
    if let Some(ct) = content_type {
        rb = rb.header(header::CONTENT_TYPE, ct);
    }
    // Authenticate to the remote with its session token (never for login itself).
    if !is_login && let Some(tok) = state.remote_token.lock().unwrap().clone() {
        rb = rb.header(header::AUTHORIZATION, format!("Bearer {tok}"));
    }

    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("remote unreachable: {e}") })),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let resp_ct = resp.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = resp.bytes().await.unwrap_or_default();

    // Capture the remote token on a successful login/bootstrap; hide the real one.
    let out = if is_login && status.is_success() {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(mut v) => {
                if let Some(tok) = v.get("token").and_then(|t| t.as_str()) {
                    *state.remote_token.lock().unwrap() = Some(tok.to_string());
                }
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("token".into(), json!("proxied"));
                }
                serde_json::to_vec(&v).unwrap_or_else(|_| bytes.to_vec())
            }
            Err(_) => bytes.to_vec(),
        }
    } else {
        bytes.to_vec()
    };

    if path == "/api/server/logout" {
        *state.remote_token.lock().unwrap() = None;
    }

    let mut response = Response::new(axum::body::Body::from(out));
    *response.status_mut() = status;
    if let Some(ct) = resp_ct {
        response.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    response
}

/// Endpoints reachable without a session in server mode.
fn is_public_server_path(path: &str) -> bool {
    matches!(
        path,
        "/api/health"
            | "/api/capabilities"
            | "/api/server/mode"
            | "/api/server/prelogin"
            | "/api/server/login"
            | "/api/server/bootstrap"
            | "/api/server/register"
            | "/api/server/logout"
    )
}

/// Pull the bearer token from the Authorization header, or the `token` query
/// param for `/ws` (browsers can't set WebSocket headers).
fn extract_token(req: &Request) -> Option<String> {
    if req.uri().path() == "/ws" {
        req.uri()
            .query()
            .into_iter()
            .flat_map(|q| q.split('&'))
            .find_map(|kv| kv.strip_prefix("token="))
            .map(|t| t.to_string())
    } else {
        req.headers()
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .map(|t| t.to_string())
    }
}

/// True if a WebSocket upgrade is same-origin (or has no Origin — a non-browser
/// client, gated by the token). Compares the Origin's host[:port] to Host.
fn ws_origin_same(req: &Request) -> bool {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok());
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok());
    match (origin, host) {
        (Some(o), Some(h)) => o.rsplit("://").next() == Some(h),
        (None, _) => true,
        _ => false,
    }
}

/// True if the request's Host header names a loopback address.
fn host_is_loopback(req: &Request) -> bool {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    // strip a trailing :port (IPv4 / hostname); IPv6 literals bind 127.0.0.1 here
    let hostname = host.rsplit_once(':').map_or(host, |(h, _)| h);
    matches!(hostname, "127.0.0.1" | "localhost")
}

// --- read endpoints ---------------------------------------------------------

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "rite-server" }))
}

/// Bump ONLY on a breaking API change. New endpoints are additive and do NOT
/// bump this — clients feature-detect (a missing endpoint 404s). See ADR 0008.
const API_VERSION: u32 = 1;
/// Oldest client semver this server still supports.
const MIN_CLIENT: &str = "0.1.2";

/// Version/capability handshake for loose client/server coupling (ADR 0008).
/// A client compares this against what it needs and prompts to update whichever
/// side is behind, instead of demanding an exact version match.
async fn capabilities() -> Json<Value> {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "minClient": MIN_CLIENT,
    }))
}

async fn first_run(State(state): State<ServerState>) -> Result<Json<bool>, AppError> {
    Ok(Json(state.auth.is_first_run().await?))
}

async fn locked(State(state): State<ServerState>) -> Json<bool> {
    Json(state.auth.is_locked().await)
}

async fn settings(
    State(state): State<ServerState>,
) -> Result<Json<HashMap<String, String>>, AppError> {
    Ok(Json(state.db.get_all_settings().await?))
}

async fn list_sessions(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
) -> Json<Vec<String>> {
    let mut ids = state.sessions.list_sessions().await;
    // In accounts mode, only return the caller's own sessions.
    if state.accounts {
        let user = as_user(&user);
        ids.retain(|id| state.owns_session(id, user));
    }
    Json(ids)
}

// --- auth -------------------------------------------------------------------

#[derive(Deserialize)]
struct PasswordReq {
    password: String,
}

async fn unlock(
    State(state): State<ServerState>,
    Json(req): Json<PasswordReq>,
) -> Result<Json<Value>, AppError> {
    let payload = match state.auth.unlock(&req.password).await? {
        UnlockResult::Success => json!({ "type": "success" }),
        UnlockResult::InvalidPassword => json!({ "type": "invalidPassword" }),
        UnlockResult::RateLimited { wait_seconds } => {
            json!({ "type": "rateLimited", "waitSeconds": wait_seconds })
        }
    };
    Ok(Json(payload))
}

async fn setup(
    State(state): State<ServerState>,
    Json(req): Json<PasswordReq>,
) -> Result<StatusCode, AppError> {
    state.auth.setup_master_password(&req.password).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn lock(State(state): State<ServerState>) -> Result<StatusCode, AppError> {
    state.auth.lock().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reset(State(state): State<ServerState>) -> Result<StatusCode, AppError> {
    state.auth.reset_database().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ChangeMasterReq {
    old: String,
    new: String,
}

/// Change the local-vault master password (ADR 0014). Re-keys all connections atomically; a wrong
/// current password → 401, a too-weak new one → 400.
async fn change_master_password_local(
    State(state): State<ServerState>,
    Json(req): Json<ChangeMasterReq>,
) -> Result<Response, AppError> {
    match state
        .auth
        .change_master_password(&req.old, &req.new)
        .await?
    {
        ChangeMasterOutcome::Success => Ok(StatusCode::NO_CONTENT.into_response()),
        ChangeMasterOutcome::WrongPassword => {
            Ok((StatusCode::UNAUTHORIZED, "current password is incorrect").into_response())
        }
        ChangeMasterOutcome::TooWeak(msg) => Ok((StatusCode::BAD_REQUEST, msg).into_response()),
    }
}

async fn validate_password(Json(req): Json<PasswordReq>) -> Json<Value> {
    let (is_valid, score, feedback) = rite_crypto::validate_password_strength(&req.password);
    Json(json!({ "is_valid": is_valid, "score": score, "feedback": feedback }))
}

// --- server accounts (ADR 0010) ---------------------------------------------

use rite_core::server_auth::{self, KdfParams, PreloginInfo, Role, User};

/// Tell the client whether this is a shared server and if it still needs its
/// first admin (bootstrap).
async fn server_mode(State(state): State<ServerState>) -> Result<Json<Value>, AppError> {
    let needs_bootstrap = state.accounts && !server_auth::has_any_user(state.db.pool()).await?;
    // A global, admin-set instance name (e.g. the company/team) so users can tell
    // which server they're on. Public so the login screen can show it too.
    let instance_name = state.db.get_setting("instance_name").await?;
    // Whether the client may keep the (RAM-derived) vault key in sessionStorage so a
    // page reload doesn't force re-login. Still zero-knowledge (the key never leaves
    // the browser); admins who enforce stricter security can turn it off. Default on.
    let session_persistence =
        state.db.get_setting("session_persistence").await? != Some("0".to_string());
    // Server-governed client capabilities (ADR: mock "Client capabilities"). The shell used
    // for terminals opened on this server (web users don't pick their own); and whether ad-hoc
    // Quick SSH is allowed (off by default — connections should live in collections).
    let default_shell = state
        .db
        .get_setting("default_shell")
        .await?
        .unwrap_or_else(|| "bash".to_string());
    let allow_quick_ssh = state.db.get_setting("allow_quick_ssh").await? == Some("1".to_string());
    // Self-service registration (ADR 0015 phase 1). Off by default — an invite-only instance
    // leaves it off; turning it on lets the sign-in screen offer "Create an account".
    let open_registration =
        state.db.get_setting("open_registration").await? == Some("1".to_string());
    // Master switch for the invitation-token path (mint + redeem). Default ON, and independent of
    // open_registration: tokens are the invite-only path, needed precisely when open reg is off.
    let allow_invitations =
        state.db.get_setting("allow_invitations").await? != Some("0".to_string());
    // A UX safety policy, server-persisted so every client honours it: when on, the client asks
    // to confirm each account role change before applying it. Default off.
    let confirm_role_change =
        state.db.get_setting("confirm_role_change").await? == Some("1".to_string());
    let healthcheck = healthcheck_policy(&state).await?;
    Ok(Json(json!({
        "accounts": state.accounts,
        "needsBootstrap": needs_bootstrap,
        "instanceName": instance_name,
        "sessionPersistence": session_persistence,
        "serveAdmin": state.serve_admin,
        "serveWebui": state.serve_webui,
        "defaultShell": default_shell,
        "allowQuickSsh": allow_quick_ssh,
        "openRegistration": open_registration,
        "allowInvitations": allow_invitations,
        "confirmRoleChange": confirm_role_change,
        "healthcheck": healthcheck,
        "collectionPolicy": collection_policy(&state).await?,
        "hostKey": state.host_key.as_deref(),
    })))
}

/// The machine health-check policy (ADR 0017), stored as one JSON setting with sane defaults:
/// passive "last seen" on; active probing off; TCP-connect the only method; no user restriction;
/// a 60s min interval. The client obeys it (passive is always free; active is governed).
async fn healthcheck_policy(state: &ServerState) -> Result<Value, AppError> {
    let stored = state
        .db
        .get_setting("healthcheck_policy")
        .await?
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    Ok(stored.unwrap_or_else(|| {
        json!({
            "passiveStatus": true,
            "active": "off",              // off | on-demand | full | client-choice
            "methods": ["tcp-connect"],   // subset of tcp-connect | icmp | ssh-handshake
            "restrictUsers": [],          // usernames allowed to actively probe (empty = all)
            "minInterval": 60,
        })
    }))
}

/// Collection governance policy (mock admin → Collections). Stored as one JSON setting with
/// permissive defaults: anyone may create collections, share with anyone in the directory, no
/// member cap, and new members default to viewer. Admins bypass these limits.
async fn collection_policy(state: &ServerState) -> Result<Value, AppError> {
    let stored = state
        .db
        .get_setting("collection_policy")
        .await?
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    Ok(stored.unwrap_or_else(|| {
        json!({
            "allowCreate": true,               // when false, only org-admins provision collections
            "allowSharingOutsideTeams": true,  // when false, members may only add teammates
            "maxMembers": 0,                   // 0 = unlimited
            "defaultRole": "viewer",           // viewer | editor — default when adding a member
        })
    }))
}

#[derive(Deserialize)]
struct InstanceNameReq {
    name: String,
}

/// Set the global instance name (org-admin only; guard-gated by `/api/admin`).
async fn set_instance_name(
    State(state): State<ServerState>,
    Json(req): Json<InstanceNameReq>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_setting("instance_name", req.name.trim())
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct EnabledReq {
    enabled: bool,
}

/// Toggle client vault-key session persistence (org-admin only).
async fn set_session_persistence(
    State(state): State<ServerState>,
    Json(req): Json<EnabledReq>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_setting("session_persistence", if req.enabled { "1" } else { "0" })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ShellReq {
    shell: String,
}

/// Set the server's default shell for terminals (org-admin only). Restricted to a small set
/// of common shells so a bad value can't be injected.
async fn set_default_shell(
    State(state): State<ServerState>,
    Json(req): Json<ShellReq>,
) -> Result<Response, AppError> {
    let shell = req.shell.trim();
    if !["bash", "sh", "zsh", "fish"].contains(&shell) {
        return Ok((StatusCode::BAD_REQUEST, "unsupported shell").into_response());
    }
    state.db.set_setting("default_shell", shell).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Allow or forbid ad-hoc Quick SSH from the toolbar (org-admin only). Off by default —
/// connections on a server should live in collections (saved, shared, auditable).
async fn set_quick_ssh(
    State(state): State<ServerState>,
    Json(req): Json<EnabledReq>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_setting("allow_quick_ssh", if req.enabled { "1" } else { "0" })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Turn self-service registration on/off (org-admin only; guard-gated by `/api/admin`, and
/// NOT `/api/admin/{users,teams}` so a manager can't flip it). Off by default (ADR 0015).
async fn set_open_registration(
    State(state): State<ServerState>,
    Json(req): Json<EnabledReq>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_setting("open_registration", if req.enabled { "1" } else { "0" })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Master switch for the invitation-token path (mint + redeem), org-admin only. Default ON;
/// turning it off closes invitations instance-wide without touching open_registration.
async fn set_allow_invitations(
    State(state): State<ServerState>,
    Json(req): Json<EnabledReq>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_setting("allow_invitations", if req.enabled { "1" } else { "0" })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Whether the invitation-token path is open (default ON). Read where tokens are minted and
/// redeemed so the master switch is enforced server-side, not just hidden in the UI.
async fn invitations_allowed(state: &ServerState) -> Result<bool, AppError> {
    Ok(state.db.get_setting("allow_invitations").await? != Some("0".to_string()))
}

/// Turn the client's "confirm every role change" safety prompt on/off (org-admin only). A UX
/// policy persisted server-side so all clients agree; no server enforcement. Default off.
async fn set_confirm_role_change(
    State(state): State<ServerState>,
    Json(req): Json<EnabledReq>,
) -> Result<StatusCode, AppError> {
    state
        .db
        .set_setting("confirm_role_change", if req.enabled { "1" } else { "0" })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Set the collection governance policy (org-admin only; guard-gated by `/api/admin`). Stored as
/// one JSON blob and surfaced in server_mode; enforced on create/add-member. Lightly validated.
async fn set_collection_policy(
    State(state): State<ServerState>,
    Json(policy): Json<Value>,
) -> Result<Response, AppError> {
    let role = policy
        .get("defaultRole")
        .and_then(|v| v.as_str())
        .unwrap_or("viewer");
    if !["viewer", "editor"].contains(&role) {
        return Ok((StatusCode::BAD_REQUEST, "invalid default role").into_response());
    }
    if policy
        .get("maxMembers")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        < 0
    {
        return Ok((StatusCode::BAD_REQUEST, "maxMembers must be ≥ 0").into_response());
    }
    state
        .db
        .set_setting("collection_policy", &policy.to_string())
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Set the machine health-check policy (org-admin only). The whole policy is stored as one
/// JSON blob and surfaced in server_mode; the client obeys it (ADR 0017). Validated lightly:
/// the active mode must be a known value and methods a known subset.
async fn set_healthcheck(
    State(state): State<ServerState>,
    Json(policy): Json<Value>,
) -> Result<Response, AppError> {
    let active = policy
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("off");
    if !["off", "on-demand", "full", "client-choice"].contains(&active) {
        return Ok((StatusCode::BAD_REQUEST, "invalid active mode").into_response());
    }
    if let Some(methods) = policy.get("methods").and_then(|v| v.as_array()) {
        let known = ["tcp-connect", "icmp", "ssh-handshake"];
        if methods
            .iter()
            .any(|m| !m.as_str().is_some_and(|s| known.contains(&s)))
        {
            return Ok((StatusCode::BAD_REQUEST, "invalid probe method").into_response());
        }
    }
    state
        .db
        .set_setting("healthcheck_policy", &policy.to_string())
        .await?;
    // Live distribution (ADR 0017): nudge every connected client to re-pull the
    // policy now instead of waiting for its next throttled poll. A payload-less,
    // session-less event broadcasts to all sockets (see `event_visible_to`).
    let _ = state
        .events_tx
        .send(json!({ "event": "policy-updated", "payload": {} }).to_string());
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Anti-flood knobs for on-demand probing (ADR 0017): one request per user per
/// cooldown, a hard cap on batch size, and a per-target connection timeout.
const PROBE_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(3);
const PROBE_MAX_TARGETS: usize = 64;
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Deserialize)]
struct ProbeTarget {
    id: String,
    host: String,
    port: u16,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Deserialize)]
struct HealthProbeReq {
    targets: Vec<ProbeTarget>,
}

/// On-demand active health-check (ADR 0017 active phase). Governed by the server's
/// health-check policy: rejected when active probing is off, when the caller isn't in
/// a non-empty restrict-users allowlist, and rate-limited per user. The client hands
/// over host:port (decrypted from its own blob — the server stays zero-knowledge about
/// *which* machines these are) and gets back an up/down verdict per target.
async fn healthcheck_probe(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Json(req): Json<HealthProbeReq>,
) -> Result<Response, AppError> {
    let policy = healthcheck_policy(&state).await?;
    let active = policy
        .get("active")
        .and_then(|v| v.as_str())
        .unwrap_or("off");
    if active == "off" {
        return Ok((
            StatusCode::FORBIDDEN,
            "active probing is disabled by the server",
        )
            .into_response());
    }
    // restrict-users: a non-empty list is an allowlist of usernames permitted to probe.
    if let Some(list) = policy.get("restrictUsers").and_then(|v| v.as_array()) {
        if !list.is_empty() {
            let uname = as_user(&user).map(|u| u.username.as_str());
            let ok = uname.is_some_and(|u| list.iter().any(|v| v.as_str() == Some(u)));
            if !ok {
                return Ok((
                    StatusCode::FORBIDDEN,
                    "not permitted to probe on this server",
                )
                    .into_response());
            }
        }
    }
    if req.targets.len() > PROBE_MAX_TARGETS {
        return Ok((StatusCode::BAD_REQUEST, "too many targets in one request").into_response());
    }
    // Anti-flood: one probe request per user per cooldown window.
    let key = as_user(&user)
        .map(|u| u.id.clone())
        .unwrap_or_else(|| "local".to_string());
    {
        let mut throttle = state.probe_throttle.lock().unwrap();
        let now = std::time::Instant::now();
        if throttle
            .get(&key)
            .is_some_and(|prev| now.duration_since(*prev) < PROBE_COOLDOWN)
        {
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                "probing too fast — slow down",
            )
                .into_response());
        }
        throttle.insert(key, now);
    }
    // Which methods this policy permits (default tcp-connect). A target may ask for a
    // specific method; anything outside the allowlist comes back "unsupported".
    let allowed: Vec<String> = policy
        .get("methods")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| m.as_str().map(String::from))
                .collect()
        })
        .filter(|v: &Vec<String>| !v.is_empty())
        .unwrap_or_else(|| vec!["tcp-connect".to_string()]);
    let default_method = allowed[0].clone();

    // Probe every target concurrently — a batch of 64 done sequentially would be far
    // too slow (up to targets × timeout).
    let mut set = tokio::task::JoinSet::new();
    for t in req.targets {
        let allowed = allowed.clone();
        let default_method = default_method.clone();
        set.spawn(async move {
            let requested = t.method.unwrap_or(default_method);
            let method = allowed
                .contains(&requested)
                .then(|| probe::ProbeMethod::parse(&requested))
                .flatten();
            match method {
                Some(method) => {
                    let r = probe::probe(&t.host, t.port, method, PROBE_TIMEOUT).await;
                    json!({ "id": t.id, "status": r.status.as_str(), "latencyMs": r.latency_ms })
                }
                None => json!({ "id": t.id, "status": "unsupported", "latencyMs": null }),
            }
        });
    }
    let mut results = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(v) = joined {
            results.push(v);
        }
    }
    Ok(Json(json!({ "results": results })).into_response())
}

#[derive(Deserialize)]
struct PreloginReq {
    username: String,
}

async fn server_prelogin(
    State(state): State<ServerState>,
    Json(req): Json<PreloginReq>,
) -> Result<Json<PreloginInfo>, AppError> {
    Ok(Json(
        server_auth::prelogin(state.db.pool(), &req.username).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginReq {
    username: String,
    auth_hash: String,
}

async fn server_login(
    State(state): State<ServerState>,
    Json(req): Json<LoginReq>,
) -> Result<Response, AppError> {
    if let Some(wait) = state.login_limiter.locked_for(&req.username) {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "too many attempts, try again later", "retryAfter": wait })),
        )
            .into_response());
    }
    match server_auth::verify_login(state.db.pool(), &req.username, &req.auth_hash).await? {
        Some(user) => {
            state.login_limiter.record_success(&req.username);
            let token = server_auth::create_session(state.db.pool(), &user.id).await?;
            let vault = server_auth::get_user_vault(state.db.pool(), &user.id).await?;
            Ok(Json(json!({ "token": token, "user": user, "vault": vault })).into_response())
        }
        None => {
            state.login_limiter.record_failure(&req.username);
            Ok((
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "invalid credentials" })),
            )
                .into_response())
        }
    }
}

async fn server_logout(State(state): State<ServerState>, headers: HeaderMap) -> StatusCode {
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
    {
        let _ = server_auth::revoke_session(state.db.pool(), token).await;
    }
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapReq {
    username: String,
    salt: String, // hex
    params: KdfParams,
    auth_hash: String,
    // Per-user vault key material generated client-side (ADR 0011 / 0013).
    master_salt: String, // hex
    protected_user_key: String,
    public_key: String, // hex (X25519)
    protected_private_key: String,
}

async fn server_bootstrap(
    State(state): State<ServerState>,
    Json(req): Json<BootstrapReq>,
) -> Result<Response, AppError> {
    if !state.accounts {
        return Ok((StatusCode::BAD_REQUEST, "not a server").into_response());
    }
    if server_auth::has_any_user(state.db.pool()).await? {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "server already initialised" })),
        )
            .into_response());
    }
    let salt = server_auth::parse_hex_salt(&req.salt)?;
    let vault = server_auth::VaultKey {
        master_salt: server_auth::parse_hex_salt(&req.master_salt)?,
        protected_user_key: req.protected_user_key,
        public_key: req.public_key,
        protected_private_key: req.protected_private_key,
    };
    let user = server_auth::create_user(
        state.db.pool(),
        &req.username,
        &salt,
        req.params,
        &req.auth_hash,
        Role::Admin,
        &vault,
        false, // bootstrap admin sets their own password → no forced change
    )
    .await?;
    let token = server_auth::create_session(state.db.pool(), &user.id).await?;
    let vault_out = server_auth::get_user_vault(state.db.pool(), &user.id).await?;
    Ok(Json(json!({ "token": token, "user": user, "vault": vault_out })).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterReq {
    username: String,
    salt: String, // hex
    params: KdfParams,
    auth_hash: String,
    master_salt: String, // hex
    protected_user_key: String,
    public_key: String, // hex (X25519)
    protected_private_key: String,
    /// An optional invitation token (ADR 0015 phase 3): when present it is redeemed (recipe
    /// applied, single-use) and bypasses the open_registration gate.
    #[serde(default)]
    token: Option<String>,
}

/// Self-service registration + invitation-token redemption (ADR 0015 phases 1 & 3). Public. The
/// client always generates its own keys, so the account needs no forced password change — the admin
/// never sees the keys. Two paths: with a valid `token`, the encoded role + team recipe is applied
/// (single-use, and it works even when open registration is off); without one, plain signup that
/// requires the opt-in `open_registration` setting and lands role `user`, no team. Returns a session.
async fn server_register(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<RegisterReq>,
) -> Result<Response, AppError> {
    if !state.accounts {
        return Ok((StatusCode::BAD_REQUEST, "not a server").into_response());
    }
    // Anti-abuse: cap self-service signups per client (X-Forwarded-For behind a proxy, else a global
    // bucket). Counts every attempt (incl. failed/duplicate) so it also blunts enumeration probing.
    if let Some(retry) = state
        .register_limiter
        .check_and_record(&client_key(&headers))
    {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, retry.to_string())],
            Json(json!({ "error": "too many sign-up attempts — try again later" })),
        )
            .into_response());
    }
    let username = req.username.trim();
    if username.is_empty() || username.chars().count() > 64 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "username must be 1–64 characters" })),
        )
            .into_response());
    }
    let salt = server_auth::parse_hex_salt(&req.salt)?;
    let vault = server_auth::VaultKey {
        master_salt: server_auth::parse_hex_salt(&req.master_salt)?,
        protected_user_key: req.protected_user_key,
        public_key: req.public_key,
        protected_private_key: req.protected_private_key,
    };
    let session = |state: ServerState, user: server_auth::User| async move {
        let token = server_auth::create_session(state.db.pool(), &user.id).await?;
        let vault_out = server_auth::get_user_vault(state.db.pool(), &user.id).await?;
        Ok::<_, AppError>(
            (
                StatusCode::CREATED,
                Json(json!({ "token": token, "user": user, "vault": vault_out })),
            )
                .into_response(),
        )
    };

    // --- Path A: redeem an invitation token (recipe applied, single-use, bypasses the gate). ---
    if let Some(tok) = req
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        // The master switch closes redemption too — a disabled instance honours no token, even
        // one minted earlier (the client hides the field; this is the real boundary).
        if !invitations_allowed(&state).await? {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "invitations are disabled on this instance" })),
            )
                .into_response());
        }
        let Some(recipe) = rite_core::enrollment::claim(state.db.pool(), tok).await? else {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "invalid or expired invitation token" })),
            )
                .into_response());
        };
        return match server_auth::create_user(
            state.db.pool(),
            username,
            &salt,
            req.params,
            &req.auth_hash,
            recipe.role,
            &vault,
            false,
        )
        .await
        {
            Ok(user) => {
                // Apply the recipe's team grants. Best-effort: a team deleted since the token was
                // minted is simply skipped rather than failing the whole redemption.
                for (team_id, team_role) in &recipe.teams {
                    let _ = rite_core::teams::set_member(
                        state.db.pool(),
                        team_id,
                        &user.id,
                        *team_role,
                    )
                    .await;
                }
                session(state, user).await
            }
            Err(_) => {
                // Signup failed (duplicate username): reopen the single-use token so it can be retried.
                let _ = rite_core::enrollment::release(state.db.pool(), &recipe.id).await;
                Ok((
                    StatusCode::CONFLICT,
                    Json(json!({ "error": "username already exists" })),
                )
                    .into_response())
            }
        };
    }

    // --- Path B: plain self-service — requires the opt-in setting, lands role `user`. ---
    if state.db.get_setting("open_registration").await? != Some("1".to_string()) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "open registration is disabled" })),
        )
            .into_response());
    }
    match server_auth::create_user(
        state.db.pool(),
        username,
        &salt,
        req.params,
        &req.auth_hash,
        Role::User,
        &vault,
        false,
    )
    .await
    {
        Ok(user) => session(state, user).await,
        Err(_) => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "username already exists" })),
        )
            .into_response()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamGrantReq {
    team_id: String,
    #[serde(default)]
    team_role: Option<String>, // "admin" | "member" (default member)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTokenReq {
    role: Role,
    #[serde(default)]
    teams: Vec<TeamGrantReq>,
    #[serde(default)]
    expires_in_secs: Option<i64>, // None = never
}

/// Mint an enrollment token (ADR 0015 phase 3). Admin or manager (guard-gated to org). A manager
/// may mint only user-role tokens (no privilege escalation, like `admin_create_user`); an admin may
/// mint user or manager — never admin (that keeps its escrow-crypto create path). The plaintext is
/// returned ONCE; only its hash is stored.
async fn admin_create_token(
    State(state): State<ServerState>,
    Extension(caller): Extension<Arc<User>>,
    Json(req): Json<CreateTokenReq>,
) -> Result<Response, AppError> {
    if !invitations_allowed(&state).await? {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "invitations are disabled on this instance" })),
        )
            .into_response());
    }
    if req.role == Role::Admin {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "admin tokens are not allowed" })),
        )
            .into_response());
    }
    if caller.role == Role::Manager && req.role != Role::User {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "managers can only mint user tokens" })),
        )
            .into_response());
    }
    // A past/zero expiry would mint a dead token — reject it (a client date-picker in the past).
    if matches!(req.expires_in_secs, Some(s) if s <= 0) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "expiry must be in the future" })),
        )
            .into_response());
    }
    // A recipe may only grant membership to teams the minter can administer (org-admins pass all),
    // mirroring add_team_member — otherwise a token would bypass per-team authorization.
    for t in &req.teams {
        if !rite_core::teams::team_exists(state.db.pool(), &t.team_id).await? {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "unknown team" })),
            )
                .into_response());
        }
        if !can_admin_team(&state, &caller, &t.team_id).await? {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(
                    json!({ "error": "you can't grant membership to a team you don't administer" }),
                ),
            )
                .into_response());
        }
    }
    let teams = req
        .teams
        .into_iter()
        .map(|t| {
            let role = t
                .team_role
                .as_deref()
                .map(rite_core::teams::TeamRole::parse)
                .unwrap_or(rite_core::teams::TeamRole::Member);
            (t.team_id, role)
        })
        .collect();
    let (token, info) = rite_core::enrollment::create(
        state.db.pool(),
        rite_core::enrollment::NewToken {
            role: req.role,
            teams,
            expires_in_secs: req.expires_in_secs,
        },
        &caller.id,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": token, "info": info })),
    )
        .into_response())
}

async fn admin_list_tokens(
    State(state): State<ServerState>,
    Extension(caller): Extension<Arc<User>>,
) -> Result<Json<Vec<rite_core::enrollment::TokenInfo>>, AppError> {
    let mut tokens = rite_core::enrollment::list(state.db.pool()).await?;
    // Owner rule: a manager manages only what's below them — user-role invitations. Admins see all.
    if caller.role != Role::Admin {
        tokens.retain(|t| t.role == Role::User);
    }
    Ok(Json(tokens))
}

async fn admin_revoke_token(
    State(state): State<ServerState>,
    Extension(caller): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    match rite_core::enrollment::role_of(state.db.pool(), &id).await? {
        None => return Ok(StatusCode::NOT_FOUND.into_response()),
        // A manager can only revoke tokens it could itself mint (user-role).
        Some(role) if caller.role != Role::Admin && role != Role::User => {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "you can't manage this token" })),
            )
                .into_response());
        }
        _ => {}
    }
    Ok(
        if rite_core::enrollment::revoke(state.db.pool(), &id).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

/// The current authenticated user (guard inserted it) + its vault key material,
/// so a client that reloaded can re-unwrap its user key without a fresh login.
async fn server_me(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Value>, AppError> {
    let vault = server_auth::get_user_vault(state.db.pool(), &user.id).await?;
    Ok(Json(json!({ "user": (*user).clone(), "vault": vault })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordReq {
    salt: String, // hex
    params: server_auth::KdfParams,
    auth_hash: String,
    master_salt: String, // hex
    protected_user_key: String,
    public_key: String, // hex (X25519)
    protected_private_key: String,
}

/// Replace the caller's own password + vault with client-derived material (the "set your
/// own password" flow — used at first login and after an admin reset). The client generates
/// a brand-new keypair, so the server (and the admin who set the initial password) can no
/// longer derive the vault key; the must-change flag is cleared. The server never sees the
/// password. The current session stays valid.
async fn change_password(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Json(req): Json<ChangePasswordReq>,
) -> Result<Response, AppError> {
    let salt = server_auth::parse_hex_salt(&req.salt)?;
    let vault = server_auth::VaultKey {
        master_salt: server_auth::parse_hex_salt(&req.master_salt)?,
        protected_user_key: req.protected_user_key,
        public_key: req.public_key,
        protected_private_key: req.protected_private_key,
    };
    Ok(
        if server_auth::set_credentials(
            state.db.pool(),
            &user.id,
            &salt,
            req.params,
            &req.auth_hash,
            &vault,
            false,
        )
        .await?
        {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

// --- per-user library tree (ADR 0016 view hierarchy) ------------------------
// An opaque, client-encrypted blob (folders + collection placement). The server
// stores/returns it verbatim and never reads it (zero-knowledge).

async fn get_library(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Value>, AppError> {
    let blob = rite_core::library_store::get(state.db.pool(), &user.id).await?;
    Ok(Json(json!({ "blob": blob })))
}

async fn set_library(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Json(req): Json<VaultBlobReq>,
) -> Result<StatusCode, AppError> {
    rite_core::library_store::set(state.db.pool(), &user.id, &req.blob).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- admin (role-gated by the guard: /api/admin/* requires role=admin) ------

async fn admin_list_users(State(state): State<ServerState>) -> Result<Json<Vec<User>>, AppError> {
    Ok(Json(server_auth::list_users(state.db.pool()).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserReq {
    username: String,
    salt: String, // hex
    params: KdfParams,
    auth_hash: String,
    role: Role,
    // The admin sets the initial password, so its browser generates the new
    // user's vault key material too (ADR 0011 / 0013). The user changes it later.
    master_salt: String, // hex
    protected_user_key: String,
    public_key: String, // hex (X25519)
    protected_private_key: String,
}

fn role_rank(r: Role) -> u8 {
    match r {
        Role::Admin => 2,
        Role::Manager => 1,
        Role::User => 0,
    }
}

/// RBAC hierarchy (owner rule): may `caller` manage — change role, disable, reset, or delete — an
/// account whose current role is `target`? A caller only ever acts on ranks **below** their own,
/// never at or above it: a manager touches regular users only (never other managers or admins).
/// Admins are the top tier with no higher authority, so they self-govern (incl. peers) — that's what
/// makes offboarding another admin possible, via the escrow-rotating disable/delete paths.
fn can_manage(caller: Role, target: Role) -> bool {
    match caller {
        Role::Admin => true,
        Role::Manager => role_rank(target) < role_rank(Role::Manager),
        Role::User => false,
    }
}

async fn admin_create_user(
    State(state): State<ServerState>,
    Extension(caller): Extension<Arc<User>>,
    Json(req): Json<CreateUserReq>,
) -> Result<Response, AppError> {
    // A manager may invite regular users, but never create admins/managers (no privilege escalation);
    // admins may create any role.
    if caller.role == Role::Manager && req.role != Role::User {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "managers can only create regular users" })),
        )
            .into_response());
    }
    let salt = server_auth::parse_hex_salt(&req.salt)?;
    let vault = server_auth::VaultKey {
        master_salt: server_auth::parse_hex_salt(&req.master_salt)?,
        protected_user_key: req.protected_user_key.clone(),
        public_key: req.public_key.clone(),
        protected_private_key: req.protected_private_key.clone(),
    };
    match server_auth::create_user(
        state.db.pool(),
        &req.username,
        &salt,
        req.params,
        &req.auth_hash,
        req.role,
        &vault,
        true, // admin-provisioned → force a password change on first login (re-keys the vault)
    )
    .await
    {
        Ok(user) => Ok((StatusCode::CREATED, Json(user)).into_response()),
        // Almost always a duplicate username (UNIQUE constraint).
        Err(_) => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "username already exists" })),
        )
            .into_response()),
    }
}

#[derive(Deserialize)]
struct StatusReq {
    status: String,
}

async fn admin_set_status(
    State(state): State<ServerState>,
    Extension(current): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<StatusReq>,
) -> Result<Response, AppError> {
    if id == current.id {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "you can't change your own status" })),
        )
            .into_response());
    }
    if req.status != "active" && req.status != "disabled" {
        return Ok((StatusCode::BAD_REQUEST, "invalid status").into_response());
    }
    let Some(target_role) = server_auth::get_role(state.db.pool(), &id).await? else {
        return Ok((StatusCode::NOT_FOUND, "unknown user").into_response());
    };
    if !can_manage(current.role, target_role) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can't manage an account at or above your level" })),
        )
            .into_response());
    }
    let ok = server_auth::set_user_status(state.db.pool(), &id, &req.status).await?;
    Ok(if ok {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
}

#[derive(Deserialize)]
struct RoleReq {
    role: Role,
}

/// Change a user's server role. Admin-only (the /api/admin guard enforces it). Restricted to
/// `user` ⇄ `manager`: assigning `admin`, or changing an existing admin's role, keeps its own
/// escrow-group crypto path (out of scope). You can't change your own role.
async fn admin_set_role(
    State(state): State<ServerState>,
    Extension(current): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<RoleReq>,
) -> Result<Response, AppError> {
    if id == current.id {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "you can't change your own role" })),
        )
            .into_response());
    }
    let Some(target_role) = server_auth::get_role(state.db.pool(), &id).await? else {
        return Ok((StatusCode::NOT_FOUND, "unknown user").into_response());
    };
    // Owner rule: only manage ranks below yours (a manager can't touch peers/admins).
    if !can_manage(current.role, target_role) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can't manage an account at or above your level" })),
        )
            .into_response());
    }
    // An existing admin's role isn't flipped here — that must go through the escrow-rotating
    // disable/delete paths, not a bare role change.
    if target_role == Role::Admin {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": "can't change an admin's role here — disable or delete instead" }),
            ),
        )
            .into_response());
    }
    // Assignment ceiling: admins may assign any role (incl. promoting to admin); a manager may only
    // assign a role strictly below manager (i.e. user) — never create a peer or a superior.
    let assign_ok = current.role == Role::Admin || role_rank(req.role) < role_rank(current.role);
    if !assign_ok {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can't assign a role at or above your level" })),
        )
            .into_response());
    }
    let ok = server_auth::set_role(state.db.pool(), &id, req.role).await?;
    Ok(if ok {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetUserReq {
    salt: String, // hex
    params: server_auth::KdfParams,
    auth_hash: String,
    master_salt: String, // hex
    protected_user_key: String,
    public_key: String, // hex (X25519)
    protected_private_key: String,
}

/// Admin-authorised account reset (ADR 0010 addendum): the admin re-provisions a temp vault
/// (they relay the temp password out-of-band) + must-change so the user sets their own next
/// login; the user's sharing crypto is WIPED (they re-request access). Identity + team
/// memberships are KEPT. The admin can't reset themselves.
async fn admin_reset_user(
    State(state): State<ServerState>,
    Extension(current): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<ResetUserReq>,
) -> Result<Response, AppError> {
    if id == current.id {
        return Ok((StatusCode::BAD_REQUEST, "you can't reset your own account").into_response());
    }
    let Some(target_role) = server_auth::get_role(state.db.pool(), &id).await? else {
        return Ok((StatusCode::NOT_FOUND, "unknown user").into_response());
    };
    if !can_manage(current.role, target_role) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can't manage an account at or above your level" })),
        )
            .into_response());
    }
    let salt = server_auth::parse_hex_salt(&req.salt)?;
    let vault = server_auth::VaultKey {
        master_salt: server_auth::parse_hex_salt(&req.master_salt)?,
        protected_user_key: req.protected_user_key,
        public_key: req.public_key,
        protected_private_key: req.protected_private_key,
    };
    // must_change = true: the temp password is admin-known, so the user re-keys on next login.
    if !server_auth::set_credentials(
        state.db.pool(),
        &id,
        &salt,
        req.params,
        &req.auth_hash,
        &vault,
        true,
    )
    .await?
    {
        return Ok((StatusCode::NOT_FOUND, "unknown user").into_response());
    }
    coll::wipe_user_sharing(state.db.pool(), &id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn admin_delete_user(
    State(state): State<ServerState>,
    Extension(current): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if id == current.id {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "you can't delete yourself" })),
        )
            .into_response());
    }
    let Some(target_role) = server_auth::get_role(state.db.pool(), &id).await? else {
        return Ok((StatusCode::NOT_FOUND, "unknown user").into_response());
    };
    if !can_manage(current.role, target_role) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "you can't manage an account at or above your level" })),
        )
            .into_response());
    }
    let ok = server_auth::delete_user(state.db.pool(), &id).await?;
    Ok(if ok {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
}

// --- teams / RBAC (product-model.md) ----------------------------------------
// Org-admin (users.role == Admin) manages all teams and any membership. A
// team-admin (team_members.role == Admin) manages its own team's membership. A
// member can view its team. These are the authz primitives the future `scope`
// (user|team) resource authorization will build on.

fn is_org_admin(user: &User) -> bool {
    user.role == Role::Admin
}

/// May `user` administer team `team_id` (manage members)? Org-admin or team-admin.
async fn can_admin_team(state: &ServerState, user: &User, team_id: &str) -> Result<bool, AppError> {
    if is_org_admin(user) {
        return Ok(true);
    }
    Ok(
        rite_core::teams::team_role(state.db.pool(), team_id, &user.id).await?
            == Some(rite_core::teams::TeamRole::Admin),
    )
}

/// May `user` view team `team_id`? Org-admin or any member.
async fn can_view_team(state: &ServerState, user: &User, team_id: &str) -> Result<bool, AppError> {
    if is_org_admin(user) {
        return Ok(true);
    }
    Ok(
        rite_core::teams::team_role(state.db.pool(), team_id, &user.id)
            .await?
            .is_some(),
    )
}

async fn admin_list_teams(
    State(state): State<ServerState>,
) -> Result<Json<Vec<rite_core::teams::Team>>, AppError> {
    Ok(Json(rite_core::teams::list_teams(state.db.pool()).await?))
}

#[derive(Deserialize)]
struct CreateTeamReq {
    name: String,
}

async fn admin_create_team(
    State(state): State<ServerState>,
    Json(req): Json<CreateTeamReq>,
) -> Result<Response, AppError> {
    let name = req.name.trim();
    if name.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "team name required").into_response());
    }
    match rite_core::teams::create_team(state.db.pool(), name).await {
        Ok(team) => Ok((StatusCode::CREATED, Json(team)).into_response()),
        Err(_) => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "team name already exists" })),
        )
            .into_response()),
    }
}

async fn admin_delete_team(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    Ok(
        if rite_core::teams::delete_team(state.db.pool(), &id).await? {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::NOT_FOUND
        },
    )
}

// --- collections governance (admin; guard-gated to admin role) ---------------

/// Every collection with member + item counts (no key needed; names stay encrypted).
async fn admin_list_collections(
    State(state): State<ServerState>,
) -> Result<Json<Vec<coll::CollectionSummary>>, AppError> {
    Ok(Json(coll::list_all_collections(state.db.pool()).await?))
}

/// The members of any collection (admin can inspect membership without the key).
async fn admin_collection_members(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<coll::CollectionMember>>, AppError> {
    Ok(Json(coll::list_members(state.db.pool(), &id).await?))
}

/// Revoke a member's access (deletes their sealed key row — no key needed).
async fn admin_remove_collection_member(
    State(state): State<ServerState>,
    Path((id, target)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    Ok(
        if coll::remove_member(state.db.pool(), &id, &target).await? {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::NOT_FOUND
        },
    )
}

/// Force-delete a collection for everyone (governance/cleanup).
async fn admin_delete_collection(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    Ok(if coll::delete_collection(state.db.pool(), &id).await? {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

// --- Admin-group escrow endpoints (ADR 0016 split-key) ----------------------

/// The current Admin-group public key (member-readable — it is public). A collection
/// creator seals its metaKey to this so admins can later read the name. Null if no
/// admin has bootstrapped the group yet (the name simply stays admin-invisible).
async fn collections_group_key_ep(
    State(state): State<ServerState>,
) -> Result<Json<Option<coll::AdminGroupKey>>, AppError> {
    Ok(Json(coll::current_admin_group(state.db.pool()).await?))
}

/// Same, on the admin surface (used during rotation to read the prior epoch pubkey).
async fn admin_group_key_ep(
    State(state): State<ServerState>,
) -> Result<Json<Option<coll::AdminGroupKey>>, AppError> {
    Ok(Json(coll::current_admin_group(state.db.pool()).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminGroupGrantReq {
    user_id: String,
    protected_private_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAdminGroupReq {
    epoch: i64,
    public_key: String,
    grants: Vec<AdminGroupGrantReq>,
}

/// Bootstrap or rotate the Admin group: a client-admin generated a fresh keypair,
/// sealed the private key to each admin, and (on rotation) re-sealed every collection
/// escrow. The server just records the new epoch + grants — it never sees a key.
async fn set_admin_group_ep(
    State(state): State<ServerState>,
    Json(req): Json<SetAdminGroupReq>,
) -> Result<StatusCode, AppError> {
    let grants: Vec<(String, String)> = req
        .grants
        .into_iter()
        .map(|g| (g.user_id, g.protected_private_key))
        .collect();
    coll::set_admin_group(state.db.pool(), req.epoch, &req.public_key, &grants).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// This admin's sealed group private key for the current epoch (404 if they hold no
/// grant yet — e.g. promoted after the last rotation, awaiting a re-grant).
async fn admin_group_grant_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Response, AppError> {
    Ok(
        match coll::admin_group_grant(state.db.pool(), &user.id).await? {
            Some(g) => Json(g).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
    )
}

/// Grant a (newly-added/promoted) admin the CURRENT group private key sealed to them —
/// the O(1) "add an admin" path: no rotation, no per-collection work. The acting admin
/// did the sealing; the server just records the grant for the current epoch.
async fn add_admin_group_grant_ep(
    State(state): State<ServerState>,
    Json(req): Json<AdminGroupGrantReq>,
) -> Result<Response, AppError> {
    let Some(group) = coll::current_admin_group(state.db.pool()).await? else {
        return Ok((StatusCode::CONFLICT, "no admin group yet").into_response());
    };
    coll::add_admin_group_grant(
        state.db.pool(),
        group.epoch,
        &req.user_id,
        &req.protected_private_key,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// The admins (with published public keys) a group grant can be sealed to.
async fn admin_list_admins_ep(
    State(state): State<ServerState>,
) -> Result<Json<Vec<coll::AdminKey>>, AppError> {
    Ok(Json(coll::list_admins_with_keys(state.db.pool()).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEscrowReq {
    meta_key_group_enc: String,
    group_epoch: i64,
}

/// Re-seal a collection's metaKey escrow to a (new) group epoch — the per-collection
/// step of a rotation, driven by a client-admin who re-sealed with the prior key.
async fn admin_set_escrow_ep(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<SetEscrowReq>,
) -> Result<StatusCode, AppError> {
    Ok(
        if coll::set_collection_group_escrow(
            state.db.pool(),
            &id,
            &req.meta_key_group_enc,
            req.group_epoch,
        )
        .await?
        {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::NOT_FOUND
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminAddMemberReq {
    user_id: String,
    protected_meta_key: String,
}

/// Admin roster meta-add: grant a user name/roster access to a collection by sealing
/// only its metaKey (the admin holds it via the group escrow). The itemsKey stays
/// unset — machine access requires a real member to seal it. Added as a viewer.
async fn admin_add_collection_member(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<AdminAddMemberReq>,
) -> Result<Response, AppError> {
    match coll::add_member_meta_only(
        state.db.pool(),
        &id,
        &req.user_id,
        coll::CollectionRole::Viewer,
        &req.protected_meta_key,
    )
    .await
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT.into_response()),
        Err(_) => Ok((StatusCode::BAD_REQUEST, "unknown user").into_response()),
    }
}

/// Teams the caller belongs to (any authenticated user).
async fn my_teams(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Vec<rite_core::teams::UserTeam>>, AppError> {
    Ok(Json(
        rite_core::teams::list_teams_for_user(state.db.pool(), &user.id).await?,
    ))
}

async fn team_members(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if !can_view_team(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "not a member of this team").into_response());
    }
    Ok(Json(rite_core::teams::list_members(state.db.pool(), &id).await?).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMemberReq {
    user_id: String,
    role: rite_core::teams::TeamRole,
}

async fn add_team_member(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<SetMemberReq>,
) -> Result<Response, AppError> {
    if !can_admin_team(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "not a team admin").into_response());
    }
    if !rite_core::teams::team_exists(state.db.pool(), &id).await? {
        return Ok((StatusCode::NOT_FOUND, "unknown team").into_response());
    }
    // The FK to users enforces that the target account exists.
    match rite_core::teams::set_member(state.db.pool(), &id, &req.user_id, req.role).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT.into_response()),
        Err(_) => Ok((StatusCode::BAD_REQUEST, "unknown user").into_response()),
    }
}

async fn remove_team_member(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, user_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let db = state.db.pool();
    // A team-admin removes anyone; a member may self-leave (remove only themselves).
    let self_leave = user_id == user.id;
    if !can_admin_team(&state, &user, &id).await? && !self_leave {
        return Ok((StatusCode::FORBIDDEN, "not a team admin").into_response());
    }
    // Keep the team managed: the last Manager can't leave/be removed (promote someone first).
    let leaver_role = rite_core::teams::team_role(db, &id, &user_id).await?;
    if leaver_role == Some(rite_core::teams::TeamRole::Admin)
        && rite_core::teams::count_admins(db, &id).await? <= 1
    {
        return Ok((
            StatusCode::CONFLICT,
            "the team needs at least one manager — promote someone first",
        )
            .into_response());
    }
    Ok(
        if rite_core::teams::remove_member(db, &id, &user_id).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

// --- collections (ADR 0016) --------------------------------------------------
// The sharing primitive. Membership = holding the sealed collection key + a role
// (owner/editor/viewer): owner manages membership/roles/delete, owner+editor write
// items, any member reads. The server never parses the encrypted name or blobs.

use rite_core::collection_store as coll;

/// The caller's role in a collection, or `None` if they are not a member.
async fn coll_role(
    state: &ServerState,
    user: &User,
    id: &str,
) -> Result<Option<coll::CollectionRole>, AppError> {
    Ok(coll::collection_role(state.db.pool(), id, &user.id).await?)
}

/// The org user directory (id, username, public key) for the member picker.
async fn directory_ep(
    State(state): State<ServerState>,
) -> Result<Json<Vec<server_auth::DirectoryEntry>>, AppError> {
    Ok(Json(server_auth::list_directory(state.db.pool()).await?))
}

async fn my_collections(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Vec<coll::UserCollection>>, AppError> {
    Ok(Json(
        coll::list_collections_for_user(state.db.pool(), &user.id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCollectionReq {
    name_enc: String,
    // Split-key model (ADR 0016): metaKey (name/colour) + itemsKey (machines), each
    // sealed to the creator.
    protected_meta_key: String,
    protected_items_key: String,
    // Optional Admin-group escrow: metaKey sealed to the group public key so admins
    // can read the name. Absent when no admin group exists yet (name stays private).
    meta_key_group_enc: Option<String>,
    group_epoch: Option<i64>,
}

async fn create_collection_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Json(req): Json<CreateCollectionReq>,
) -> Result<Response, AppError> {
    // Governance: an admin may forbid non-admins from provisioning collections.
    let policy = collection_policy(&state).await?;
    let allow_create = policy
        .get("allowCreate")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !allow_create && user.role != Role::Admin {
        return Ok((
            StatusCode::FORBIDDEN,
            "collection creation is restricted to admins",
        )
            .into_response());
    }
    let id = coll::create_collection(
        state.db.pool(),
        &req.name_enc,
        &user.id,
        &req.protected_meta_key,
        &req.protected_items_key,
    )
    .await?;
    if let (Some(enc), Some(epoch)) = (req.meta_key_group_enc.as_ref(), req.group_epoch) {
        coll::set_collection_group_escrow(state.db.pool(), &id, enc, epoch).await?;
    }
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionReq {
    name_enc: String,
}

async fn update_collection_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateCollectionReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_write() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "need write access").into_response()),
    }
    Ok(
        if coll::set_name_enc(state.db.pool(), &id, &req.name_enc).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

async fn delete_collection_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_manage() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "only an owner can delete").into_response()),
    }
    Ok(if coll::delete_collection(state.db.pool(), &id).await? {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetOfferReq {
    team_id: String,
    discovery_label: String,
}

/// Offer this collection to a team for discovery (owner only): an org link + a plaintext
/// label. The real name and machines stay encrypted; the label is RBAC-gated to the team.
async fn set_collection_offer_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<SetOfferReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_manage() => {}
        _ => {
            return Ok((
                StatusCode::FORBIDDEN,
                "only an owner can offer a collection",
            )
                .into_response());
        }
    }
    if !rite_core::teams::team_exists(state.db.pool(), &req.team_id).await? {
        return Ok((StatusCode::BAD_REQUEST, "unknown team").into_response());
    }
    let label = req.discovery_label.trim();
    if label.is_empty() {
        return Ok((StatusCode::BAD_REQUEST, "a discovery label is required").into_response());
    }
    Ok(
        if coll::set_collection_offer(state.db.pool(), &id, Some(&req.team_id), Some(label)).await?
        {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

/// Stop offering this collection for discovery (owner only).
async fn clear_collection_offer_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_manage() => {}
        _ => {
            return Ok(
                (StatusCode::FORBIDDEN, "only an owner can change the offer").into_response(),
            );
        }
    }
    Ok(
        if coll::set_collection_offer(state.db.pool(), &id, None, None).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

/// Collections offered to the teams the caller belongs to (discovery). Team-member RBAC is
/// enforced in the query; only the plaintext labels are returned.
async fn offered_collections_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Vec<coll::OfferedCollection>>, AppError> {
    Ok(Json(
        coll::list_offered_to_user(state.db.pool(), &user.id).await?,
    ))
}

/// Request access to a collection offered to one of the caller's teams. RBAC: the collection
/// must be discoverable by the caller (offered to a team they belong to); already-members and
/// non-discoverers are rejected. Idempotent.
async fn request_access_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if coll_role(&state, &user, &id).await?.is_some() {
        return Ok((StatusCode::CONFLICT, "you already have access").into_response());
    }
    let can_discover = coll::list_offered_to_user(state.db.pool(), &user.id)
        .await?
        .iter()
        .any(|o| o.id == id);
    if !can_discover {
        return Ok((StatusCode::FORBIDDEN, "not discoverable by you").into_response());
    }
    coll::add_access_request(state.db.pool(), &id, &user.id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRequestReq {
    user_id: String,
}

/// Dismiss a pending access request (owner/editor). Granting is a re-seal via the member
/// endpoint, which the client follows with this to clear the request.
async fn resolve_access_request_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<ResolveRequestReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_write() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "only a key-holder can resolve").into_response()),
    }
    Ok(
        if coll::remove_access_request(state.db.pool(), &id, &req.user_id).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

/// Access requests the caller can grant (they own/edit the collection). The inbox.
async fn incoming_requests_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Vec<coll::IncomingRequest>>, AppError> {
    Ok(Json(
        coll::list_incoming_requests(state.db.pool(), &user.id).await?,
    ))
}

async fn collection_members_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if coll_role(&state, &user, &id).await?.is_none() {
        return Ok((StatusCode::FORBIDDEN, "not a member").into_response());
    }
    Ok(Json(coll::list_members(state.db.pool(), &id).await?).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddCollectionMemberReq {
    user_id: String,
    role: coll::CollectionRole,
    // metaKey + itemsKey sealed to the new member.
    protected_meta_key: String,
    protected_items_key: String,
}

async fn add_collection_member_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<AddCollectionMemberReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_manage() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "only an owner can add members").into_response()),
    }
    // Governance (org-admins bypass both limits).
    if user.role != Role::Admin {
        let policy = collection_policy(&state).await?;
        // Member cap (0 = unlimited).
        let max = policy
            .get("maxMembers")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if max > 0 {
            let count = coll::list_members(state.db.pool(), &id).await?.len() as i64;
            if count >= max {
                return Ok(
                    (StatusCode::CONFLICT, "collection is at its member limit").into_response()
                );
            }
        }
        // No sharing outside teams: the target must share a team with the person adding them.
        let allow_outside = policy
            .get("allowSharingOutsideTeams")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !allow_outside
            && !rite_core::teams::users_share_team(state.db.pool(), &user.id, &req.user_id).await?
        {
            return Ok((
                StatusCode::FORBIDDEN,
                "you can only add members you share a team with",
            )
                .into_response());
        }
    }
    match coll::add_member(
        state.db.pool(),
        &id,
        &req.user_id,
        req.role,
        &req.protected_meta_key,
        &req.protected_items_key,
    )
    .await
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT.into_response()),
        Err(_) => Ok((StatusCode::BAD_REQUEST, "unknown user").into_response()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetRoleReq {
    role: coll::CollectionRole,
}

async fn set_collection_role_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, target)): Path<(String, String)>,
    Json(req): Json<SetRoleReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_manage() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "only an owner can change roles").into_response()),
    }
    // Keep at least one owner: refuse to demote the last owner.
    if req.role != coll::CollectionRole::Owner
        && coll::collection_role(state.db.pool(), &id, &target).await?
            == Some(coll::CollectionRole::Owner)
        && coll::count_owners(state.db.pool(), &id).await? <= 1
    {
        return Ok((
            StatusCode::CONFLICT,
            "a collection needs at least one owner",
        )
            .into_response());
    }
    Ok(
        if coll::set_role(state.db.pool(), &id, &target, req.role).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "not a member").into_response()
        },
    )
}

async fn remove_collection_member_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, target)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let self_leave = target == user.id;
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_manage() || self_leave => {}
        Some(_) => {
            return Ok((StatusCode::FORBIDDEN, "only an owner can remove members").into_response());
        }
        None => return Ok((StatusCode::FORBIDDEN, "not a member").into_response()),
    }
    // Keep at least one owner (also blocks the last owner from leaving).
    if coll::collection_role(state.db.pool(), &id, &target).await?
        == Some(coll::CollectionRole::Owner)
        && coll::count_owners(state.db.pool(), &id).await? <= 1
    {
        return Ok((
            StatusCode::CONFLICT,
            "a collection needs at least one owner",
        )
            .into_response());
    }
    Ok(
        if coll::remove_member(state.db.pool(), &id, &target).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

async fn collection_items_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if coll_role(&state, &user, &id).await?.is_none() {
        return Ok((StatusCode::FORBIDDEN, "not a member").into_response());
    }
    Ok(Json(coll::list_items(state.db.pool(), &id).await?).into_response())
}

async fn create_collection_item_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<VaultBlobReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_write() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "need write access").into_response()),
    }
    let item = coll::create_item(state.db.pool(), &id, &req.blob).await?;
    Ok((StatusCode::CREATED, Json(item)).into_response())
}

async fn update_collection_item_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, item_id)): Path<(String, String)>,
    Json(req): Json<VaultBlobReq>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_write() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "need write access").into_response()),
    }
    Ok(
        if coll::update_item(state.db.pool(), &id, &item_id, &req.blob).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "unknown item").into_response()
        },
    )
}

async fn delete_collection_item_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, item_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    match coll_role(&state, &user, &id).await? {
        Some(r) if r.can_write() => {}
        _ => return Ok((StatusCode::FORBIDDEN, "need write access").into_response()),
    }
    Ok(
        if coll::delete_item(state.db.pool(), &id, &item_id).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "unknown item").into_response()
        },
    )
}

// --- settings (per-key) -----------------------------------------------------

async fn get_setting(
    State(state): State<ServerState>,
    Path(key): Path<String>,
) -> Result<Json<Option<String>>, AppError> {
    Ok(Json(state.db.get_setting(&key).await?))
}

#[derive(Deserialize)]
struct ValueReq {
    value: String,
}

async fn set_setting(
    State(state): State<ServerState>,
    Path(key): Path<String>,
    Json(req): Json<ValueReq>,
) -> Result<StatusCode, AppError> {
    state.db.set_setting(&key, &req.value).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- connections ------------------------------------------------------------

/// 423 Locked — a remote context is active but its vault key is not held.
fn vault_locked() -> Response {
    (
        StatusCode::LOCKED,
        Json(json!({ "error": "vault locked", "locked": true })),
    )
        .into_response()
}

async fn get_connections(State(state): State<ServerState>) -> Result<Response, AppError> {
    // Remote context (ADR 0011): serve the user's decrypted vault connections.
    if let Some(server) = state.remote_context() {
        let Some(key) = state.vault_key() else {
            return Ok(vault_locked());
        };
        return Ok(Json(vault_conn::list(&state, &server, &key).await?).into_response());
    }
    Ok(Json(state.connections.get_all_connections().await?).into_response())
}

async fn create_connection(
    State(state): State<ServerState>,
    Json(input): Json<CreateConnectionInput>,
) -> Result<Response, AppError> {
    if let Some(server) = state.remote_context() {
        let Some(key) = state.vault_key() else {
            return Ok(vault_locked());
        };
        return Ok(Json(vault_conn::create(&state, &server, &key, &input).await?).into_response());
    }
    Ok(Json(state.connections.create_connection(input).await?).into_response())
}

async fn update_connection(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateConnectionInput>,
) -> Result<Response, AppError> {
    if let Some(server) = state.remote_context() {
        let Some(key) = state.vault_key() else {
            return Ok(vault_locked());
        };
        // The vault stores a whole encrypted connection; decrypt it (with its
        // secrets), apply the update, re-encrypt, and store.
        let existing = vault_conn::list_raw(&state, &server, &key)
            .await?
            .into_iter()
            .find(|(cid, ..)| *cid == id);
        let Some((_, input_existing, created_at, _)) = existing else {
            return Ok((StatusCode::NOT_FOUND, "unknown connection").into_response());
        };
        let merged = vault_conn::merge_update(input_existing, input);
        vault_conn::update(&state, &server, &key, &id, &merged).await?;
        return Ok(Json(vault_conn::info_for(id, &merged, created_at)).into_response());
    }
    Ok(Json(state.connections.update_connection(input).await?).into_response())
}

async fn delete_connection(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if let Some(server) = state.remote_context() {
        if state.vault_key().is_none() {
            return Ok(vault_locked());
        }
        vault_conn::delete(&state, &server, &id).await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    state.connections.delete_connection(&id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// --- per-user vault connections (ADR 0011) ----------------------------------
// Opaque ciphertext blobs scoped to the authenticated user. The guard requires
// a session in accounts mode and inserts the `User`; the server never reads the
// blob. Only reachable in accounts mode (a user must be present).

async fn vault_list_connections(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
) -> Result<Json<Value>, AppError> {
    let items = rite_core::vault_store::list(state.db.pool(), &user.id).await?;
    Ok(Json(json!(items)))
}

#[derive(Deserialize)]
struct VaultBlobReq {
    blob: String,
}

async fn vault_create_connection(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Json(req): Json<VaultBlobReq>,
) -> Result<Response, AppError> {
    let item = rite_core::vault_store::create(state.db.pool(), &user.id, &req.blob).await?;
    Ok((StatusCode::CREATED, Json(json!(item))).into_response())
}

async fn vault_update_connection(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<VaultBlobReq>,
) -> Result<StatusCode, AppError> {
    let ok = rite_core::vault_store::update(state.db.pool(), &user.id, &id, &req.blob).await?;
    Ok(if ok {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

async fn vault_delete_connection(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let ok = rite_core::vault_store::delete(state.db.pool(), &user.id, &id).await?;
    Ok(if ok {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

// --- ssh config -------------------------------------------------------------

async fn default_ssh_config_path() -> Json<String> {
    Json(rite_core::ssh_config::get_default_ssh_config_path())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseSshConfigReq {
    config_path: String,
}

async fn parse_ssh_config(
    Json(req): Json<ParseSshConfigReq>,
) -> Result<Json<Vec<SshConfigEntry>>, AppError> {
    Ok(Json(rite_core::ssh_config::parse_ssh_config(
        &req.config_path,
    )?))
}

/// List the public identities held by the local SSH agent (for the connection
/// form's identity picker). Local-only, read-only; agent auth is native-gated in
/// the UI, so this reflects the machine running the client.
async fn agent_identities() -> Result<Json<Vec<rite_core::terminal::AgentIdentityInfo>>, AppError> {
    Ok(Json(rite_core::terminal::list_agent_identities().await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KbdRespondReq {
    challenge_id: String,
    /// One answer per prompt, or `null` if the user cancelled the challenge.
    responses: Option<Vec<String>>,
}

/// Deliver the client's answers to an in-flight keyboard-interactive challenge
/// (2FA/PAM). Only the user who triggered the connect (the challenge owner) may
/// answer; an unknown/expired id is a harmless no-op.
async fn kbd_interactive_respond(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Json(req): Json<KbdRespondReq>,
) -> Result<Json<Value>, AppError> {
    let owner = as_user(&user)
        .map(|u| u.id.clone())
        .unwrap_or_else(|| "local".to_string());
    let pending = {
        let mut reg = state.kbd_challenges.lock().unwrap();
        match reg.get(&req.challenge_id) {
            Some(p) if p.owner != owner => {
                return Err(anyhow::anyhow!("not your challenge").into());
            }
            Some(_) => reg.remove(&req.challenge_id),
            None => None,
        }
    };
    if let Some(p) = pending {
        let _ = p.tx.send(req.responses);
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ImportEntriesReq {
    entries: Vec<SshConfigEntry>,
}

async fn import_ssh_config(
    State(state): State<ServerState>,
    Json(req): Json<ImportEntriesReq>,
) -> Result<Json<Vec<ConnectionInfo>>, AppError> {
    // Best-effort like the desktop command: skip entries that fail, import the rest.
    let mut imported = Vec::new();
    for entry in req.entries {
        match state
            .connections
            .create_connection(entry.to_connection_input())
            .await
        {
            Ok(info) => imported.push(info),
            Err(e) => tracing::warn!(
                "[rite-server] skipped ssh-config entry '{}': {}",
                entry.host,
                e
            ),
        }
    }
    Ok(Json(imported))
}

// --- context multiplexer (ADR 0012, native client roster) -------------------

async fn load_roster(state: &ServerState) -> Vec<RemoteServer> {
    state
        .db
        .get_setting("remote_servers")
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

async fn save_roster(state: &ServerState, roster: &[RemoteServer]) -> Result<(), AppError> {
    let json = serde_json::to_string(roster).unwrap_or_else(|_| "[]".to_string());
    state.db.set_setting("remote_servers", &json).await?;
    Ok(())
}

fn active_json(ctx: &ActiveContext) -> Value {
    match ctx {
        ActiveContext::Local => json!("local"),
        ActiveContext::Remote(s) => json!({ "id": s.id, "url": s.url, "label": s.label }),
    }
}

/// A remote URL must be https (or http on loopback for local dev).
fn is_valid_remote_url(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        return !rest.is_empty();
    }
    if let Some(rest) = url.strip_prefix("http://") {
        return rest.starts_with("127.") || rest.starts_with("localhost");
    }
    false
}

/// Canonical form stored in the roster: trim, drop a trailing slash, and lowercase the
/// scheme + authority (host[:port] is case-insensitive). Any path is preserved but is not
/// lowercased. Storing the canonical form keeps the roster tidy and case-stable.
fn normalize_remote_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    match trimmed.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = match rest.split_once('/') {
                Some((a, p)) => (a, Some(p)),
                None => (rest, None),
            };
            let base = format!(
                "{}://{}",
                scheme.to_ascii_lowercase(),
                authority.to_ascii_lowercase()
            );
            match path {
                Some(p) => format!("{base}/{p}"),
                None => base,
            }
        }
        None => trimmed.to_ascii_lowercase(),
    }
}

/// The origin key used to dedupe the roster: scheme + authority only, lowercased (path
/// dropped) — identical to the desktop shell's `ContextKey::server`. Two spellings of one
/// endpoint (case, trailing slash, path) therefore collapse to a single roster entry, so
/// the roster can never disagree with the shell's one-window-per-context registry.
fn remote_origin(url: &str) -> String {
    let trimmed = url.trim();
    match trimmed.split_once("://") {
        Some((scheme, rest)) => {
            let authority = rest.split_once('/').map(|(a, _)| a).unwrap_or(rest);
            format!(
                "{}://{}",
                scheme.to_ascii_lowercase(),
                authority.to_ascii_lowercase()
            )
        }
        None => trimmed.trim_end_matches('/').to_ascii_lowercase(),
    }
}

async fn get_context(State(state): State<ServerState>) -> Result<Json<Value>, AppError> {
    let roster = load_roster(&state).await;
    let active = active_json(&state.context.lock().unwrap());
    Ok(Json(json!({ "active": active, "roster": roster })))
}

#[derive(Deserialize)]
struct AddServerReq {
    url: String,
    label: Option<String>,
}

async fn add_server(
    State(state): State<ServerState>,
    Json(req): Json<AddServerReq>,
) -> Result<Response, AppError> {
    let url = normalize_remote_url(&req.url);
    if !is_valid_remote_url(&url) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "remote must be https:// (http:// only on loopback)" })),
        )
            .into_response());
    }
    let origin = remote_origin(&url);
    let mut roster = load_roster(&state).await;
    if roster.iter().any(|s| remote_origin(&s.url) == origin) {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "server already in the roster" })),
        )
            .into_response());
    }
    let entry = RemoteServer {
        id: uuid::Uuid::new_v4().to_string(),
        label: req
            .label
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| url.clone()),
        url,
        cert_fingerprint: None,
        icon: None,
    };
    roster.push(entry.clone());
    save_roster(&state, &roster).await?;
    Ok((StatusCode::CREATED, Json(entry)).into_response())
}

#[derive(Deserialize)]
struct SetIconReq {
    /// An emoji or `data:` image URI; absent/null clears it.
    icon: Option<String>,
}

/// Set (or clear) a roster server's device-local icon (ADR 0014).
async fn set_server_icon(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<SetIconReq>,
) -> Result<Response, AppError> {
    let mut roster = load_roster(&state).await;
    let Some(entry) = roster.iter_mut().find(|s| s.id == id) else {
        return Ok((StatusCode::NOT_FOUND, "unknown server").into_response());
    };
    entry.icon = req.icon.filter(|s| !s.is_empty());
    save_roster(&state, &roster).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn remove_server(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let mut roster = load_roster(&state).await;
    let before = roster.len();
    roster.retain(|s| s.id != id);
    save_roster(&state, &roster).await?;
    // If the removed server was active, revoke its session and fall back to Local.
    let is_active =
        matches!(&*state.context.lock().unwrap(), ActiveContext::Remote(s) if s.id == id);
    if is_active {
        clear_remote_session(&state).await;
        *state.cert_pin.lock().unwrap() = None;
        *state.context.lock().unwrap() = ActiveContext::Local;
    }
    Ok(if roster.len() < before {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

#[derive(Deserialize)]
struct UpdateServerReq {
    url: String,
    label: Option<String>,
}

/// Edit a roster server's URL/label (ADR 0012). A changed URL is a different endpoint, so its
/// pinned cert is cleared — it must be re-pinned (TOFU) on next connect.
async fn update_server(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateServerReq>,
) -> Result<Response, AppError> {
    let url = normalize_remote_url(&req.url);
    if !is_valid_remote_url(&url) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "remote must be https:// (http:// only on loopback)" })),
        )
            .into_response());
    }
    let origin = remote_origin(&url);
    let mut roster = load_roster(&state).await;
    if roster
        .iter()
        .any(|s| remote_origin(&s.url) == origin && s.id != id)
    {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "server already in the roster" })),
        )
            .into_response());
    }
    let Some(entry) = roster.iter_mut().find(|s| s.id == id) else {
        return Ok((StatusCode::NOT_FOUND, "unknown server").into_response());
    };
    if entry.url != url {
        entry.cert_fingerprint = None; // new endpoint → re-pin on next connect
    }
    entry.url = url.clone();
    entry.label = req
        .label
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| url.clone());
    let updated = entry.clone();
    save_roster(&state, &roster).await?;
    Ok(Json(updated).into_response())
}

#[derive(Deserialize)]
struct SetActiveReq {
    /// "local" or a roster server id.
    server: String,
}

async fn set_active_context(
    State(state): State<ServerState>,
    Json(req): Json<SetActiveReq>,
) -> Result<Response, AppError> {
    // Revoke the current remote session before switching (ADR 0012 §5).
    clear_remote_session(&state).await;

    if req.server == "local" {
        *state.cert_pin.lock().unwrap() = None;
        *state.context.lock().unwrap() = ActiveContext::Local;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    match load_roster(&state)
        .await
        .into_iter()
        .find(|s| s.id == req.server)
    {
        Some(s) => {
            // Point the pinned verifier at this remote's fingerprint (if any)
            // before any proxy connection is made (ADR 0012 §4).
            *state.cert_pin.lock().unwrap() = s.cert_fingerprint.clone();
            *state.context.lock().unwrap() = ActiveContext::Remote(s);
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        None => Ok((StatusCode::NOT_FOUND, "unknown server").into_response()),
    }
}

#[derive(Deserialize)]
struct ProbeReq {
    url: String,
}

/// Probe a remote's TLS cert without trusting it (ADR 0012 §4, TOFU). Returns
/// the leaf SHA-256 fingerprint and whether webpki roots would accept it, so the
/// UI can show the fingerprint for out-of-band confirmation before pinning.
async fn probe_remote(
    State(_state): State<ServerState>,
    Json(req): Json<ProbeReq>,
) -> Result<Response, AppError> {
    let url = normalize_remote_url(&req.url);
    if !is_valid_remote_url(&url) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "remote must be https:// (http:// only on loopback)" })),
        )
            .into_response());
    }
    // A loopback http remote has no cert to probe — trust it as-is.
    if url.starts_with("http://") {
        return Ok(Json(json!({ "trusted": true, "fingerprint": null })).into_response());
    }
    let captured = Arc::new(std::sync::Mutex::new(None));
    let config = tls_pin::client_config(tls_pin::CaptureVerifier::new(captured.clone()));
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError(anyhow::anyhow!("build probe client: {e}")))?;
    // Best-effort request: the TLS handshake captures the cert regardless of the
    // HTTP outcome (the endpoint may 401/404 — we only care about the certificate).
    let _ = client.get(format!("{url}/api/health")).send().await;
    match captured.lock().unwrap().clone() {
        Some((fingerprint, trusted)) => {
            Ok(Json(json!({ "trusted": trusted, "fingerprint": fingerprint })).into_response())
        }
        None => Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "could not reach remote (TLS handshake failed)" })),
        )
            .into_response()),
    }
}

#[derive(Deserialize)]
struct PinReq {
    fingerprint: String,
}

/// Pin a self-signed remote's cert fingerprint in the roster (ADR 0012 §4). The
/// user has confirmed the fingerprint out-of-band; store it so later connects
/// must match. If the server is the active context, update the live pin too.
async fn pin_server(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<PinReq>,
) -> Result<Response, AppError> {
    let fp = req.fingerprint.trim().to_ascii_lowercase();
    if fp.len() != 64 || !fp.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "fingerprint must be 64 hex chars (SHA-256)" })),
        )
            .into_response());
    }
    let mut roster = load_roster(&state).await;
    let Some(entry) = roster.iter_mut().find(|s| s.id == id) else {
        return Ok((StatusCode::NOT_FOUND, "unknown server").into_response());
    };
    entry.cert_fingerprint = Some(fp.clone());
    save_roster(&state, &roster).await?;
    let is_active =
        matches!(&*state.context.lock().unwrap(), ActiveContext::Remote(s) if s.id == id);
    if is_active {
        *state.cert_pin.lock().unwrap() = Some(fp);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultUnlockReq {
    user_key: String, // hex (32 bytes)
    /// Idle auto-lock in seconds; 0/absent = no idle lock (explicit lock still works).
    auto_lock_secs: Option<u64>,
}

/// The webview posts the unwrapped user key here after login (ADR 0011). Held by
/// the local server (RAM) so it survives reloads; enforced idle-locked server-side.
async fn vault_unlock(
    State(state): State<ServerState>,
    Json(req): Json<VaultUnlockReq>,
) -> Result<Response, AppError> {
    let bytes = server_auth::parse_hex_salt(&req.user_key)?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError(anyhow::anyhow!("user key must be 32 bytes")))?;
    let timeout = req
        .auto_lock_secs
        .filter(|s| *s > 0)
        .map(std::time::Duration::from_secs);
    state.vault.lock().unwrap().unlock(key, timeout);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Whether the local vault key is currently held (checks the idle timeout).
async fn vault_status(State(state): State<ServerState>) -> Json<Value> {
    let unlocked = state.vault.lock().unwrap().check_expiry();
    Json(json!({ "unlocked": unlocked }))
}

/// Explicitly zeroize the held vault key (lock).
async fn vault_lock(State(state): State<ServerState>) -> StatusCode {
    state.vault.lock().unwrap().lock();
    StatusCode::NO_CONTENT
}

/// If a remote context is active, best-effort revoke its session on the remote,
/// then drop the local token (ADR 0012 §5 — no orphan sessions).
async fn clear_remote_session(state: &ServerState) {
    // The held vault key belongs to the context we're leaving — zeroize it.
    state.vault.lock().unwrap().lock();
    let url = match &*state.context.lock().unwrap() {
        ActiveContext::Remote(s) => Some(s.url.clone()),
        ActiveContext::Local => None,
    };
    let token = state.remote_token.lock().unwrap().take();
    if let (Some(url), Some(tok)) = (url, token) {
        let _ = state
            .http_client
            .post(format!("{url}/api/server/logout"))
            .header(header::AUTHORIZATION, format!("Bearer {tok}"))
            .send()
            .await;
    }
}

// --- ssh host keys ----------------------------------------------------------

#[derive(Deserialize)]
struct HostKeyReq {
    host: String,
    port: u16,
}

async fn accept_host_key(
    State(state): State<ServerState>,
    Json(req): Json<HostKeyReq>,
) -> Result<StatusCode, AppError> {
    rite_core::known_hosts::accept_pending_host_key(state.db.pool(), &req.host, req.port).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reject_host_key(
    State(state): State<ServerState>,
    Json(req): Json<HostKeyReq>,
) -> Result<StatusCode, AppError> {
    rite_core::known_hosts::reject_pending_host_key(state.db.pool(), &req.host, req.port).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- shells -----------------------------------------------------------------

#[derive(Deserialize)]
struct ShellsReq {
    shells: Vec<String>,
}

async fn installed_shells(Json(req): Json<ShellsReq>) -> Json<Vec<String>> {
    Json(
        req.shells
            .into_iter()
            .filter(|p| std::path::Path::new(p).exists())
            .collect(),
    )
}

// --- terminal ---------------------------------------------------------------

#[derive(Deserialize)]
struct LocalReq {
    shell: Option<String>,
}

async fn create_local(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Json(req): Json<LocalReq>,
) -> Result<Json<Value>, AppError> {
    let id = state
        .sessions
        .create_local_session(state.events_sink(), req.shell)
        .await?;
    state.record_session_owner(&id, as_user(&user));
    Ok(Json(json!({ "sessionId": id })))
}

#[derive(Deserialize)]
struct ConnectSshReq {
    #[serde(rename = "connectionId")]
    connection_id: String,
}

async fn connect_ssh(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Json(req): Json<ConnectSshReq>,
) -> Result<Response, AppError> {
    // Client-execute (ADR 0011 §4 / ADR 0012 phase 6): in a remote context the
    // saved connection is an encrypted vault record — the local server decrypts
    // it and opens SSH from its own network position, streaming on the local /ws.
    if let Some(server) = state.remote_context() {
        let Some(key) = state.vault_key() else {
            return Ok(vault_locked());
        };
        let input = vault_conn::get_input(&state, &server, &key, &req.connection_id)
            .await?
            .ok_or_else(|| AppError(anyhow::anyhow!("connection not found")))?;
        let (connection, auth) = vault_conn::to_connection(&req.connection_id, input)?;
        let id = state
            .sessions
            .create_quick_ssh_session(
                connection,
                auth,
                state.events_sink(),
                state.interactive_provider(as_user(&user)),
            )
            .await?;
        state.record_session_owner(&id, as_user(&user));
        return Ok(Json(json!({ "sessionId": id })).into_response());
    }
    let id = state
        .sessions
        .create_session(
            req.connection_id.clone(),
            state.events_sink(),
            state.interactive_provider(as_user(&user)),
        )
        .await?;
    // Record "last used" in the local vault (ADR 0017 passive status). This is the local
    // single-user DB — the user's own machine — so unlike the accounts context (where it's
    // client-local to stay zero-knowledge) it's fine to persist it server-side here.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let _ = state
        .db
        .update_connection_last_used(&req.connection_id, now)
        .await;
    state.record_session_owner(&id, as_user(&user));
    Ok(Json(json!({ "sessionId": id })).into_response())
}

/// Quick-connect auth, mirroring the desktop `QuickAuthMethod` wire shape.
#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum QuickAuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
    Agent {
        identity: Option<String>,
        #[serde(default)]
        forward: bool,
    },
}

impl From<QuickAuthMethod> for AuthMethod {
    fn from(quick: QuickAuthMethod) -> Self {
        match quick {
            QuickAuthMethod::Password { password } => AuthMethod::Password { password },
            QuickAuthMethod::PublicKey {
                key_path,
                passphrase,
            } => AuthMethod::PublicKey {
                key_path,
                passphrase,
            },
            QuickAuthMethod::Agent { identity, forward } => AuthMethod::Agent { identity, forward },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuickSshReq {
    host: String,
    port: u16,
    username: String,
    auth_method: QuickAuthMethod,
}

async fn quick_ssh(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Json(req): Json<QuickSshReq>,
) -> Result<Json<Value>, AppError> {
    // Ad-hoc connection, never persisted (mirrors the desktop quick_ssh_connect).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let auth: AuthMethod = req.auth_method.clone().into();
    let connection = Connection {
        id: format!("quick-{}", uuid::Uuid::new_v4()),
        name: format!("{}@{}", req.username, req.host),
        protocol: Protocol::SSH,
        hostname: req.host,
        port: req.port,
        username: req.username,
        auth_method: auth.clone(),
        metadata: ConnectionMetadata {
            color: None,
            icon: Some("⚡".to_string()),
            folder: None,
            notes: Some("Quick connect (not saved)".to_string()),
        },
        ssh_keep_alive_override: None,
        ssh_keep_alive_interval: None,
        preconnect: None,
        last_used_at: None,
        created_at: now,
        updated_at: now,
    };
    let id = state
        .sessions
        .create_quick_ssh_session(
            connection,
            auth,
            state.events_sink(),
            state.interactive_provider(as_user(&user)),
        )
        .await?;
    state.record_session_owner(&id, as_user(&user));
    Ok(Json(json!({ "sessionId": id })))
}

#[derive(Deserialize)]
struct InputReq {
    data: Vec<u8>,
}

async fn send_input(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Path(id): Path<String>,
    Json(req): Json<InputReq>,
) -> Result<Response, AppError> {
    if !state.owns_session(&id, as_user(&user)) {
        return Ok(not_your_session());
    }
    state.sessions.send_input(&id, req.data).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn claim(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Path(id): Path<String>,
) -> Response {
    if !state.owns_session(&id, as_user(&user)) {
        return not_your_session();
    }
    let data = state.sessions.claim_session_output(&id).await;
    Json(json!({ "data": base64::engine::general_purpose::STANDARD.encode(&data) })).into_response()
}

#[derive(Deserialize)]
struct ResizeReq {
    cols: u32,
    rows: u32,
}

async fn resize(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Path(id): Path<String>,
    Json(req): Json<ResizeReq>,
) -> Result<Response, AppError> {
    if !state.owns_session(&id, as_user(&user)) {
        return Ok(not_your_session());
    }
    state
        .sessions
        .resize_terminal(&id, req.cols, req.rows)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn close(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if !state.owns_session(&id, as_user(&user)) {
        return Ok(not_your_session());
    }
    state.sessions.close_session(&id).await?;
    state.forget_session(&id);
    Ok(StatusCode::NO_CONTENT.into_response())
}

// --- websocket: stream `{event,payload}` messages to the client -------------

async fn ws_handler(
    State(state): State<ServerState>,
    user: Option<Extension<Arc<User>>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Multiplexer (ADR 0012 / 0011 §4): when a remote context is active, merge the
    // LOCAL event stream (client-execute SSH sessions run on this machine) with a
    // bridge to the remote's /ws (server-execute terminals stream through). Both
    // reach the same webview socket, so the two execution modes coexist. The local
    // multiplexer is single-user (not accounts mode), so no per-owner scoping here;
    // the remote does its own scoping.
    let active = { state.context.lock().unwrap().clone() };
    if let ActiveContext::Remote(server) = active {
        let token = state.remote_token.lock().unwrap().clone();
        let remote_url = remote_ws_url(&server.url, token.as_deref());
        let tls = state.tls_config.clone();
        let rx = state.events_tx.subscribe();
        return ws.on_upgrade(move |socket| merge_ws(socket, remote_url, tls, rx));
    }

    // Accounts mode: only forward events for sessions this user owns (ADR 0011
    // multi-user debt). Local/desktop mode (no accounts) forwards everything.
    let accounts = state.accounts;
    let owners = state.session_owners.clone();
    let user_id = as_user(&user).map(|u| u.id.clone());
    let mut rx = state.events_tx.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if event_visible_to(accounts, &owners, user_id.as_deref(), &msg)
                        && socket.send(Message::Text(msg.into())).await.is_err()
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// Build the remote's ws(s) URL for the proxy, carrying the session token in the
/// query (browsers can't set WS headers; the local proxy mirrors that).
fn remote_ws_url(base: &str, token: Option<&str>) -> String {
    let ws_base = base
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    match token {
        Some(t) => format!("{ws_base}/ws?token={t}"),
        None => format!("{ws_base}/ws"),
    }
}

/// Merge, onto one webview WebSocket, the LOCAL event stream (client-execute SSH
/// sessions) and a bridge to the active remote's `/ws` (server-execute). Events
/// are server→client (terminal input goes over HTTP), so this is one-directional
/// fan-in; inbound frames from the webview are drained. The TLS config carries the
/// pinned verifier (ADR 0012 §4).
async fn merge_ws(
    socket: axum::extract::ws::WebSocket,
    remote_url: String,
    tls: Arc<rustls::ClientConfig>,
    mut local_rx: broadcast::Receiver<String>,
) {
    use futures_util::{SinkExt, StreamExt};

    let (mut sink, mut client_stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(256);

    // Local events (client-execute terminals on this machine) → the webview.
    let tx_local = tx.clone();
    tokio::spawn(async move {
        loop {
            match local_rx.recv().await {
                Ok(msg) => {
                    if tx_local.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Remote /ws (server-execute terminals on the remote) → the webview.
    let tx_remote = tx.clone();
    tokio::spawn(async move {
        use tokio_tungstenite::tungstenite::Message as T;
        let connector = tokio_tungstenite::Connector::Rustls(tls);
        let remote = match tokio_tungstenite::connect_async_tls_with_config(
            &remote_url,
            None,
            false,
            Some(connector),
        )
        .await
        {
            Ok((stream, _)) => stream,
            Err(e) => {
                tracing::warn!("[rite-server] ws merge: remote connect failed: {e}");
                return;
            }
        };
        let (_w, mut remote_rx) = remote.split();
        while let Some(Ok(msg)) = remote_rx.next().await {
            let out = match msg {
                T::Text(t) => Message::Text(t.as_str().to_owned().into()),
                T::Binary(b) => Message::Binary(b.to_vec().into()),
                T::Close(_) => break,
                _ => continue,
            };
            if tx_remote.send(out).await.is_err() {
                break;
            }
        }
    });
    drop(tx); // only the two pumps hold senders now

    // Forward merged events to the webview until it disconnects.
    loop {
        tokio::select! {
            maybe = rx.recv() => match maybe {
                Some(m) => {
                    if sink.send(m).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            inbound = client_stream.next() => {
                if inbound.is_none() {
                    break; // webview closed the socket
                }
                // Inbound frames are ignored — terminal input is sent over HTTP.
            }
        }
    }
}

// --- error mapping ----------------------------------------------------------

/// Maps an internal error to a 500 JSON response.
struct AppError(anyhow::Error);

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!("[rite-server] request failed: {:#}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn register_limiter_caps_per_window_per_key() {
        let rl = RegisterLimiter::default();
        for _ in 0..RegisterLimiter::MAX {
            assert!(
                rl.check_and_record("1.2.3.4").is_none(),
                "attempts under the cap pass"
            );
        }
        assert!(
            rl.check_and_record("1.2.3.4").is_some(),
            "the (MAX+1)th attempt is limited (429)"
        );
        // A different client key has its own independent budget.
        assert!(rl.check_and_record("5.6.7.8").is_none());
    }

    #[test]
    fn client_key_prefers_first_forwarded_hop_else_global() {
        let mut h = HeaderMap::new();
        assert_eq!(client_key(&h), "global");
        h.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_key(&h), "203.0.113.7");
    }

    #[test]
    fn vault_key_holder_locks_and_expires() {
        use std::time::Duration;
        let mut h = VaultKeyHolder::new();
        assert!(h.get().is_none(), "starts locked");

        h.unlock([9u8; 32], Some(Duration::from_secs(1000)));
        assert_eq!(h.get(), Some([9u8; 32]), "unlocked key is retrievable");

        // Idle past the timeout → the key is zeroized (server-side auto-lock).
        h.last_active = std::time::Instant::now() - Duration::from_secs(2000);
        assert!(h.get().is_none(), "idle-expired key is gone");
        assert!(!h.check_expiry());

        // No-timeout unlock stays until an explicit lock.
        h.unlock([1u8; 32], None);
        assert!(h.get().is_some());
        h.lock();
        assert!(h.get().is_none(), "explicit lock zeroizes");
    }

    #[test]
    fn remote_url_normalizes_scheme_host_and_trailing_slash() {
        // Scheme + host lowercased, trailing slash dropped; a path is kept (not lowercased).
        assert_eq!(
            normalize_remote_url("  HTTPS://Rite.Example.COM/ "),
            "https://rite.example.com"
        );
        assert_eq!(
            normalize_remote_url("https://rite.example.com"),
            "https://rite.example.com"
        );
        assert_eq!(
            normalize_remote_url("https://Host:8443/Base/"),
            "https://host:8443/Base"
        );
    }

    #[test]
    fn remote_origin_matches_registry_key_semantics() {
        // Same origin key for every spelling that the shell's ContextKey::server collapses:
        // case, trailing slash, and any path all fold to one origin.
        let want = "https://rite.example.com";
        for spelling in [
            "https://rite.example.com",
            "HTTPS://Rite.Example.com/",
            "https://rite.example.com/some/path",
            "  https://RITE.example.com  ",
        ] {
            assert_eq!(
                remote_origin(spelling),
                want,
                "{spelling} should map to {want}"
            );
        }
        // A different port is a different origin.
        assert_ne!(
            remote_origin("https://rite.example.com"),
            remote_origin("https://rite.example.com:8443")
        );
    }

    async fn test_state() -> ServerState {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        ServerState::new(&dir.path().join("vault.db"))
            .await
            .unwrap()
    }

    fn test_user(id: &str) -> User {
        User {
            id: id.to_string(),
            username: id.to_string(),
            role: rite_core::server_auth::Role::User,
            status: "active".to_string(),
            created_at: 0,
            must_change_password: false,
        }
    }

    #[tokio::test]
    async fn sessions_are_sealed_to_their_owner() {
        // Local/desktop mode (no accounts): everything is allowed (single user).
        let local = test_state().await;
        assert!(local.owns_session("s1", None));

        // Accounts mode: only the recorded owner may drive the session.
        let state = test_state().await.with_accounts();
        let alice = test_user("alice");
        let bob = test_user("bob");
        state.record_session_owner("s1", Some(&alice));
        assert!(state.owns_session("s1", Some(&alice)));
        assert!(
            !state.owns_session("s1", Some(&bob)),
            "another user is denied"
        );
        assert!(!state.owns_session("s1", None), "anonymous is denied");
        assert!(
            !state.owns_session("ghost", Some(&alice)),
            "an unrecorded session is denied in accounts mode"
        );
        state.forget_session("s1");
        assert!(
            !state.owns_session("s1", Some(&alice)),
            "closed session is forgotten"
        );
    }

    #[test]
    fn ws_events_are_scoped_by_owner() {
        let owners =
            std::sync::Mutex::new(HashMap::from([("s1".to_string(), "alice".to_string())]));
        let data = r#"{"event":"terminal-data","payload":{"sessionId":"s1","data":"x"}}"#;
        // No accounts → everything is visible (single user).
        assert!(event_visible_to(false, &owners, Some("bob"), data));
        // Accounts → a session event reaches only its owner.
        assert!(event_visible_to(true, &owners, Some("alice"), data));
        assert!(!event_visible_to(true, &owners, Some("bob"), data));
        // A non-session event (host-key) is still broadcast (documented follow-up).
        let hostkey = r#"{"event":"ssh:host-key-unknown","payload":{"host":"h","port":22}}"#;
        assert!(event_visible_to(true, &owners, Some("bob"), hostkey));
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let app = build_router(test_state().await);
        let res = app
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn fresh_vault_is_first_run() {
        let app = build_router(test_state().await);
        let res = app
            .oneshot(
                Request::get("/api/auth/first-run")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn capabilities_reports_version() {
        let app = build_router(test_state().await);
        let res = app
            .oneshot(
                Request::get("/api/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn token_guard_rejects_and_allows() {
        let app = build_router(test_state().await.with_token("secret"));

        // No Host + no token => rejected (non-loopback host).
        let res = app
            .clone()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // Loopback Host but wrong token => 401.
        let res = app
            .clone()
            .oneshot(
                Request::get("/api/health")
                    .header("host", "127.0.0.1")
                    .header("authorization", "Bearer nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // Loopback Host + correct token => OK.
        let res = app
            .oneshot(
                Request::get("/api/health")
                    .header("host", "127.0.0.1")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn no_sessions_initially() {
        let app = build_router(test_state().await);
        let res = app
            .oneshot(Request::get("/api/terminal").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
