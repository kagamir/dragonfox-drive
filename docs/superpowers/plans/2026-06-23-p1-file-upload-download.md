# P1 File Upload / Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete P1 end-to-end-encrypted single-chunk file upload/download loop (the last P1 pillar), replacing the stub `files.rs` handlers with real implementations and wiring the frontend upload/download/delete UI.

**Architecture:** Whole file is encrypted as one AES-GCM chunk in a Web Worker (`chunk_count=1`, `chunkIndex=0`). A per-file random `file_key` wraps the chunk and the encrypted manifest; `file_key` itself is master_key-wrapped and stored in a new `files` column. Server treats all bytes as opaque blobs. Upload = create → putManifest → putChunk(raw body) → finalize; download = getChunk → worker decrypt → Blob.

**Tech Stack:** Rust (axum + sqlx + SQLite), Vue 3 + TypeScript + Pinia, WebCrypto (AES-GCM) + libsodium (WASM), Comlink Web Worker, Vitest.

## Global Constraints

- Rust backend checked with `cargo test --manifest-path server/Cargo.toml`; frontend with `npm test --prefix web`; typecheck with `npm run typecheck --prefix web`.
- SQL: runtime `sqlx::query` / `sqlx::query_as` with `.bind()` only — NO `sqlx::query!` macros, no `.sqlx` offline cache.
- Frontend tests stub globals with `vi.stubGlobal("fetch", ...)` — NO `msw`. localforage is mocked in setup.
- Do NOT remove the `fixLibsodiumImport` plugin in `web/vite.config.ts`.
- Do NOT stage the pre-existing uncommitted files (`server/src/api/assets.rs`, `web/vite.config.ts`, `web/package-lock.json`) — only stage files this feature touches.
- Username auth (register/login/session) is already implemented and merged to master; this plan builds on top of it.
- Chunk constants: `chunk_count = 1`, `chunkIndex = 0`, `iv = iv_base XOR 0` (counter-style, forward-compatible with P2).
- Conversation language: 中文.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/migrations/20260101000002_files_file_key.sql` | create | Add `encrypted_file_key` + nonce columns |
| `server/src/models.rs` | modify | Add `FileRow` (sqlx::FromRow) |
| `server/src/config.rs` | modify | `max_upload_bytes` default 100 MiB |
| `server/src/api/files.rs` | modify | Implement all 8 handlers + DTOs |
| `server/src/main.rs` | modify | `DefaultBodyLimit` layer |
| `web/src/crypto/file.ts` | create | `Manifest` type, base64/hex helpers, `encryptFilePayload` / `decryptFilePayload` |
| `web/src/crypto/file.test.ts` | create | Round-trip tests |
| `web/src/workers/crypto.worker.ts` | modify | Expose `encryptFile` / `decryptFile` / `decryptManifest` |
| `web/src/api/types.ts` | modify | Extend `CreateFileRequest` + `FileMeta`; add `Manifest` |
| `web/src/api/files.ts` | modify | `putChunk` raw body + `onProgress`; `create` body |
| `web/src/stores/files.ts` | modify | `upload` / `download` / `remove` + progress + display names |
| `web/src/views/DriveView.vue` | modify | Upload UI, file list, download/delete buttons |
| `docs/api.md` | modify | `create` body + `put_chunk` raw body |

---

### Task 1: Migration + FileRow model + config default

**Files:**
- Create: `server/migrations/20260101000002_files_file_key.sql`
- Modify: `server/src/models.rs` (append `FileRow`)
- Modify: `server/src/config.rs:101-109` (`LimitSettings::default`) and `:153` (test assertion)

**Interfaces:**
- Produces: `FileRow` struct (used by Task 2's `list`), migration applied by every server test's `test_state_with_db`.

- [ ] **Step 1: Write the migration**

`server/migrations/20260101000002_files_file_key.sql`:
```sql
-- Persist the per-file file_key, wrapped by the user's master_key.
-- Written by `create` at upload start, so non-null for any ready file.
ALTER TABLE files ADD COLUMN encrypted_file_key TEXT;
ALTER TABLE files ADD COLUMN encrypted_file_key_nonce TEXT;
```

- [ ] **Step 2: Add `FileRow` to models.rs**

Append to `server/src/models.rs` (after the existing `User` struct):
```rust
#[derive(Debug, sqlx::FromRow)]
pub struct FileRow {
    pub id: String,
    pub owner_id: String,
    pub status: String,
    pub total_size: i64,
    pub chunk_count: i32,
    pub encrypted_manifest: Option<String>,
    pub encrypted_manifest_nonce: Option<String>,
    pub encrypted_file_key: Option<String>,
    pub encrypted_file_key_nonce: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```
(`total_size` / `chunk_count` are signed because SQLite INTEGER maps to `i64`/`i32` in sqlx; the API DTO converts them to `u64`/`u32`.)

- [ ] **Step 3: Change `max_upload_bytes` default + update its test**

In `server/src/config.rs`, replace the `LimitSettings` default impl body:
```rust
impl Default for LimitSettings {
    fn default() -> Self {
        Self {
            max_upload_bytes: 100 * 1024 * 1024,
            max_chunk_bytes: 8 * 1024 * 1024,
            rate_limit_per_minute: 600,
        }
    }
}
```
In the `defaults_match_documented_values` test, update the assertion:
```rust
assert_eq!(s.limits.max_upload_bytes, 100 * 1024 * 1024);
```

- [ ] **Step 4: Run tests to verify migration + model compile**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: PASS (existing 50 tests still green; migration applies cleanly; `FileRow` compiles though unused yet — `#[allow(dead_code)]` is not needed because Task 2 uses it immediately).

- [ ] **Step 5: Commit**

```bash
git add server/migrations/20260101000002_files_file_key.sql server/src/models.rs server/src/config.rs
git commit -m "feat(server): add file_key columns migration + FileRow + 100MiB upload default"
```

---

### Task 2: Server `list` + `create` handlers

**Files:**
- Modify: `server/src/api/files.rs` (replace `list` + `create` stubs; extend `FileMeta` + `CreateFileRequest`)

**Interfaces:**
- Consumes: `FileRow` (Task 1), `AuthUser` (existing), `AppState` (existing).
- Produces: `list` returns `{ files: FileMeta[] }` with the new columns; `create` accepts the extended body and returns `{ id, upload_url }`.

- [ ] **Step 1: Write the failing tests**

Append a `#[cfg(test)] mod tests` block to `server/src/api/files.rs`:
```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path server/Cargo.toml api::files`
Expected: FAIL (stubs still return empty/errors).

- [ ] **Step 3: Extend `FileMeta` + `CreateFileRequest` and implement `list` + `create`**

Replace the top of `server/src/api/files.rs` (DTOs + `FileMeta` + `list` + `create`). Only the imports `list`/`create` need are added now; Tasks 3-4 add `Path`, `Bytes`, `header`, `IntoResponse`, `storage` as their handlers are introduced (avoids unused-import warnings at each commit):
```rust
use axum::{
    extract::State,
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
```
Leave the remaining stub handlers (`get_manifest`, `put_manifest`, `get_chunk`, `put_chunk`, `finalize`, `delete`) untouched for now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml api::files`
Expected: PASS (the 4 new tests green).

- [ ] **Step 5: Commit**

```bash
git add server/src/api/files.rs
git commit -m "feat(server): implement files list + create handlers"
```

---

### Task 3: Server `put_manifest` + `get_manifest`

**Files:**
- Modify: `server/src/api/files.rs` (replace `put_manifest` + `get_manifest` stubs)

**Interfaces:**
- Produces: `PUT /api/files/:id/manifest` stores the encrypted manifest; `GET` returns it.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `server/src/api/files.rs`:
```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path server/Cargo.toml api::files::tests::put_then get_manifest_returns`
Expected: FAIL (stubs return `ApiError::Internal`).

- [ ] **Step 3: Implement `put_manifest` + `get_manifest`**

First add `Path` to the axum imports at the top of `server/src/api/files.rs`:
```rust
use axum::{
    extract::{Path, State},
    Json,
};
```

Then replace those two stub functions in `server/src/api/files.rs`:
```rust
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
```
(`PutManifestRequest` already exists as a stub struct; replace it with this exact definition so it lives next to its handler.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml api::files`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/files.rs
git commit -m "feat(server): implement files put_manifest + get_manifest"
```

---

### Task 4: Server `put_chunk` + `get_chunk` + body limit

**Files:**
- Modify: `server/src/api/files.rs` (replace `put_chunk` + `get_chunk` stubs)
- Modify: `server/src/main.rs:82-93` (`build_router`) — add `DefaultBodyLimit`

**Interfaces:**
- Consumes: `storage::write_chunk` / `read_chunk` / `chunk_path` (existing).
- Produces: `put_chunk` accepts a raw `Bytes` body; `get_chunk` returns `application/octet-stream`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:
```rust
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
        Arc::get_mut(&mut state.settings).unwrap().limits.max_upload_bytes = 5;
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
```
Add `use axum::body::Bytes;` is already at the top of the file (Task 2 import block). The test module needs `use super::*;` which it has.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path server/Cargo.toml api::files::tests::put_chunk get_chunk_returns`
Expected: FAIL (stubs return `ApiError::Internal`).

- [ ] **Step 3: Implement `put_chunk` + `get_chunk`**

First extend the axum imports at the top of `server/src/api/files.rs` to include the items these handlers need:
```rust
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::header,
    response::IntoResponse,
    Json,
};
```
and add the storage import below the other `use crate::...` lines:
```rust
use crate::storage;
```

Then replace the two stub functions:
```rust
pub async fn put_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, idx)): Path<(String, u32)>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let max = state.settings.limits.max_upload_bytes;
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
```

- [ ] **Step 4: Add the `DefaultBodyLimit` layer**

In `server/src/main.rs`, add the import and layer. Replace the `build_router` fn:
```rust
use axum::{extract::DefaultBodyLimit, serve, Router};

fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::very_permissive();
    let compression = CompressionLayer::new().br(true);
    let max_body = state.settings.limits.max_upload_bytes as usize;

    Router::new()
        .merge(api::routes())
        .fallback(api::assets::fallback)
        .layer(DefaultBodyLimit::max(max_body))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(compression)
        .with_state(state)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml api::files`
Expected: PASS (all chunk tests green; the layer is exercised by the integration smoke in Task 10).

- [ ] **Step 6: Commit**

```bash
git add server/src/api/files.rs server/src/main.rs
git commit -m "feat(server): implement put_chunk + get_chunk (raw body) + body limit"
```

---

### Task 5: Server `finalize` + `delete`

**Files:**
- Modify: `server/src/api/files.rs` (replace `finalize` + `delete` stubs)

**Interfaces:**
- Produces: `finalize` flips `status` to `ready` after verifying chunk count; `delete` soft-deletes + removes on-disk chunks.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:
```rust
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
    async fn delete_soft_deletes_and_removes_chunks() {
        let (state, _guard) = files_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        storage::write_chunk(&state, "f1", 0, b"abc").await.unwrap();
        delete(State(state.clone()), auth("u1"), Path("f1".into())).await.unwrap();
        let row: (String,) = sqlx::query_as("SELECT status FROM files WHERE id = 'f1'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0, "deleted");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path server/Cargo.toml api::files::tests::finalize delete`
Expected: FAIL.

- [ ] **Step 3: Implement `finalize` + `delete`**

Replace the two stub functions:
```rust
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
    let now = chrono::Utc::now().to_rfc3339();
    let res = sqlx::query(
        "UPDATE files SET status = 'deleted', updated_at = ? WHERE id = ? AND owner_id = ?")
        .bind(&now).bind(&id).bind(&user.user_id)
        .execute(&state.db).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    storage::delete_file_chunks(&state, &id).await?;
    Ok(Json(json!({ "ok": true })))
}
```

- [ ] **Step 4: Run the full backend suite**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: PASS (all previous + new tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/api/files.rs
git commit -m "feat(server): implement finalize + delete handlers"
```

---

### Task 6: Frontend `crypto/file.ts` + worker exposure

**Files:**
- Create: `web/src/crypto/file.ts`
- Create: `web/src/crypto/file.test.ts`
- Modify: `web/src/workers/crypto.worker.ts` (add 3 methods to `api`)

**Interfaces:**
- Consumes: `encrypt`/`decrypt`/`encryptChunk`/`decryptChunk`/`chunkIv` (symmetric.ts), `generateFileKey`/`wrapMasterKey`/`unwrapMasterKey` (keys.ts), `randomBytes`/`RawKey` (kdf.ts).
- Produces: `cryptoApi.encryptFile` / `cryptoApi.decryptFile` / `cryptoApi.decryptManifest` (Comlink); `Manifest` type; base64/hex helpers.

- [ ] **Step 1: Write `crypto/file.ts`**

```typescript
/**
 * High-level file encrypt/decrypt orchestration.
 *
 * P1 model: the whole file is a single AES-GCM chunk (chunkIndex = 0, IV =
 * iv_base XOR 0). A random per-file file_key encrypts both the chunk and the
 * manifest; file_key itself is master_key-wrapped for storage on the server.
 */

import {
  decrypt,
  encrypt,
  chunkIv,
  decryptChunk,
  encryptChunk,
} from "./symmetric";
import {
  generateFileKey,
  unwrapMasterKey,
  wrapMasterKey,
  type WrappedKey,
} from "./keys";
import { randomBytes, type RawKey } from "./kdf";

export const FILE_CHUNK_SIZE = 4 * 1024 * 1024;

export interface Manifest {
  version: number;
  name: string;
  mime: string;
  size: number;
  chunk_size: number;
  iv_base: string; // base64 of the 12-byte iv_base
  plaintext_sha256: string; // hex
  created_at: string; // RFC-3339
}

/** Wire-format payload returned by encryptFile (base64 for server columns). */
export interface EncryptedFilePayload {
  ciphertext: Uint8Array;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
  encrypted_manifest: string; // base64
  encrypted_manifest_nonce: string; // base64
}

// --- encoding helpers (shared; auth.ts keeps its own local copy) ----------

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function toWrapped(ct: Uint8Array, iv: Uint8Array): WrappedKey {
  return { ciphertext: ct, iv };
}

export async function encryptFile(
  masterKey: RawKey,
  plaintext: Uint8Array,
  name: string,
  mime: string,
): Promise<EncryptedFilePayload> {
  const fileKey = generateFileKey();
  const ivBase = randomBytes(12);
  const ciphertext = await encryptChunk(fileKey, chunkIv(ivBase, 0), plaintext);

  const wrapped: WrappedKey = await wrapMasterKey(fileKey, masterKey);

  const sha = new Uint8Array(
    await crypto.subtle.digest("SHA-256", plaintext as BufferSource),
  );
  const manifest: Manifest = {
    version: 1,
    name,
    mime: mime || "application/octet-stream",
    size: plaintext.length,
    chunk_size: FILE_CHUNK_SIZE,
    iv_base: toBase64(ivBase),
    plaintext_sha256: toHex(sha),
    created_at: new Date().toISOString(),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const encManifest = await encrypt(fileKey, manifestBytes);

  return {
    ciphertext,
    encrypted_file_key: toBase64(wrapped.ciphertext),
    encrypted_file_key_nonce: toBase64(wrapped.iv),
    encrypted_manifest: toBase64(encManifest.ciphertext),
    encrypted_manifest_nonce: toBase64(encManifest.iv),
  };
}

export async function decryptManifest(
  masterKey: RawKey,
  encryptedFileKey: string,
  encryptedFileKeyNonce: string,
  encryptedManifest: string,
  encryptedManifestNonce: string,
): Promise<Manifest> {
  const fileKey = await unwrapMasterKey(
    toWrapped(fromBase64(encryptedFileKey), fromBase64(encryptedFileKeyNonce)),
    masterKey,
  );
  const plain = await decrypt(
    fileKey,
    fromBase64(encryptedManifest),
    fromBase64(encryptedManifestNonce),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Manifest;
}

export async function decryptFile(
  masterKey: RawKey,
  encryptedFileKey: string,
  encryptedFileKeyNonce: string,
  encryptedManifest: string,
  encryptedManifestNonce: string,
  ciphertext: Uint8Array,
): Promise<{ plaintext: Uint8Array; manifest: Manifest }> {
  const manifest = await decryptManifest(
    masterKey, encryptedFileKey, encryptedFileKeyNonce,
    encryptedManifest, encryptedManifestNonce,
  );
  const fileKey = await unwrapMasterKey(
    toWrapped(fromBase64(encryptedFileKey), fromBase64(encryptedFileKeyNonce)),
    masterKey,
  );
  const ivBase = fromBase64(manifest.iv_base);
  const plaintext = await decryptChunk(fileKey, chunkIv(ivBase, 0), ciphertext);
  return { plaintext, manifest };
}
```

- [ ] **Step 2: Write the round-trip test**

`web/src/crypto/file.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from "vitest";

import { encryptFile, decryptFile, decryptManifest } from "./file";
import { generateMasterKey } from "./keys";
import { initCrypto } from "./index";

describe("file crypto", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("round-trips a small file byte-identical", async () => {
    const master = generateMasterKey();
    const pt = new TextEncoder().encode("hello dragonfox");
    const payload = await encryptFile(master, pt, "note.txt", "text/plain");
    const { plaintext, manifest } = await decryptFile(
      master,
      payload.encrypted_file_key,
      payload.encrypted_file_key_nonce,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
      payload.ciphertext,
    );
    expect(Array.from(plaintext)).toEqual(Array.from(pt));
    expect(manifest.name).toBe("note.txt");
    expect(manifest.mime).toBe("text/plain");
    expect(manifest.size).toBe(pt.length);
  });

  it("round-trips an empty file", async () => {
    const master = generateMasterKey();
    const pt = new Uint8Array(0);
    const payload = await encryptFile(master, pt, "empty.bin", "");
    const { plaintext } = await decryptFile(
      master,
      payload.encrypted_file_key,
      payload.encrypted_file_key_nonce,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
      payload.ciphertext,
    );
    expect(plaintext.length).toBe(0);
  });

  it("decryptManifest alone recovers metadata", async () => {
    const master = generateMasterKey();
    const pt = new TextEncoder().encode("x");
    const payload = await encryptFile(master, pt, "a.txt", "text/plain");
    const m = await decryptManifest(
      master,
      payload.encrypted_file_key,
      payload.encrypted_file_key_nonce,
      payload.encrypted_manifest,
      payload.encrypted_manifest_nonce,
    );
    expect(m.name).toBe("a.txt");
    expect(m.iv_base).toBeTruthy();
  });
});
```

- [ ] **Step 3: Expose the three methods in the worker**

In `web/src/workers/crypto.worker.ts`, add to the imports at the top:
```typescript
import {
  decryptFile as decryptFilePayload,
  decryptManifest as decryptManifestPayload,
  encryptFile as encryptFilePayload,
  type EncryptedFilePayload,
  type Manifest,
} from "@/crypto/file";
```
Then add these three methods inside the `export const api = { ... }` object (after `decryptChunk`):
```typescript
  async encryptFile(
    masterKey: RawKey,
    plaintext: Uint8Array,
    name: string,
    mime: string,
  ): Promise<EncryptedFilePayload> {
    return encryptFilePayload(masterKey, plaintext, name, mime);
  },

  async decryptManifest(
    masterKey: RawKey,
    encryptedFileKey: string,
    encryptedFileKeyNonce: string,
    encryptedManifest: string,
    encryptedManifestNonce: string,
  ): Promise<Manifest> {
    return decryptManifestPayload(
      masterKey, encryptedFileKey, encryptedFileKeyNonce,
      encryptedManifest, encryptedManifestNonce,
    );
  },

  async decryptFile(
    masterKey: RawKey,
    encryptedFileKey: string,
    encryptedFileKeyNonce: string,
    encryptedManifest: string,
    encryptedManifestNonce: string,
    ciphertext: Uint8Array,
  ): Promise<{ plaintext: Uint8Array; manifest: Manifest }> {
    return decryptFilePayload(
      masterKey, encryptedFileKey, encryptedFileKeyNonce,
      encryptedManifest, encryptedManifestNonce, ciphertext,
    );
  },
```

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix web -- file.test`
Expected: PASS (3 file-crypto tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/crypto/file.ts web/src/crypto/file.test.ts web/src/workers/crypto.worker.ts
git commit -m "feat(web): add file encrypt/decrypt orchestration + worker methods"
```

---

### Task 7: Frontend `api/types.ts` + `api/files.ts` (raw-body putChunk)

**Files:**
- Modify: `web/src/api/types.ts` (extend `CreateFileRequest` + `FileMeta`; this file already has a `Manifest`-like concept only in crypto — keep API `Manifest` separate or re-export)
- Modify: `web/src/api/files.ts` (`create` body, `putChunk` raw body + `onProgress`)

**Interfaces:**
- Consumes: `getAuthToken` (client.ts), `EncryptedFilePayload` (Task 6).
- Produces: `filesApi.putChunk(id, idx, bytes, onProgress?)` via XHR with upload progress.

- [ ] **Step 1: Extend the API types**

In `web/src/api/types.ts`, replace the `CreateFileRequest` and `FileMeta` interfaces:
```typescript
export interface CreateFileRequest {
  total_size: number;
  chunk_count: number;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
}

export interface FileMeta {
  id: string;
  owner_id: string;
  status: "pending" | "uploading" | "ready" | "deleted";
  total_size: number;
  chunk_count: number;
  encrypted_manifest: string | null; // base64
  encrypted_manifest_nonce: string | null; // base64
  encrypted_file_key: string | null; // base64
  encrypted_file_key_nonce: string | null; // base64
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Rewrite `files.ts` with raw-body `putChunk` + `onProgress`**

Replace the entire `web/src/api/files.ts`:
```typescript
import { http } from "./client";
import { getAuthToken, ApiError, request } from "./client";
import type { CreateFileRequest, CreateFileResponse, FileMeta } from "./types";

export const filesApi = {
  list: () => http.get<{ files: FileMeta[] }>("/api/files"),

  create: (body: CreateFileRequest) =>
    http.post<CreateFileResponse>("/api/files", body),

  getManifest: (id: string) =>
    http.get<{ encrypted_manifest: string; encrypted_manifest_nonce: string }>(
      `/api/files/${id}/manifest`,
    ),

  putManifest: (
    id: string,
    body: { encrypted_manifest: string; encrypted_manifest_nonce: string },
  ) => http.put<{ ok: true }>(`/api/files/${id}/manifest`, body),

  /**
   * Upload a single encrypted chunk as a raw octet-stream body with
   * upload-progress reporting. Uses XHR (fetch has no upload-progress API).
   * On 401 the caller is expected to refresh and retry (same as other
   * endpoints; the short upload window rarely crosses token expiry).
   */
  putChunk: (
    id: string,
    index: number,
    ciphertext: Uint8Array,
    onProgress?: (ratio: number) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/files/${id}/chunks/${index}`);
      const token = getAuthToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      if (signal) {
        signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new ApiError("upload aborted", 0));
        });
      }
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true });
        else {
          reject(
            new ApiError(xhr.statusText || `HTTP ${xhr.status}`, xhr.status),
          );
        }
      };
      xhr.onerror = () => reject(new ApiError("network error", 0));
      xhr.send(ciphertext);
    });
  },

  /** Fetch a single encrypted chunk. */
  getChunk: (id: string, index: number, signal?: AbortSignal) =>
    request<Response>(`/api/files/${id}/chunks/${index}`, {
      method: "GET",
      rawResponse: true,
      signal,
    }),

  finalize: (id: string) => http.post<{ ok: true }>(`/api/files/${id}/finalize`),

  remove: (id: string) => http.delete<{ ok: true }>(`/api/files/${id}`),
};
```
(The `request` import remains used by `getChunk`; `http` is used by the JSON endpoints. No unused imports.)

- [ ] **Step 3: Verify typecheck + existing tests still compile**

Run: `npm run typecheck --prefix web`
Expected: PASS.

Run: `npm test --prefix web`
Expected: PASS (existing 74 tests; no test removed).

- [ ] **Step 4: Commit**

```bash
git add web/src/api/types.ts web/src/api/files.ts
git commit -m "feat(web): extend file types + raw-body putChunk with progress"
```

---

### Task 8: `stores/files.ts` upload / download / remove + display names

**Files:**
- Modify: `web/src/stores/files.ts`

**Interfaces:**
- Consumes: `filesApi` (Task 7), `cryptoApi` (worker), `useAuthStore().masterKey`.
- Produces: `files.upload(file)`, `files.download(meta)`, `files.remove(id)`, plus `uploading`, `uploadProgress`, `downloading`, `displayNames`.

- [ ] **Step 1: Write the failing store tests**

Create `web/src/stores/files.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {
    encryptFile: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([1, 2, 3]),
      encrypted_file_key: "fk",
      encrypted_file_key_nonce: "fkn",
      encrypted_manifest: "em",
      encrypted_manifest_nonce: "emn",
    }),
    decryptFile: vi.fn().mockResolvedValue({
      plaintext: new Uint8Array([9, 9]),
      manifest: { name: "dl.txt", mime: "text/plain", iv_base: "iv==" },
    }),
  },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

