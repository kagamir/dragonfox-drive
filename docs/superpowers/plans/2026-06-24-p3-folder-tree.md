# P3 Encrypted Folder Tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nested, zero-knowledge folder hierarchy where the server sees only opaque encrypted rows — neither folder names nor the tree structure — and the client builds the tree in the browser.

**Architecture:** A new `folders` table stores encrypted parent pointers (AES-GCM with `master_key`), a per-folder `folder_key` wrapped by the parent's `folder_key` (root items wrapped by `master_key` — the MEGA model), and an encrypted name. The client downloads every folder row, decrypts parent pointers with `master_key` to recover tree shape, then walks the key-wrap chain to decrypt names. Files gain an encrypted parent pointer; a file inside a folder has its `file_key` wrapped by that folder's `folder_key`.

**Tech Stack:** Rust (axum 0.7 + sqlx 0.8 + SQLite), Vue 3 + TypeScript (Vite, Pinia, Comlink Web Workers), AES-256-GCM via WebCrypto, Vitest + `#[tokio::test]`.

## Global Constraints

- All encryption is AES-256-GCM via WebCrypto (client-side); the server stores only opaque base64 blobs.
- `encrypted_parent_id` is always encrypted with `master_key` (never `folder_key`) — mandatory to break the bootstrapping cycle (spec §1.4).
- Folder/file `key` wrapping is hierarchical: wrapped by the parent folder's `folder_key`, or by `master_key` for root items.
- Owner-scoping: every endpoint returns `404` (never `403`) for non-owned ids, matching `files.rs`.
- Cascade + standalone delete are **hard** (`DELETE FROM`, not `status='deleted'`).
- The server cannot see structure, so it returns ALL folders; the client filters and paginates.
- Follow existing patterns: Rust handlers use `(State<AppState>, AuthUser, ...)`, inline `#[tokio::test]` modules; TS crypto is pure functions in `crypto/`, exposed via the Comlink worker; stores tested with `vi.mock` + `setActivePinia`.
- Chunk size 4 MiB, AES-GCM IV 96 bits, tag 128 bits (unchanged constants).
- Migration filenames are zero-padded: `20260101000003_folders.sql`.
- Verify after each task: `cargo check --manifest-path server/Cargo.toml` and `cargo test --manifest-path server/Cargo.toml`; `npm run typecheck --prefix web` and `npm run test --prefix web`.

---

## File Structure

**Server (Rust):**
- `server/migrations/20260101000003_folders.sql` — NEW. `folders` table + 2 `files` columns.
- `server/src/models.rs` — MODIFY. Add `FolderRow`; add 2 fields to `FileRow`.
- `server/src/api/folders.rs` — NEW. list/create/patch/delete handlers + tests.
- `server/src/api/mod.rs` — MODIFY. Register folder routes + PATCH /api/files/:id.
- `server/src/api/files.rs` — MODIFY. Hard delete, PATCH-move, new columns in `FileMeta`/list/create, update tests.
- `server/src/db/mod.rs` — MODIFY. Extend migrate test.

**Frontend (TS/Vue):**
- `web/src/crypto/folder.ts` — NEW. Pure crypto helpers.
- `web/src/crypto/folder.test.ts` — NEW.
- `web/src/workers/crypto.worker.ts` — MODIFY. Expose folder crypto via Comlink.
- `web/src/workers/crypto.worker.test.ts` — MODIFY.
- `web/src/api/types.ts` — MODIFY. Folder + move types; `FileMeta` parent fields.
- `web/src/api/client.ts` — MODIFY. Add `http.patch`.
- `web/src/api/folders.ts` — NEW. `foldersApi`.
- `web/src/api/files.ts` — MODIFY. Add `filesApi.move`.
- `web/src/stores/folders.ts` — NEW. Tree build, navigation, pagination, CRUD.
- `web/src/stores/folders.test.ts` — NEW.
- `web/src/stores/files.ts` — MODIFY. Folder-aware upload, `filesWithParent`, `moveFile`.
- `web/src/stores/files.test.ts` — MODIFY.
- `web/src/views/DriveView.vue` — MODIFY. Breadcrumbs, mixed list, CRUD actions.
- `web/src/views/DriveView.test.ts` — MODIFY.
- `web/src/components/MovePickerModal.vue` — NEW.

**Docs:** `docs/api.md`, `docs/crypto-design.md`, `README.md` — MODIFY.

---

## Task 1: Migration + migrate test

**Files:**
- Create: `server/migrations/20260101000003_folders.sql`
- Modify: `server/src/db/mod.rs`

**Interfaces:**
- Produces: `folders` table and `files.encrypted_parent_id` / `files.encrypted_parent_id_nonce` columns for all later tasks.

- [ ] **Step 1: Write the failing test**

In `server/src/db/mod.rs`, inside the existing `migrate_creates_all_expected_tables` test, add `"folders"` to the expected-tables list and append a `files` column check. Replace the `for expected in [...]` array with:

```rust
        for expected in [
            "devices",
            "file_chunks",
            "files",
            "folders",
            "refresh_tokens",
            "shares",
            "users",
        ] {
            assert!(
                names.contains(&expected.to_string()),
                "missing table {expected}; got {names:?}"
            );
        }
```

Then append at the end of that test (after the users username assertions):

```rust
        // P3: files gained two encrypted-parent columns for the folder tree.
        let file_cols: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM pragma_table_info('files') ORDER BY cid")
                .fetch_all(&pool)
                .await
                .unwrap();
        let file_col_names: Vec<String> = file_cols.into_iter().map(|r| r.0).collect();
        assert!(
            file_col_names.contains(&"encrypted_parent_id".to_string()),
            "files must have encrypted_parent_id; got {file_col_names:?}"
        );
        assert!(
            file_col_names.contains(&"encrypted_parent_id_nonce".to_string()),
            "files must have encrypted_parent_id_nonce; got {file_col_names:?}"
        );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path server/Cargo.toml migrate_creates_all_expected`
Expected: FAIL — `missing table folders`.

- [ ] **Step 3: Create the migration**

Create `server/migrations/20260101000003_folders.sql`:

```sql
-- P3: encrypted folder tree. The server stores only opaque rows: it cannot read
-- folder names (encrypted with the folder's own folder_key) and it cannot see
-- the tree structure (parent_id is encrypted with the user's master_key).
CREATE TABLE folders (
    id                          TEXT PRIMARY KEY,
    owner_id                    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Parent folder id, AES-GCM-encrypted with the user's master_key. NULL ≡ root.
    encrypted_parent_id         TEXT,
    encrypted_parent_id_nonce   TEXT,
    -- This folder's folder_key, wrapped by the PARENT's folder_key
    -- (or by master_key when encrypted_parent_id is NULL).
    encrypted_folder_key        TEXT NOT NULL,
    encrypted_folder_key_nonce  TEXT NOT NULL,
    -- Folder name, encrypted with this folder's OWN folder_key.
    encrypted_name              TEXT NOT NULL,
    encrypted_name_nonce        TEXT NOT NULL,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_folders_owner ON folders(owner_id);

-- Files gain an encrypted parent pointer; NULL ≡ root (zero data migration).
ALTER TABLE files ADD COLUMN encrypted_parent_id       TEXT;
ALTER TABLE files ADD COLUMN encrypted_parent_id_nonce TEXT;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path server/Cargo.toml migrate_creates_all_expected`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/20260101000003_folders.sql server/src/db/mod.rs
git commit -m "feat(db): folders table + files encrypted_parent_id columns"
```

---

## Task 2: Server folders API (list / create / patch / cascade delete)

**Files:**
- Modify: `server/src/models.rs` (add `FolderRow`)
- Create: `server/src/api/folders.rs`
- Modify: `server/src/api/mod.rs` (register routes)

**Interfaces:**
- Produces: `FolderRow`; handlers `folders::list`, `folders::create`, `folders::patch`, `folders::delete` registered at `GET/POST /api/folders` and `PATCH/DELETE /api/folders/:id`.

- [ ] **Step 1: Add `FolderRow` to models**

Append to `server/src/models.rs`:

```rust
#[derive(Debug, sqlx::FromRow)]
pub struct FolderRow {
    pub id: String,
    pub owner_id: String,
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
    pub encrypted_folder_key: String,
    pub encrypted_folder_key_nonce: String,
    pub encrypted_name: String,
    pub encrypted_name_nonce: String,
    pub created_at: String,
    pub updated_at: String,
}
```

- [ ] **Step 2: Write the failing handler tests (handlers stubbed)**

Create `server/src/api/folders.rs` with tests first; handlers come in Step 4. Start the file with just enough to compile the tests (they reference `list/create/patch/delete`):

```rust
//! Encrypted folder endpoints.
//!
//! Folders are zero-knowledge: the server stores only opaque encrypted blobs.
//! The client builds the tree locally — the server never sees names or structure.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::models::FolderRow;
use crate::state::AppState;
use crate::storage;

