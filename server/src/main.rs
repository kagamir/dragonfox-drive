//! DragonFox Drive server entry point.

mod api;
mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod state;
mod storage;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{serve, Router};
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

    Router::new()
        .merge(api::routes())
        .fallback(api::assets::fallback)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(compression)
        .with_state(state)
}
