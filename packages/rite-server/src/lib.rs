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
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
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
        .with_state(state)
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
        req.extensions_mut().insert(Arc::new(user));
    }

    next.run(req).await
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
    match server_auth::verify_login(state.db.pool(), &req.username, &req.auth_hash).await? {
        Some(user) => {
            let token = server_auth::create_session(state.db.pool(), &user.id).await?;
            Ok(Json(json!({ "token": token, "user": user })).into_response())
        }
        None => Ok((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid credentials" })),
        )
            .into_response()),
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
