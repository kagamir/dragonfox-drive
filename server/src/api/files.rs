//! File & chunk endpoints.
//!
//! The server treats all file data as opaque encrypted blobs. It only tracks
//! chunk indices, sizes, and storage paths. The encrypted manifest (containing
//! file name, mime, etc.) is also stored as an opaque blob.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::header,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::models::FileRow;
use crate::state::AppState;
use crate::storage;

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
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
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
            encrypted_parent_id: r.encrypted_parent_id,
            encrypted_parent_id_nonce: r.encrypted_parent_id_nonce,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows: Vec<FileRow> = sqlx::query_as(
        "SELECT id, owner_id, status, total_size, chunk_count, \
         encrypted_manifest, encrypted_manifest_nonce, \
         encrypted_file_key, encrypted_file_key_nonce, \
         encrypted_parent_id, encrypted_parent_id_nonce, \
         created_at, updated_at \
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
    #[serde(default)]
    pub encrypted_parent_id: Option<String>,
    #[serde(default)]
    pub encrypted_parent_id_nonce: Option<String>,
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
    let max = state.settings.limits.max_file_bytes;
    if max > 0 && req.total_size > max {
        return Err(ApiError::PayloadTooLarge);
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO files (id, owner_id, status, total_size, chunk_count, \
         encrypted_file_key, encrypted_file_key_nonce, \
         encrypted_parent_id, encrypted_parent_id_nonce) \
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.user_id)
        .bind(req.total_size as i64)
        .bind(req.chunk_count as i32)
        .bind(&req.encrypted_file_key)
        .bind(&req.encrypted_file_key_nonce)
        .bind(&req.encrypted_parent_id)
        .bind(&req.encrypted_parent_id_nonce)
        .execute(&state.db).await?;
    Ok(Json(json!({
        "id": id,
        "upload_url": format!("/api/files/{}/chunks/{{idx}}", id),
    })))
}

pub async fn get_manifest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT encrypted_manifest, encrypted_manifest_nonce FROM files \
         WHERE id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.user_id)
        .fetch_optional(&state.db).await?;
    match row {
        None => Err(ApiError::NotFound),
        Some((m, n)) => Ok(Json(json!({
            "encrypted_manifest": m,
            "encrypted_manifest_nonce": n,
        }))),
    }
}

#[derive(Debug, Deserialize)]
pub struct PutManifestRequest {
    pub encrypted_manifest: String,
    pub encrypted_manifest_nonce: String,
}

pub async fn put_manifest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<PutManifestRequest>,
) -> ApiResult<Json<Value>> {
    let now = chrono::Utc::now().to_rfc3339();
    let res = sqlx::query(
        "UPDATE files SET encrypted_manifest = ?, encrypted_manifest_nonce = ?, updated_at = ? \
         WHERE id = ? AND owner_id = ?")
        .bind(&req.encrypted_manifest)
        .bind(&req.encrypted_manifest_nonce)
        .bind(&now)
        .bind(&id)
        .bind(&user.user_id)
        .execute(&state.db).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn get_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, idx)): Path<(String, u32)>,
) -> ApiResult<impl IntoResponse> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT status FROM files WHERE id = ? AND owner_id = ?")
        .bind(&id).bind(&user.user_id)
        .fetch_optional(&state.db).await?;
    match row {
        None => Err(ApiError::NotFound),
        Some((status,)) if status != "ready" => {
            Err(ApiError::BadRequest("file is not ready".into()))
        }
        Some(_) => {
            let bytes = storage::read_chunk(&state, &id, idx)
                .await?
                .ok_or(ApiError::NotFound)?;
            Ok((
                [(header::CONTENT_TYPE, "application/octet-stream")],
                bytes,
            ))
        }
    }
}