const createMock = vi.fn();
const putManifestMock = vi.fn().mockResolvedValue({ ok: true });
const putChunkMock = vi.fn().mockResolvedValue({ ok: true });
const finalizeMock = vi.fn().mockResolvedValue({ ok: true });
const removeMock = vi.fn().mockResolvedValue({ ok: true });
const getChunkMock = vi.fn().mockResolvedValue(
  new Response(new Uint8Array([1, 2, 3])),
);

vi.mock("@/api/files", () => ({
  filesApi: {
    list: vi.fn().mockResolvedValue({ files: [] }),
    create: (b: unknown) => {
      createMock(b);
      return Promise.resolve({ id: "fid", upload_url: "/x" });
    },
    putManifest: putManifestMock,
    putChunk: putChunkMock,
    finalize: finalizeMock,
    remove: removeMock,
    getChunk: getChunkMock,
  },
}));

import { cryptoApi } from "@/workers/crypto";
import { useFilesStore } from "./files";
import { useAuthStore } from "./auth";

describe("files store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    createMock.mockClear();
    putManifestMock.mockClear();
    putChunkMock.mockClear();
    finalizeMock.mockClear();
    removeMock.mockClear();
  });

  it("upload calls create → putManifest → putChunk → finalize in order", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", {
      type: "text/plain",
    });
    await files.upload(file);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ total_size: 2, chunk_count: 1 }),
    );
    expect(putManifestMock).toHaveBeenCalledWith("fid", expect.any(Object));
    expect(putChunkMock).toHaveBeenCalledWith(
      "fid", 0, expect.any(Uint8Array), expect.any(Function),
    );
    expect(finalizeMock).toHaveBeenCalledWith("fid");
  });

  it("remove calls the api and refreshes", async () => {
    const files = useFilesStore();
    await files.remove("x");
    expect(removeMock).toHaveBeenCalledWith("x");
  });

  it("download fetches the chunk and decrypts it", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    // jsdom lacks URL.createObjectURL
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.download(meta);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 0);
    expect(cryptoApi.decryptFile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix web -- files.test`
Expected: FAIL (`upload` / `remove` don't exist on the store yet).

- [ ] **Step 3: Implement the store actions**

Replace the entire `web/src/stores/files.ts`:
```typescript
import { defineStore } from "pinia";
import { ref } from "vue";

import { filesApi } from "@/api/files";
import type { FileMeta } from "@/api/types";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";

export const useFilesStore = defineStore("files", () => {
  const files = ref<FileMeta[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const uploading = ref(false);
  const uploadProgress = ref(0);
  const downloading = ref(false);
  const displayNames = ref<Record<string, string>>({});

  function masterKey(): Uint8Array {
    const key = useAuthStore().masterKey;
    if (!key) throw new Error("not unlocked — master key missing");
    return key;
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const res = await filesApi.list();
      files.value = res.files;
      void decryptNames();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** Best-effort: decrypt each ready file's manifest to show its real name. */
  async function decryptNames(): Promise<void> {
    const key = masterKey();
    for (const f of files.value) {
      if (
        f.status === "ready" &&
        f.encrypted_manifest &&
        f.encrypted_manifest_nonce &&
        f.encrypted_file_key &&
        f.encrypted_file_key_nonce &&
        !displayNames.value[f.id]
      ) {
        try {
          const m = await cryptoApi.decryptManifest(
            key,
            f.encrypted_file_key,
            f.encrypted_file_key_nonce,
            f.encrypted_manifest,
            f.encrypted_manifest_nonce,
          );
          displayNames.value[f.id] = m.name;
        } catch {
          /* leave id as the display fallback */
        }
      }
    }
  }

  async function upload(file: File): Promise<void> {
    uploading.value = true;
    uploadProgress.value = 0;
    error.value = null;
    try {
      await ensureCryptoReady();
      const key = masterKey();
      const plaintext = new Uint8Array(await file.arrayBuffer());
      const payload = await cryptoApi.encryptFile(
        key,
        plaintext,
        file.name,
        file.type,
      );
      const { id } = await filesApi.create({
        total_size: plaintext.length,
        chunk_count: 1,
        encrypted_file_key: payload.encrypted_file_key,
        encrypted_file_key_nonce: payload.encrypted_file_key_nonce,
      });
      await filesApi.putManifest(id, {
        encrypted_manifest: payload.encrypted_manifest,
        encrypted_manifest_nonce: payload.encrypted_manifest_nonce,
      });
      await filesApi.putChunk(id, 0, payload.ciphertext, (r) => {
        uploadProgress.value = r;
      });
      await filesApi.finalize(id);
      await refresh();
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      uploading.value = false;
    }
  }

  async function download(meta: FileMeta): Promise<void> {
    downloading.value = true;
    try {
      await ensureCryptoReady();
      const key = masterKey();
      const resp = await filesApi.getChunk(meta.id, 0);
      const ciphertext = new Uint8Array(await resp.arrayBuffer());
      const { plaintext, manifest } = await cryptoApi.decryptFile(
        key,
        meta.encrypted_file_key!,
        meta.encrypted_file_key_nonce!,
        meta.encrypted_manifest!,
        meta.encrypted_manifest_nonce!,
        ciphertext,
      );
      const blob = new Blob([plaintext as BlobPart], { type: manifest.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = manifest.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      downloading.value = false;
    }
  }

  async function remove(id: string): Promise<void> {
    await filesApi.remove(id);
    await refresh();
  }

  return {
    files,
    loading,
    error,
    uploading,
    uploadProgress,
    downloading,
    displayNames,
    refresh,
    upload,
    download,
    remove,
  };
});
```

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix web -- files.test`
Expected: PASS (3 new tests; existing auth/client tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(web): files store upload/download/remove with progress"
```

---

### Task 9: `DriveView.vue` UI + `docs/api.md`

**Files:**
- Modify: `web/src/views/DriveView.vue`
- Modify: `docs/api.md:84-117` (create body + put_chunk raw body)

**Interfaces:**
- Consumes: `useFilesStore` (upload/download/remove/progress), `useAuthStore`.

- [ ] **Step 1: Rewrite `DriveView.vue`**

Replace the entire file `web/src/views/DriveView.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import type { FileMeta } from "@/api/types";

const auth = useAuthStore();
const files = useFilesStore();
const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

onMounted(() => {
  void files.refresh();
});

function signOut() {
  void auth.logout().then(() => router.push({ name: "login" }));
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement;
  const f = target.files?.[0];
  if (!f) return;
  try {
    await files.upload(f);
  } catch {
    /* error surfaced in store */
  } finally {
    target.value = "";
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const f = e.dataTransfer?.files[0];
  if (f) void files.upload(f).catch(() => {});
}

function onDragOver() {
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function nameOf(f: FileMeta): string {
  return files.displayNames[f.id] ?? f.id;
}

function download(f: FileMeta) {
  void files.download(f).catch(() => {});
}

function remove(f: FileMeta) {
  if (confirm(`Delete "${nameOf(f)}"?`)) void files.remove(f.id);
}
</script>

<template>
  <main class="page">
    <header class="bar">
      <div class="brand"><span class="logo">DragonFox Drive</span></div>
      <nav>
        <RouterLink :to="{ name: 'drive' }">My files</RouterLink>
        <RouterLink :to="{ name: 'settings' }">Settings</RouterLink>
        <button class="link" @click="signOut">Sign out</button>
      </nav>
    </header>

    <section class="content">
      <h1>Your encrypted files</h1>

      <div
        class="dropzone"
        :class="{ over: dragOver }"
        @click="pickFile"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <p v-if="!files.uploading">Drop a file here or click to choose</p>
        <p v-else>Encrypting &amp; uploading… {{ Math.round(files.uploadProgress * 100) }}%</p>
        <progress v-if="files.uploading" :value="files.uploadProgress" max="1" />
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          @change="onFileChosen"
        />
      </div>

      <p v-if="files.error" class="error">{{ files.error }}</p>

      <p class="muted" v-if="!files.files.length && !files.loading">
        No files yet.
      </p>

      <ul class="list" v-if="files.files.length">
        <li v-for="f in files.files" :key="f.id">
          <span class="name">{{ nameOf(f) }}</span>
          <span class="meta">{{ fmtSize(f.total_size) }} · {{ f.status }}</span>
          <span class="actions">
            <button class="link" :disabled="f.status !== 'ready'" @click="download(f)">Download</button>
            <button class="link" @click="remove(f)">Delete</button>
          </span>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.page { display: flex; flex-direction: column; min-height: 100vh; }
.bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.8rem 1.5rem; border-bottom: 1px solid var(--df-color-border);
  background: var(--df-color-bg-elevated);
}
.brand .logo { font-weight: 700; letter-spacing: 0.02em; }
nav { display: flex; gap: 1rem; align-items: center; }
nav a { color: var(--df-color-fg-muted); }
nav a.router-link-active { color: var(--df-color-fg); }
.link { background: transparent; color: var(--df-color-fg-muted); border: 0; cursor: pointer; padding: 0; }
.link:disabled { opacity: 0.4; cursor: default; }
.content { padding: 2rem 1.5rem; max-width: 1100px; width: 100%; margin: 0 auto; }
h1 { margin: 0 0 1rem; font-size: 1.4rem; }
.muted { color: var(--df-color-fg-muted); }
.error { color: #c0392b; }
.dropzone {
  border: 2px dashed var(--df-color-border); border-radius: var(--df-radius-sm);
  padding: 2rem; text-align: center; cursor: pointer; color: var(--df-color-fg-muted);
  margin-bottom: 1.5rem;
}
.dropzone.over { border-color: var(--df-color-fg); }
.hidden { display: none; }
progress { width: 60%; }
.list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.list li {
  background: var(--df-color-bg-elevated); border: 1px solid var(--df-color-border);
  border-radius: var(--df-radius-sm); padding: 0.7rem 0.9rem;
  display: flex; flex-direction: column; gap: 0.15rem;
}
.name { font-weight: 600; }
.meta { color: var(--df-color-fg-muted); font-size: 0.8rem; }
.actions { display: flex; gap: 1rem; margin-top: 0.3rem; }
</style>
```

- [ ] **Step 2: Update `docs/api.md`**

Replace the `### POST /api/files` request block and the `### PUT /api/files/:id/chunks/:idx` section:
````markdown
### `POST /api/files`

```json
{
  "total_size": 12345678,
  "chunk_count": 1,
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>"
}
```

Response:
```json
{ "id": "uuid", "upload_url": "/api/files/uuid/chunks/{idx}" }
```

`total_size` must be `<= limits.max_upload_bytes` (default 100 MiB) or the
server responds `413`.
````

And:
````markdown
### `PUT /api/files/:id/chunks/:idx`

`Content-Type: application/octet-stream`. The request body is the raw
encrypted chunk bytes (single whole-file chunk in P1). Server stores it as an
opaque blob at `<data_dir>/blobs/<shard1>/<shard2>/<file_id>/chunk_<idx>`.
Responds `413` if the body exceeds `limits.max_upload_bytes`.
````

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck --prefix web`
Expected: PASS.

Run: `npm run build --prefix web`
Expected: PASS (the `fixLibsodiumImport` plugin is preserved).

- [ ] **Step 4: Commit**

```bash
git add web/src/views/DriveView.vue docs/api.md
git commit -m "feat(web): DriveView upload/download/delete UI + api docs"
```

---

### Task 10: Full verification + smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the entire backend test suite**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: all tests PASS (prior 50 + new file-handler tests).

- [ ] **Step 2: Run the entire frontend test suite**

Run: `npm test --prefix web`
Expected: all tests PASS (prior 74 + file-crypto + files-store tests).

- [ ] **Step 3: Typecheck + production build**

Run: `npm run typecheck --prefix web && npm run build --prefix web`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Start backend: `cargo run --manifest-path server/Cargo.toml`
Start frontend: `npm run dev --prefix web`
In a browser at `http://localhost:5173`:
1. Register a user.
2. Drag a small file (e.g. an image) onto the dropzone → progress reaches 100% → file appears in the list with its real name.
3. Reload the page → session restored → file still listed.
4. Click Download → verify the downloaded file is byte-identical to the original.
5. Click Delete → confirm → file disappears.

Expected: all steps succeed; downloaded file matches original.

- [ ] **Step 5: No commit (verification task)**

If everything passes, the feature branch is ready for review.