#[derive(Debug, Serialize)]
pub struct FolderMeta {
    pub id: String,
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
    pub encrypted_folder_key: String,
    pub encrypted_folder_key_nonce: String,
    pub encrypted_name: String,
    pub encrypted_name_nonce: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<FolderRow> for FolderMeta {
    fn from(r: FolderRow) -> Self {
        FolderMeta {
            id: r.id,
            encrypted_parent_id: r.encrypted_parent_id,
            encrypted_parent_id_nonce: r.encrypted_parent_id_nonce,
            encrypted_folder_key: r.encrypted_folder_key,
            encrypted_folder_key_nonce: r.encrypted_folder_key_nonce,
            encrypted_name: r.encrypted_name,
            encrypted_name_nonce: r.encrypted_name_nonce,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Value>> {
    let rows: Vec<FolderRow> = sqlx::query_as(
        "SELECT id, owner_id, encrypted_parent_id, encrypted_parent_id_nonce, \
         encrypted_folder_key, encrypted_folder_key_nonce, \
         encrypted_name, encrypted_name_nonce, created_at, updated_at \
         FROM folders WHERE owner_id = ? ORDER BY created_at ASC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await?;
    let folders: Vec<FolderMeta> = rows.into_iter().map(FolderMeta::from).collect();
    Ok(Json(json!({ "folders": folders })))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<Value>,
) -> ApiResult<Json<Value>> {
    let obj = req
        .as_object()
        .ok_or_else(|| ApiError::BadRequest("expected object".into()))?;
    let get_str = |k: &str| -> ApiResult<String> {
        obj.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| ApiError::BadRequest(format!("{k} must be a string")))
    };
    let encrypted_folder_key = get_str("encrypted_folder_key")?;
    let encrypted_folder_key_nonce = get_str("encrypted_folder_key_nonce")?;
    let encrypted_name = get_str("encrypted_name")?;
    let encrypted_name_nonce = get_str("encrypted_name_nonce")?;
    let (encrypted_parent_id, encrypted_parent_id_nonce) = match obj.get("encrypted_parent_id") {
        None | Some(Value::Null) => (None, None),
        Some(_) => (Some(get_str("encrypted_parent_id")?), Some(get_str("encrypted_parent_id_nonce")?)),
    };

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO folders (id, owner_id, encrypted_parent_id, encrypted_parent_id_nonce, \
         encrypted_folder_key, encrypted_folder_key_nonce, \
         encrypted_name, encrypted_name_nonce) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user.user_id)
    .bind(&encrypted_parent_id)
    .bind(&encrypted_parent_id_nonce)
    .bind(&encrypted_folder_key)
    .bind(&encrypted_folder_key_nonce)
    .bind(&encrypted_name)
    .bind(&encrypted_name_nonce)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "id": id })))
}

pub async fn patch(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<Value>,
) -> ApiResult<Json<Value>> {
    let obj = req
        .as_object()
        .ok_or_else(|| ApiError::BadRequest("expected object".into()))?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut updates: Vec<(&str, Option<String>)> = Vec::new();
    updates.push(("updated_at", Some(now)));

    for (json_key, col) in [
        ("encrypted_name", "encrypted_name"),
        ("encrypted_name_nonce", "encrypted_name_nonce"),
        ("encrypted_parent_id", "encrypted_parent_id"),
        ("encrypted_parent_id_nonce", "encrypted_parent_id_nonce"),
        ("encrypted_folder_key", "encrypted_folder_key"),
        ("encrypted_folder_key_nonce", "encrypted_folder_key_nonce"),
    ] {
        if let Some(v) = obj.get(json_key) {
            let val = match v {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                _ => return Err(ApiError::BadRequest(format!("{json_key} must be string or null"))),
            };
            updates.push((col, val));
        }
    }
    if updates.len() == 1 {
        return Err(ApiError::BadRequest("no fields to update".into()));
    }

    let set_clause: Vec<String> = updates
        .iter()
        .map(|(col, val)| {
            if val.is_some() {
                format!("{col} = ?")
            } else {
                format!("{col} = NULL")
            }
        })
        .collect();
    let sql = format!("UPDATE folders SET {} WHERE id = ? AND owner_id = ?", set_clause.join(", "));
    let mut q = sqlx::query(&sql);
    for (_, val) in &updates {
        if let Some(v) = val {
            q = q.bind(v);
        }
    }
    let res = q.bind(&id).bind(&user.user_id).execute(&state.db).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<Value>,
) -> ApiResult<Json<Value>> {
    let folder_ids: Vec<String> = req
        .get("folder_ids")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError::BadRequest("folder_ids must be an array".into()))?
        .iter()
        .map(|v| v.as_str().map(|s| s.to_string()).ok_or_else(|| ApiError::BadRequest("folder_ids must be strings".into())))
        .collect::<Result<_, _>>()?;
    let file_ids: Vec<String> = req
        .get("file_ids")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError::BadRequest("file_ids must be an array".into()))?
        .iter()
        .map(|v| v.as_str().map(|s| s.to_string()).ok_or_else(|| ApiError::BadRequest("file_ids must be strings".into())))
        .collect::<Result<_, _>>()?;

    if !folder_ids.contains(&id) {
        return Err(ApiError::BadRequest("target id must be included in folder_ids".into()));
    }

    let mut tx = state.db.begin().await?;
    {
        let mut qb = sqlx::QueryBuilder::new("DELETE FROM folders WHERE owner_id = ");
        qb.push_bind(&user.user_id).push(" AND id IN (");
        let mut sep = qb.separated(", ");
        for fid in &folder_ids {
            sep.push_bind(fid);
        }
        sep.push_unseparated(")");
        let res = qb.build().execute(&mut *tx).await?;
        if res.rows_affected() != folder_ids.len() as u64 {
            tx.rollback().await?;
            return Err(ApiError::NotFound);
        }
    }
    if !file_ids.is_empty() {
        let mut qb = sqlx::QueryBuilder::new("DELETE FROM files WHERE owner_id = ");
        qb.push_bind(&user.user_id).push(" AND id IN (");
        let mut sep = qb.separated(", ");
        for fid in &file_ids {
            sep.push_bind(fid);
        }
        sep.push_unseparated(")");
        let res = qb.build().execute(&mut *tx).await?;
        if res.rows_affected() != file_ids.len() as u64 {
            tx.rollback().await?;
            return Err(ApiError::NotFound);
        }
    }
    tx.commit().await?;

    for fid in &file_ids {
        storage::delete_file_chunks(&state, fid).await?;
    }
    Ok(Json(json!({ "ok": true, "deleted_folders": folder_ids.len(), "deleted_files": file_ids.len() })))
}
```

Now append the tests module to the same file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Arc;

    async fn folders_state() -> (AppState, tempfile::TempDir) {
        let mut settings = Settings::default();
        settings.jwt.secret = "test".into();
        let dir = tempfile::tempdir().unwrap();
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

    fn create_body(parent: Option<&str>) -> Value {
        let mut v = json!({
            "encrypted_folder_key": "fk", "encrypted_folder_key_nonce": "fkn",
            "encrypted_name": "n", "encrypted_name_nonce": "nn",
        });
        if let Some(p) = parent {
            v["encrypted_parent_id"] = json!(p);
            v["encrypted_parent_id_nonce"] = json!("pn");
        }
        v
    }

    #[tokio::test]
    async fn create_inserts_row_and_returns_id() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_body(None))).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());
        let row: (String,) = sqlx::query_as("SELECT encrypted_name FROM folders WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0, "n");
    }

    #[tokio::test]
    async fn list_returns_only_caller_folders() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        sqlx::query("INSERT INTO folders (id, owner_id, encrypted_folder_key, encrypted_folder_key_nonce, encrypted_name, encrypted_name_nonce) VALUES ('f1','u1','k','kn','n','nn')").execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO folders (id, owner_id, encrypted_folder_key, encrypted_folder_key_nonce, encrypted_name, encrypted_name_nonce) VALUES ('f2','u2','k','kn','n','nn')").execute(&state.db).await.unwrap();
        let res = list(State(state.clone()), auth("u1")).await.unwrap();
        let ids: Vec<String> = res.0["folders"].as_array().unwrap().iter()
            .map(|f| f["id"].as_str().unwrap().to_string()).collect();
        assert!(ids.contains(&"f1".to_string()));
        assert!(!ids.contains(&"f2".to_string()));
    }

    #[tokio::test]
    async fn patch_rename_updates_only_name() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_body(None))).await.unwrap();
        let id = res.0["id"].as_str().unwrap();
        patch(State(state.clone()), auth("u1"), Path(id.to_string()),
            Json(json!({ "encrypted_name": "n2", "encrypted_name_nonce": "nn2" }))).await.unwrap();
        let row: (String, Option<String>) = sqlx::query_as(
            "SELECT encrypted_name, encrypted_parent_id FROM folders WHERE id = ?")
            .bind(id).fetch_one(&state.db).await.unwrap();
        assert_eq!(row.0, "n2");
        assert!(row.1.is_none(), "parent must be untouched by a rename");
    }

    #[tokio::test]
    async fn patch_move_sets_parent_null_for_root() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        sqlx::query("INSERT INTO folders (id, owner_id, encrypted_parent_id, encrypted_parent_id_nonce, encrypted_folder_key, encrypted_folder_key_nonce, encrypted_name, encrypted_name_nonce) VALUES ('c','u1','p','pn','k','kn','n','nn')").execute(&state.db).await.unwrap();
        patch(State(state.clone()), auth("u1"), Path("c".into()),
            Json(json!({ "encrypted_parent_id": null, "encrypted_parent_id_nonce": null, "encrypted_folder_key": "k2", "encrypted_folder_key_nonce": "kn2" }))).await.unwrap();
        let row: (Option<String>, String) = sqlx::query_as(
            "SELECT encrypted_parent_id, encrypted_folder_key FROM folders WHERE id = 'c'")
            .fetch_one(&state.db).await.unwrap();
        assert!(row.0.is_none(), "move-to-root must NULL the parent");
        assert_eq!(row.1, "k2");
    }

    #[tokio::test]
    async fn patch_returns_404_for_non_owner() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        sqlx::query("INSERT INTO folders (id, owner_id, encrypted_folder_key, encrypted_folder_key_nonce, encrypted_name, encrypted_name_nonce) VALUES ('f1','u1','k','kn','n','nn')").execute(&state.db).await.unwrap();
        let err = patch(State(state.clone()), auth("u2"), Path("f1".into()),
            Json(json!({ "encrypted_name": "x", "encrypted_name_nonce": "y" }))).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn delete_cascade_removes_listed_folders_and_files() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        sqlx::query("INSERT INTO folders (id, owner_id, encrypted_folder_key, encrypted_folder_key_nonce, encrypted_name, encrypted_name_nonce) VALUES ('fo','u1','k','kn','n','nn'),('ch','u1','k','kn','n','nn')").execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO files (id, owner_id, status, total_size, chunk_count, encrypted_file_key, encrypted_file_key_nonce) VALUES ('fi','u1','ready',1,1,'k','kn')").execute(&state.db).await.unwrap();
        let res = delete(State(state.clone()), auth("u1"), Path("fo".into()),
            Json(json!({ "folder_ids": ["fo","ch"], "file_ids": ["fi"] }))).await.unwrap();
        assert_eq!(res.0["deleted_folders"], 2);
        assert_eq!(res.0["deleted_files"], 1);
        let (fc,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM folders WHERE owner_id='u1'").fetch_one(&state.db).await.unwrap();
        assert_eq!(fc, 0);
        let (fic,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM files WHERE owner_id='u1'").fetch_one(&state.db).await.unwrap();
        assert_eq!(fic, 0, "hard delete removes the row");
    }

    #[tokio::test]
    async fn delete_returns_404_when_any_id_not_owned() {
        let (state, _g) = folders_state().await;
        seed_user(&state, "u1").await;
        sqlx::query("INSERT INTO folders (id, owner_id, encrypted_folder_key, encrypted_folder_key_nonce, encrypted_name, encrypted_name_nonce) VALUES ('fo','u1','k','kn','n','nn')").execute(&state.db).await.unwrap();
        let err = delete(State(state.clone()), auth("u1"), Path("fo".into()),
            Json(json!({ "folder_ids": ["fo","not-mine"], "file_ids": [] }))).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
        let (fc,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM folders WHERE id='fo'").fetch_one(&state.db).await.unwrap();
        assert_eq!(fc, 1, "transaction must roll back");
    }
}
```

