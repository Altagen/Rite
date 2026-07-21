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
use rite_core::auth::{AuthManager, UnlockResult};
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
mod tls_pin;
mod vault_conn;
mod ws_events;
use ws_events::WsSessionEvents;

/// Shared server state: the rite-core managers plus a broadcast of session
/// events to connected WebSocket clients.
#[derive(Clone)]
pub struct ServerState {
    pub db: Database,
    pub auth: Arc<AuthManager>,
    pub connections: Arc<ConnectionsManager>,
    pub sessions: Arc<SessionManager>,
    pub events_tx: broadcast::Sender<String>,
    /// When set (local desktop shell), API/WS requests require this bearer token
    /// and a loopback Host — the ADR 0009 local-transport guard. `None` in
    /// dev/container mode.
    pub token: Option<Arc<String>>,
    /// Server mode (ADR 0010): API/WS require a valid session (login-issued
    /// bearer token) instead of the loopback launch token. Mutually exclusive
    /// with `token` in practice (local shell vs shared server).
    pub accounts: bool,
    /// Per-account login rate limiter (brute-force protection, server mode).
    login_limiter: Arc<LoginLimiter>,
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
            login_limiter: Arc::new(LoginLimiter::default()),
            tls: false,
            context: Arc::new(std::sync::Mutex::new(ActiveContext::Local)),
            remote_token: Arc::new(std::sync::Mutex::new(None)),
            http_client,
            cert_pin,
            tls_config,
            vault: Arc::new(std::sync::Mutex::new(VaultKeyHolder::new())),
            session_owners: Arc::new(std::sync::Mutex::new(HashMap::new())),
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

    /// A `SessionEvents` sink that broadcasts session output to WebSocket clients.
    fn events_sink(&self) -> Arc<WsSessionEvents> {
        Arc::new(WsSessionEvents::new(self.events_tx.clone()))
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
        .route("/api/server/me", get(server_me))
        .route(
            "/api/admin/users",
            get(admin_list_users).post(admin_create_user),
        )
        .route("/api/admin/users/{id}", delete(admin_delete_user))
        .route("/api/admin/users/{id}/status", patch(admin_set_status))
        .route("/api/admin/instance", patch(set_instance_name))
        // Teams / RBAC (product-model.md). Org-admin manages teams (/api/admin/*,
        // guard-gated to admin); team management is per-team authorized in-handler.
        .route(
            "/api/admin/teams",
            get(admin_list_teams).post(admin_create_team),
        )
        .route("/api/admin/teams/{id}", delete(admin_delete_team))
        .route("/api/teams", get(my_teams))
        .route(
            "/api/teams/{id}/members",
            get(team_members).post(add_team_member),
        )
        .route(
            "/api/teams/{id}/members/{userId}",
            delete(remove_team_member),
        )
        .route(
            "/api/teams/{id}/members/{userId}/key",
            post(grant_team_key).delete(revoke_team_key),
        )
        // Team shared connections (ADR 0013): opaque ciphertext, only for members
        // who hold the team key.
        .route(
            "/api/teams/{id}/connections",
            get(team_conn_list).post(team_conn_create),
        )
        .route(
            "/api/teams/{id}/connections/{cid}",
            put(team_conn_update).delete(team_conn_delete),
        )
        // Collections (ADR 0016): the sharing primitive. Members hold the sealed
        // collection key; roles (owner/editor/viewer) gate manage vs write. The
        // server stores only opaque blobs (names + items encrypted).
        .route("/api/directory", get(directory_ep))
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
        .route("/api/context", get(get_context))
        .route("/api/context/servers", post(add_server))
        .route("/api/context/servers/{id}", delete(remove_server))
        .route("/api/context/servers/{id}/pin", post(pin_server))
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
        .route("/api/ssh-config/default-path", get(default_ssh_config_path))
        .route("/api/ssh-config/parse", post(parse_ssh_config))
        .route("/api/ssh-config/import", post(import_ssh_config))
        .route("/api/ssh/host-key/accept", post(accept_host_key))
        .route("/api/ssh/host-key/reject", post(reject_host_key))
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
/// serve until shutdown. The desktop shell uses this to learn the random local
/// port for its webview.
pub async fn serve(state: ServerState, addr: &str, on_bound: impl FnOnce(u16)) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    on_bound(listener.local_addr()?.port());
    axum::serve(listener, build_router(state)).await?;
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
    axum_server::bind_rustls(socket, config)
        .serve(build_router(state.with_tls()).into_make_service())
        .await?;
    Ok(())
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
        // Admin endpoints require the admin role.
        if path.starts_with("/api/admin") && user.role != Role::Admin {
            return (StatusCode::FORBIDDEN, "admin role required").into_response();
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

    let is_login = path == "/api/server/login" || path == "/api/server/bootstrap";

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
    Ok(Json(json!({
        "accounts": state.accounts,
        "needsBootstrap": needs_bootstrap,
        "instanceName": instance_name,
    })))
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
    )
    .await?;
    let token = server_auth::create_session(state.db.pool(), &user.id).await?;
    let vault_out = server_auth::get_user_vault(state.db.pool(), &user.id).await?;
    Ok(Json(json!({ "token": token, "user": user, "vault": vault_out })).into_response())
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

async fn admin_create_user(
    State(state): State<ServerState>,
    Json(req): Json<CreateUserReq>,
) -> Result<Response, AppError> {
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
    let ok = server_auth::set_user_status(state.db.pool(), &id, &req.status).await?;
    Ok(if ok {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
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
    if !can_admin_team(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "not a team admin").into_response());
    }
    Ok(
        if rite_core::teams::remove_member(state.db.pool(), &id, &user_id).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::NOT_FOUND.into_response()
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantKeyReq {
    /// The team key sealed to the target member's public key (ADR 0013).
    protected_team_key: String,
}

/// Grant (or initialize) a member's team key. Two cases:
/// - **Init**: the caller seals the first team key to *themselves* while the team
///   has no key-holder yet — they must be a team member.
/// - **Grant**: a key-holder (who can seal the real key) that is also a team-admin
///   seals it to another member.
/// The server stores only the sealed blob and can't verify its contents — it
/// trusts a key-holder to seal the correct key (a griefing risk bounded to the team).
async fn grant_team_key(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, target)): Path<(String, String)>,
    Json(req): Json<GrantKeyReq>,
) -> Result<Response, AppError> {
    let db = state.db.pool();
    let is_init = target == user.id && !rite_core::teams::team_has_any_key(db, &id).await?;
    let allowed = if is_init {
        rite_core::teams::team_role(db, &id, &user.id)
            .await?
            .is_some()
    } else {
        can_admin_team(&state, &user, &id).await?
            && rite_core::teams::member_has_key(db, &id, &user.id).await?
    };
    if !allowed {
        return Ok((StatusCode::FORBIDDEN, "not a key-holder admin").into_response());
    }
    Ok(
        if rite_core::teams::set_member_key(db, &id, &target, &req.protected_team_key).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "target is not a team member").into_response()
        },
    )
}

