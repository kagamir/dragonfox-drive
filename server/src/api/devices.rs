use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Serialize;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct DeviceItem {
    pub id: String,
    pub name: String,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ListDevicesResponse {
    pub devices: Vec<DeviceItem>,
}

#[derive(Debug, Serialize)]
pub struct RevokeResponse {
    pub ok: bool,
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<ListDevicesResponse>> {
    let rows: Vec<(String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, last_seen_at, created_at, revoked_at \
         FROM devices WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await?;

    let devices = rows
        .into_iter()
        .map(|(id, name, last_seen_at, created_at, revoked_at)| DeviceItem {
            id, name, last_seen_at, created_at, revoked_at,
        })
        .collect();
    Ok(Json(ListDevicesResponse { devices }))
}

pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<RevokeResponse>> {
    if id == user.device_id {
        return Err(ApiError::BadRequest(
            "cannot revoke current device; use logout instead".into(),
        ));
    }
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(&now)
    .bind(&id)
    .bind(&user.user_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
    )
    .bind(&now)
    .bind(&id)
    .execute(&state.db)
    .await?;
    Ok(Json(RevokeResponse { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthUser;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Arc;

    async fn test_state() -> (AppState, tempfile::TempDir) {
        let mut settings = Settings::default();
        settings.jwt.secret = "test".into();
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}?mode=rwc", dir.path().join("t.db").to_string_lossy().replace('\\', "/"));
        let pool = db::connect(&url).await.unwrap();
        db::migrate(&pool).await.unwrap();
        (AppState::new(Arc::new(settings), pool), dir)
    }

    async fn seed_user_and_devices(state: &AppState) -> (String, String, String) {
        // Returns (user_id, device_a, device_b)
        let uid = "u1";
        sqlx::query("INSERT INTO users (id, username, kdf_salt, server_salt, verifier_hash, encrypted_master_key, encrypted_master_key_nonce) VALUES (?, ?, 's','s','h','k','n')")
            .bind(uid).bind(uid).execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO devices (id, user_id, name) VALUES ('dev-a', ?, 'Chrome 120 · macOS')")
            .bind(uid).execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO devices (id, user_id, name) VALUES ('dev-b', ?, 'Firefox · Windows')")
            .bind(uid).execute(&state.db).await.unwrap();
        (uid.into(), "dev-a".into(), "dev-b".into())
    }

    fn auth(uid: &str, device_id: &str) -> AuthUser {
        AuthUser { user_id: uid.into(), device_id: device_id.into() }
    }

    #[tokio::test]
    async fn list_returns_all_devices_for_user_ordered_by_created_desc() {
        let (state, _dir) = test_state().await;
        let uid = "u1";
        sqlx::query("INSERT INTO users (id, username, kdf_salt, server_salt, verifier_hash, encrypted_master_key, encrypted_master_key_nonce) VALUES (?, ?, 's','s','h','k','n')")
            .bind(uid).bind(uid).execute(&state.db).await.unwrap();
        // Explicit, distinct created_at so DESC ordering is deterministic.
        sqlx::query("INSERT INTO devices (id, user_id, name, created_at) VALUES ('dev-old', ?, 'Older', '2026-06-01T00:00:00Z')")
            .bind(uid).execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO devices (id, user_id, name, created_at) VALUES ('dev-new', ?, 'Newer', '2026-06-25T00:00:00Z')")
            .bind(uid).execute(&state.db).await.unwrap();

        let res = list(State(state.clone()), auth(uid, "dev-new")).await.unwrap();
        assert_eq!(res.0.devices.len(), 2);
        assert_eq!(res.0.devices[0].id, "dev-new", "newest device must come first");
        assert_eq!(res.0.devices[1].id, "dev-old");
    }

    #[tokio::test]
    async fn revoke_soft_sets_revoked_at_and_cascades_refresh_tokens() {
        let (state, _dir) = test_state().await;
        let (uid, _a, _b) = seed_user_and_devices(&state).await;
        sqlx::query("INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at) VALUES ('rt-1', ?, 'dev-b', 'hash-1', '2099-01-01T00:00:00Z')")
            .bind(&uid).execute(&state.db).await.unwrap();
        revoke(State(state.clone()), auth(&uid, "dev-a"), Path("dev-b".into())).await.unwrap();
        let dev: (Option<String>,) = sqlx::query_as("SELECT revoked_at FROM devices WHERE id = 'dev-b'")
            .fetch_one(&state.db).await.unwrap();
        assert!(dev.0.is_some());
        let rt: (Option<String>,) = sqlx::query_as("SELECT revoked_at FROM refresh_tokens WHERE id = 'rt-1'")
            .fetch_one(&state.db).await.unwrap();
        assert!(rt.0.is_some());
    }

    #[tokio::test]
    async fn revoke_rejects_self_revoke_with_400() {
        let (state, _dir) = test_state().await;
        let (uid, _a, _b) = seed_user_and_devices(&state).await;
        match revoke(State(state.clone()), auth(&uid, "dev-a"), Path("dev-a".into())).await {
            Err(ApiError::BadRequest(_)) => {}
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn revoke_returns_404_for_unknown_or_other_users_device() {
        let (state, _dir) = test_state().await;
        let (uid, _a, _b) = seed_user_and_devices(&state).await;
        match revoke(State(state.clone()), auth(&uid, "dev-a"), Path("not-yours".into())).await {
            Err(ApiError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn revoke_does_not_touch_other_devices() {
        let (state, _dir) = test_state().await;
        let (uid, _a, _b) = seed_user_and_devices(&state).await;
        revoke(State(state.clone()), auth(&uid, "dev-a"), Path("dev-b".into())).await.unwrap();
        let other: (Option<String>,) = sqlx::query_as("SELECT revoked_at FROM devices WHERE id = 'dev-a'")
            .fetch_one(&state.db).await.unwrap();
        assert!(other.0.is_none(), "revoking dev-b must not affect dev-a");
    }
}
