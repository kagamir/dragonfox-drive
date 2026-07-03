//! Embedded static asset serving.
//!
//! In release builds the frontend's built `dist/` directory is embedded into
//! the binary via `rust-embed`. In development the Vite dev server is used
//! directly (the developer points a browser at `http://localhost:5173`), so
//! the embed is compiled out via `cfg(debug_assertions)` and `web/dist` does
//! not need to exist.

use axum::{
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
};

// Embedding is only compiled in for release builds. This keeps `cargo run`
// (debug) working without a prior `npm run build` in `web/`, matching the
// README's dev workflow.
#[cfg(not(debug_assertions))]
use axum::{
    body::Body,
    http::{header, HeaderValue},
};
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

/// Files that must never be immutably cached: the SPA shell, the service
/// worker script (so browsers see logic changes), and the version manifest
/// (the frontend's update signal). Everything else is content-hashed and
/// safe to cache forever.
fn cache_control_for(path: &str) -> &'static str {
    match path {
        "index.html" | "sw.js" | "sw-manifest.json" => "no-store",
        _ => "public, max-age=31536000, immutable",
    }
}

#[cfg(not(debug_assertions))]
fn serve_asset(path: &str, asset: EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let body = Body::from(asset.data.into_owned());
    let mut response = Response::new(body);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.essence_str()).unwrap());
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control_for(path)),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::cache_control_for;

    #[test]
    fn dynamic_files_are_not_immutably_cached() {
        assert_eq!(cache_control_for("sw.js"), "no-store");
        assert_eq!(cache_control_for("sw-manifest.json"), "no-store");
        assert_eq!(cache_control_for("index.html"), "no-store");
    }

    #[test]
    fn hashed_assets_are_immutable() {
        assert_eq!(
            cache_control_for("assets/index-abc123.js"),
            "public, max-age=31536000, immutable"
        );
    }
}
