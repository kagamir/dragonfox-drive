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
    };
    let refresh_claims = AccessClaims {
        sub: user_id.to_string(),
        dev: device_id.map(str::to_string),
        exp: refresh_exp.timestamp(),
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
