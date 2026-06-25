//! Public link-share endpoints.
//!
//! Zero-knowledge: file_key is re-wrapped (AES-GCM) with a share_key derived
//! from a share password / random URL-fragment key. The server only stores the
//! re-wrapped blob and (optionally) a SHA-256 verifier of share_key.

use axum::{
    extract::{Path, Query, State},
    http::header,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::storage;

#[derive(Debug, Deserialize)]
pub struct CreateShareRequest {
    pub file_id: String,
    pub share_salt: String,
    pub encrypted_file_key: String,
    pub encrypted_file_key_nonce: String,
    pub password_hash: Option<String>,
    pub expires_at: Option<String>,
    pub download_limit: Option<u32>,
}

/// Per-row share state derived from `revoked_at`/`expires_at`/`download_limit`.
fn active_state(
    revoked_at: &Option<String>,
    expires_at: &Option<String>,
    download_limit: Option<i64>,
    download_count: i64,
    now: chrono::DateTime<chrono::Utc>,
) -> &'static str {
    if revoked_at.is_some() {
        return "revoked";
    }
    if let Some(ts) = expires_at {
        if let Ok(t) = chrono::DateTime::parse_from_rfc3339(ts) {
            if t.with_timezone(&chrono::Utc) <= now {
                return "expired";
            }
        }
    }
    if let Some(limit) = download_limit {
        if download_count >= limit {
            return "exhausted";
        }
    }
    "active"
}

/// SQL fragment encoding "active right now" so the atomic count-increment
/// UPDATE can re-check the same condition to avoid races.
const ACTIVE_WHERE: &str = "revoked_at IS NULL \
    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) \
    AND (download_limit IS NULL OR download_count < download_limit)";

#[derive(Debug, Serialize)]
pub struct ShareListItem {
    pub file_id: String,
    pub id: String,
    pub state: String,
    pub requires_password: bool,
    pub expires_at: Option<String>,
    pub download_limit: Option<u32>,
    pub download_count: u32,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateShareRequest>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT status, encrypted_manifest FROM files WHERE id = ? AND owner_id = ?",
    )
    .bind(&req.file_id)
    .bind(&user.user_id)
    .fetch_optional(&state.db)
    .await?;
    let (status, manifest) = match row {
        None => return Err(ApiError::NotFound),
        Some(v) => v,
    };
    if status != "ready" {
        return Err(ApiError::BadRequest("file is not ready".into()));
    }
    if manifest.is_none() {
        return Err(ApiError::BadRequest("file has no manifest".into()));
    }
    if let Some(ts) = &req.expires_at {
        match chrono::DateTime::parse_from_rfc3339(ts) {
            Ok(t) if t.with_timezone(&chrono::Utc) > chrono::Utc::now() => {}
            _ => {
                return Err(ApiError::BadRequest(
                    "expires_at must be a future RFC-3339 timestamp".into(),
                ))
            }
        }
    }
    if let Some(limit) = req.download_limit {
        if limit == 0 {
            return Err(ApiError::BadRequest("download_limit must be >= 1".into()));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO shares (id, file_id, owner_id, share_salt, encrypted_file_key, \
         encrypted_file_key_nonce, password_hash, expires_at, download_limit) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.file_id)
    .bind(&user.user_id)
    .bind(&req.share_salt)
    .bind(&req.encrypted_file_key)
    .bind(&req.encrypted_file_key_nonce)
    .bind(&req.password_hash)
    .bind(&req.expires_at)
    .bind(req.download_limit.map(|v| v as i32))
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Debug, Deserialize)]
pub struct ListSharesQuery {
    pub file_id: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListSharesQuery>,
) -> ApiResult<Json<Value>> {
    let (sql, file_filter): (&str, Option<&str>) = match q.file_id.as_deref() {
        Some(fid) => (
            "SELECT s.file_id, s.id, s.expires_at, s.download_limit, s.download_count, \
             s.revoked_at, s.created_at, (s.password_hash IS NOT NULL) AS has_pw \
             FROM shares s WHERE s.owner_id = ? AND s.file_id = ? ORDER BY s.created_at DESC",
            Some(fid),
        ),
        None => (
            "SELECT s.file_id, s.id, s.expires_at, s.download_limit, s.download_count, \
             s.revoked_at, s.created_at, (s.password_hash IS NOT NULL) AS has_pw \
             FROM shares s WHERE s.owner_id = ? ORDER BY s.created_at DESC",
            None,
        ),
    };
    let mut qry = sqlx::query_as::<
        _,
        (String, String, Option<String>, Option<i32>, i32, Option<String>, String, bool),
    >(sql)
    .bind(&user.user_id);
    if let Some(fid) = file_filter {
        qry = qry.bind(fid);
    }
    let rows = qry.fetch_all(&state.db).await?;
    let now = chrono::Utc::now();
    let items: Vec<ShareListItem> = rows
        .into_iter()
        .map(|(file_id, id, expires_at, dl, dc, revoked_at, created_at, has_pw)| ShareListItem {
            file_id,
            id,
            state: active_state(&revoked_at, &expires_at, dl.map(|v| v as i64), dc as i64, now)
                .into(),
            requires_password: has_pw,
            expires_at,
            download_limit: dl.map(|v| v as u32),
            download_count: dc as u32,
            revoked_at,
            created_at,
        })
        .collect();
    Ok(Json(json!({ "shares": items })))
}

pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let now = chrono::Utc::now().to_rfc3339();
    let res = sqlx::query(
        "UPDATE shares SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL",
    )
    .bind(&now)
    .bind(&id)
    .bind(&user.user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// Hard-delete a share row (owner only). Distinct from `revoke`, which keeps
/// the row for audit. 404 for non-owner or missing — never leaks existence.
pub async fn purge(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let res = sqlx::query("DELETE FROM shares WHERE id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.user_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

// --- Public endpoints (implemented in Task 3) -------------------------------

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(
        String,            // share_salt
        Option<String>,    // password_hash
        Option<String>,    // expires_at
        Option<i64>,       // download_limit
        i64,               // download_count
        Option<String>,    // revoked_at
        String,            // encrypted_file_key
        String,            // encrypted_file_key_nonce
        Option<String>,    // files.encrypted_manifest
        Option<String>,    // files.encrypted_manifest_nonce
    )> = sqlx::query_as(
        "SELECT s.share_salt, s.password_hash, s.expires_at, s.download_limit, \
         s.download_count, s.revoked_at, s.encrypted_file_key, s.encrypted_file_key_nonce, \
         f.encrypted_manifest, f.encrypted_manifest_nonce \
         FROM shares s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let r = match row {
        None => return Err(ApiError::NotFound),
        Some(r) => r,
    };
    let now = chrono::Utc::now();
    let st = active_state(&r.5, &r.2, r.3, r.4, now);
    if st != "active" {
        return Ok(Json(json!({
            "id": id, "state": st, "requires_password": r.1.is_some(),
        })));
    }
    let requires_password = r.1.is_some();
    if requires_password {
        // Gated: do NOT disclose the key/manifest; no count increment.
        return Ok(Json(json!({
            "id": id, "state": "active", "requires_password": true,
            "share_salt": r.0,
        })));
    }
    // Active + no password: atomically claim one open, then disclose the key.
    let res = sqlx::query(&format!(
        "UPDATE shares SET download_count = download_count + 1 WHERE id = ? AND {ACTIVE_WHERE}"
    ))
    .bind(&id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        // Raced to exhausted/expired/revoked between read and update.
        return Ok(Json(json!({ "id": id, "state": "exhausted", "requires_password": false })));
    }
    Ok(Json(json!({
        "id": id, "state": "active", "requires_password": false,
        "share_salt": r.0,
        "encrypted_file_key": r.6,
        "encrypted_file_key_nonce": r.7,
        "encrypted_manifest": r.8,
        "encrypted_manifest_nonce": r.9,
    })))
}

#[derive(Debug, Deserialize)]
pub struct VerifyShareRequest {
    pub password_verifier: String,
}

/// Constant-time equality of two hex strings. Returns false on length mismatch
/// or decode error (lengths are fixed by SHA-256 — 64 hex chars — so the early
/// return leaks nothing).
fn ct_eq_hex(a: &str, b: &str) -> bool {
    let (av, bv) = match (hex::decode(a), hex::decode(b)) {
        (Ok(av), Ok(bv)) => (av, bv),
        _ => return false,
    };
    if av.len() != bv.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in av.iter().zip(bv.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub async fn verify(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<VerifyShareRequest>,
) -> ApiResult<Json<Value>> {
    let row: Option<(
        Option<String>,   // password_hash
        Option<String>,   // expires_at
        Option<i64>,      // download_limit
        i64,              // download_count
        Option<String>,   // revoked_at
        String,           // encrypted_file_key
        String,           // encrypted_file_key_nonce
        Option<String>,   // manifest
        Option<String>,   // manifest_nonce
    )> = sqlx::query_as(
        "SELECT s.password_hash, s.expires_at, s.download_limit, s.download_count, \
         s.revoked_at, s.encrypted_file_key, s.encrypted_file_key_nonce, \
         f.encrypted_manifest, f.encrypted_manifest_nonce \
         FROM shares s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let r = match row {
        None => return Err(ApiError::NotFound),
        Some(r) => r,
    };
    let stored = r.0.as_deref().ok_or_else(|| {
        ApiError::BadRequest("share is not password-protected".into())
    })?;
    let now = chrono::Utc::now();
    let st = active_state(&r.4, &r.1, r.2, r.3, now);
    if st != "active" {
        return Err(ApiError::Forbidden);
    }
    if !ct_eq_hex(&req.password_verifier, stored) {
        return Err(ApiError::Unauthorized);
    }
    let res = sqlx::query(&format!(
        "UPDATE shares SET download_count = download_count + 1 WHERE id = ? AND {ACTIVE_WHERE}"
    ))
    .bind(&id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::Forbidden);
    }
    Ok(Json(json!({
        "state": "active",
        "encrypted_file_key": r.5,
        "encrypted_file_key_nonce": r.6,
        "encrypted_manifest": r.7,
        "encrypted_manifest_nonce": r.8,
    })))
}

pub async fn get_chunk(
    State(state): State<AppState>,
    Path((id, idx)): Path<(String, u32)>,
) -> ApiResult<impl IntoResponse> {
    let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT f.status, s.file_id, s.revoked_at, s.expires_at \
         FROM shares s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    match row {
        None => Err(ApiError::NotFound),
        Some((status, file_id, revoked_at, expires_at)) => {
            if status != "ready" {
                return Err(ApiError::BadRequest("file is not ready".into()));
            }
            if revoked_at.is_some() {
                return Err(ApiError::Forbidden);
            }
            if let Some(ts) = expires_at {
                if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&ts) {
                    if t.with_timezone(&chrono::Utc) <= chrono::Utc::now() {
                        return Err(ApiError::Forbidden);
                    }
                }
            }
            let bytes = storage::read_chunk(&state, &file_id, idx)
                .await?
                .ok_or(ApiError::NotFound)?;
            Ok((
                [(header::CONTENT_TYPE, "application/octet-stream")],
                bytes,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Arc;

    async fn shares_state() -> (AppState, tempfile::TempDir) {
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
             encrypted_master_key, encrypted_master_key_nonce) VALUES (?, ?, 's','s','h','k','n')",
        )
        .bind(uid)
        .bind(uid)
        .execute(&state.db)
        .await
        .unwrap();
    }

    fn auth(uid: &str) -> AuthUser {
        AuthUser {
            user_id: uid.into(),
            device_id: None,
        }
    }

    async fn seed_ready_file(state: &AppState, id: &str, owner: &str) {
        sqlx::query(
            "INSERT INTO files (id, owner_id, status, total_size, chunk_count, encrypted_manifest, \
             encrypted_manifest_nonce, encrypted_file_key, encrypted_file_key_nonce) \
             VALUES (?, ?, 'ready', 10, 1, 'm', 'mn', 'k', 'kn')",
        )
        .bind(id)
        .bind(owner)
        .execute(&state.db)
        .await
        .unwrap();
    }

    fn create_req(file_id: &str) -> CreateShareRequest {
        CreateShareRequest {
            file_id: file_id.into(),
            share_salt: "salt".into(),
            encrypted_file_key: "k".into(),
            encrypted_file_key_nonce: "kn".into(),
            password_hash: None,
            expires_at: None,
            download_limit: None,
        }
    }

    #[tokio::test]
    async fn create_inserts_row_and_returns_id() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());
        let (cnt,): (i32,) = sqlx::query_as("SELECT count(*) FROM shares WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(cnt, 1);
    }

    #[tokio::test]
    async fn create_404_for_non_owner() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let err = create(State(state.clone()), auth("u2"), Json(create_req("f1")))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn create_400_when_file_not_ready() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        sqlx::query(
            "INSERT INTO files (id, owner_id, status, total_size, chunk_count, encrypted_manifest, \
             encrypted_manifest_nonce, encrypted_file_key, encrypted_file_key_nonce) \
             VALUES ('f1','u1','pending',10,1,'m','mn','k','kn')",
        )
        .execute(&state.db)
        .await
        .unwrap();
        let err = create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
    }

    #[tokio::test]
    async fn create_rejects_past_expiry_and_zero_limit() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let mut past = create_req("f1");
        past.expires_at = Some("2000-01-01T00:00:00Z".into());
        assert!(matches!(
            create(State(state.clone()), auth("u1"), Json(past))
                .await
                .unwrap_err(),
            ApiError::BadRequest(_)
        ));
        let mut zero = create_req("f1");
        zero.download_limit = Some(0);
        assert!(matches!(
            create(State(state.clone()), auth("u1"), Json(zero))
                .await
                .unwrap_err(),
            ApiError::BadRequest(_)
        ));
    }

    #[tokio::test]
    async fn list_returns_only_owners_shares_for_file() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        seed_ready_file(&state, "f2", "u2").await;
        create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        create(State(state.clone()), auth("u2"), Json(create_req("f2")))
            .await
            .unwrap();
        let res = list(
            State(state.clone()),
            auth("u1"),
            Query(ListSharesQuery {
                file_id: Some("f1".into()),
            }),
        )
        .await
        .unwrap();
        let arr = res.0["shares"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["state"], "active");
    }

    #[tokio::test]
    async fn revoke_sets_revoked_at_for_owner() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        revoke(State(state.clone()), auth("u1"), Path(id.clone()))
            .await
            .unwrap();
        let (rv,): (Option<String>,) =
            sqlx::query_as("SELECT revoked_at FROM shares WHERE id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(rv.is_some());
    }

    #[tokio::test]
    async fn revoke_404_for_non_owner() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        let err = revoke(State(state.clone()), auth("u2"), Path(id))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn active_state_classifies_rows() {
        let now = chrono::Utc::now();
        assert_eq!(active_state(&None, &None, None, 0, now), "active");
        assert_eq!(
            active_state(&Some("x".into()), &None, None, 0, now),
            "revoked"
        );
        let past = (now - chrono::Duration::seconds(10)).to_rfc3339();
        assert_eq!(
            active_state(&None, &Some(past), None, 0, now),
            "expired"
        );
        assert_eq!(active_state(&None, &None, Some(1), 1, now), "exhausted");
        assert_eq!(active_state(&None, &None, Some(1), 0, now), "active");
    }

    #[tokio::test]
    async fn revoke_twice_returns_404() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1"))).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        revoke(State(state.clone()), auth("u1"), Path(id.clone())).await.unwrap();
        let err = revoke(State(state.clone()), auth("u1"), Path(id)).await.unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn list_reports_requires_password_when_hash_set() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO shares (id, file_id, owner_id, share_salt, encrypted_file_key, \
             encrypted_file_key_nonce, password_hash) VALUES (?, 'f1', 'u1', 's', 'k', 'kn', 'h')",
        )
        .bind(&id).execute(&state.db).await.unwrap();
        let res = list(State(state.clone()), auth("u1"),
            Query(ListSharesQuery { file_id: Some("f1".into()) })).await.unwrap();
        let arr = res.0["shares"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["requires_password"], true);
    }

    #[tokio::test]
    async fn list_all_returns_all_shares_with_file_id() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        seed_ready_file(&state, "f2", "u1").await;
        create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        create(State(state.clone()), auth("u1"), Json(create_req("f2")))
            .await
            .unwrap();
        let res = list(
            State(state.clone()),
            auth("u1"),
            Query(ListSharesQuery { file_id: None }),
        )
        .await
        .unwrap();
        let items = res.0["shares"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let fids: Vec<&str> = items.iter().map(|s| s["file_id"].as_str().unwrap()).collect();
        assert!(fids.contains(&"f1"));
        assert!(fids.contains(&"f2"));
    }

    async fn seed_chunk(state: &AppState, file_id: &str) {
        crate::storage::write_chunk(state, file_id, 0, b"cipherbytes").await.unwrap();
    }

    #[tokio::test]
    async fn get_no_password_discloses_key_and_increments() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1"))).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        let r1 = get(State(state.clone()), Path(id.clone())).await.unwrap();
        assert_eq!(r1.0["state"], "active");
        assert_eq!(r1.0["requires_password"], false);
        assert!(r1.0["encrypted_file_key"].is_string());
        assert!(r1.0["encrypted_manifest"].is_string());
        let (dc,): (i32,) = sqlx::query_as("SELECT download_count FROM shares WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(dc, 1);
    }

    #[tokio::test]
    async fn get_password_share_withholds_key_and_does_not_count() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let mut req = create_req("f1");
        req.password_hash = Some("a".repeat(64));
        let res = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        let r = get(State(state.clone()), Path(id.clone())).await.unwrap();
        assert_eq!(r.0["requires_password"], true);
        assert!(r.0.get("encrypted_file_key").is_none() || r.0["encrypted_file_key"].is_null());
        let (dc,): (i32,) = sqlx::query_as("SELECT download_count FROM shares WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(dc, 0);
    }

    #[tokio::test]
    async fn get_exhausted_returns_state_without_key() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let mut req = create_req("f1");
        req.download_limit = Some(1);
        let res = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        get(State(state.clone()), Path(id.clone())).await.unwrap(); // count=1
        let r = get(State(state.clone()), Path(id.clone())).await.unwrap(); // now exhausted
        assert_eq!(r.0["state"], "exhausted");
        assert!(r.0.get("encrypted_file_key").is_none() || r.0["encrypted_file_key"].is_null());
    }

    #[tokio::test]
    async fn verify_rejects_wrong_password_without_counting() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let mut req = create_req("f1");
        req.password_hash = Some("a".repeat(64));
        let res = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        let err = verify(
            State(state.clone()), Path(id.clone()),
            Json(VerifyShareRequest { password_verifier: "b".repeat(64) }),
        ).await.unwrap_err();
        assert!(matches!(err, ApiError::Unauthorized));
        let (dc,): (i32,) = sqlx::query_as("SELECT download_count FROM shares WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(dc, 0, "wrong-password verify must not increment download_count");
    }

    #[tokio::test]
    async fn verify_success_discloses_key_and_increments() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let mut req = create_req("f1");
        req.password_hash = Some("a".repeat(64));
        let res = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        let r = verify(
            State(state.clone()), Path(id.clone()),
            Json(VerifyShareRequest { password_verifier: "a".repeat(64) }),
        ).await.unwrap();
        assert_eq!(r.0["state"], "active");
        assert!(r.0["encrypted_file_key"].is_string());
        let (dc,): (i32,) = sqlx::query_as("SELECT download_count FROM shares WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(dc, 1);
    }

    #[tokio::test]
    async fn get_chunk_blocks_revoked_and_expired_but_not_exhausted() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        seed_chunk(&state, "f1").await;
        let mut req = create_req("f1");
        req.download_limit = Some(1);
        let res = create(State(state.clone()), auth("u1"), Json(req)).await.unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        // open once -> count=1 -> exhausted, but chunk still allowed (in-flight stream)
        get(State(state.clone()), Path(id.clone())).await.unwrap();
        let resp = get_chunk(State(state.clone()), Path((id.clone(), 0u32))).await;
        assert!(resp.is_ok(), "chunk must be allowed after exhaustion");
        // revoke -> blocked
        revoke(State(state.clone()), auth("u1"), Path(id.clone())).await.unwrap();
        let res = get_chunk(State(state.clone()), Path((id.clone(), 0u32))).await;
        assert!(matches!(res, Err(ApiError::Forbidden)));
    }

    #[tokio::test]
    async fn ct_eq_hex_matches_and_differs() {
        assert!(ct_eq_hex("ab", "ab"));
        assert!(!ct_eq_hex("ab", "cd"));
        assert!(!ct_eq_hex("ab", "abc"));
        assert!(!ct_eq_hex("zz", "ab")); // non-hex -> false
    }

    #[tokio::test]
    async fn purge_removes_row_for_owner() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        purge(State(state.clone()), auth("u1"), Path(id.clone()))
            .await
            .unwrap();
        let (cnt,): (i32,) = sqlx::query_as("SELECT count(*) FROM shares WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(cnt, 0);
    }

    #[tokio::test]
    async fn purge_404_for_non_owner() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        seed_user(&state, "u2").await;
        seed_ready_file(&state, "f1", "u1").await;
        let res = create(State(state.clone()), auth("u1"), Json(create_req("f1")))
            .await
            .unwrap();
        let id = res.0["id"].as_str().unwrap().to_string();
        let err = purge(State(state.clone()), auth("u2"), Path(id))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn purge_404_for_missing() {
        let (state, _g) = shares_state().await;
        seed_user(&state, "u1").await;
        let err = purge(State(state.clone()), auth("u1"), Path("nope".into()))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }
}