pub async fn list_chunks(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(i32, String)> = sqlx::query_as(
        "SELECT chunk_count, status FROM files WHERE id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.user_id)
        .fetch_optional(&state.db).await?;
    let (chunk_count, status) = match row {
        None => return Err(ApiError::NotFound),
        Some((c, s)) => (c, s),
    };
    let rows: Vec<(i32,)> = sqlx::query_as(
        "SELECT idx FROM file_chunks WHERE file_id = ? ORDER BY idx")
        .bind(&id)
        .fetch_all(&state.db).await?;
    let indices: Vec<i32> = rows.into_iter().map(|(i,)| i).collect();
    Ok(Json(json!({
        "indices": indices,
        "chunk_count": chunk_count,
        "status": status,
    })))
}

pub async fn put_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, idx)): Path<(String, u32)>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let max = state.settings.limits.max_chunk_bytes;
    if max > 0 && (bytes.len() as u64) > max {
        return Err(ApiError::PayloadTooLarge);
    }
    let exists: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM files WHERE id = ? AND owner_id = ?")
        .bind(&id).bind(&user.user_id)
        .fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(ApiError::NotFound);
    }
    storage::write_chunk(&state, &id, idx, &bytes).await?;
    let path = storage::chunk_path(&state.settings.storage.data_dir, &id, idx);
    sqlx::query(
        "INSERT INTO file_chunks (file_id, idx, cipher_size, storage_path) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(file_id, idx) DO UPDATE SET \
            cipher_size = excluded.cipher_size, \
            storage_path = excluded.storage_path")
        .bind(&id)
        .bind(idx as i32)
        .bind(bytes.len() as i64)
        .bind(path.to_string_lossy().to_string())
        .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn finalize(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let file: Option<(i32,)> = sqlx::query_as(
        "SELECT chunk_count FROM files WHERE id = ? AND owner_id = ?")
        .bind(&id).bind(&user.user_id)
        .fetch_optional(&state.db).await?;
    let chunk_count = match file {
        None => return Err(ApiError::NotFound),
        Some((c,)) => c,
    };
    let count: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM file_chunks WHERE file_id = ?")
        .bind(&id).fetch_one(&state.db).await?;
    if count.0 != chunk_count as i64 {
        return Err(ApiError::BadRequest(format!(
            "expected {} chunks, found {}", chunk_count, count.0)));
    }
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE files SET status = 'ready', updated_at = ? WHERE id = ?")
        .bind(&now).bind(&id)
        .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    // Verify ownership first so we don't touch blobs for an unknown/non-owned id.
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM files WHERE id = ? AND owner_id = ?")
            .bind(&id).bind(&user.user_id)
            .fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(ApiError::NotFound);
    }
    sqlx::query("DELETE FROM files WHERE id = ? AND owner_id = ?")
        .bind(&id).bind(&user.user_id)
        .execute(&state.db).await?;
    storage::delete_file_chunks(&state, &id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Move a file to a new parent (or root). The client supplies the already
/// re-wrapped file_key + the new encrypted parent; the server does no crypto.
pub async fn patch_move(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<Value>,
) -> ApiResult<Json<Value>> {
    let now = chrono::Utc::now().to_rfc3339();
    let get_str = |k: &str| -> ApiResult<String> {
        req.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
            .ok_or_else(|| ApiError::BadRequest(format!("{k} must be a string")))
    };
    let encrypted_file_key = get_str("encrypted_file_key")?;
    let encrypted_file_key_nonce = get_str("encrypted_file_key_nonce")?;
    let (encrypted_parent_id, encrypted_parent_id_nonce) = match req.get("encrypted_parent_id") {
        None | Some(Value::Null) => (None, None),
        Some(_) => (Some(get_str("encrypted_parent_id")?), Some(get_str("encrypted_parent_id_nonce")?)),
    };

    let res = sqlx::query(
        "UPDATE files SET encrypted_file_key = ?, encrypted_file_key_nonce = ?, \
         encrypted_parent_id = ?, encrypted_parent_id_nonce = ?, updated_at = ? \
         WHERE id = ? AND owner_id = ?")
        .bind(&encrypted_file_key)
        .bind(&encrypted_file_key_nonce)
        .bind(&encrypted_parent_id)
        .bind(&encrypted_parent_id_nonce)
        .bind(&now).bind(&id).bind(&user.user_id)
        .execute(&state.db).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
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
        // Isolate blob storage under the same tempdir so chunk-writing tests
        // don't race on the shared `./data` default across parallel tests.
        settings.storage.data_dir = dir.path().join("data");
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
            encrypted_parent_id: None,
            encrypted_parent_id_nonce: None,
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
            encrypted_parent_id: None, encrypted_parent_id_nonce: None,
        };
        let err = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
    }

    #[tokio::test]
    async fn create_rejects_oversized_total() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        let req = CreateFileRequest {
            total_size: state.settings.limits.max_file_bytes + 1,
            chunk_count: 1,
            encrypted_file_key: "k".into(), encrypted_file_key_nonce: "kn".into(),
            encrypted_parent_id: None, encrypted_parent_id_nonce: None,
        };
        let err = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap_err();
        assert!(matches!(err, ApiError::PayloadTooLarge));
    }

    async fn seed_ready_file(state: &AppState, id: &str, owner: &str) {
        sqlx::query(
            "INSERT INTO files (id, owner_id, status, total_size, chunk_count, \
             encrypted_file_key, encrypted_file_key_nonce) \
             VALUES (?, ?, 'pending', 10, 1, 'k', 'kn')",
        )
        .bind(id).bind(owner).execute(&state.db).await.unwrap();
    }

    #[tokio::test]
    async fn put_then_get_manifest_round_trips() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        put_manifest(
            State(state.clone()), auth("u1"), Path("f1".into()),
            Json(PutManifestRequest {
                encrypted_manifest: "EM".into(),
                encrypted_manifest_nonce: "EN".into(),
            }),
        ).await.unwrap();
        let res = get_manifest(State(state.clone()), auth("u1"), Path("f1".into())).await.unwrap();
        assert_eq!(res.0["encrypted_manifest"], "EM");
        assert_eq!(res.0["encrypted_manifest_nonce"], "EN");
    }

    #[tokio::test]
    async fn get_manifest_returns_404_for_non_owner() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let err = get_manifest(State(state.clone()), auth("u2"), Path("f1".into())).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn put_manifest_returns_404_when_missing() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        let err = put_manifest(
            State(state.clone()), auth("u1"), Path("nope".into()),
            Json(PutManifestRequest { encrypted_manifest: "x".into(), encrypted_manifest_nonce: "y".into() }),
        ).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn put_chunk_writes_bytes_and_row() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let body = Bytes::from_static(b"cipherdata");
        put_chunk(
            State(state.clone()), auth("u1"),
            Path(("f1".to_string(), 0u32)), body,
        ).await.unwrap();
        let on_disk = storage::read_chunk(&state, "f1", 0).await.unwrap();
        assert_eq!(on_disk, Some(b"cipherdata".to_vec()));
        let count: (i64,) = sqlx::query_as("SELECT count(*) FROM file_chunks WHERE file_id = 'f1'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn put_chunk_returns_413_when_oversized() {
        let (mut state, _guard) = files_state().await;
        // Shrink the limit so the test allocates a few bytes, not ~100 MiB.
        Arc::get_mut(&mut state.settings).unwrap().limits.max_chunk_bytes = 5;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let big = Bytes::from_static(b"123456"); // 6 bytes > 5
        let err = put_chunk(
            State(state.clone()), auth("u1"),
            Path(("f1".to_string(), 0u32)), big,
        ).await.unwrap_err();
        assert!(matches!(err, ApiError::PayloadTooLarge));
    }

    #[tokio::test]
    async fn put_chunk_returns_404_for_non_owner() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let err = put_chunk(
            State(state.clone()), auth("u2"),
            Path(("f1".to_string(), 0u32)), Bytes::from_static(b"x"),
        ).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn get_chunk_returns_stored_bytes() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        storage::write_chunk(&state, "f1", 0, b"payload").await.unwrap();
        sqlx::query("UPDATE files SET status = 'ready' WHERE id = 'f1'")
            .execute(&state.db).await.unwrap();
        let resp = get_chunk(
            State(state.clone()), auth("u1"),
            Path(("f1".to_string(), 0u32)),
        ).await.unwrap().into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], b"payload");
    }

    #[tokio::test]
    async fn finalize_marks_ready_when_chunk_count_matches() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        storage::write_chunk(&state, "f1", 0, b"x").await.unwrap();
        sqlx::query("INSERT INTO file_chunks (file_id, idx, cipher_size, storage_path) \
                     VALUES ('f1', 0, 1, 'p')")
            .execute(&state.db).await.unwrap();
        finalize(State(state.clone()), auth("u1"), Path("f1".into())).await.unwrap();
        let row: (String,) = sqlx::query_as("SELECT status FROM files WHERE id = 'f1'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0, "ready");
    }

    #[tokio::test]
    async fn finalize_rejects_when_count_mismatch() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        // file declares chunk_count=1 but no chunk rows exist
        seed_ready_file(&state, "f1", "u1").await;
        let err = finalize(State(state.clone()), auth("u1"), Path("f1".into())).await.unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
    }

    #[tokio::test]
    async fn delete_hard_deletes_row_and_removes_chunks() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        storage::write_chunk(&state, "f1", 0, b"abc").await.unwrap();
        delete(State(state.clone()), auth("u1"), Path("f1".into())).await.unwrap();
        let row: Option<(String,)> = sqlx::query_as("SELECT id FROM files WHERE id = 'f1'")
            .fetch_optional(&state.db).await.unwrap();
        assert!(row.is_none(), "hard delete must remove the row entirely");
        assert!(storage::read_chunk(&state, "f1", 0).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_returns_404_for_non_owner() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let err = delete(State(state.clone()), auth("u2"), Path("f1".into())).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn patch_move_updates_parent_and_file_key() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        patch_move(
            State(state.clone()), auth("u1"), Path("f1".into()),
            Json(json!({
                "encrypted_parent_id": "encP", "encrypted_parent_id_nonce": "encPn",
                "encrypted_file_key": "newK", "encrypted_file_key_nonce": "newKn",
            })),
        ).await.unwrap();
        let row: (Option<String>, String) = sqlx::query_as(
            "SELECT encrypted_parent_id, encrypted_file_key FROM files WHERE id = 'f1'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0.as_deref(), Some("encP"));
        assert_eq!(row.1, "newK");
    }

    #[tokio::test]
    async fn patch_move_returns_404_for_non_owner() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let err = patch_move(
            State(state.clone()), auth("u2"), Path("f1".into()),
            Json(json!({
                "encrypted_parent_id": null, "encrypted_parent_id_nonce": null,
                "encrypted_file_key": "k", "encrypted_file_key_nonce": "kn",
            })),
        ).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn list_chunks_returns_indices_chunk_count_and_status() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        // file declares chunk_count=1 in seed_ready_file; override to 3
        sqlx::query("UPDATE files SET chunk_count = 3 WHERE id = 'f1'")
            .execute(&state.db).await.unwrap();
        storage::write_chunk(&state, "f1", 0, b"a").await.unwrap();
        storage::write_chunk(&state, "f1", 2, b"c").await.unwrap();
        sqlx::query("INSERT INTO file_chunks (file_id, idx, cipher_size, storage_path) \
                     VALUES ('f1', 0, 1, 'p0'), ('f1', 2, 1, 'p2')")
            .execute(&state.db).await.unwrap();

        let res = list_chunks(State(state.clone()), auth("u1"), Path("f1".into()))
            .await.unwrap();
        let v = res.0;
        assert_eq!(v["indices"], serde_json::json!([0, 2]));
        assert_eq!(v["chunk_count"], 3);
        assert_eq!(v["status"], "pending");
    }

    #[tokio::test]
    async fn list_chunks_returns_404_for_non_owner() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let err = list_chunks(State(state.clone()), auth("u2"), Path("f1".into()))
            .await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn list_chunks_empty_for_fresh_pending() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = list_chunks(State(state.clone()), auth("u1"), Path("f1".into()))
            .await.unwrap();
        assert_eq!(res.0["indices"], serde_json::json!([]));
        assert_eq!(res.0["chunk_count"], 1);
    }

    #[tokio::test]
    async fn put_chunk_is_idempotent_on_re_put() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        put_chunk(
            State(state.clone()), auth("u1"),
            Path(("f1".to_string(), 0u32)), Bytes::from_static(b"first"),
        ).await.unwrap();
        put_chunk(
            State(state.clone()), auth("u1"),
            Path(("f1".to_string(), 0u32)), Bytes::from_static(b"second"),
        ).await.unwrap();
        let count: (i64,) = sqlx::query_as(
            "SELECT count(*) FROM file_chunks WHERE file_id = 'f1' AND idx = 0")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(count.0, 1, "re-put must update, not duplicate");
        assert_eq!(
            storage::read_chunk(&state, "f1", 0).await.unwrap(),
            Some(b"second".to_vec()),
        );
    }

    #[tokio::test]
    async fn finalize_marks_ready_for_multi_chunk() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        // a 3-chunk file
        sqlx::query(
            "INSERT INTO files (id, owner_id, status, total_size, chunk_count, \
             encrypted_file_key, encrypted_file_key_nonce) \
             VALUES ('f1', 'u1', 'pending', 30, 3, 'k', 'kn')",
        ).execute(&state.db).await.unwrap();
        for i in 0..3u32 {
            storage::write_chunk(&state, "f1", i, b"x").await.unwrap();
            sqlx::query("INSERT INTO file_chunks (file_id, idx, cipher_size, storage_path) \
                         VALUES ('f1', ?, 1, 'p')")
                .bind(i as i32).execute(&state.db).await.unwrap();
        }
        finalize(State(state.clone()), auth("u1"), Path("f1".into())).await.unwrap();
        let row: (String,) = sqlx::query_as("SELECT status FROM files WHERE id = 'f1'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0, "ready");
    }
}
