//! DragonFox Drive server entry point.

mod api;
mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod models;
mod state;
mod storage;
mod util;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::http::{header, HeaderName, HeaderValue};
use axum::{extract::DefaultBodyLimit, serve, Router};
use tower_http::{
    compression::CompressionLayer, set_header::SetResponseHeaderLayer, trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::config::Settings;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    init_tracing();

    let settings = Settings::load().context("failed to load configuration")?;

    let host = settings.server.host.clone();
    let port = settings.server.port;

    std::fs::create_dir_all(&settings.storage.data_dir).with_context(|| {
        format!(
            "creating data dir {}",
            settings.storage.data_dir.display()
        )
    })?;

    let pool = db::connect(&settings.database.url)
        .await
        .context("failed to connect to database")?;
    db::migrate(&pool)
        .await
        .context("failed to run database migrations")?;

    tracing::info!(
        data_dir = %settings.storage.data_dir.display(),
        "dragonfox drive starting"
    );

    let state = AppState::new(Arc::new(settings), pool);
    let app = build_router(state);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .context("invalid server bind address")?;

    tracing::info!(%addr, "listening");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .context("binding tcp listener")?;
    serve(listener, app.into_make_service())
        .await
        .context("server error")?;

    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,dragonfox_drive=debug,sqlx=warn"));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();
}

/// Content-Security-Policy for the SPA. The app is served same-origin, so
/// `'self'` covers scripts/styles/assets/XHR. The two non-obvious allowances:
///   - `script-src 'wasm-unsafe-eval'` — libsodium runs as WebAssembly, which
///     CSP gates behind this token (without it `WebAssembly.instantiate` fails).
///   - `blob:` in `media-src`/`img-src`/`worker-src` — file previews use
///     `URL.createObjectURL(blob)` and the crypto worker may be a blob URL.
/// `style-src 'unsafe-inline'` accommodates Vue/Vite's injected styles.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
    script-src 'self' 'wasm-unsafe-eval'; \
    style-src 'self' 'unsafe-inline'; \
    img-src 'self' blob: data:; \
    media-src 'self' blob:; \
    connect-src 'self'; \
    worker-src 'self' blob:; \
    object-src 'none'; \
    base-uri 'self'; \
    frame-ancestors 'none'";

