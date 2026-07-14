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
    /// HTTP client for proxying to the active remote.
    http_client: reqwest::Client,
}

/// A saved remote server in the roster (ADR 0012). No token here — the remote
/// session lives in RAM only (see the proxy phase).
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServer {
    pub id: String,
    pub url: String,
    pub label: String,
}

/// The one active context (ADR 0006 single active context).
#[derive(Clone)]
enum ActiveContext {
    Local,
    Remote(RemoteServer),
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
            http_client: reqwest::Client::new(),
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
        .route("/api/context", get(get_context))
        .route("/api/context/servers", post(add_server))
        .route("/api/context/servers/{id}", delete(remove_server))
        .route("/api/context/active", post(set_active_context))
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
    // harness). /ws is proxied in a later phase.
    if is_api && path != "/ws" && path != "/api/health" && !path.starts_with("/api/context") {
        let active = { state.context.lock().unwrap().clone() };
        if let ActiveContext::Remote(server) = active {
            return proxy_to_remote(&state, &server, req).await;
        }
    }

    next.run(req).await
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

async fn list_sessions(State(state): State<ServerState>) -> Json<Vec<String>> {
    Json(state.sessions.list_sessions().await)
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
    Ok(Json(
        json!({ "accounts": state.accounts, "needsBootstrap": needs_bootstrap }),
    ))
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
            Ok(Json(json!({ "token": token, "user": user })).into_response())
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
    let user = server_auth::create_user(
        state.db.pool(),
        &req.username,
        &salt,
        req.params,
        &req.auth_hash,
        Role::Admin,
    )
    .await?;
    let token = server_auth::create_session(state.db.pool(), &user.id).await?;
    Ok(Json(json!({ "token": token, "user": user })).into_response())
}

/// The current authenticated user (guard inserted it).
async fn server_me(Extension(user): Extension<Arc<User>>) -> Json<User> {
    Json((*user).clone())
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
}

async fn admin_create_user(
    State(state): State<ServerState>,
    Json(req): Json<CreateUserReq>,
) -> Result<Response, AppError> {
    let salt = server_auth::parse_hex_salt(&req.salt)?;
    match server_auth::create_user(
        state.db.pool(),
        &req.username,
        &salt,
        req.params,
        &req.auth_hash,
        req.role,
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

async fn get_connections(
    State(state): State<ServerState>,
) -> Result<Json<Vec<ConnectionInfo>>, AppError> {
    Ok(Json(state.connections.get_all_connections().await?))
}

async fn create_connection(
    State(state): State<ServerState>,
    Json(input): Json<CreateConnectionInput>,
) -> Result<Json<ConnectionInfo>, AppError> {
    Ok(Json(state.connections.create_connection(input).await?))
}

async fn update_connection(
    State(state): State<ServerState>,
    Path(_id): Path<String>,
    Json(input): Json<UpdateConnectionInput>,
) -> Result<Json<ConnectionInfo>, AppError> {
    // `UpdateConnectionInput` carries its own id; the path id is for REST shape.
    Ok(Json(state.connections.update_connection(input).await?))
}

async fn delete_connection(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.connections.delete_connection(&id).await?;
    Ok(StatusCode::NO_CONTENT)
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
        *state.context.lock().unwrap() = ActiveContext::Local;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    match load_roster(&state)
        .await
        .into_iter()
        .find(|s| s.id == req.server)
    {
        Some(s) => {
            *state.context.lock().unwrap() = ActiveContext::Remote(s);
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        None => Ok((StatusCode::NOT_FOUND, "unknown server").into_response()),
    }
}

/// If a remote context is active, best-effort revoke its session on the remote,
/// then drop the local token (ADR 0012 §5 — no orphan sessions).
async fn clear_remote_session(state: &ServerState) {
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
    Json(req): Json<LocalReq>,
) -> Result<Json<Value>, AppError> {
    let id = state
        .sessions
        .create_local_session(state.events_sink(), req.shell)
        .await?;
    Ok(Json(json!({ "sessionId": id })))
}

#[derive(Deserialize)]
struct ConnectSshReq {
    #[serde(rename = "connectionId")]
    connection_id: String,
}

async fn connect_ssh(
    State(state): State<ServerState>,
    Json(req): Json<ConnectSshReq>,
) -> Result<Json<Value>, AppError> {
    let id = state
        .sessions
        .create_session(req.connection_id, state.events_sink())
        .await?;
    Ok(Json(json!({ "sessionId": id })))
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
    Ok(Json(json!({ "sessionId": id })))
}

#[derive(Deserialize)]
struct InputReq {
    data: Vec<u8>,
}

async fn send_input(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<InputReq>,
) -> Result<StatusCode, AppError> {
    state.sessions.send_input(&id, req.data).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn claim(State(state): State<ServerState>, Path(id): Path<String>) -> Json<Value> {
    let data = state.sessions.claim_session_output(&id).await;
    Json(json!({ "data": base64::engine::general_purpose::STANDARD.encode(&data) }))
}

#[derive(Deserialize)]
struct ResizeReq {
    cols: u32,
    rows: u32,
}

async fn resize(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(req): Json<ResizeReq>,
) -> Result<StatusCode, AppError> {
    state
        .sessions
        .resize_terminal(&id, req.cols, req.rows)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn close(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.sessions.close_session(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- websocket: stream `{event,payload}` messages to the client -------------

async fn ws_handler(State(state): State<ServerState>, ws: WebSocketUpgrade) -> Response {
    let mut rx = state.events_tx.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if socket.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
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

    async fn test_state() -> ServerState {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        ServerState::new(&dir.path().join("vault.db"))
            .await
            .unwrap()
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
