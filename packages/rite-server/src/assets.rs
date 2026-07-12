//! Embedded frontend assets (the built React app) + SPA fallback.
//!
//! The UI is embedded into the binary so a single `rite` ships it (ADR 0004).
//! The embed folder `web/` is committed with only a `.gitkeep`; the release
//! build copies `apps/desktop/dist/*` into it. So in CI / dev the embed is empty
//! and this handler returns 404 (the API and `/ws` still work); a release binary
//! serves the real frontend. Unknown paths fall back to `index.html` for SPA
//! routing.

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
