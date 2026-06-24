//! HTTP API routes registration.

pub mod assets;
pub mod auth;
pub mod files;
pub mod folders;
pub mod health;
pub mod shares;

use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health::health))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/prelogin", post(auth::prelogin))
        .route("/api/auth/refresh", post(auth::refresh))
        .route("/api/files", get(files::list).post(files::create))
        .route(
            "/api/files/:id/manifest",
            get(files::get_manifest).put(files::put_manifest),
        )
        .route(
            "/api/files/:id/chunks/:idx",
            get(files::get_chunk).put(files::put_chunk),
        )
        .route("/api/files/:id/chunks", get(files::list_chunks))
        .route("/api/files/:id/finalize", post(files::finalize))
        .route(
            "/api/files/:id",
            axum::routing::patch(files::patch_move).delete(files::delete),
        )
        .route(
            "/api/folders",
            get(folders::list).post(folders::create),
        )
        .route(
            "/api/folders/:id",
            axum::routing::patch(folders::patch).delete(folders::delete),
        )
        .route("/api/shares", post(shares::create))
        .route("/api/shares/:id", get(shares::get).delete(shares::revoke))
        .route("/api/shares/:id/chunks/:idx", get(shares::get_chunk))
}
