//! Authentication endpoints.
//!
//! The server is zero-trust: it only ever sees a client-derived `auth_verifier`
//! (an Argon2id hash over the password-derived key) and the wrapped
//! `encrypted_master_key`. It never sees plaintext passwords, master keys,
//! or file keys.

use axum::extract::State;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::{issue_token_pair, persist_refresh_token, revoke_refresh_token, verify_access_token, TokenPair};
use crate::error::{ApiError, ApiResult};
use crate::models::User;
use crate::state::AppState;

/// `^[a-z0-9_-]{3,32}$`
fn is_valid_username(s: &str) -> bool {
    let len = s.len();
    (3..=32).contains(&len)
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn normalise_username(s: &str) -> String {
    s.trim().to_lowercase()
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    /// Argon2id-derived verifier of the password-derived key. Server hashes this
    /// again (Argon2id with server_salt) before storing.
    pub auth_verifier: String,
    /// Per-user salt used by the client for KDF (hex).
    pub kdf_salt: String,
    /// Server-side Argon2id salt for hashing `auth_verifier` (hex). Sent by client.
    pub server_salt: String,
    /// `master_key` wrapped by `password_key` (AES-256-GCM, base64).
    pub encrypted_master_key: String,
    /// nonce/iv for the wrapped master key (base64).
    pub encrypted_master_key_nonce: String,
}

#[derive(Debug, Deserialize)]
pub struct PreloginRequest {
    pub username: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub auth_verifier: String,
    /// Optional: name of the new device requesting login (unused in P1).
    pub device_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct PreloginResponse {
    pub kdf_salt: String,
    pub server_salt: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub user_id: String,
    pub username: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub kdf_salt: String,
    pub tokens: TokenPair,
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let username = normalise_username(&req.username);
    if !is_valid_username(&username) {
        return Err(ApiError::BadRequest(
            "username must be 3-32 chars of [a-z0-9_-]".into(),
        ));
    }
    tracing::info!(username = %username, "register request");

    let verifier_hash = crate::crypto::hash_verifier(&req.auth_verifier, &req.server_salt)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    let id = uuid::Uuid::new_v4().to_string();

    let insert = sqlx::query(
        "INSERT INTO users (id, username, kdf_salt, server_salt, verifier_hash, \
         encrypted_master_key, encrypted_master_key_nonce) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(&req.kdf_salt)
    .bind(&req.server_salt)
    .bind(&verifier_hash)
    .bind(&req.encrypted_master_key)
    .bind(&req.encrypted_master_key_nonce)
    .execute(&state.db)
    .await;

    match insert {
        Ok(_) => {}
        Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
            return Err(ApiError::Conflict("username already taken".into()));
        }
        Err(e) => return Err(e.into()),
    }

    let pair = issue_token_pair(&state, &id, None)?;
    persist_refresh_token(&state, &id, None, &pair.refresh_token).await?;

    Ok(Json(AuthResponse {
        user_id: id,
        username,
        encrypted_master_key: req.encrypted_master_key,
        encrypted_master_key_nonce: req.encrypted_master_key_nonce,
        kdf_salt: req.kdf_salt,
        tokens: pair,
    }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    tracing::info!(username = %req.username, "login request");

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Arc;

    async fn test_state_with_db() -> (AppState, tempfile::TempDir) {
        let mut settings = Settings::default();
        settings.jwt.secret = "test-secret".into();
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir
            .path()
            .join("test.db")
            .to_string_lossy()
            .replace('\\', "/");
        let url = format!("sqlite://{}?mode=rwc", db_path);
        let pool = db::connect(&url).await.unwrap();
        db::migrate(&pool).await.unwrap();
        (AppState::new(Arc::new(settings), pool), dir)
    }

    fn req(username: &str) -> RegisterRequest {
        RegisterRequest {
            username: username.into(),
            auth_verifier: "ab".repeat(32), // 64 hex chars = 32 bytes
            kdf_salt: "cd".repeat(16),
            server_salt: "ef".repeat(16),
            encrypted_master_key: "enc".into(),
            encrypted_master_key_nonce: "nonce".into(),
        }
    }

    #[tokio::test]
    async fn register_returns_tokens_and_username() {
        let (state, _dir) = test_state_with_db().await;
        let res = register(State(state.clone()), Json(req("alice"))).await.unwrap();
        assert_eq!(res.0.username, "alice");
        assert!(!res.0.tokens.access_token.is_empty());
        assert!(!res.0.tokens.refresh_token.is_empty());
    }

    #[tokio::test]
    async fn register_rejects_duplicate_username() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), Json(req("alice"))).await.unwrap();
        match register(State(state.clone()), Json(req("Alice"))).await {
            Err(ApiError::Conflict(_)) => {}
            other => panic!("expected Conflict (409), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_rejects_invalid_username() {
        let (state, _dir) = test_state_with_db().await;
        for bad in ["ab", "a".repeat(33).as_str(), "With Space", "bad!"] {
            match register(State(state.clone()), Json(req(bad))).await {
                Err(ApiError::BadRequest(_)) => {}
                other => panic!("username {bad:?}: expected BadRequest, got {other:?}"),
            }
        }
    }
}
