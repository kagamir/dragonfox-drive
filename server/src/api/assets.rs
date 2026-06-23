//! Embedded static asset serving.
//!
//! In release builds the frontend's built `dist/` directory is embedded into
//! the binary via `rust-embed`. In development the Vite dev server is used
//! directly (the developer points a browser at `http://localhost:5173`), so
//! the embed is compiled out via `cfg(debug_assertions)` and `web/dist` does
//! not need to exist.

use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};

// Embedding is only compiled in for release builds. This keeps `cargo run`
// (debug) working without a prior `npm run build` in `web/`, matching the
// README's dev workflow.
#[cfg(not(debug_assertions))]
use rust_embed::{EmbeddedFile, RustEmbed};

#[cfg(not(debug_assertions))]
#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct FrontendAssets;

/// Fallback handler: tries to serve a static asset, otherwise returns
/// `index.html` so the SPA can handle client-side routing.
///
/// In debug builds there are no embedded assets; we return a hint pointing
/// the operator at the Vite dev server instead.
pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    #[cfg(not(debug_assertions))]
    {
        // Try the exact path first.
        if let Some(asset) = FrontendAssets::get(path) {
            return serve_asset(path, asset);
        }

        // Try `index.html` for SPA routes.
        if let Some(asset) = FrontendAssets::get("index.html") {
            return serve_asset("index.html", asset);
        }
    }

    // No embedded assets (dev build, or release build with empty dist).
    // Tell the operator to run the frontend.
    let _ = uri;
    let _ = path;
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Frontend not built. Use the Vite dev server (`npm run dev` in `web/`, \
         then open http://localhost:5173), or run `npm run build` in `web/` \
         before building the backend in release mode.",
    )
        .into_response()
}

#[cfg(not(debug_assertions))]
fn serve_asset(path: &str, asset: EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let body = Body::from(asset.data.into_owned());
    let mut response = Response::new(body);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.essence_str()).unwrap());
    if path != "index.html" {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
}
