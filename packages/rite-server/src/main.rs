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

    let state = rite_server::ServerState::new(&db_path).await?;
    let app = rite_server::build_router(state);

    let addr = "127.0.0.1:1421";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("[rite-server] listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
