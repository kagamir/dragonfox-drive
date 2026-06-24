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
