//! rite-server binary: open the vault and serve the HTTP API on local TCP.
//!
//! Phase-2 skeleton — TCP on 127.0.0.1 for easy testing. A Unix-socket bind
//! (local desktop shell) and TCP+TLS (shared server) come in later phases.

use anyhow::{Context, Result};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    let db_path = dirs::data_dir()
        .context("could not resolve the user data directory")?
        .join("rite")
        .join("vault.db");
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    info!("[rite-server] vault at {}", db_path.display());

    let mut state = rite_server::ServerState::new(&db_path).await?;
    // RITE_TOKEN gates API/WS in local desktop mode (ADR 0009). Absent =>
    // dev/container mode with no token (shared-server auth comes in Phase 5).
    if let Ok(token) = std::env::var("RITE_TOKEN")
        && !token.is_empty()
    {
        state = state.with_token(token);
        info!("[rite-server] local-transport guard enabled (token required)");
    }
    let app = rite_server::build_router(state);

    // RITE_ADDR default = loopback; port 0 lets the OS pick a free port (the
    // desktop shell reads the bound port back to point the webview at it).
    let addr = std::env::var("RITE_ADDR").unwrap_or_else(|_| "127.0.0.1:1421".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let local = listener.local_addr()?;
    info!("[rite-server] listening on http://{local}");
    axum::serve(listener, app).await?;
    Ok(())
}