- [ ] **Step 3: Register the routes**

In `server/src/api/mod.rs`, add the folder routes inside `routes()`, right after the `.route("/api/files/:id", delete(files::delete))` line:

```rust
        .route(
            "/api/folders",
            get(folders::list).post(folders::create),
        )
        .route(
            "/api/folders/:id",
            axum::routing::patch(folders::patch).delete(folders::delete),
        )
```

- [ ] **Step 4: Run the handler tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml folders::`
Expected: all 7 `folders::tests::*` PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/models.rs server/src/api/folders.rs server/src/api/mod.rs
git commit -m "feat(api): folders CRUD endpoints (list/create/patch/cascade-delete)"
```

---

## Task 3: Server files changes (hard delete, PATCH-move, new columns)

**Files:**
- Modify: `server/src/models.rs` (add 2 fields to `FileRow`)
- Modify: `server/src/api/files.rs`
- Modify: `server/src/api/mod.rs` (bind PATCH on `/api/files/:id`)

**Interfaces:**
- Produces: `files::patch_move` registered at `PATCH /api/files/:id`; `FileMeta` carries `encrypted_parent_id` + nonce; `delete` is hard.

- [ ] **Step 1: Add fields to `FileRow`**

In `server/src/models.rs`, insert into `FileRow` (after `encrypted_file_key_nonce`):

```rust
    pub encrypted_file_key: Option<String>,
    pub encrypted_file_key_nonce: Option<String>,
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
    pub created_at: String,
    pub updated_at: String,
```

- [ ] **Step 2: Update `FileMeta`, `From<FileRow>`, `list`, `CreateFileRequest`, `create`**

In `server/src/api/files.rs`:

Add the two parent fields to `FileMeta` (after `encrypted_file_key_nonce`):

```rust
    pub encrypted_file_key: Option<String>,
    pub encrypted_file_key_nonce: Option<String>,
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
    pub created_at: String,
    pub updated_at: String,
```

Add the same two fields to the `From<FileRow> for FileMeta` impl:

```rust
            encrypted_file_key: r.encrypted_file_key,
            encrypted_file_key_nonce: r.encrypted_file_key_nonce,
            encrypted_parent_id: r.encrypted_parent_id,
            encrypted_parent_id_nonce: r.encrypted_parent_id_nonce,
            created_at: r.created_at,
            updated_at: r.updated_at,
```

Update the `list` SELECT (add the two columns before `created_at`):

```rust
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
```

Extend `CreateFileRequest` with optional parent fields:

```rust
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
```

Update the `create` INSERT to write the parent columns:

```rust
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
```

- [ ] **Step 3: Write the failing tests (hard delete + patch-move)**

In the `server/src/api/files.rs` tests module, REPLACE `delete_soft_deletes_and_removes_chunks` with:

```rust
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
```

ADD patch-move tests after the delete tests:

```rust
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
```

Update the three `CreateFileRequest { ... }` literals in the test module (`create_inserts_pending_row_and_returns_id`, `create_rejects_zero_chunk_count`, `create_rejects_oversized_total`) to include the two new fields, e.g.:

```rust
        let req = CreateFileRequest {
            total_size: 123, chunk_count: 1,
            encrypted_file_key: "k".into(), encrypted_file_key_nonce: "kn".into(),
            encrypted_parent_id: None, encrypted_parent_id_nonce: None,
        };
```

- [ ] **Step 4: Run tests to verify they fail (patch_move undefined)**

Run: `cargo test --manifest-path server/Cargo.toml --no-run`
Expected: compile error — cannot find function `patch_move`.

- [ ] **Step 5: Convert `delete` to hard delete + add `patch_move`**

Replace the `delete` handler body in `server/src/api/files.rs`:

```rust
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
```

Add `patch_move` below `delete`:

```rust
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
```

- [ ] **Step 6: Bind PATCH on `/api/files/:id`**

In `server/src/api/mod.rs`, replace the line:

```rust
        .route("/api/files/:id", delete(files::delete))
```

with:

```rust
        .route(
            "/api/files/:id",
            axum::routing::patch(files::patch_move).delete(files::delete),
        )
```

- [ ] **Step 7: Run all server tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: PASS (all `files::tests`, `folders::tests`, migrate test).

- [ ] **Step 8: Commit**

```bash
git add server/src/models.rs server/src/api/files.rs server/src/api/mod.rs
git commit -m "feat(api): files PATCH-move + hard delete + encrypted_parent_id columns"
```

---

## Task 4: Frontend folder crypto layer

**Files:**
- Create: `web/src/crypto/folder.ts`
- Create: `web/src/crypto/folder.test.ts`
- Modify: `web/src/workers/crypto.worker.ts`
- Modify: `web/src/workers/crypto.worker.test.ts`

**Interfaces:**
- Produces: `newFolderKey`, `encryptFolderName`/`decryptFolderName`, `encryptParentId`/`decryptParentId`, `wrapFolderKey`/`unwrapFolderKey` (raw `Uint8Array`); same names on the Comlink `cryptoApi`.

- [ ] **Step 1: Write the failing pure-function tests**

Create `web/src/crypto/folder.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";

import {
  newFolderKey,
  encryptFolderName,
  decryptFolderName,
  encryptParentId,
  decryptParentId,
  wrapFolderKey,
  unwrapFolderKey,
} from "./folder";
import { generateMasterKey } from "./keys";
import { initCrypto } from "./index";

describe("folder crypto", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("newFolderKey returns a 32-byte key", () => {
    expect(newFolderKey().length).toBe(32);
  });

  it("folder name encrypt/decrypt round-trips", async () => {
    const fk = newFolderKey();
    const enc = await encryptFolderName(fk, "Taxes 2026");
    expect(await decryptFolderName(fk, enc.ciphertext, enc.iv)).toBe("Taxes 2026");
  });

  it("folder name decrypt throws with the wrong key", async () => {
    const fk = newFolderKey();
    const enc = await encryptFolderName(fk, "secret");
    await expect(decryptFolderName(newFolderKey(), enc.ciphertext, enc.iv)).rejects.toThrow();
  });

  it("encryptParentId returns null for a root (null) parent", async () => {
    const mk = generateMasterKey();
    expect(await encryptParentId(mk, null)).toBeNull();
  });

  it("parent id encrypt/decrypt round-trips for a non-root parent", async () => {
    const mk = generateMasterKey();
    const enc = await encryptParentId(mk, "parent-uuid-123");
    expect(enc).not.toBeNull();
    expect(await decryptParentId(mk, enc!.ciphertext, enc!.iv)).toBe("parent-uuid-123");
  });

  it("decryptParentId returns null for null inputs (root)", async () => {
    const mk = generateMasterKey();
    expect(await decryptParentId(mk, null, null)).toBeNull();
  });

  it("folder_key wraps by master_key at the root", async () => {
    const mk = generateMasterKey();
    const fk = newFolderKey();
    const wrapped = await wrapFolderKey(fk, mk);
    expect(Array.from(await unwrapFolderKey(wrapped, mk))).toEqual(Array.from(fk));
  });

  it("folder_key wraps in a chain (child folder_key by root folder_key)", async () => {
    const mk = generateMasterKey();
    const rootFk = newFolderKey();
    const childFk = newFolderKey();
    const rootWrapped = await wrapFolderKey(rootFk, mk);
    const rootRecovered = await unwrapFolderKey(rootWrapped, mk);
    const childWrapped = await wrapFolderKey(childFk, rootRecovered);
    expect(Array.from(await unwrapFolderKey(childWrapped, rootFk))).toEqual(Array.from(childFk));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --prefix web -- folder.test`
Expected: FAIL — cannot resolve `./folder`.

- [ ] **Step 3: Implement the pure crypto module**

Create `web/src/crypto/folder.ts`:

