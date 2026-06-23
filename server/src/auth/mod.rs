//! Authentication primitives: JWT issuance & middleware.
//!
//! IMPORTANT: the server NEVER verifies the user's password directly. Instead, the
//! client derives an `auth_verifier` from its password (Argon2id over a
//! password-derived key) and submits that. The server only verifies this verifier
//! against a stored hash. This keeps the password and master_key entirely client-side.

use axum::{
    async_trait,
    extract::{FromRequestParts, State},
    http::request::Parts,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    pub sub: String,        // user id
    pub dev: Option<String>, // device id
    pub exp: i64,
    /// JWT ID (RFC 7519 §4.1.7). Unique per issued token so that two refresh
    /// tokens minted for the same user/device in the same second still hash to
    /// distinct `refresh_tokens.token_hash` values.
    pub jti: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

pub type AuthResult<T> = Result<T, ApiError>;

pub fn issue_token_pair(
    state: &AppState,
    user_id: &str,
    device_id: Option<&str>,
) -> AuthResult<TokenPair> {
    let now = Utc::now();
    let access_exp = now + Duration::seconds(state.settings.jwt.access_ttl_seconds);
    let refresh_exp = now + Duration::seconds(state.settings.jwt.refresh_ttl_seconds);

    let access_claims = AccessClaims {
        sub: user_id.to_string(),
        dev: device_id.map(str::to_string),
        exp: access_exp.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
    };
    let refresh_claims = AccessClaims {
        sub: user_id.to_string(),
        dev: device_id.map(str::to_string),
        exp: refresh_exp.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
    };

    let encoding = EncodingKey::from_secret(state.settings.jwt.secret.as_bytes());
    let access_token = encode(&Header::default(), &access_claims, &encoding)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    let refresh_token = encode(&Header::default(), &refresh_claims, &encoding)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    Ok(TokenPair {
        access_token,
        refresh_token,
        expires_in: state.settings.jwt.access_ttl_seconds,
    })
}

pub fn verify_access_token(state: &AppState, token: &str) -> AuthResult<AccessClaims> {
    let decoding = DecodingKey::from_secret(state.settings.jwt.secret.as_bytes());
    let data = decode::<AccessClaims>(token, &decoding, &Validation::default())
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(data.claims)
}

/// Persist a freshly-issued refresh token's SHA-256 hash into the allowlist.
pub async fn persist_refresh_token(
    state: &AppState,
    user_id: &str,
    device_id: Option<&str>,
    refresh_token: &str,
) -> AuthResult<()> {
    let hash = crate::crypto::hash_refresh_token(refresh_token);
    let id = uuid::Uuid::new_v4().to_string();
    let expires_at =
        (Utc::now() + Duration::seconds(state.settings.jwt.refresh_ttl_seconds)).to_rfc3339();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(device_id)
    .bind(hash)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Mark a refresh token (looked up by its hash) as revoked.
pub async fn revoke_refresh_token(state: &AppState, token_hash: &str) -> AuthResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?")
        .bind(now)
        .bind(token_hash)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Extractor that authenticates a request via `Authorization: Bearer <jwt>`.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub device_id: Option<String>,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .ok_or(ApiError::Unauthorized)?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or(ApiError::Unauthorized)?;

        let claims = verify_access_token(state, token)?;
        Ok(AuthUser {
            user_id: claims.sub,
            device_id: claims.dev,
        })
    }
}

