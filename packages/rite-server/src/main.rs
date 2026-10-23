//! rite-server binary: open the vault and serve the HTTP API on local TCP.
//!
//! Phase-2 skeleton — TCP on 127.0.0.1 for easy testing. A Unix-socket bind
//! (local desktop shell) and TCP+TLS (shared server) come in later phases.

use anyhow::{Context, Result};
use tracing::{info, warn};

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
        match admin_bootstrap_creds() {
            Some((user, pass))
                if !rite_core::server_auth::has_any_user(state.db.pool()).await? =>
            {
                rite_core::server_auth::bootstrap_admin(state.db.pool(), &user, &pass).await?;
                info!("[rite-server] bootstrapped admin '{user}' from the environment");
            }
            // A password that is still mounted on an instance that already has accounts is
            // a live admin credential at rest, doing nothing. It used to be read and
            // silently ignored at every start, which is how it stays there for months.
            Some(_) => warn!(
                "[rite-server] an admin bootstrap password is still configured, and this \
                 instance already has accounts — nothing was created. Remove the secret \
                 (deploy/admin_password.txt and the RITE_ADMIN_* variables): it is a live \
                 credential that no longer does anything."
            ),
            None => {}
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
    resolve_bootstrap_creds(
        std::env::var("RITE_ADMIN_USER").ok(),
        std::env::var("RITE_ADMIN_PASSWORD_FILE")
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok()),
        std::env::var("RITE_ADMIN_PASSWORD").ok(),
    )
}

/// The rule itself, with the environment read out of it so it can be tested.
///
/// **An EMPTY password file means "do not bootstrap".** The bootstrap now lives in an
/// override (`deploy/compose.bootstrap.yml`), so the ordinary way to get the browser's
/// `Create the server administrator` is to leave that override out. Emptying the file is
/// the other way — it keeps the override in place and leaves no password at rest, which is
/// what an operator who has finished bootstrapping wants.
///
/// An empty file does NOT fall through to `RITE_ADMIN_PASSWORD`: the operator who emptied
/// it asked for no bootstrap, and silently using a variable they had also set would be the
/// opposite of that.
fn resolve_bootstrap_creds(
    user: Option<String>,
    password_file: Option<String>,
    password_var: Option<String>,
) -> Option<(String, String)> {
    let user = user.filter(|v| !v.is_empty())?;
    let pass = password_file
        .map(|s| s.trim().to_string())
        .or(password_var)
        .filter(|v| !v.is_empty())?;
    Some((user, pass))
}

#[cfg(test)]
mod tests {
    use super::resolve_bootstrap_creds;

    /// The documented opt-out (`docs/SERVER.md`). Dropping the bootstrap override is the
    /// first way out; EMPTYING the file is the second, for a deployment that keeps the
    /// override — compose refuses to start when a secret's source is missing, so the file
    /// has to exist. That is a contract now, so it is pinned here.
    #[test]
    fn an_empty_password_file_means_no_bootstrap() {
        let some = |s: &str| Some(s.to_string());

        // The turnkey path: a user and a file with a password in it.
        assert_eq!(
            resolve_bootstrap_creds(some("admin"), some("a-strong-password\n"), None),
            Some(("admin".to_string(), "a-strong-password".to_string())),
            "a trailing newline is how `printf`/`echo` leave it, and must be trimmed"
        );

        // Emptied on purpose: no account is created, and the web UI offers to create one.
        assert_eq!(resolve_bootstrap_creds(some("admin"), some(""), None), None);
        assert_eq!(
            resolve_bootstrap_creds(some("admin"), some("   \n\t"), None),
            None
        );

        // …and it does NOT fall through to the variable. Someone who emptied the file
        // asked for no bootstrap; quietly using a password they had also set elsewhere
        // would be the opposite of what they asked.
        assert_eq!(
            resolve_bootstrap_creds(some("admin"), some(""), some("from-the-variable")),
            None,
            "an emptied file is a decision, not a gap to fill"
        );

        // The variable is the fallback only when there is no file at all.
        assert_eq!(
            resolve_bootstrap_creds(some("admin"), None, some("from-the-variable")),
            Some(("admin".to_string(), "from-the-variable".to_string()))
        );

        // No user, no bootstrap — whatever the password says.
        assert_eq!(resolve_bootstrap_creds(None, some("p"), None), None);
        assert_eq!(resolve_bootstrap_creds(some(""), some("p"), None), None);
    }
}
