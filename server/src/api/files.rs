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
use crate::models::FileRow;
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
    pub encrypted_file_key: Option<String>,
    pub encrypted_file_key_nonce: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<FileRow> for FileMeta {
    fn from(r: FileRow) -> Self {
        FileMeta {
            id: r.id,
            owner_id: r.owner_id,
            status: r.status,
            total_size: r.total_size as u64,
            chunk_count: r.chunk_count as u32,
            encrypted_manifest: r.encrypted_manifest,
            encrypted_manifest_nonce: r.encrypted_manifest_nonce,
            encrypted_file_key: r.encrypted_file_key,
            encrypted_file_key_nonce: r.encrypted_file_key_nonce,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<FileRow> = sqlx::query_as(
        "SELECT id, owner_id, status, total_size, chunk_count, \
         encrypted_manifest, encrypted_manifest_nonce, \
         encrypted_file_key, encrypted_file_key_nonce, created_at, updated_at \
         FROM files WHERE owner_id = ? AND status != 'deleted' \
         ORDER BY created_at DESC")
        .bind(&user.user_id)
        .fetch_all(&state.db).await?;
    let files: Vec<FileMeta> = rows.into_iter().map(FileMeta::from).collect();
    Ok(Json(json!({ "files": files })))
}

#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    pub total_size: u64,
    pub chunk_count: u32,
    pub encrypted_file_key: String,
    pub encrypted_file_key_nonce: String,
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateFileRequest>,
) -> ApiResult<Json<Value>> {
    if req.chunk_count == 0 {
        return Err(ApiError::BadRequest("chunk_count must be >= 1".into()));
    }
    if req.total_size == 0 {
        return Err(ApiError::BadRequest("total_size must be > 0".into()));
    }
    let max = state.settings.limits.max_upload_bytes;
    if max > 0 && req.total_size > max {
        return Err(ApiError::PayloadTooLarge);
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO files (id, owner_id, status, total_size, chunk_count, \
         encrypted_file_key, encrypted_file_key_nonce) \
         VALUES (?, ?, 'pending', ?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.user_id)
        .bind(req.total_size as i64)
        .bind(req.chunk_count as i32)
        .bind(&req.encrypted_file_key)
        .bind(&req.encrypted_file_key_nonce)
        .execute(&state.db).await?;
    Ok(Json(json!({
        "id": id,
        "upload_url": format!("/api/files/{}/chunks/{{idx}}", id),
    })))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Arc;
    use std::collections::HashSet;

    /// Returns a fresh migrated state backed by a temp SQLite file. The
    /// caller MUST bind the returned `TempDir` to a local var (e.g. `_guard`)
    /// so it outlives the queries — dropping it would delete the db file.
    async fn files_state() -> (AppState, tempfile::TempDir) {
        let mut settings = Settings::default();
        settings.jwt.secret = "test".into();
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("t.db").to_string_lossy().replace('\\', "/");
        let url = format!("sqlite://{}?mode=rwc", db_path);
        let pool = db::connect(&url).await.unwrap();
        db::migrate(&pool).await.unwrap();
        (AppState::new(Arc::new(settings), pool), dir)
    }

    async fn seed_user(state: &AppState, uid: &str) {
        sqlx::query(
            "INSERT INTO users (id, username, kdf_salt, server_salt, verifier_hash, \
             encrypted_master_key, encrypted_master_key_nonce) \
             VALUES (?, ?, 's', 's', 'h', 'k', 'n')",
        )
        .bind(uid).bind(uid).execute(&state.db).await.unwrap();
    }

    fn auth(uid: &str) -> AuthUser {
        AuthUser { user_id: uid.into(), device_id: None }
    }

    #[tokio::test]
    async fn list_returns_only_caller_files() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        // u1 owns one ready file
        sqlx::query(
            "INSERT INTO files (id, owner_id, status, total_size, chunk_count, \
             encrypted_file_key, encrypted_file_key_nonce) \
             VALUES ('f1', 'u1', 'ready', 10, 1, 'k', 'kn')",
        ).execute(&state.db).await.unwrap();
        // u2 owns a different file
        sqlx::query(
            "INSERT INTO files (id, owner_id, status, total_size, chunk_count, \
             encrypted_file_key, encrypted_file_key_nonce) \
             VALUES ('f2', 'u2', 'ready', 20, 1, 'k', 'kn')",
        ).execute(&state.db).await.unwrap();

        let res = list(State(state.clone()), auth("u1")).await.unwrap();
        let ids: HashSet<String> = res.0["files"]
            .as_array().unwrap().iter()
            .map(|f| f["id"].as_str().unwrap().to_string())
            .collect();
        assert!(ids.contains("f1"));
        assert!(!ids.contains("f2"));
    }

    #[tokio::test]
    async fn create_inserts_pending_row_and_returns_id() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        let req = CreateFileRequest {
            total_size: 123,
            chunk_count: 1,
            encrypted_file_key: "k".into(),
            encrypted_file_key_nonce: "kn".into(),
        };
        let res = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let row: (String, i64) = sqlx::query_as(
            "SELECT status, total_size FROM files WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 123);
    }

    #[tokio::test]
    async fn create_rejects_zero_chunk_count() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        let req = CreateFileRequest {
            total_size: 10, chunk_count: 0,
            encrypted_file_key: "k".into(), encrypted_file_key_nonce: "kn".into(),
        };
        let err = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
    }

    #[tokio::test]
    async fn create_rejects_oversized_total() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        let req = CreateFileRequest {
            total_size: state.settings.limits.max_upload_bytes + 1,
            chunk_count: 1,
            encrypted_file_key: "k".into(), encrypted_file_key_nonce: "kn".into(),
        };
        let err = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap_err();
        assert!(matches!(err, ApiError::PayloadTooLarge));
    }
}
