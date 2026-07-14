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
    // RITE_ACCOUNTS enables server mode (accounts + sessions, ADR 0010) for a
    // shared/team server.
    if std::env::var("RITE_ACCOUNTS").is_ok_and(|v| v == "1" || v == "true") {
        state = state.with_accounts();
        info!("[rite-server] server mode enabled (accounts + sessions)");
    }
    // RITE_ADDR default = loopback; port 0 lets the OS pick a free port (the
    // desktop shell reads the bound port back to point the webview at it).
    let addr = std::env::var("RITE_ADDR").unwrap_or_else(|_| "127.0.0.1:1421".to_string());

    // RITE_TLS_CERT + RITE_TLS_KEY (PEM) enable built-in TLS (ADR 0010). For
    // production behind a reverse proxy, leave these unset (the proxy terminates
    // TLS) — see docs/RELEASE / decisions/0010.
    match (
        std::env::var("RITE_TLS_CERT"),
        std::env::var("RITE_TLS_KEY"),
    ) {
        (Ok(cert), Ok(key)) if !cert.is_empty() && !key.is_empty() => {
            info!("[rite-server] listening on https://{addr} (built-in TLS)");
            rite_server::serve_tls(state, &addr, cert.as_ref(), key.as_ref()).await?;
        }
        _ => {
            let host = addr.rsplit_once(':').map_or(addr.as_str(), |(h, _)| h);
            rite_server::serve(state, &addr, |port| {
                info!("[rite-server] listening on http://{host}:{port}");
            })
            .await?;
        }
    }
    Ok(())
}
