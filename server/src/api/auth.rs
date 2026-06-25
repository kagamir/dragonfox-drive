//! Authentication endpoints.
//!
//! The server is zero-trust: it only ever sees a client-derived `auth_verifier`
//! (an Argon2id hash over the password-derived key) and the wrapped
//! `encrypted_master_key`. It never sees plaintext passwords, master keys,
//! or file keys.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::{issue_token_pair, persist_refresh_token, revoke_refresh_token, verify_access_token, TokenPair};
use crate::error::{ApiError, ApiResult};
use crate::models::User;
use crate::state::AppState;
use crate::util::ua::parse_user_agent;

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
    pub device_id: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub kdf_salt: String,
    pub tokens: TokenPair,
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<Json<AuthResponse>> {
    if !state.settings.security.allow_registration {
        return Err(ApiError::Forbidden);
    }
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

    let device_id = uuid::Uuid::new_v4().to_string();
    let device_name = parse_user_agent(
        headers
            .get(axum::http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
    );
    sqlx::query("INSERT INTO devices (id, user_id, name) VALUES (?, ?, ?)")
        .bind(&device_id)
        .bind(&id)
        .bind(&device_name)
        .execute(&state.db)
        .await?;

    let pair = issue_token_pair(&state, &id, &device_id)?;
    persist_refresh_token(&state, &id, Some(&device_id), &pair.refresh_token).await?;

    Ok(Json(AuthResponse {
        user_id: id,
        username,
        device_id,
        encrypted_master_key: req.encrypted_master_key,
        encrypted_master_key_nonce: req.encrypted_master_key_nonce,
        kdf_salt: req.kdf_salt,
        tokens: pair,
    }))
}

pub async fn prelogin(
    State(state): State<AppState>,
    Json(req): Json<PreloginRequest>,
) -> ApiResult<Json<PreloginResponse>> {
    let username = normalise_username(&req.username);
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT kdf_salt, server_salt FROM users WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?;
    match row {
        Some((kdf_salt, server_salt)) => Ok(Json(PreloginResponse { kdf_salt, server_salt })),
        None => Err(ApiError::NotFound),
    }
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let username = normalise_username(&req.username);
    tracing::info!(username = %username, "login request");

    // Don't distinguish "no such user" from "wrong password" in the response.
    let user: User = sqlx::query_as::<_, User>(
        "SELECT id, username, kdf_salt, server_salt, verifier_hash, \
         encrypted_master_key, encrypted_master_key_nonce, created_at, updated_at \
         FROM users WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Unauthorized)?;

    let ok = crate::crypto::verify_verifier(&req.auth_verifier, &user.verifier_hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    if !ok {
        return Err(ApiError::Unauthorized);
    }

    let device_id = uuid::Uuid::new_v4().to_string();
    let device_name = parse_user_agent(
        headers
            .get(axum::http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
    );
    sqlx::query("INSERT INTO devices (id, user_id, name) VALUES (?, ?, ?)")
        .bind(&device_id)
        .bind(&user.id)
        .bind(&device_name)
        .execute(&state.db)
        .await?;

    let pair = issue_token_pair(&state, &user.id, &device_id)?;
    persist_refresh_token(&state, &user.id, Some(&device_id), &pair.refresh_token).await?;

    Ok(Json(AuthResponse {
        user_id: user.id,
        username: user.username,
        device_id,
        encrypted_master_key: user.encrypted_master_key,
        encrypted_master_key_nonce: user.encrypted_master_key_nonce,
        kdf_salt: user.kdf_salt,
        tokens: pair,
    }))
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> ApiResult<Json<TokenPair>> {
    let claims = verify_access_token(&state, &req.refresh_token)?;
    let hash = crate::crypto::hash_refresh_token(&req.refresh_token);

    let active: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM refresh_tokens \
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(&hash)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(&state.db)
    .await?;
    if active.is_none() {
        return Err(ApiError::Unauthorized);
    }

    revoke_refresh_token(&state, &hash).await?;
    let pair = issue_token_pair(&state, &claims.sub, &claims.dev)?;
    persist_refresh_token(&state, &claims.sub, Some(&claims.dev), &pair.refresh_token).await?;
    Ok(Json(pair))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use axum::http::HeaderMap;
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
        let res = register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        assert_eq!(res.0.username, "alice");
        assert!(!res.0.tokens.access_token.is_empty());
        assert!(!res.0.tokens.refresh_token.is_empty());
    }

    #[tokio::test]
    async fn register_rejects_duplicate_username() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        match register(State(state.clone()), HeaderMap::new(), Json(req("Alice"))).await {
            Err(ApiError::Conflict(_)) => {}
            other => panic!("expected Conflict (409), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_rejects_invalid_username() {
        let (state, _dir) = test_state_with_db().await;
        for bad in ["ab", "a".repeat(33).as_str(), "With Space", "bad!"] {
            match register(State(state.clone()), HeaderMap::new(), Json(req(bad))).await {
                Err(ApiError::BadRequest(_)) => {}
                other => panic!("username {bad:?}: expected BadRequest, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn register_is_forbidden_when_registration_disabled() {
        let (mut state, _dir) = test_state_with_db().await;
        // `Arc::get_mut` is sound here: nothing else has cloned this state yet.
        Arc::get_mut(&mut state.settings)
            .expect("settings Arc uniquely held in test")
            .security
            .allow_registration = false;

        match register(State(state.clone()), HeaderMap::new(), Json(req("alice"))).await {
            Err(ApiError::Forbidden) => {}
            other => panic!("expected Forbidden (403) when registration is closed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn prelogin_returns_salts_for_a_known_user() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        let res = prelogin(
            State(state.clone()),
            Json(PreloginRequest { username: "ALICE ".into() }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.server_salt, "ef".repeat(16));
        assert_eq!(res.0.kdf_salt, "cd".repeat(16));
    }

    #[tokio::test]
    async fn prelogin_returns_not_found_for_unknown_user() {
        let (state, _dir) = test_state_with_db().await;
        match prelogin(
            State(state.clone()),
            Json(PreloginRequest { username: "ghost".into() }),
        )
        .await
        {
            Err(ApiError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    fn login_req(username: &str, verifier_hex: &str) -> LoginRequest {
        LoginRequest {
            username: username.into(),
            auth_verifier: verifier_hex.into(),
            device_name: None,
        }
    }

    #[tokio::test]
    async fn login_succeeds_with_the_registered_verifier() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        let res = login(
            State(state.clone()),
            HeaderMap::new(),
            Json(login_req("alice", &"ab".repeat(32))),
        )
        .await
        .unwrap();
        assert_eq!(res.0.username, "alice");
        assert!(!res.0.tokens.refresh_token.is_empty());
    }

    #[tokio::test]
    async fn login_rejects_a_wrong_verifier() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        match login(
            State(state.clone()),
            HeaderMap::new(),
            Json(login_req("alice", &"00".repeat(32))),
        )
        .await
        {
            Err(ApiError::Unauthorized) => {}
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn login_rejects_an_unknown_user() {
        let (state, _dir) = test_state_with_db().await;
        assert!(matches!(
            login(
                State(state.clone()),
                HeaderMap::new(),
                Json(login_req("ghost", &"ab".repeat(32))),
            )
            .await,
            Err(ApiError::Unauthorized)
        ));
    }

    async fn register_tokens(state: &AppState, username: &str) -> TokenPair {
        let res = register(State(state.clone()), HeaderMap::new(), Json(req(username)))
            .await
            .unwrap();
        res.0.tokens
    }

    #[tokio::test]
    async fn refresh_issues_a_new_pair_and_revokes_the_old_token() {
        let (state, _dir) = test_state_with_db().await;
        let pair = register_tokens(&state, "alice").await;

        let new_pair = refresh(
            State(state.clone()),
            Json(RefreshRequest { refresh_token: pair.refresh_token.clone() }),
        )
        .await
        .unwrap();
        assert_ne!(new_pair.0.refresh_token, pair.refresh_token);
        assert_ne!(new_pair.0.access_token, pair.access_token);
    }

    #[tokio::test]
    async fn refresh_rejects_a_replayed_old_token() {
        let (state, _dir) = test_state_with_db().await;
        let pair = register_tokens(&state, "alice").await;
        let old = pair.refresh_token.clone();
        refresh(
            State(state.clone()),
            Json(RefreshRequest { refresh_token: old.clone() }),
        )
        .await
        .unwrap();
        match refresh(
            State(state.clone()),
            Json(RefreshRequest { refresh_token: old }),
        )
        .await
        {
            Err(ApiError::Unauthorized) => {}
            other => panic!("expected Unauthorized on replay, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refresh_rejects_a_garbage_token() {
        let (state, _dir) = test_state_with_db().await;
        assert!(matches!(
            refresh(
                State(state.clone()),
                Json(RefreshRequest { refresh_token: "not.a.jwt".into() }),
            )
            .await,
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn login_creates_a_device_row_with_parsed_ua() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();

        let res = login(
            State(state.clone()),
            HeaderMap::new(), // no UA → "Unknown browser · Unknown OS"
            Json(login_req("alice", &"ab".repeat(32))),
        )
        .await
        .unwrap();

        let row: (String, String) =
            sqlx::query_as("SELECT id, name FROM devices WHERE id = ?")
                .bind(&res.0.device_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(row.0, res.0.device_id);
        assert_eq!(row.1, "Unknown browser · Unknown OS");
    }

    #[tokio::test]
    async fn register_also_creates_a_device_row() {
        let (state, _dir) = test_state_with_db().await;
        let res = register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM devices WHERE user_id = ? AND id = ?")
                .bind(&res.0.user_id)
                .bind(&res.0.device_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn access_token_carries_dev_claim_matching_device_id() {
        let (state, _dir) = test_state_with_db().await;
        let res = register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        let claims = crate::auth::verify_access_token(&state, &res.0.tokens.access_token).unwrap();
        assert_eq!(claims.dev, res.0.device_id);
    }

    #[tokio::test]
    async fn login_records_device_name_from_user_agent() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), HeaderMap::new(), Json(req("alice")))
            .await
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                .parse()
                .unwrap(),
        );
        let res = login(
            State(state.clone()),
            headers,
            Json(login_req("alice", &"ab".repeat(32))),
        )
        .await
        .unwrap();
        let row: (String,) = sqlx::query_as("SELECT name FROM devices WHERE id = ?")
            .bind(&res.0.device_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(row.0, "Chrome 120 · macOS");
    }
}
