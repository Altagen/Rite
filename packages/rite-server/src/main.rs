//! rite-server binary: open the vault and serve the HTTP API on local TCP.
//!
//! Phase-2 skeleton — TCP on 127.0.0.1 for easy testing. A Unix-socket bind
//! (local desktop shell) and TCP+TLS (shared server) come in later phases.

use anyhow::{Context, Result};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    // Pin the process-level rustls CryptoProvider to ring. Both the TLS server
    // (axum-server) and the multiplexer's TLS clients (reqwest / tokio-tungstenite)
    // otherwise fail to auto-select a provider when the tree exposes more than one.
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

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

        // Non-interactive admin bootstrap for headless deploys: on a fresh
        // server, RITE_ADMIN_USER + RITE_ADMIN_PASSWORD(_FILE) create the admin.
        if let Some((user, pass)) = admin_bootstrap_creds()
            && !rite_core::server_auth::has_any_user(state.db.pool()).await?
        {
            rite_core::server_auth::bootstrap_admin(state.db.pool(), &user, &pass).await?;
            info!("[rite-server] bootstrapped admin '{user}' from the environment");
        }
    }
    // RITE_ADDR default = loopback; port 0 lets the OS pick a free port (the
    // desktop shell reads the bound port back to point the webview at it).
    let addr = std::env::var("RITE_ADDR").unwrap_or_else(|_| "127.0.0.1:1421".to_string());

    let host = addr.rsplit_once(':').map_or(addr.as_str(), |(h, _)| h);
    let is_loopback = matches!(host, "::1" | "localhost") || host.starts_with("127.");

    // RITE_TLS_CERT + RITE_TLS_KEY (PEM) enable built-in TLS (ADR 0010).
    let cert = std::env::var("RITE_TLS_CERT")
        .ok()
        .filter(|v| !v.is_empty());
    let key = std::env::var("RITE_TLS_KEY").ok().filter(|v| !v.is_empty());
    let tls_configured = cert.is_some() && key.is_some();

    // Secure-by-default: refuse to serve accounts over plaintext HTTP on a
    // non-loopback address unless TLS is on, or the operator explicitly accepts
    // it (behind a TLS-terminating reverse proxy, or a trusted network).
    let allow_insecure =
        std::env::var("RITE_ALLOW_INSECURE_HTTP").is_ok_and(|v| v == "1" || v == "true");
    if state.accounts && !is_loopback && !tls_configured && !allow_insecure {
        anyhow::bail!(
            "refusing to serve accounts over plaintext HTTP on {addr}.\n\
             Set RITE_TLS_CERT + RITE_TLS_KEY for direct TLS (see docs/SERVER.md for a\n\
             self-signed certificate), or set RITE_ALLOW_INSECURE_HTTP=1 if this is behind\n\
             a TLS-terminating reverse proxy or on a trusted network."
        );
    }

    match (cert, key) {
        (Some(cert), Some(key)) => {
            info!("[rite-server] listening on https://{addr} (built-in TLS)");
            rite_server::serve_tls(state, &addr, cert.as_ref(), key.as_ref()).await?;
        }
        _ => {
            if state.accounts && !is_loopback {
                info!("[rite-server] WARNING: serving accounts over plaintext HTTP on {addr}");
            }
            rite_server::serve(state, &addr, |port| {
                info!("[rite-server] listening on http://{host}:{port}");
            })
            .await?;
        }
    }
    Ok(())
}

/// Admin bootstrap credentials from the environment: `RITE_ADMIN_USER` plus
/// either `RITE_ADMIN_PASSWORD_FILE` (preferred — read from a mounted secret) or
/// `RITE_ADMIN_PASSWORD`. Returns `None` if not fully set.
fn admin_bootstrap_creds() -> Option<(String, String)> {
    let user = std::env::var("RITE_ADMIN_USER")
        .ok()
        .filter(|v| !v.is_empty())?;
    let pass = std::env::var("RITE_ADMIN_PASSWORD_FILE")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .or_else(|| std::env::var("RITE_ADMIN_PASSWORD").ok())
        .filter(|v| !v.is_empty())?;
    Some((user, pass))
}
