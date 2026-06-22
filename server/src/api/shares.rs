//! Public link-share endpoints.
//!
//! Link shares are zero-knowledge: the file_key is re-wrapped (AES-GCM) with a
//! `share_key` derived from a share password or random URL-fragment key. The
//! server only ever stores the re-wrapped blob and (optionally) a hash of the
//! share password for access control on password-protected shares.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateShareRequest {
    pub file_id: String,
    /// KDF salt used to derive the share_key (hex). Public.
    pub share_salt: String,
    /// `file_key` re-wrapped by `share_key` (base64).
    pub encrypted_file_key: String,
    pub encrypted_file_key_nonce: String,
    /// If set, share requires a password. Server stores hash of the share_key
    /// derived from that password (so it can gate access without knowing it).
    pub password_hash: Option<String>,
    pub expires_at: Option<String>,
    pub download_limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ShareInfo {
    pub id: String,
    pub file_id: String,
    pub share_salt: String,
    pub encrypted_file_key: String,
    pub encrypted_file_key_nonce: String,
    pub requires_password: bool,
    pub expires_at: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(_req): Json<CreateShareRequest>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "shares::create not yet implemented (p3 milestone)"
    )))
}

pub async fn get(
    State(state): State<AppState>,
    Path(_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Ok(Json(json!({
        "id": "stub",
        "requires_password": false,
        "expires_at": null,
    })))
}

pub async fn revoke(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "shares::revoke not yet implemented"
    )))
}

pub async fn get_chunk(
    State(state): State<AppState>,
    Path((_id, _idx)): Path<(String, u32)>,
) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::Internal(anyhow::anyhow!(
        "shares::get_chunk not yet implemented"
    )))
}