fn build_router(state: AppState) -> Router {
    let compression = CompressionLayer::new().br(true);
    let max_body = state.settings.limits.max_chunk_bytes as usize;

    // Fixed, same-origin security posture. No CORS layer: the SPA and API share
    // an origin (in dev, Vite proxies /api → :8080, so the browser still sees a
    // single origin), so cross-origin access is simply not enabled. HSTS is
    // intentionally omitted — terminate TLS at a reverse proxy and add
    // `Strict-Transport-Security` there so plaintext dev isn't self-locked.
    let sec = |name: HeaderName, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
    };

    Router::new()
        .merge(api::routes())
        .fallback(api::assets::fallback)
        .layer(DefaultBodyLimit::max(max_body))
        .layer(TraceLayer::new_for_http())
        .layer(sec(header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY))
        .layer(sec(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(sec(header::X_FRAME_OPTIONS, "DENY"))
        .layer(sec(header::REFERRER_POLICY, "no-referrer"))
        .layer(sec(
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ))
        .layer(compression)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    //! Router-level integration tests.
    //!
    //! The per-handler unit tests in `api/*.rs` call handler functions directly
    //! and therefore bypass axum's middleware stack. These tests exercise the
    //! real `build_router` output via `tower::ServiceExt::oneshot` so that the
    //! router-wide `DefaultBodyLimit`, the `AuthUser` extractor, and route
    //! registration are all covered. This is the layer where the
    //! "413 on prelogin" regression lived (a `max_upload_bytes = 0` in
    //! config.toml collapsed the body limit to zero).

    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::auth::issue_token_pair;

    /// Build a router backed by an in-memory DB. Returns the router and the
    /// cloned `AppState` so tests can mint JWTs signed with the same secret.
    async fn test_router(max_chunk: u64) -> (Router, AppState) {
        let mut settings = Settings::default();
        settings.jwt.secret = "test".into();
        settings.limits.max_chunk_bytes = max_chunk;
        let pool = db::connect("sqlite::memory:").await.unwrap();
        db::migrate(&pool).await.unwrap();
        let state = AppState::new(Arc::new(settings), pool);
        (build_router(state.clone()), state)
    }

    /// Mint a Bearer header for `user_id`, first seeding the user + device row
    /// the per-request revocation check requires. Idempotent (`INSERT OR IGNORE`)
    /// so tests that call it more than once don't trip a PRIMARY KEY violation.
    async fn bearer(state: &AppState, user_id: &str) -> String {
        sqlx::query(
            "INSERT OR IGNORE INTO users \
             (id, username, kdf_salt, server_salt, verifier_hash, \
              encrypted_master_key, encrypted_master_key_nonce) \
             VALUES (?, ?, 's','s','h','k','n')",
        )
        .bind(user_id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query("INSERT OR IGNORE INTO devices (id, user_id, name) VALUES (?, ?, 'Test')")
            .bind("test-device")
            .bind(user_id)
            .execute(&state.db)
            .await
            .unwrap();
        let pair = issue_token_pair(state, user_id, "test-device").unwrap();
        format!("Bearer {}", pair.access_token)
    }

    #[tokio::test]
    async fn health_returns_200_without_a_body() {
        let (app, _state) = test_router(104857600).await;
        let res = app
            .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn responses_carry_fixed_security_headers() {
        let (app, _state) = test_router(104857600).await;
        let res = app
            .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let h = res.headers();
        let csp = h
            .get("content-security-policy")
            .expect("CSP header present")
            .to_str()
            .unwrap();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("wasm-unsafe-eval"), "CSP must allow libsodium WASM");
        assert!(csp.contains("frame-ancestors 'none'"));
        assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
        assert_eq!(h.get("x-frame-options").unwrap(), "DENY");
        assert_eq!(h.get("referrer-policy").unwrap(), "no-referrer");
        assert_eq!(h.get("cross-origin-opener-policy").unwrap(), "same-origin");
    }

    #[tokio::test]
    async fn no_permissive_cors_header_is_emitted() {
        // Regression guard: the old `CorsLayer::very_permissive()` reflected any
        // origin. With it removed, no ACAO header should appear on API responses.
        let (app, _state) = test_router(104857600).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .header("origin", "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(res.headers().get("access-control-allow-origin").is_none());
    }

    /// Regression guard for the 413-on-prelogin incident: a normal-sized auth
    /// JSON body must reach the handler, not be rejected by the router-wide
    /// `DefaultBodyLimit`.
    #[tokio::test]
    async fn small_json_body_is_not_rejected_by_the_body_limit() {
        let (app, _state) = test_router(104857600).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/prelogin")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"nobody"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 404 = prelogin reached the handler and reported an unknown user.
        // The regression would have produced 413 here.
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn oversized_body_is_rejected_with_413() {
        let (app, _state) = test_router(100).await; // deliberately tiny limit
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/prelogin")
                    .header("content-type", "application/json")
                    .body(Body::from(vec![b'x'; 101]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn zero_body_limit_rejects_every_body_with_413() {
        // Direct guard for the exact regression: max_upload_bytes = 0 must
        // not silently pass through; the symptom is 413 on any body.
        let (app, _state) = test_router(0).await;
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/prelogin")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"nobody"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn protected_route_rejects_missing_authorization_with_401() {
        let (app, _state) = test_router(104857600).await;
        let res = app
            .oneshot(Request::builder().uri("/api/files").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn protected_route_accepts_a_valid_bearer_token() {
        let (app, state) = test_router(104857600).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/files")
                    .header("authorization", bearer(&state, "user-1").await)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn protected_route_rejects_a_deleted_device() {
        let (app, state) = test_router(104857600).await;
        let token = bearer(&state, "user-1").await;
        sqlx::query("DELETE FROM devices WHERE id = ?")
            .bind("test-device")
            .execute(&state.db)
            .await
            .unwrap();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/files")
                    .header("authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn protected_route_rejects_a_malformed_authorization_header() {
        let (app, _state) = test_router(104857600).await;
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/files")
                    .header("authorization", "Basic dXNlcjpwdw==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
