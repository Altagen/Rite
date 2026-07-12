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
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine as _;
use rite_core::auth::{AuthManager, UnlockResult};
use rite_core::connections_manager::ConnectionsManager;
use rite_core::db::Database;
use rite_core::terminal::SessionManager;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;

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
        })
    }

    /// A `SessionEvents` sink that broadcasts session output to WebSocket clients.
    fn events_sink(&self) -> Arc<WsSessionEvents> {
        Arc::new(WsSessionEvents::new(self.events_tx.clone()))
    }
}

/// Build the HTTP/WebSocket router. The desktop shell and the standalone server
/// share it.
pub fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/first-run", get(first_run))
        .route("/api/auth/locked", get(locked))
        .route("/api/auth/unlock", post(unlock))
        .route("/api/settings", get(settings))
        .route("/api/terminal", get(list_sessions))
        .route("/api/terminal/local", post(create_local))
        .route("/api/terminal/{id}/input", post(send_input))
        .route("/api/terminal/{id}/claim", post(claim))
        .route("/api/terminal/{id}/resize", post(resize))
        .route("/api/terminal/{id}", delete(close))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

// --- read endpoints ---------------------------------------------------------

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "rite-server" }))
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
struct UnlockReq {
    password: String,
}

async fn unlock(
    State(state): State<ServerState>,
    Json(req): Json<UnlockReq>,
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
    async fn no_sessions_initially() {
        let app = build_router(test_state().await);
        let res = app
            .oneshot(Request::get("/api/terminal").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
