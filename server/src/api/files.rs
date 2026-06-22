//! File & chunk endpoints.
//!
//! The server treats all file data as opaque encrypted blobs. It only tracks
//! chunk indices, sizes, and storage paths. The encrypted manifest (containing
//! file name, mime, etc.) is also stored as an opaque blob.

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct FileMeta {
    pub id: String,
    pub owner_id: String,
    pub status: String,
    pub total_size: u64,
    pub chunk_count: u32,
    pub encrypted_manifest: Option<String>,
    pub encrypted_manifest_nonce: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn list(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    let _ = state;
    let files: Vec<FileMeta> = Vec::new();
    Ok(Json(json!({ "files": files })))
}

#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    pub total_size: u64,
    pub chunk_count: u32,
}

pub async fn create(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(_req): Json<CreateFileRequest>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "files::create not yet implemented (p2 milestone)"
    )))
}

pub async fn get_manifest(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "files::get_manifest not yet implemented"
    )))
}

#[derive(Debug, Deserialize)]
pub struct PutManifestRequest {
    pub encrypted_manifest: String,
    pub encrypted_manifest_nonce: String,
}

pub async fn put_manifest(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(_id): Path<String>,
    Json(_req): Json<PutManifestRequest>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "files::put_manifest not yet implemented"
    )))
}

pub async fn get_chunk(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((_id, _idx)): Path<(String, u32)>,
) -> ApiResult<impl IntoResponse> {
    let _ = state;
    Err::<Vec<u8>, ApiError>(ApiError::Internal(anyhow::anyhow!(
        "files::get_chunk not yet implemented (p2 milestone)"
    )))
}

pub async fn put_chunk(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((_id, _idx)): Path<(String, u32)>,
    _body: axum::body::Body,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "files::put_chunk not yet implemented (p2 milestone)"
    )))
}

pub async fn finalize(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "files::finalize not yet implemented"
    )))
}

pub async fn delete(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "files::delete not yet implemented"
    )))
}