/// Revoke a member's key grant (clears their sealed key). Team-admin / org-admin.
/// Key rotation (against a cached key) is deferred — see ADR 0013.
async fn revoke_team_key(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, target)): Path<(String, String)>,
) -> Result<Response, AppError> {
    if !can_admin_team(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "not a team admin").into_response());
    }
    Ok(
        if rite_core::teams::clear_member_key(state.db.pool(), &id, &target).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "no key to revoke").into_response()
        },
    )
}

// --- team connections (ADR 0013) --------------------------------------------
// Opaque ciphertext scoped by team; only a member who holds the team key (and can
// therefore decrypt) may read or write. Org-admins without the key have no access
// — zero-knowledge. The server never parses the blob.

/// A 403 for a caller who isn't a key-holding member of the team.
async fn require_team_key(
    state: &ServerState,
    user: &User,
    team_id: &str,
) -> Result<bool, AppError> {
    Ok(rite_core::teams::member_has_key(state.db.pool(), team_id, &user.id).await?)
}

async fn team_conn_list(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    if !require_team_key(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "no team key").into_response());
    }
    Ok(Json(rite_core::team_store::list(state.db.pool(), &id).await?).into_response())
}

async fn team_conn_create(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path(id): Path<String>,
    Json(req): Json<VaultBlobReq>,
) -> Result<Response, AppError> {
    if !require_team_key(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "no team key").into_response());
    }
    let item = rite_core::team_store::create(state.db.pool(), &id, &req.blob).await?;
    Ok((StatusCode::CREATED, Json(item)).into_response())
}

async fn team_conn_update(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, cid)): Path<(String, String)>,
    Json(req): Json<VaultBlobReq>,
) -> Result<Response, AppError> {
    if !require_team_key(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "no team key").into_response());
    }
    Ok(
        if rite_core::team_store::update(state.db.pool(), &id, &cid, &req.blob).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "unknown connection").into_response()
        },
    )
}

async fn team_conn_delete(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Path((id, cid)): Path<(String, String)>,
) -> Result<Response, AppError> {
    if !require_team_key(&state, &user, &id).await? {
        return Ok((StatusCode::FORBIDDEN, "no team key").into_response());
    }
    Ok(
        if rite_core::team_store::delete(state.db.pool(), &id, &cid).await? {
            StatusCode::NO_CONTENT.into_response()
        } else {
            (StatusCode::NOT_FOUND, "unknown connection").into_response()
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
    protected_collection_key: String,
}

async fn create_collection_ep(
    State(state): State<ServerState>,
    Extension(user): Extension<Arc<User>>,
    Json(req): Json<CreateCollectionReq>,
) -> Result<Response, AppError> {
    let id = coll::create_collection(
        state.db.pool(),
        &req.name_enc,
        &user.id,
        &req.protected_collection_key,
    )
    .await?;
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
    protected_collection_key: String,
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
    match coll::add_member(
        state.db.pool(),
        &id,
        &req.user_id,
        req.role,
        &req.protected_collection_key,
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
    let url = req.url.trim().trim_end_matches('/').to_string();
    if !is_valid_remote_url(&url) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "remote must be https:// (http:// only on loopback)" })),
        )
            .into_response());
    }
    let mut roster = load_roster(&state).await;
    if roster.iter().any(|s| s.url == url) {
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
    };
    roster.push(entry.clone());
    save_roster(&state, &roster).await?;
    Ok((StatusCode::CREATED, Json(entry)).into_response())
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
    State(state): State<ServerState>,
    Json(req): Json<ProbeReq>,
) -> Result<Response, AppError> {
    let url = req.url.trim().trim_end_matches('/').to_string();
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
            .create_quick_ssh_session(connection, auth, state.events_sink())
            .await?;
        state.record_session_owner(&id, as_user(&user));
        return Ok(Json(json!({ "sessionId": id })).into_response());
    }
    let id = state
        .sessions
        .create_session(req.connection_id, state.events_sink())
        .await?;
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
        last_used_at: None,
        created_at: now,
        updated_at: now,
    };
    let id = state
        .sessions
        .create_quick_ssh_session(connection, auth, state.events_sink())
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
