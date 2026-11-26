//! Authentication primitives: JWT issuance & middleware.
//!
//! IMPORTANT: the server NEVER verifies the user's password directly. Instead, the
//! client derives an `auth_verifier` from its password (Argon2id over a
//! password-derived key) and submits that. The server only verifies this verifier
//! against a stored hash. This keeps the password and master_key entirely client-side.

use axum::{
    async_trait,
    extract::{FromRequestParts, State},
    http::{header::USER_AGENT, request::Parts, HeaderMap},
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::state::AppState;
use crate::util::{client_ip::ClientIp, ua::native_android_name};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    pub sub: String,        // user id
    pub dev: String,        // device id (required post-P4)
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
    device_id: &str,
) -> AuthResult<TokenPair> {
    let now = Utc::now();
    let access_exp = now + Duration::seconds(state.settings.jwt.access_ttl_seconds);
    let refresh_exp = now + Duration::seconds(state.settings.jwt.refresh_ttl_seconds);

    let access_claims = AccessClaims {
        sub: user_id.to_string(),
        dev: device_id.to_string(),
        exp: access_exp.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
    };
    let refresh_claims = AccessClaims {
        sub: user_id.to_string(),
        dev: device_id.to_string(),
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

/// Verify the session still belongs to this user on every request. The same read
/// checks whether activity needs persisting, avoiding a write on each chunk.
pub async fn record_activity(
    state: &AppState, user_id: &str, device_id: &str, headers: &HeaderMap, ip: ClientIp,
) -> AuthResult<()> {
    let observed_ip = ip.0.map(|address| address.to_string());
    let app_name = headers.get(USER_AGENT).and_then(|v| v.to_str().ok()).and_then(native_android_name);
    let (name, stored_ip, due): (String, Option<String>, bool) = sqlx::query_as(
        "SELECT name, ip_address, COALESCE(unixepoch(last_seen_at) <= unixepoch('now') - 60, 1) \
         FROM devices WHERE id = ? AND user_id = ?",
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Unauthorized)?;

    let ip_changed = observed_ip.is_some() && observed_ip != stored_ip;
    let version_changed = app_name.as_ref().is_some_and(|value| value != &name);
    if due || ip_changed || version_changed {
        // Metadata is best effort. Missing observations must not erase known values.
        let _ = sqlx::query(
            "UPDATE devices SET last_seen_at = ?, ip_address = COALESCE(?, ip_address), \
             name = COALESCE(?, name) WHERE id = ? AND user_id = ?",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(observed_ip)
        .bind(app_name)
        .bind(device_id)
        .bind(user_id)
        .execute(&state.db)
        .await;
    }
    Ok(())
}

/// Extractor that authenticates a request via `Authorization: Bearer <jwt>`.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub device_id: String,
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

        let device_id = claims.dev;

        record_activity(state, &claims.sub, &device_id, &parts.headers, ClientIp::from_parts(parts, state)).await?;
        Ok(AuthUser {
            user_id: claims.sub,
            device_id,
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
        let pair = issue_token_pair(&state, "user-1", "dev-1").unwrap();
        let claims = verify_access_token(&state, &pair.access_token).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.dev, "dev-1");
    }

    #[tokio::test]
    async fn refresh_token_has_later_expiry_than_access() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "u", "dev").unwrap();
        assert_ne!(pair.access_token, pair.refresh_token);
        let access = verify_access_token(&state, &pair.access_token).unwrap();
        let refresh = verify_access_token(&state, &pair.refresh_token).unwrap();
        assert!(refresh.exp > access.exp, "refresh must outlive access");
    }

    #[tokio::test]
    async fn verify_rejects_token_signed_with_a_different_secret() {
        let state = test_state().await;
        let pair = issue_token_pair(&state, "u", "dev").unwrap();
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
            dev: "dev".into(),
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

    #[tokio::test]
    async fn auth_user_extractor_rejects_a_token_with_no_dev_claim() {
        // A token minted by an old binary (pre-P4) has no `dev` claim. The new
        // extractor must reject it rather than fall back to None — otherwise the
        // per-request device-revocation check would have nothing to look up.
        let state = test_state().await;
        let claims = serde_json::json!({
            "sub": "user-x",
            "exp": (Utc::now() + Duration::seconds(300)).timestamp(),
            "jti": "no-dev-jti",
        });
        let encoding = EncodingKey::from_secret(b"test-secret");
        let token = encode(&Header::default(), &claims, &encoding).unwrap();
        let req = Request::builder()
            .header("authorization", format!("Bearer {token}"))
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn active_legacy_device_gets_its_current_address_and_app_version() {
        use axum::extract::ConnectInfo;
        use std::net::SocketAddr;
        let (state, _dir) = test_state_with_db().await;
        seed_user(&state, "owner").await;
        sqlx::query("INSERT INTO devices (id, user_id, name) VALUES ('phone','owner','Unknown browser · Android')")
            .execute(&state.db).await.unwrap();
        let pair = issue_token_pair(&state, "owner", "phone").unwrap();
        for remote in ["192.0.2.2:1234", "[2001:db8::42]:1234"] {
            let req = Request::builder()
                .extension(ConnectInfo(remote.parse::<SocketAddr>().unwrap()))
                .header("authorization", format!("Bearer {}", pair.access_token))
                .header("user-agent", "DragonFoxDrive/1.2.3 (Android 14)")
                .body(()).unwrap();
            let (mut parts, _) = req.into_parts();
            AuthUser::from_request_parts(&mut parts, &state).await.unwrap();
        }
        let valid = AuthUser { user_id: "owner".into(), device_id: "phone".into() };
        let list = crate::api::devices::list(State(state.clone()), valid).await.unwrap();
        assert_eq!(list.0.devices[0].ip_address.as_deref(), Some("2001:db8::42"));
        assert_eq!(list.0.devices[0].name, "DragonFox Drive 1.2.3 · Android 14");
        assert!(list.0.devices[0].last_seen_at.is_some());
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

    /// Insert a device row.
    async fn seed_device(state: &AppState, device_id: &str, user_id: &str) {
        sqlx::query("INSERT INTO devices (id, user_id, name) VALUES (?, ?, 'Test')")
            .bind(device_id)
            .bind(user_id)
            .execute(&state.db)
            .await
            .unwrap();
    }

    /// Hard-delete a device row (cascades to its refresh_tokens via FK).
    async fn delete_device(state: &AppState, device_id: &str) {
        sqlx::query("DELETE FROM devices WHERE id = ?")
            .bind(device_id)
            .execute(&state.db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn auth_user_extractor_rejects_a_deleted_device() {
        let (state, _dir) = test_state_with_db().await;
        seed_user(&state, "u1").await;
        seed_device(&state, "dev-1", "u1").await;
        let pair = issue_token_pair(&state, "u1", "dev-1").unwrap();
        delete_device(&state, "dev-1").await;

        let req = Request::builder()
            .header("authorization", format!("Bearer {}", pair.access_token))
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn auth_user_extractor_rejects_an_unknown_device() {
        let (state, _dir) = test_state_with_db().await;
        seed_user(&state, "u1").await;
        // No device row for "ghost-device".
        let pair = issue_token_pair(&state, "u1", "ghost-device").unwrap();
        let req = Request::builder()
            .header("authorization", format!("Bearer {}", pair.access_token))
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        assert!(matches!(
            AuthUser::from_request_parts(&mut parts, &state).await,
            Err(ApiError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn auth_user_extractor_accepts_an_active_device() {
        let (state, _dir) = test_state_with_db().await;
        seed_user(&state, "u1").await;
        seed_device(&state, "dev-1", "u1").await;
        let pair = issue_token_pair(&state, "u1", "dev-1").unwrap();

        let req = Request::builder()
            .header("authorization", format!("Bearer {}", pair.access_token))
            .body::<String>(String::new())
            .unwrap();
        let (mut parts, _body) = req.into_parts();
        let user = AuthUser::from_request_parts(&mut parts, &state).await.unwrap();
        assert_eq!(user.user_id, "u1");
        assert_eq!(user.device_id, "dev-1");
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