```ts
/**
 * Folder crypto: the folder_key hierarchy + encrypted metadata helpers.
 *
 * Model (see docs/crypto-design.md P3 §):
 *   - Each folder has a random 32-byte folder_key.
 *   - folder_key is wrapped (AES-GCM) by the PARENT's folder_key, or by
 *     master_key for root folders.
 *   - A folder's NAME is encrypted with its OWN folder_key.
 *   - The PARENT POINTER is ALWAYS encrypted with master_key — never
 *     folder_key — so the client can recover tree shape before walking the
 *     key-wrap chain (breaks the bootstrapping cycle).
 *
 * Operates on raw Uint8Array; base64 (de)serialization is the store's job.
 */

import { encrypt, decrypt } from "./symmetric";
import { randomBytes, type RawKey } from "./kdf";
import type { WrappedKey } from "./keys";

export interface EncryptedFieldRaw {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

export function newFolderKey(): RawKey {
  return randomBytes(32);
}

export async function encryptFolderName(
  folderKey: RawKey,
  name: string,
): Promise<EncryptedFieldRaw> {
  const enc = await encrypt(folderKey, new TextEncoder().encode(name));
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function decryptFolderName(
  folderKey: RawKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const plain = await decrypt(folderKey, ciphertext, iv);
  return new TextDecoder().decode(plain);
}

export async function encryptParentId(
  masterKey: RawKey,
  parentId: string | null,
): Promise<EncryptedFieldRaw | null> {
  if (parentId === null) return null;
  const enc = await encrypt(masterKey, new TextEncoder().encode(parentId));
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function decryptParentId(
  masterKey: RawKey,
  ciphertext: Uint8Array | null,
  iv: Uint8Array | null,
): Promise<string | null> {
  if (ciphertext === null || iv === null) return null;
  const plain = await decrypt(masterKey, ciphertext, iv);
  return new TextDecoder().decode(plain);
}

export async function wrapFolderKey(
  folderKey: RawKey,
  wrapperKey: RawKey,
): Promise<WrappedKey> {
  const enc = await encrypt(wrapperKey, folderKey);
  return { ciphertext: enc.ciphertext, iv: enc.iv };
}

export async function unwrapFolderKey(
  wrapped: WrappedKey,
  wrapperKey: RawKey,
): Promise<RawKey> {
  return decrypt(wrapperKey, wrapped.ciphertext, wrapped.iv);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --prefix web -- folder.test`
Expected: PASS (8 tests).

- [ ] **Step 5: Expose the folder crypto on the worker**

In `web/src/workers/crypto.worker.ts`, add imports alongside the other `@/crypto` imports at the top:

```ts
import {
  newFolderKey as newFolderKeyFn,
  encryptFolderName as encryptFolderNameFn,
  decryptFolderName as decryptFolderNameFn,
  encryptParentId as encryptParentIdFn,
  decryptParentId as decryptParentIdFn,
  wrapFolderKey as wrapFolderKeyFn,
  unwrapFolderKey as unwrapFolderKeyFn,
} from "@/crypto/folder";
```

Add these methods inside the `api` object (after `decryptFile`):

```ts
  // --- Folders (P3) -----------------------------------------------------

  newFolderKey(): RawKey {
    return newFolderKeyFn();
  },

  async encryptFolderName(folderKey: RawKey, name: string) {
    return encryptFolderNameFn(folderKey, name);
  },

  async decryptFolderName(folderKey: RawKey, ciphertext: Uint8Array, iv: Uint8Array) {
    return decryptFolderNameFn(folderKey, ciphertext, iv);
  },

  async encryptParentId(masterKey: RawKey, parentId: string | null) {
    return encryptParentIdFn(masterKey, parentId);
  },

  async decryptParentId(
    masterKey: RawKey,
    ciphertext: Uint8Array | null,
    iv: Uint8Array | null,
  ) {
    return decryptParentIdFn(masterKey, ciphertext, iv);
  },

  async wrapFolderKey(folderKey: RawKey, wrapperKey: RawKey) {
    return wrapFolderKeyFn(folderKey, wrapperKey);
  },

  async unwrapFolderKey(wrapped: WrappedKey, wrapperKey: RawKey) {
    return unwrapFolderKeyFn(wrapped, wrapperKey);
  },
```

- [ ] **Step 6: Add worker coverage tests**

In `web/src/workers/crypto.worker.test.ts`, add inside the `describe` block:

```ts
  it("folder name round-trips through the worker api", async () => {
    const fk = api.newFolderKey();
    const enc = await api.encryptFolderName(fk, "Photos");
    expect(await api.decryptFolderName(fk, enc.ciphertext, enc.iv)).toBe("Photos");
  });

  it("parent id encrypts/decrypts and null means root", async () => {
    const mk = api.newMasterKey();
    expect(await api.encryptParentId(mk, null)).toBeNull();
    const enc = await api.encryptParentId(mk, "pid");
    expect(enc).not.toBeNull();
    expect(await api.decryptParentId(mk, enc!.ciphertext, enc!.iv)).toBe("pid");
  });

  it("folder_key wraps by master_key then unwraps via worker api", async () => {
    const mk = api.newMasterKey();
    const fk = api.newFolderKey();
    const wrapped = await api.wrapFolderKey(fk, mk);
    expect(Array.from(await api.unwrapFolderKey(wrapped, mk))).toEqual(Array.from(fk));
  });
```

- [ ] **Step 7: Run folder + worker tests + typecheck**

Run: `npm run test --prefix web -- folder crypto.worker` then `npm run typecheck --prefix web`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/crypto/folder.ts web/src/crypto/folder.test.ts web/src/workers/crypto.worker.ts web/src/workers/crypto.worker.test.ts
git commit -m "feat(crypto): folder_key hierarchy + name/parent-id helpers (worker-exposed)"
```

---

## Task 5: Frontend API client (types + folders + http.patch)

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/client.ts` (add `http.patch`)
- Create: `web/src/api/folders.ts`
- Modify: `web/src/api/files.ts` (add `filesApi.move`)

**Interfaces:**
- Produces: `FolderInfo`, `CreateFolderRequest`, `PatchFolderRequest`, `DeleteFolderRequest`, `DeleteFolderResponse`, `PatchFileMoveRequest`; `foldersApi` (`list`/`create`/`patch`/`remove`); `filesApi.move`; `http.patch`; `FileMeta` gains `encrypted_parent_id` + nonce.

- [ ] **Step 1: Extend `types.ts`**

In `web/src/api/types.ts`, add the two parent fields to `FileMeta` (after `encrypted_file_key_nonce`):

```ts
  encrypted_file_key: string | null; // base64
  encrypted_file_key_nonce: string | null; // base64
  encrypted_parent_id: string | null; // base64; null ≡ root
  encrypted_parent_id_nonce: string | null; // base64
  created_at: string;
```

Extend `CreateFileRequest` with optional parent fields:

```ts
export interface CreateFileRequest {
  total_size: number;
  chunk_count: number;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
  encrypted_parent_id?: string | null; // base64; omit/null ≡ root
  encrypted_parent_id_nonce?: string | null; // base64
}
```

Append the folder + move types at the end of the file:

```ts
// ---- Folders (P3) -------------------------------------------------------

export interface FolderInfo {
  id: string;
  encrypted_parent_id: string | null; // base64; null ≡ root
  encrypted_parent_id_nonce: string | null; // base64
  encrypted_folder_key: string; // base64
  encrypted_folder_key_nonce: string; // base64
  encrypted_name: string; // base64
  encrypted_name_nonce: string; // base64
  created_at: string;
  updated_at: string;
}

export interface CreateFolderRequest {
  encrypted_parent_id: string | null;
  encrypted_parent_id_nonce: string | null;
  encrypted_folder_key: string;
  encrypted_folder_key_nonce: string;
  encrypted_name: string;
  encrypted_name_nonce: string;
}

/**
 * PATCH folder body. Omitted fields are not updated. To move to root, set
 * encrypted_parent_id + nonce to null AND supply the re-wrapped folder_key.
 * Use `undefined` (not null) for fields you do not want to change.
 */
export interface PatchFolderRequest {
  encrypted_name?: string;
  encrypted_name_nonce?: string;
  encrypted_parent_id?: string | null;
  encrypted_parent_id_nonce?: string | null;
  encrypted_folder_key?: string;
  encrypted_folder_key_nonce?: string;
}

export interface DeleteFolderRequest {
  folder_ids: string[];
  file_ids: string[];
}

export interface DeleteFolderResponse {
  ok: true;
  deleted_folders: number;
  deleted_files: number;
}

export interface PatchFileMoveRequest {
  encrypted_parent_id: string | null;
  encrypted_parent_id_nonce: string | null;
  encrypted_file_key: string;
  encrypted_file_key_nonce: string;
}
```

- [ ] **Step 2: Add `http.patch` to the client**

In `web/src/api/client.ts`, replace the `http` object with:

```ts
export const http = {
  get: <T>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "POST", body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "DELETE" }),
};
```

- [ ] **Step 3: Create `folders.ts` API client**

Create `web/src/api/folders.ts`:

```ts
import { http, request } from "./client";
import type {
  CreateFolderRequest,
  DeleteFolderRequest,
  DeleteFolderResponse,
  FolderInfo,
  PatchFolderRequest,
} from "./types";

export const foldersApi = {
  list: () => http.get<{ folders: FolderInfo[] }>("/api/folders"),

  create: (body: CreateFolderRequest) =>
    http.post<{ id: string }>("/api/folders", body),

  patch: (id: string, body: PatchFolderRequest) =>
    http.patch<{ ok: true }>(`/api/folders/${id}`, body),

  remove: (id: string, body: DeleteFolderRequest) =>
    request<DeleteFolderResponse>(`/api/folders/${id}`, { method: "DELETE", body }),
};
```

- [ ] **Step 4: Add `filesApi.move`**

In `web/src/api/files.ts`, change the top import to include `http`:

```ts
import { http, getAuthToken, ApiError, request } from "./client";
```

Add the `move` method to the `filesApi` object (after `finalize`):