// `State<AppState>` is used by handlers in api/auth.rs via `extract::State`.
#[allow(dead_code)]
fn _state_used(_: State<AppState>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use axum::extract::FromRequestParts;
    use axum::http::Request;
    use std::sync::Arc;

    async fn test_state() -> AppState {
        let mut settings = Settings::default();
        settings.jwt.secret = "test-secret".into();
        let pool = db::connect("sqlite::memory:").await.unwrap();
        AppState::new(Arc::new(settings), pool)
    }

    #[tokio::test]
    async fn issue_and_verify_round_trip() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "user-1", Some("dev-1")).unwrap();
        let claims = verify_access_token(&state, &pair.access_token).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.dev.as_deref(), Some("dev-1"));
    }

    #[tokio::test]
    async fn refresh_token_has_later_expiry_than_access() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "u", None).unwrap();
        assert_ne!(pair.access_token, pair.refresh_token);
        let access = verify_access_token(&state, &pair.access_token).unwrap();
        let refresh = verify_access_token(&state, &pair.refresh_token).unwrap();
        assert!(refresh.exp > access.exp, "refresh must outlive access");
    }

    #[tokio::test]
    async fn verify_rejects_token_signed_with_a_different_secret() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "u", None).unwrap();
        let mut other_state = test_state().await;
        Arc::get_mut(&mut other_state.settings)
            .unwrap()
            .jwt
            .secret = "different-secret".into();
        match verify_access_token(&other_state, &pair.access_token) {
            Err(ApiError::Unauthorized) => {}
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn verify_rejects_malformed_token() {
        let state = test_state().await;
        assert!(matches!(
            verify_access_token(&state, "not.a.jwt"),
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn verify_rejects_expired_token() {
        let state = test_state().await;
        let expired = AccessClaims {
            sub: "u".into(),
            dev: None,
            exp: (Utc::now() - Duration::seconds(300)).timestamp(),
            jti: "expired-jti".into(),
        };
        let encoding = EncodingKey::from_secret(b"test-secret");
        let token = encode(&Header::default(), &expired, &encoding).unwrap();
        assert!(matches!(
            verify_access_token(&state, &token),
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn auth_user_extractor_accepts_a_valid_bearer_token() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "user-x", Some("dev-x")).unwrap();
        let req = Request::builder()
            .header("authorization", format!("Bearer {}", pair.access_token))
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        let user = AuthUser::from_request_parts(&mut parts, &state)
            .await
            .unwrap();
        assert_eq!(user.user_id, "user-x");
        assert_eq!(user.device_id.as_deref(), Some("dev-x"));
    }

    #[tokio::test]
    async fn auth_user_extractor_rejects_missing_header() {
        let state = test_state().await;
        let req = Request::<String>::default();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn auth_user_extractor_rejects_non_bearer_scheme() {
        let state = test_state().await;
        let req = Request::builder()
            .header("authorization", "Basic dXNlcjpwdw==")
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }

    /// A migrated file-backed AppState (refresh_tokens requires real tables).
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

    /// Insert a minimal parent user row so refresh_tokens.user_id satisfies its FK.
    async fn seed_user(state: &AppState, user_id: &str) {
        sqlx::query(
            "INSERT INTO users \
             (id, username, kdf_salt, server_salt, verifier_hash, \
              encrypted_master_key, encrypted_master_key_nonce) \
             VALUES (?, ?, 'salt', 'salt', 'hash', 'key', 'nonce')",
        )
        .bind(user_id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn persist_refresh_token_inserts_an_unrevoked_row() {
        let (state, _dir) = test_state_with_db().await;
        seed_user(&state, "u1").await;
        persist_refresh_token(&state, "u1", None, "tok-1")
            .await
            .unwrap();
        let hash = crate::crypto::hash_refresh_token("tok-1");
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT revoked_at FROM refresh_tokens WHERE token_hash = ?",
        )
        .bind(&hash)
        .fetch_optional(&state.db)
        .await
        .unwrap();
        let row = row.expect("row must exist");
        assert!(row.0.is_none(), "revoked_at must be NULL for a fresh token");
    }

    #[tokio::test]
    async fn revoke_refresh_token_sets_revoked_at() {
        let (state, _dir) = test_state_with_db().await;
        seed_user(&state, "u1").await;
        persist_refresh_token(&state, "u1", None, "tok-1")
            .await
            .unwrap();
        let hash = crate::crypto::hash_refresh_token("tok-1");
        revoke_refresh_token(&state, &hash).await.unwrap();
        let row: (Option<String>,) = sqlx::query_as(
            "SELECT revoked_at FROM refresh_tokens WHERE token_hash = ?",
        )
        .bind(&hash)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert!(row.0.is_some(), "revoked_at must be set after revoke");
    }
}
