//! Embedded frontend assets (the built React app) + SPA fallback.
//!
//! The UI is embedded into the binary so a single `rite` ships it (ADR 0004).
//! The embed folder `web/` is committed with only a `.gitkeep`; the release
//! build copies `apps/desktop/dist/*` into it. So in CI / dev the embed is empty
//! and this handler returns 404 (the API and `/ws` still work); a release binary
//! serves the real frontend. Unknown paths fall back to `index.html` for SPA
//! routing.

use std::path::PathBuf;

use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web"]
struct Assets;

/// Serve an embedded asset, falling back to `index.html` for SPA routes.
pub async fn static_handler(uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };

    if let Some(file) = Assets::get(path) {
        let mime = file.metadata.mimetype().to_string();
        return ([(header::CONTENT_TYPE, mime)], file.data.into_owned()).into_response();
    }

    match Assets::get("index.html") {
        Some(index) => (
            [(header::CONTENT_TYPE, "text/html".to_string())],
            index.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "frontend not built").into_response(),
    }
}

/// Serve the frontend from a directory on disk (dev harness, `RITE_WEB_DIR`)
/// instead of the compile-time embed, so the frontend can be rebuilt without
/// recompiling the server. Same SPA fallback as `static_handler`.
pub async fn dir_handler(base: PathBuf, uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let rel = if raw.is_empty() { "index.html" } else { raw };
    // The path comes from a URL; reject traversal before touching the disk.
    if rel.split('/').any(|seg| seg == "..") {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }

    if let Ok(bytes) = tokio::fs::read(base.join(rel)).await {
        return ([(header::CONTENT_TYPE, mime_for(rel))], bytes).into_response();
    }
    match tokio::fs::read(base.join("index.html")).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "text/html".to_string())], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "frontend not built").into_response(),
    }
}

/// Minimal extension→MIME map for the dev dir handler (the frontend only ships
/// these types). The embedded handler uses rust-embed's richer detection.
fn mime_for(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "json" => "application/json",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
    .to_string()
}