```ts
  move: (id: string, body: import("./types").PatchFileMoveRequest) =>
    http.patch<{ ok: true }>(`/api/files/${id}`, body),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: no errors (new `encrypted_parent_id` fields are nullable so existing call sites still typecheck).

- [ ] **Step 6: Commit**

```bash
git add web/src/api/types.ts web/src/api/client.ts web/src/api/folders.ts web/src/api/files.ts
git commit -m "feat(api): folders client + files.move + http.patch + parent-id types"
```

---

## Task 6: Frontend folders store

**Files:**
- Create: `web/src/stores/folders.ts`
- Create: `web/src/stores/folders.test.ts`

**Interfaces:**
- Consumes: `foldersApi`, `cryptoApi.{decryptParentId,unwrapFolderKey,decryptFolderName,newFolderKey,wrapFolderKey,encryptFolderName,encryptParentId}` (Tasks 4–5), `useFilesStore().filesWithParent` + `.refresh` (Task 7 — the store test mocks `@/stores/files`).
- Produces: `useFoldersStore` with `folders`, `currentFolderId`, `page`, `breadcrumbs`, `totalPages`, `paginatedView`, `loadTree`, `navigateTo`, `setPage`, `createFolder`, `renameFolder`, `moveFolder`, `deleteFolder`, `folderKeyOf`.

- [ ] **Step 1: Write the failing store tests**

Create `web/src/stores/folders.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const { listMock, createMock, patchMock, removeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  patchMock: vi.fn().mockResolvedValue({ ok: true }),
  removeMock: vi.fn().mockResolvedValue({ ok: true, deleted_folders: 0, deleted_files: 0 }),
}));

vi.mock("@/api/folders", () => ({
  foldersApi: {
    list: listMock,
    create: (b: unknown) => {
      createMock(b);
      return Promise.resolve({ id: "new-id" });
    },
    patch: patchMock,
    remove: removeMock,
  },
}));

const {
  decryptParentIdMock,
  unwrapFolderKeyMock,
  decryptFolderNameMock,
  newFolderKeyMock,
  wrapFolderKeyMock,
  encryptFolderNameMock,
  encryptParentIdMock,
} = vi.hoisted(() => ({
  decryptParentIdMock: vi.fn(),
  unwrapFolderKeyMock: vi.fn(),
  decryptFolderNameMock: vi.fn(),
  newFolderKeyMock: vi.fn(() => new Uint8Array(32)),
  wrapFolderKeyMock: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array([1]), iv: new Uint8Array([2]) }),
  encryptFolderNameMock: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array([3]), iv: new Uint8Array([4]) }),
  encryptParentIdMock: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array([5]), iv: new Uint8Array([6]) }),
}));

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {
    decryptParentId: decryptParentIdMock,
    unwrapFolderKey: unwrapFolderKeyMock,
    decryptFolderName: decryptFolderNameMock,
    newFolderKey: newFolderKeyMock,
    wrapFolderKey: wrapFolderKeyMock,
    encryptFolderName: encryptFolderNameMock,
    encryptParentId: encryptParentIdMock,
  },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

const { filesWithParentMock, filesRefreshMock } = vi.hoisted(() => ({
  filesWithParentMock: vi.fn(() => []),
  filesRefreshMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/stores/files", () => ({
  useFilesStore: () => ({ filesWithParent: filesWithParentMock, refresh: filesRefreshMock }),
}));

import { useFoldersStore } from "./folders";
import { useAuthStore } from "./auth";

const ENC = "AA==";

function row(id: string, parentId: string | null) {
  return {
    id,
    encrypted_parent_id: parentId === null ? null : ENC,
    encrypted_parent_id_nonce: parentId === null ? null : ENC,
    encrypted_folder_key: ENC,
    encrypted_folder_key_nonce: ENC,
    encrypted_name: ENC,
    encrypted_name_nonce: ENC,
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
  };
}

describe("folders store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listMock.mockReset();
    createMock.mockClear();
    patchMock.mockClear();
    removeMock.mockClear();
    decryptParentIdMock.mockReset();
    unwrapFolderKeyMock.mockReset();
    decryptFolderNameMock.mockReset();
    filesWithParentMock.mockReset();
    filesWithParentMock.mockReturnValue([]);
    filesRefreshMock.mockClear();
  });

  it("loadTree decrypts shape, unwraps the key chain, and decrypts names", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const rootKey = new Uint8Array(32).fill(1);
    const childKey = new Uint8Array(32).fill(2);
    listMock.mockResolvedValue({ folders: [row("root", null), row("child", "root")] });
    decryptParentIdMock.mockResolvedValueOnce("root").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValueOnce(rootKey).mockResolvedValueOnce(childKey);
    decryptFolderNameMock.mockResolvedValueOnce("Root").mockResolvedValueOnce("Child");

    const folders = useFoldersStore();
    await folders.loadTree();

    expect(folders.folders.length).toBe(2);
    const root = folders.folders.find((f) => f.id === "root")!;
    const child = folders.folders.find((f) => f.id === "child")!;
    expect(root.parentId).toBeNull();
    expect(root.name).toBe("Root");
    expect(child.parentId).toBe("root");
    expect(child.name).toBe("Child");
  });

  it("orphans (parent not in set) are surfaced as root", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("orphan", "ghost")] });
    decryptParentIdMock.mockResolvedValueOnce("ghost");
    unwrapFolderKeyMock.mockResolvedValueOnce(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValueOnce("O");

    const folders = useFoldersStore();
    await folders.loadTree();
    expect(folders.folders[0].parentId).toBeNull();
  });

  it("moveFolder rejects moving a folder into its own descendant", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("a", null), row("b", "a")] });
    decryptParentIdMock.mockResolvedValueOnce("a").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    const folders = useFoldersStore();
    await folders.loadTree();

    await expect(folders.moveFolder("a", "b")).rejects.toThrow(/descendant/i);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("paginatedView returns the combined children list", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("a", null), row("b", null)] });
    decryptParentIdMock.mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    const folders = useFoldersStore();
    await folders.loadTree();

    expect(folders.paginatedView.length).toBe(2);
    expect(folders.totalPages).toBe(1);
  });

  it("createFolder posts wrapped key + encrypted name/parent and appends locally", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [] });
    const folders = useFoldersStore();
    await folders.loadTree();

    await folders.createFolder("New");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ encrypted_name: expect.any(String) }),
    );
    expect(folders.folders.find((f) => f.id === "new-id")?.name).toBe("New");
  });

  it("deleteFolder sends the descendant set and removes locally", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    listMock.mockResolvedValue({ folders: [row("root", null), row("sub", "root")] });
    decryptParentIdMock.mockResolvedValueOnce("root").mockResolvedValue("x");
    unwrapFolderKeyMock.mockResolvedValue(new Uint8Array(32));
    decryptFolderNameMock.mockResolvedValue("n");
    filesWithParentMock.mockImplementation((pid: string | null) =>
      pid === "sub" ? [{ id: "file1" }] : [],
    );
    removeMock.mockResolvedValue({ ok: true, deleted_folders: 2, deleted_files: 1 });

    const folders = useFoldersStore();
    await folders.loadTree();
    await folders.deleteFolder("root");

    expect(removeMock).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({
        folder_ids: expect.arrayContaining(["root", "sub"]),
        file_ids: ["file1"],
      }),
    );
    expect(folders.folders.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --prefix web -- folders.test`
Expected: FAIL — cannot resolve `./folders`.

- [ ] **Step 3: Implement the store**

Create `web/src/stores/folders.ts`:

```ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";

import { foldersApi } from "@/api/folders";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";
import { useFilesStore } from "./files";
import { fromBase64, toBase64 } from "@/crypto/file";
import type {
  CreateFolderRequest,
  DeleteFolderRequest,
  FolderInfo,
  PatchFolderRequest,
} from "@/api/types";
import type { FileMeta } from "@/api/types";

export interface FolderNode {
  id: string;
  parentId: string | null;
  folderKey: Uint8Array;
  name: string;
  createdAt: string;
}

export interface FolderEntry {
  kind: "folder";
  folder: FolderNode;
}
export interface FileEntry {
  kind: "file";
  file: FileMeta;
}
export type TreeEntry = FolderEntry | FileEntry;

const PAGE_SIZE = 50;

export const useFoldersStore = defineStore("folders", () => {
  const folders = ref<FolderNode[]>([]);
  const currentFolderId = ref<string | null>(null);
  const page = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  function masterKey(): Uint8Array {
    const key = useAuthStore().masterKey;
    if (!key) throw new Error("not unlocked — master key missing");
    return key;
  }

  const byId = computed(() => {
    const m = new Map<string, FolderNode>();
    for (const f of folders.value) m.set(f.id, f);
    return m;
  });

  function folderKeyOf(id: string): Uint8Array | undefined {
    return byId.value.get(id)?.folderKey;
  }

  const breadcrumbs = computed<FolderNode[]>(() => {
    const path: FolderNode[] = [];
    let cur = currentFolderId.value ? byId.value.get(currentFolderId.value) ?? null : null;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.value.get(cur.parentId) ?? null : null;
    }
    return path;
  });

  const childrenFolders = computed(() =>
    folders.value
      .filter((f) => f.parentId === currentFolderId.value)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const combinedChildren = computed<TreeEntry[]>(() => {
    const filesStore = useFilesStore();
    const folderRows: FolderEntry[] = childrenFolders.value.map((folder) => ({ kind: "folder", folder }));
    const fileRows: FileEntry[] = filesStore
      .filesWithParent(currentFolderId.value)
      .map((file) => ({ kind: "file", file }));
    return [...folderRows, ...fileRows];
  });

  const totalPages = computed(() =>
    Math.max(1, Math.ceil(combinedChildren.value.length / PAGE_SIZE)),
  );

  const paginatedView = computed<TreeEntry[]>(() => {
    const start = page.value * PAGE_SIZE;
    return combinedChildren.value.slice(start, start + PAGE_SIZE);
  });

  async function loadTree(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const { folders: rows } = await foldersApi.list();

      // 1. decrypt parent ids with master_key
      const shape: { row: FolderInfo; parentId: string | null }[] = [];
      for (const row of rows) {
        const parentId =
          row.encrypted_parent_id && row.encrypted_parent_id_nonce
            ? await cryptoApi.decryptParentId(
                mk,
                fromBase64(row.encrypted_parent_id),
                fromBase64(row.encrypted_parent_id_nonce),
              )
            : null;
        shape.push({ row, parentId });
      }

      // 2. orphan recovery: parent not present → root
      const idSet = new Set(rows.map((r) => r.id));
      for (const s of shape) {
        if (s.parentId && !idSet.has(s.parentId)) s.parentId = null;
      }

      // 3. BFS the key-wrap chain from roots
      const childrenOf = new Map<string | null, string[]>();
      for (const s of shape) {
        const arr = childrenOf.get(s.parentId) ?? [];
        arr.push(s.row.id);
        childrenOf.set(s.parentId, arr);
      }
      const keyById = new Map<string, Uint8Array>();
      const nameById = new Map<string, string>();
      const queue: (string | null)[] = [null];
      const processed = new Set<string>();
      while (queue.length) {
        const parent = queue.shift()!;
        for (const cid of childrenOf.get(parent) ?? []) {
          if (processed.has(cid)) continue;
          processed.add(cid);
          const s = shape.find((x) => x.row.id === cid)!;
          const wrapperKey = parent === null ? mk : keyById.get(parent)!;
          const folderKey = await cryptoApi.unwrapFolderKey(
            {
              ciphertext: fromBase64(s.row.encrypted_folder_key),
              iv: fromBase64(s.row.encrypted_folder_key_nonce),
            },
            wrapperKey,
          );
          keyById.set(cid, folderKey);
          const name = await cryptoApi.decryptFolderName(
            folderKey,
            fromBase64(s.row.encrypted_name),
            fromBase64(s.row.encrypted_name_nonce),
          );
          nameById.set(cid, name);
          queue.push(cid);
        }
      }

      folders.value = shape.map((s) => ({
        id: s.row.id,
        parentId: s.parentId,
        folderKey: keyById.get(s.row.id)!,
        name: nameById.get(s.row.id) ?? "(encrypted)",
        createdAt: s.row.created_at,
      }));

      if (page.value > totalPages.value - 1) page.value = totalPages.value - 1;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  function navigateTo(folderId: string | null): void {
    currentFolderId.value = folderId;
    page.value = 0;
  }

  function setPage(n: number): void {
    page.value = Math.min(Math.max(0, n), totalPages.value - 1);
  }

  async function createFolder(name: string): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const folderKey = await cryptoApi.newFolderKey();
      const parentId = currentFolderId.value;
      let wrapperKey: Uint8Array;
      if (parentId === null) {
        wrapperKey = mk;
      } else {
        const pk = folderKeyOf(parentId);
        if (!pk) throw new Error("current folder key not available");
        wrapperKey = pk;
      }
      const wrapped = await cryptoApi.wrapFolderKey(folderKey, wrapperKey);
      const nameEnc = await cryptoApi.encryptFolderName(folderKey, name);
      const parentEnc = await cryptoApi.encryptParentId(mk, parentId);
      const body: CreateFolderRequest = {
        encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
        encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
        encrypted_folder_key: toBase64(wrapped.ciphertext),
        encrypted_folder_key_nonce: toBase64(wrapped.iv),
        encrypted_name: toBase64(nameEnc.ciphertext),
        encrypted_name_nonce: toBase64(nameEnc.iv),
      };
      const { id } = await foldersApi.create(body);
      folders.value = [
        ...folders.value,
        { id, parentId, folderKey, name, createdAt: new Date().toISOString() },
      ];
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  async function renameFolder(id: string, newName: string): Promise<void> {
    const node = byId.value.get(id);
    if (!node) throw new Error("folder not found");
    const enc = await cryptoApi.encryptFolderName(node.folderKey, newName);
    await foldersApi.patch(id, {
      encrypted_name: toBase64(enc.ciphertext),
      encrypted_name_nonce: toBase64(enc.iv),
    });
    folders.value = folders.value.map((f) => (f.id === id ? { ...f, name: newName } : f));
  }

  function isDescendant(candidateId: string, ancestorId: string): boolean {
    let cur = byId.value.get(candidateId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parentId ? byId.value.get(cur.parentId) ?? null : null;
    }
    return false;
  }

  async function moveFolder(id: string, newParentId: string | null): Promise<void> {
    if (newParentId !== null && isDescendant(newParentId, id)) {
      throw new Error("cannot move a folder into itself or its own descendant");
    }
    const mk = masterKey();
    const node = byId.value.get(id);
    if (!node) throw new Error("folder not found");
    let wrapperKey: Uint8Array;
    if (newParentId === null) {
      wrapperKey = mk;
    } else {
      const pk = folderKeyOf(newParentId);
      if (!pk) throw new Error("target folder key not available");
      wrapperKey = pk;
    }
    const wrapped = await cryptoApi.wrapFolderKey(node.folderKey, wrapperKey);
    const parentEnc = await cryptoApi.encryptParentId(mk, newParentId);
    const body: PatchFolderRequest = {
      encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
      encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
      encrypted_folder_key: toBase64(wrapped.ciphertext),
      encrypted_folder_key_nonce: toBase64(wrapped.iv),
    };
    await foldersApi.patch(id, body);
    folders.value = folders.value.map((f) =>
      f.id === id ? { ...f, parentId: newParentId } : f,
    );
  }

  async function deleteFolder(id: string): Promise<void> {
    const folderIds = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const f of folders.value) {
        if (f.parentId === cur && !folderIds.has(f.id)) {
          folderIds.add(f.id);
          stack.push(f.id);
        }
      }
    }
    const filesStore = useFilesStore();
    const fileIds = new Set<string>();
    for (const fid of folderIds) {
      for (const file of filesStore.filesWithParent(fid)) {
        fileIds.add(file.id);
      }
    }
    const body: DeleteFolderRequest = {
      folder_ids: [...folderIds],
      file_ids: [...fileIds],
    };
    await foldersApi.remove(id, body);
    folders.value = folders.value.filter((f) => !folderIds.has(f.id));
    await filesStore.refresh();
    if (currentFolderId.value && folderIds.has(currentFolderId.value)) {
      navigateTo(null);
    }
  }

  return {
    folders,
    currentFolderId,
    page,
    loading,
    error,
    breadcrumbs,
    totalPages,
    paginatedView,
    loadTree,
    navigateTo,
    setPage,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    folderKeyOf,
  };
});
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `npm run test --prefix web -- folders.test`
Expected: PASS (6 tests).

