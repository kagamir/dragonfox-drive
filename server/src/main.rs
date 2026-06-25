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
use axum::{extract::DefaultBodyLimit, serve, Router};
use tower_http::{compression::CompressionLayer, cors::CorsLayer, trace::TraceLayer};
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

fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::very_permissive();
    let compression = CompressionLayer::new().br(true);
    let max_body = state.settings.limits.max_chunk_bytes as usize;

    Router::new()
        .merge(api::routes())
        .fallback(api::assets::fallback)
        .layer(DefaultBodyLimit::max(max_body))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
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

    fn bearer(state: &AppState, user_id: &str) -> String {
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
                    .header("authorization", bearer(&state, "user-1"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
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
