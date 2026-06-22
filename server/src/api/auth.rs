//! Authentication endpoints.
//!
//! The server is zero-trust: it only ever sees a client-derived `auth_verifier`
//! (an Argon2id hash over the password-derived key) and the wrapped
//! `encrypted_master_key`. It never sees plaintext passwords, master keys,
//! or file keys.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::{issue_token_pair, TokenPair};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    /// Argon2id-derived verifier of the password-derived key. Server hashes this
    /// again (Argon2id with its own salt) before storing.
    pub auth_verifier: String,
    /// Per-user salt used by the client for KDF (hex).
    pub kdf_salt: String,
    /// Server-side Argon2id salt for hashing `auth_verifier` (hex). Sent by client.
    pub server_salt: String,
    /// `master_key` wrapped by `password_key` (AES-256-GCM, base64).
    pub encrypted_master_key: String,
    /// Associated data: nonce/iv for the wrapped master key (base64).
    pub encrypted_master_key_nonce: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub auth_verifier: String,
    /// Optional: name of the new device requesting login.
    pub device_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub user_id: String,
    pub email: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub kdf_salt: String,
    pub tokens: TokenPair,
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<Json<AuthResponse>> {
    tracing::info!(email = %req.email, "register request");

    // TODO(p1-impl): hash auth_verifier with argon2 + server_salt, insert user,
    //                issue token pair. For now we return a placeholder so the
    //                handler signature compiles & routes wire up correctly.
    let _ = (state, req);
    Err(ApiError::Internal(anyhow::anyhow!(
        "register not yet implemented (p1 milestone)"
    )))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    tracing::info!(email = %req.email, "login request");

    let _ = (state, req);
    Err(ApiError::Internal(anyhow::anyhow!(
        "login not yet implemented (p1 milestone)"
    )))
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> ApiResult<Json<TokenPair>> {
    let _ = (state, req);
    Err(ApiError::Internal(anyhow::anyhow!(
        "refresh not yet implemented (p1 milestone)"
    )))
}

// Suppress unused-import warning for issue_token_pair; will be wired in p1 impl.
#[allow(dead_code)]
fn _ensure_used(state: &AppState, user_id: &str) -> ApiResult<TokenPair> {
    issue_token_pair(state, user_id, None)
}