> **Note:** the folders store references `useFilesStore().filesWithParent` and `.refresh`, which the real files store gains only in Task 7. This step runs just the folders-store test (with `@/stores/files` mocked), so it passes in isolation. Full-project `typecheck` is deferred to Task 7 Step 4, after which both stores exist and the whole project typechecks.

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/folders.ts web/src/stores/folders.test.ts
git commit -m "feat(store): folders store — tree build, navigation, pagination, CRUD"
```

---

## Task 7: Frontend files store changes (folder-aware upload + moveFile)

**Files:**
- Modify: `web/src/stores/files.ts`
- Modify: `web/src/stores/files.test.ts`

**Interfaces:**
- Consumes: `useFoldersStore().currentFolderId` + `folderKeyOf` (Task 6), `cryptoApi.encryptParentId` (Task 4), `filesApi.move` + `CreateFileRequest.encrypted_parent_id` (Task 5).
- Produces: `fileParents` map, `filesWithParent(parentId)`, `moveFile(id, newParentId)`; `upload` wraps `file_key` with the current folder's `folder_key` and sets `encrypted_parent_id`.

- [ ] **Step 1: Write the failing tests**

In `web/src/stores/files.test.ts`, add `encryptParentId` to the existing `cryptoApi` mock object (next to `wrap`/`seal`):

```ts
    encryptParentId: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([11]),
      iv: new Uint8Array([12]),
    }),
```

Add a folders-store mock near the other `vi.mock` calls (before `import { useFilesStore }`):

```ts
const { currentFolderIdMock, folderKeyOfMock, filesMoveMock } = vi.hoisted(() => ({
  currentFolderIdMock: { value: null as string | null },
  folderKeyOfMock: vi.fn(() => undefined),
  filesMoveMock: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/stores/folders", () => ({
  useFoldersStore: () => ({
    get currentFolderId() {
      return currentFolderIdMock.value;
    },
    folderKeyOf: folderKeyOfMock,
  }),
}));
```

Add `move: filesMoveMock` to the existing `vi.mock("@/api/files", ...)` `filesApi` object (so the store's `filesApi.move` call is observable):

```ts
    move: filesMoveMock,
```

Add these tests inside the `describe("files store", ...)` block:

```ts
  it("upload into a folder wraps fileKey with the folder key + sets parent", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    currentFolderIdMock.value = "fold";
    folderKeyOfMock.mockReturnValue(new Uint8Array(32).fill(7));
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ encrypted_parent_id: expect.any(String) }),
    );
    // fileKey was wrapped with the folder key, not masterKey: cryptoApi.wrap was
    // called with the folder key (32 bytes of 7) as the wrapper.
    expect((cryptoApi.wrap as any)).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      new Uint8Array(32).fill(7),
    );
    currentFolderIdMock.value = null;
    folderKeyOfMock.mockReturnValue(undefined);
  });

  it("upload to root wraps fileKey with masterKey and omits parent", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    currentFolderIdMock.value = null;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    // create body should omit encrypted_parent_id (undefined → not in object)
    expect(createMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ encrypted_parent_id: expect.anything() }),
    );
  });

  it("moveFile re-wraps the file_key and PATCHes the new parent", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    // a file currently at root (no parent); move it into "dest"
    files.files.value = []; // ensure clean
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      encrypted_parent_id: null, encrypted_parent_id_nonce: null,
      created_at: "", updated_at: "",
    };
    files.files.value = [meta];
    folderKeyOfMock.mockReturnValue(new Uint8Array(32).fill(9)); // dest's folder key
    await files.moveFile("f1", "dest");
    expect(filesMoveMock).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ encrypted_parent_id: expect.any(String) }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --prefix web -- files.test`
Expected: FAIL — `files.files` is not assignable / `moveFile` is not a function.

- [ ] **Step 3: Modify the store**

In `web/src/stores/files.ts`:

Add the imports (extend the existing `@/crypto/file` import to confirm `fromBase64`/`toBase64` are present — they are; add `useFoldersStore` import):

```ts
import { useFoldersStore } from "./folders";
```

Add state inside `useFilesStore` (near the other `ref`s):

```ts
  const fileParents = ref<Record<string, string | null>>({});
