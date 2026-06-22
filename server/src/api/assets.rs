//! Embedded static asset serving.
//!
//! In release builds the frontend's built `dist/` directory is embedded into
//! the binary via `rust-embed`. In development the Vite dev server is used
//! directly (the developer points a browser at `http://localhost:5173`).

use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct FrontendAssets;

/// Fallback handler: tries to serve a static asset, otherwise returns
/// `index.html` so the SPA can handle client-side routing.
pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Try the exact path first.
    if let Some(asset) = FrontendAssets::get(path) {
        return serve_asset(path, asset);
    }

    // Try `index.html` for SPA routes.
    if let Some(asset) = FrontendAssets::get("index.html") {
        return serve_asset("index.html", asset);
    }

    // No embedded assets (dev build). Tell the operator to run the frontend.
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Frontend not built. Run `npm run build` in `web/` or use the Vite dev server.",
    )
        .into_response()
}

fn serve_asset(path: &str, asset: rust_embed::EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let body = Body::from(asset.data.into_owned());
    let mut response = Response::new(body);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.essence_str()).unwrap());
    if path != "index.html" {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    }
    response
}