```

In `refresh()`, after `void decryptNames();` add:

```ts
    void decryptParents();
```

Add the `decryptParents` helper (next to `decryptNames`):

```ts
  async function decryptParents(): Promise<void> {
    let key: Uint8Array;
    try {
      key = masterKey();
    } catch {
      return;
    }
    for (const f of files.value) {
      if (fileParents.value[f.id] === undefined) {
        if (f.encrypted_parent_id && f.encrypted_parent_id_nonce) {
          try {
            fileParents.value[f.id] = await cryptoApi.decryptParentId(
              key,
              fromBase64(f.encrypted_parent_id),
              fromBase64(f.encrypted_parent_id_nonce),
            );
          } catch {
            fileParents.value[f.id] = null;
          }
        } else {
          fileParents.value[f.id] = null;
        }
      }
    }
  }

  function filesWithParent(parentId: string | null): FileMeta[] {
    return files.value.filter((f) => (fileParents.value[f.id] ?? null) === parentId);
  }
```

Modify the `upload` function's wrap-key + create section. Replace the block:

```ts
      const wrapped: WrappedKey = await cryptoApi.wrap(fileKey, mk);
      const { id } = await filesApi.create({
        total_size: total,
        chunk_count: n,
        encrypted_file_key: toBase64(wrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(wrapped.iv),
      });
```

with:

```ts
      const foldersStore = useFoldersStore();
      const parentId = foldersStore.currentFolderId;
      let wrapKey: Uint8Array;
      if (parentId === null) {
        wrapKey = mk;
      } else {
        const fk = foldersStore.folderKeyOf(parentId);
        if (!fk) throw new Error("current folder key not available");
        wrapKey = fk;
      }
      const wrapped: WrappedKey = await cryptoApi.wrap(fileKey, wrapKey);
      const parentEnc = await cryptoApi.encryptParentId(mk, parentId);
      const { id } = await filesApi.create({
        total_size: total,
        chunk_count: n,
        encrypted_file_key: toBase64(wrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(wrapped.iv),
        ...(parentEnc
          ? {
              encrypted_parent_id: toBase64(parentEnc.ciphertext),
              encrypted_parent_id_nonce: toBase64(parentEnc.iv),
            }
          : {}),
      });
      fileParents.value[id] = parentId;
```

Add the `moveFile` action (after `download`):

```ts
  async function moveFile(id: string, newParentId: string | null): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const foldersStore = useFoldersStore();
      const meta = files.value.find((f) => f.id === id);
      if (!meta || !meta.encrypted_file_key || !meta.encrypted_file_key_nonce) {
        throw new Error("file not found");
      }
      const curParent = fileParents.value[id] ?? null;
      let curWrapKey: Uint8Array;
      if (curParent === null) {
        curWrapKey = mk;
      } else {
        const fk = foldersStore.folderKeyOf(curParent);
        if (!fk) throw new Error("current folder key not available");
        curWrapKey = fk;
      }
      const fileKey = await cryptoApi.unwrap(
        {
          ciphertext: fromBase64(meta.encrypted_file_key),
          iv: fromBase64(meta.encrypted_file_key_nonce),
        },
        curWrapKey,
      );
      let newWrapKey: Uint8Array;
      if (newParentId === null) {
        newWrapKey = mk;
      } else {
        const fk = foldersStore.folderKeyOf(newParentId);
        if (!fk) throw new Error("target folder key not available");
        newWrapKey = fk;
      }
      const rewrapped = await cryptoApi.wrap(fileKey, newWrapKey);
      const parentEnc = await cryptoApi.encryptParentId(mk, newParentId);
      await filesApi.move(id, {
        encrypted_parent_id: parentEnc ? toBase64(parentEnc.ciphertext) : null,
        encrypted_parent_id_nonce: parentEnc ? toBase64(parentEnc.iv) : null,
        encrypted_file_key: toBase64(rewrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(rewrapped.iv),
      });
      fileParents.value[id] = newParentId;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }
```

Expose the new members in the returned object (add to the `return { ... }`):

```ts
    filesWithParent,
    moveFile,
```

(`fileParents` is internal; not exposed.)

- [ ] **Step 4: Run the tests + typecheck**

Run: `npm run test --prefix web -- files.test` then `npm run typecheck --prefix web`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(store): folder-aware upload + filesWithParent + moveFile"
```

---

## Task 8: DriveView navigation + folder CRUD UI

**Files:**
- Modify: `web/src/views/DriveView.vue`
- Modify: `web/src/views/DriveView.test.ts`

**Interfaces:**
- Consumes: `useFoldersStore` (Task 6), `useFilesStore` (Task 7), `files.displayNames` for file names, `MovePickerModal` (Task 9).

**⚠ Execution order:** Execute **Task 9 (MovePickerModal) before this task.** `DriveView.vue` imports `MovePickerModal.vue`, so the project only typechecks once Task 9 exists. (Task 8's own test stubs the modal via `vi.mock`, but the real source import requires Task 9.)

- [ ] **Step 1: Write the failing view test**

Replace `web/src/views/DriveView.test.ts` entirely:

```ts
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {},
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({ filesApi: { list: vi.fn().mockResolvedValue({ files: [] }) } }));
vi.mock("@/api/folders", () => ({
  foldersApi: { list: vi.fn().mockResolvedValue({ folders: [] }) },
}));
// Stub the modal so the view renders without its real dependencies.
vi.mock("@/components/MovePickerModal.vue", () => ({
  default: { template: "<div />", props: ["open", "excludeId"] },
}));

describe("DriveView", () => {
  it("renders a breadcrumb, a New folder button, and the empty hint at root", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView);
    await flushPromises();
    expect(w.text()).toMatch(/Drive/);
    expect(w.findAll("button").some((b) => b.text() === "New folder")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --prefix web -- DriveView.test`
Expected: FAIL — no "New folder" button (the old view has none).

- [ ] **Step 3: Rewrite `DriveView.vue`**

Replace the entire contents of `web/src/views/DriveView.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import { useFoldersStore } from "@/stores/folders";
import type { FileMeta } from "@/api/types";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
import MovePickerModal from "@/components/MovePickerModal.vue";

const auth = useAuthStore();
const files = useFilesStore();
const folders = useFoldersStore();
const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

// Move-picker state: kind + id of the item being moved.
const moveTarget = ref<{ kind: "folder" | "file"; id: string } | null>(null);

onMounted(() => {
  void folders.loadTree();
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
    await folders.loadTree();
  } catch {
    /* error surfaced in store */
  } finally {
    target.value = "";
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const f = e.dataTransfer?.files[0];
  if (f) void files.upload(f).then(() => folders.loadTree()).catch(() => {});
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
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function fileName(f: FileMeta): string {
  return files.displayNames[f.id] ?? f.id;
}

function previewable(f: FileMeta): boolean {
  return f.status === "ready";
}

function open(f: FileMeta) {
  void files.openPreview(f).catch(() => {});
}
function download(f: FileMeta) {
  void files.download(f).catch(() => {});
}
function remove(f: FileMeta) {
  if (confirm(`Delete "${fileName(f)}"?`)) void files.remove(f.id).then(() => folders.loadTree());
}

// --- folder actions ------------------------------------------------------

function newFolder() {
  const name = prompt("Folder name");
  if (name) void folders.createFolder(name);
}

function openFolder(id: string) {
  folders.navigateTo(id);
}

function crumbTo(id: string | null) {
  folders.navigateTo(id);
}

function renameFolder(id: string, current: string) {
  const name = prompt("Rename folder", current);
  if (name) void folders.renameFolder(id, name);
}

function moveFolder(id: string) {
  moveTarget.value = { kind: "folder", id };
}

function moveFile(id: string) {
  moveTarget.value = { kind: "file", id };
}

function removeFolder(id: string, name: string) {
  if (confirm(`Delete "${name}" and everything inside it? This cannot be undone.`)) {
    void folders.deleteFolder(id);
  }
}

async function onMovePicked(dest: string | null) {
  const t = moveTarget.value;
  moveTarget.value = null;
  if (!t) return;
  try {
    if (t.kind === "folder") await folders.moveFolder(t.id, dest);
    else await files.moveFile(t.id, dest);
  } catch {
    /* error surfaced in store */
  }
}

const showPrevPage = computed(() => folders.page > 0);
const showNextPage = computed(() => folders.page < folders.totalPages - 1);
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
      <nav class="breadcrumbs">
        <a class="link crumb" @click="crumbTo(null)">Drive</a>
        <template v-for="b in folders.breadcrumbs" :key="b.id">
          <span class="sep">/</span>
          <a class="link crumb" @click="crumbTo(b.id)">{{ b.name }}</a>
        </template>
      </nav>

      <div class="toolbar">
        <button class="link" @click="newFolder">New folder</button>
      </div>

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
        <input ref="fileInput" type="file" class="hidden" @change="onFileChosen" />
      </div>

      <p v-if="files.error || folders.error" class="error">{{ files.error || folders.error }}</p>

      <p class="muted" v-if="!folders.paginatedView.length && !files.loading">
        Nothing here.
      </p>

      <ul class="list">
        <li v-for="entry in folders.paginatedView" :key="entry.kind + entry.file?.id ?? entry.folder?.id">
          <template v-if="entry.kind === 'folder'">
            <span class="name">📁 {{ entry.folder.name }}</span>
            <span class="actions">
              <button class="link" @click="openFolder(entry.folder.id)">Open</button>
              <button class="link" @click="renameFolder(entry.folder.id, entry.folder.name)">Rename</button>
              <button class="link" @click="moveFolder(entry.folder.id)">Move</button>
              <button class="link" @click="removeFolder(entry.folder.id, entry.folder.name)">Delete</button>
            </span>
          </template>
          <template v-else>
            <span class="name">{{ fileName(entry.file) }}</span>
            <span class="meta">{{ fmtSize(entry.file.total_size) }} · {{ entry.file.status }}</span>
            <span class="actions">
              <button class="link" :disabled="!previewable(entry.file)" @click="open(entry.file)">Open</button>
              <button class="link" :disabled="entry.file.status !== 'ready'" @click="download(entry.file)">Download</button>
              <button class="link" @click="moveFile(entry.file.id)">Move</button>
              <button class="link" @click="remove(entry.file)">Delete</button>
            </span>
          </template>
        </li>
      </ul>

      <nav class="pager" v-if="folders.totalPages > 1">
        <button class="link" :disabled="!showPrevPage" @click="folders.setPage(folders.page - 1)">Prev</button>
        <span class="muted">Page {{ folders.page + 1 }} / {{ folders.totalPages }}</span>
        <button class="link" :disabled="!showNextPage" @click="folders.setPage(folders.page + 1)">Next</button>
      </nav>

      <section v-if="files.activeUploads.length" class="uploads">
        <h2>Incomplete uploads</h2>
        <ul class="list">
          <li v-for="u in files.activeUploads" :key="u.fileId">
            <span class="name">{{ u.file.name }}</span>
            <span class="meta">{{ Math.round(u.progress * 100) }}% · {{ u.phase }}</span>
            <progress :value="u.progress" max="1" />
            <button class="link" @click="files.cancelUpload(u.fileId)">Cancel</button>
          </li>
        </ul>
      </section>

      <FilePreviewModal
        v-if="files.preview"
        :kind="files.preview.kind"
        :url="files.preview.url"
        :name="files.preview.name"
        @close="files.closePreview()"
      />

      <MovePickerModal
        :open="moveTarget !== null"
        :exclude-id="moveTarget?.kind === 'folder' ? moveTarget.id : undefined"
        @pick="onMovePicked"
        @cancel="moveTarget = null"
      />
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
.breadcrumbs { margin-bottom: 1rem; display: flex; gap: 0.4rem; align-items: center; }
.crumb { color: var(--df-color-fg-muted); cursor: pointer; }
.sep { color: var(--df-color-fg-muted); }
.toolbar { margin-bottom: 1rem; }
h1, h2 { margin: 0 0 1rem; font-size: 1.4rem; }
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
.pager { display: flex; gap: 1rem; align-items: center; margin-top: 1rem; }
.uploads { margin-top: 2rem; }
</style>
```

- [ ] **Step 4: Run the view test + typecheck**

Run: `npm run test --prefix web -- DriveView.test` then `npm run typecheck --prefix web`
Expected: PASS, no type errors (Task 9's `MovePickerModal.vue` must already exist).

- [ ] **Step 5: Commit**

```bash
git add web/src/views/DriveView.vue web/src/views/DriveView.test.ts
git commit -m "feat(ui): DriveView folder navigation + breadcrumbs + folder CRUD"
```

---

## Task 9: MovePickerModal + move wiring

**Files:**
- Create: `web/src/components/MovePickerModal.vue`
- Create: `web/src/components/MovePickerModal.test.ts`

**Interfaces:**
- Consumes: `useFoldersStore().folders` (the decrypted tree) for the picker list; emits `pick(destId: string | null)` and `cancel`.
- Produces: the modal component imported by `DriveView.vue` (Task 8). `excludeId` prop hides a folder's own subtree from the destination list (cycle prevention at the UI layer; the store re-checks).

- [ ] **Step 1: Write the failing component test**

Create `web/src/components/MovePickerModal.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/workers/crypto", () => ({ cryptoApi: {}, ensureCryptoReady: vi.fn() }));
vi.mock("@/api/files", () => ({ filesApi: {} }));
vi.mock("@/api/folders", () => ({ foldersApi: {} }));

import MovePickerModal from "./MovePickerModal.vue";
import { useFoldersStore } from "@/stores/folders";
import { useAuthStore } from "@/stores/auth";

describe("MovePickerModal", () => {
  it("lists root folders + a Move to root button, emits pick(null) for root", async () => {
    setActivePinia(createPinia());
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const folders = useFoldersStore();
    folders.folders = [
      { id: "a", parentId: null, folderKey: new Uint8Array(32), name: "Alpha", createdAt: "" },
      { id: "b", parentId: "a", folderKey: new Uint8Array(32), name: "Beta", createdAt: "" },
    ] as any;

    const w = mount(MovePickerModal, { props: { open: true, excludeId: "a" } });
    // "Alpha" is excluded (it's the moved folder itself); "Beta" is its
    // descendant and must also be excluded to prevent cycles.
    expect(w.text()).not.toMatch(/Alpha/);
    expect(w.text()).not.toMatch(/Beta/);
    expect(w.text()).toMatch(/Move to root/);

    await w.findAll("button").find((b) => b.text() === "Move to root")!.trigger("click");
    expect(w.emitted("pick")?.[0]).toEqual([null]);
  });

  it("renders nothing when open is false", () => {
    setActivePinia(createPinia());
    const w = mount(MovePickerModal, { props: { open: false } });
    expect(w.find(".picker-backdrop").exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --prefix web -- MovePickerModal`
Expected: FAIL — cannot resolve `./MovePickerModal.vue`.

- [ ] **Step 3: Implement the modal**

Create `web/src/components/MovePickerModal.vue`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useFoldersStore } from "@/stores/folders";

const props = defineProps<{ open: boolean; excludeId?: string }>();
const emit = defineEmits<{ pick: [dest: string | null]; cancel: [] }>();

const folders = useFoldersStore();

/** The set of folder ids to hide: the excluded folder + all its descendants. */
const hiddenIds = computed<Set<string>>(() => {
  const out = new Set<string>();
  if (!props.excludeId) return out;
  const stack = [props.excludeId];
  out.add(props.excludeId);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders.folders) {
      if (f.parentId === cur && !out.has(f.id)) {
        out.add(f.id);
        stack.push(f.id);
      }
    }
  }
  return out;
});

/** Root-level folders not hidden, for the flat picker (P3: no nesting UI). */
const destinations = computed(() =>
  folders.folders
    .filter((f) => f.parentId === null && !hiddenIds.value.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel");
}
</script>

<template>
  <div v-if="open" class="picker-backdrop" @click.self="emit('cancel')" @keydown="onKey">
    <div class="picker-card">
      <header>
        <span class="title">Move to…</span>
        <button class="link" @click="emit('cancel')">Cancel</button>
      </header>
      <ul class="dest-list">
        <li>
          <button class="link row" @click="emit('pick', null)">Move to root</button>
        </li>
        <li v-for="d in destinations" :key="d.id">
          <button class="link row" @click="emit('pick', d.id)">📁 {{ d.name }}</button>
        </li>
        <li v-if="!destinations.length" class="muted">No other folders.</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.picker-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 60;
}
.picker-card {
  background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm);
  padding: 1rem; width: 100%; max-width: 420px;
}
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
.title { font-weight: 600; }
.dest-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.row { display: block; width: 100%; text-align: left; padding: 0.4rem 0.5rem; border-radius: var(--df-radius-sm); }
.row:hover { background: var(--df-color-border); }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg); }
.muted { color: var(--df-color-fg-muted); padding: 0.4rem 0.5rem; }
</style>
```

- [ ] **Step 4: Run the component tests + full frontend suite**

Run: `npm run test --prefix web` then `npm run typecheck --prefix web`
Expected: all frontend tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MovePickerModal.vue web/src/components/MovePickerModal.test.ts
git commit -m "feat(ui): MovePickerModal — cycle-safe folder destination picker"
```

---

## Task 10: Docs (crypto-design, api, README)

**Files:**
- Modify: `docs/crypto-design.md`
- Modify: `docs/api.md`
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the folder key hierarchy to `docs/crypto-design.md`**

After the "Manifest" section and before "Link sharing", insert a new section:

```markdown
## Folder tree (P3)

Folders form a zero-knowledge hierarchy that hides **both** folder names and
the tree structure from the server.

Each folder has a random 32-byte `folder_key`. A child's key (file_key or
subfolder's folder_key) is wrapped by its **parent folder's** `folder_key`;
root-level items are wrapped by `master_key` (so a root file behaves exactly
as in P1/P2). This makes move operations cheap (one re-wrap of the moved
item's key) and a future "share folder" feature elegant (re-wrap one key).

The **parent pointer** is always encrypted with `master_key` — never
`folder_key` — so the client can recover the tree shape before walking the
key-wrap chain (which would otherwise be circular). Consequence: a future
share recipient cannot decrypt structure on their own; folder sharing will
need to re-share the parent pointers of the shared subtree.

The client downloads every folder row, decrypts all parent pointers with
`master_key`, then BFS-walks the key graph from the roots to decrypt names.
Orphaned items (parent not present) are surfaced as root.
```

- [ ] **Step 2: Add the folder endpoints to `docs/api.md`**

After the `## Files` section's `DELETE /api/files/:id` entry and before
`## Shares`, insert a `## Folders` section documenting `GET /api/folders`,
`POST /api/folders`, `PATCH /api/folders/:id`, `DELETE /api/folders/:id`
(with the `{ folder_ids, file_ids }` cascade body), and the
`PATCH /api/files/:id` move endpoint. Mirror the request/response shapes
exactly as implemented in Tasks 2–3 (opaque base64 blobs; `404` for non-owner;
hard delete).

- [ ] **Step 3: Update the README status table**

In `README.md`, change the P3 row to reflect folder-tree progress:

```markdown
| P3 | Link sharing, encrypted folder tree | 🚧 in progress (folder tree) |
```

- [ ] **Step 4: Commit**

```bash
git add docs/crypto-design.md docs/api.md README.md
git commit -m "docs: P3 folder tree — crypto hierarchy, folder API, status"
```

---

## Final verification

After Task 10, run the full verification suite once more:

```bash
cargo test --manifest-path server/Cargo.toml
npm run test --prefix web
npm run typecheck --prefix web
npm run build --prefix web
cargo check --manifest-path server/Cargo.toml
```

All must pass. The production build (`vite build` + `cargo check`) confirms the
single-binary embed path still works end-to-end.

