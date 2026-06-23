# Auth Implementation (Register / Login / Session) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tester able to register (by username), logout, login, reload the page without losing the session, and ride out access-token expiry via auto-refresh.

**Architecture:** Zero-trust: the server only ever stores an Argon2id hash of a client-derived `auth_verifier` and an AES-GCM-wrapped `master_key`. Sessions use short-lived JWT access tokens + rotating refresh tokens persisted in a `refresh_tokens` allowlist. The frontend derives all keys client-side and persists only the refresh token (localStorage) + device-wrapped master key (IndexedDB).

**Tech Stack:** Rust (axum 0.7, sqlx 0.8 SQLite, argon2 0.5, jsonwebtoken 9); Vue 3 + TS (pinia, libsodium-wrappers-sumo, WebCrypto, vitest).

## Global Constraints

- **Identity = username**, regex `^[a-z0-9_-]{3,32}$`, normalised via `trim().to_lowercase()`. **No `email` field anywhere** (code, DTOs, docs).
- **Server Argon2id** uses `argon2::Argon2::default()` (Argon2id, m=19456 KiB, t=2, p=1); output is a PHC string stored in `users.verifier_hash`.
- **SQL**: runtime `sqlx::query` / `sqlx::query_as` with `.bind()` only — **never** `sqlx::query!` macros (no `.sqlx` offline cache, no `DATABASE_URL` at compile time).
- **Refresh**: allowlist + rotation — every issued refresh token is hashed (SHA-256) into `refresh_tokens`; `/api/auth/refresh` revokes the old token and issues+p persists a new one.
- **Frontend tests**: stub `fetch` per-test via `vi.stubGlobal("fetch", vi.fn())` — **no msw** (it conflicts with happy-dom). `localforage` is already mocked in `src/__tests__/setup.ts`. libsodium WASM is warmed up in setup.
- **Do NOT remove** the `fixLibsodiumImport` plugin in `web/vite.config.ts` (production build + tests depend on it).
- **All needed Rust crates are already in `server/Cargo.toml`** (argon2, sha2, hex, uuid v4, chrono, base64). No dependency changes.
- **Linux commands** (this environment):
  - Backend check: `cargo check --manifest-path server/Cargo.toml`
  - Backend tests: `cargo test --manifest-path server/Cargo.toml`
  - Frontend tests: `npm test --prefix web`
  - Frontend typecheck: `npm run typecheck --prefix web`

**Spec:** `docs/superpowers/specs/2026-06-23-auth-implementation-design.md`

---

## Task 1: DB migration — rename `email` to `username`

**Files:**
- Create: `server/migrations/20260101000001_rename_email_to_username.sql`
- Modify: `server/src/db/mod.rs` (add a test assertion)

**Interfaces:** Produces `users.username` column (was `email`) for all later tasks.

- [ ] **Step 1: Create the migration file**

`server/migrations/20260101000001_rename_email_to_username.sql`:
```sql
-- Rename the identity column from email to username (P1 auth milestone).
-- SQLite >= 3.25 supports ALTER TABLE ... RENAME COLUMN; the UNIQUE constraint
-- is preserved across the rename. The index is rebuilt for naming clarity.
ALTER TABLE users RENAME COLUMN email TO username;
DROP INDEX idx_users_email;
CREATE INDEX idx_users_username ON users(username);
```

- [ ] **Step 2: Add a migration test asserting the `username` column exists**

In `server/src/db/mod.rs`, inside `mod tests`, add after the `migrate_creates_all_expected_tables` test body (before the closing `}` of that test):

```rust
        // P1: the email column was renamed to username.
        let col_names: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('users') ORDER BY cid",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let names: Vec<String> = col_names.into_iter().map(|r| r.0).collect();
        assert!(
            names.contains(&"username".to_string()),
            "users must have a `username` column; got {names:?}"
        );
        assert!(
            !names.contains(&"email".to_string()),
            "users must NOT have an `email` column; got {names:?}"
        );
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cargo test --manifest-path server/Cargo.toml db::tests::migrate_creates_all_expected_tables`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/20260101000001_rename_email_to_username.sql server/src/db/mod.rs
git commit -m "feat(db): rename users.email to users.username"
```

---

## Task 2: Server crypto module — Argon2id hashing + token hash

**Files:**
- Create: `server/src/crypto.rs`
- Modify: `server/src/main.rs:3-9` (add `mod crypto;`)

**Interfaces:**
- Produces: `crate::crypto::hash_verifier(auth_verifier_hex: &str, server_salt_hex: &str) -> anyhow::Result<String>` (PHC string)
- Produces: `crate::crypto::verify_verifier(auth_verifier_hex: &str, phc: &str) -> anyhow::Result<bool>`
- Produces: `crate::crypto::hash_refresh_token(token: &str) -> String` (SHA-256 hex)

- [ ] **Step 1: Register the module**

In `server/src/main.rs`, add `mod crypto;` to the module block (lines 3–9):
```rust
mod api;
mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod state;
mod storage;
```
> `mod models;` is added in Task 3, not here.

- [ ] **Step 2: Write the failing tests**

Create `server/src/crypto.rs` with only tests (implementation stubbed):
```rust
//! Server-side hashing primitives.
//!
//! The server never sees the user's password. It receives a client-derived
//! `auth_verifier` (itself an Argon2id output) and hashes it again with the
//! user's `server_salt` before storage. This adds a third Argon2id layer so
//! that a DB leak still requires per-candidate triple Argon2id to crack.

#[cfg(test)]
mod tests {
    use super::*;

    const SALT_HEX: &str = "00112233445566778899aabbccddeeff";
    const VERIFIER_HEX: &str =
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const ZERO_VERIFIER_HEX: &str =
        "0000000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn hash_and_verify_round_trip() {
        let phc = hash_verifier(VERIFIER_HEX, SALT_HEX).unwrap();
        assert!(verify_verifier(VERIFIER_HEX, &phc).unwrap());
    }

    #[test]
    fn verify_rejects_a_different_verifier() {
        let phc = hash_verifier(VERIFIER_HEX, SALT_HEX).unwrap();
        assert!(!verify_verifier(ZERO_VERIFIER_HEX, &phc).unwrap());
    }

    #[test]
    fn different_server_salt_yields_different_phc() {
        let other_salt = "ffeeddccbbaa99887766554433221100";
        let a = hash_verifier(VERIFIER_HEX, SALT_HEX).unwrap();
        let b = hash_verifier(VERIFIER_HEX, other_salt).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn hash_refresh_token_is_deterministic_distinct_and_hex() {
        let h1 = hash_refresh_token("token-abc");
        let h2 = hash_refresh_token("token-abc");
        assert_eq!(h1, h2);
        assert_ne!(h1, hash_refresh_token("token-xyz"));
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail to compile**

Run: `cargo test --manifest-path server/Cargo.toml crypto`
Expected: compile error (`cannot find function hash_verifier`).

- [ ] **Step 4: Implement the functions**

Add above the `#[cfg(test)]` block in `server/src/crypto.rs`:
```rust
use anyhow::{Context, Result};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use sha2::{Digest, Sha256};

/// Hash a client-derived `auth_verifier` (hex) with `server_salt` (hex) using
/// Argon2id (crate defaults: m=19456 KiB, t=2, p=1). Returns a PHC string that
/// embeds the salt and parameters.
pub fn hash_verifier(auth_verifier_hex: &str, server_salt_hex: &str) -> Result<String> {
    let verifier = hex::decode(auth_verifier_hex).context("auth_verifier is not valid hex")?;
    let salt_bytes = hex::decode(server_salt_hex).context("server_salt is not valid hex")?;
    let salt = SaltString::encode_b64(&salt_bytes).context("encoding server salt as b64")?;
    let phc = Argon2::default()
        .hash_password(&verifier, &salt)
        .context("argon2 hashing of auth_verifier failed")?;
    Ok(phc.to_string())
}

/// Verify a client-derived `auth_verifier` (hex) against a stored PHC string.
/// Reads parameters back out of the PHC, so the same default instance verifies
/// hashes it issued.
pub fn verify_verifier(auth_verifier_hex: &str, phc: &str) -> Result<bool> {
    let verifier = hex::decode(auth_verifier_hex).context("auth_verifier is not valid hex")?;
    let parsed = PasswordHash::new(phc).context("parsing stored verifier hash")?;
    Ok(Argon2::default().verify_password(&verifier, &parsed).is_ok())
}

/// SHA-256 hex of a refresh-token JWT, for the `refresh_tokens.token_hash` column.
pub fn hash_refresh_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml crypto`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/crypto.rs server/src/main.rs
git commit -m "feat(server): add Argon2id verifier hashing + refresh-token hash"
```

---

## Task 3: Server models + refresh-token allowlist persistence

**Files:**
- Create: `server/src/models.rs`
- Modify: `server/src/main.rs` (add `mod models;`)
- Modify: `server/src/auth/mod.rs` (add `persist_refresh_token`, `revoke_refresh_token`; add tests)

**Interfaces:**
- Produces: `crate::models::User` (`#[derive(sqlx::FromRow)]`, fields match `users` columns)
- Produces: `crate::auth::persist_refresh_token(state, user_id, device_id: Option<&str>, refresh_token: &str) -> AuthResult<()>`
- Produces: `crate::auth::revoke_refresh_token(state, token_hash: &str) -> AuthResult<()>`
- Consumes: `crate::crypto::hash_refresh_token`

> **Design note (refines spec §4.3):** `issue_token_pair` stays a pure synchronous JWT-signing function (existing tests untouched). Allowlist persistence is a *separate* async helper called by the handlers. This keeps the JWT unit tests DB-free.

- [ ] **Step 1: Create `models.rs`**

`server/src/models.rs`:
```rust
//! Database row models (sqlx::FromRow).

#[derive(Debug, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub kdf_salt: String,
    pub server_salt: String,
    pub verifier_hash: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub created_at: String,
    pub updated_at: String,
}
```

- [ ] **Step 2: Register `mod models;`**

In `server/src/main.rs`, add `mod models;` (so the module list is `api, auth, config, crypto, db, error, models, state, storage`).

- [ ] **Step 3: Write failing tests in `auth/mod.rs`**

In `server/src/auth/mod.rs`, the existing `#[cfg(test)] mod tests` already builds an in-memory state via `test_state()` using `sqlite::memory:` — but the allowlist needs a *migrated* file DB (in-memory pools don't share schema across connections). Add a new helper + tests at the end of `mod tests`:

```rust
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

    #[tokio::test]
    async fn persist_refresh_token_inserts_an_unrevoked_row() {
        let (state, _dir) = test_state_with_db().await;
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
```

- [ ] **Step 4: Run the tests to verify they fail to compile**

Run: `cargo test --manifest-path server/Cargo.toml auth::tests`
Expected: compile error (`cannot find function persist_refresh_token`).

- [ ] **Step 5: Implement the persistence helpers**

In `server/src/auth/mod.rs`, add after `verify_access_token` (before the `AuthUser` extractor) :

```rust
/// Persist a freshly-issued refresh token's SHA-256 hash into the allowlist.
pub async fn persist_refresh_token(
    state: &AppState,
    user_id: &str,
    device_id: Option<&str>,
    refresh_token: &str,
) -> AuthResult<()> {
    let hash = crate::crypto::hash_refresh_token(refresh_token);
    let id = uuid::Uuid::new_v4().to_string();
    let expires_at = (Utc::now() + Duration::seconds(state.settings.jwt.refresh_ttl_seconds))
        .to_rfc3339();
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
```

`Utc` and `Duration` are already imported at the top of `auth/mod.rs` (`use chrono::{Duration, Utc};`). `sqlx::query` is in scope via the existing `use` of sqlx types? No — add `use sqlx::Executor;` is unnecessary; `sqlx::query(...).execute(&pool)` works through sqlx's prelude. If the compiler complains, the existing `db/mod.rs` calls `sqlx::query(...).execute(pool)` without extra imports, so it resolves. Keep as-is.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml auth`
Expected: PASS (existing 8 + new 2).

- [ ] **Step 7: Commit**

```bash
git add server/src/models.rs server/src/main.rs server/src/auth/mod.rs
git commit -m "feat(server): add User model + refresh-token allowlist persistence"
```

---

## Task 4: `register` handler + username DTOs

**Files:**
- Modify: `server/src/api/auth.rs` (DTOs `email`→`username`, add `PreloginRequest`/`PreloginResponse`, implement `register`)

**Interfaces:**
- Produces: `register(State, Json<RegisterRequest>) -> ApiResult<Json<AuthResponse>>`
- Produces: DTOs with `username` field; `PreloginRequest`, `PreloginResponse`
- Consumes: `crate::crypto::hash_verifier`, `crate::auth::{issue_token_pair, persist_refresh_token}`, `crate::models::User`

- [ ] **Step 1: Rewrite the DTOs and imports at the top of `api/auth.rs`**

Replace lines 1–53 (the module doc + imports + DTOs) with:
```rust
//! Authentication endpoints.
//!
//! The server is zero-trust: it only ever sees a client-derived `auth_verifier`
//! (an Argon2id hash over the password-derived key) and the wrapped
//! `encrypted_master_key`. It never sees plaintext passwords, master keys,
//! or file keys.

use axum::extract::State;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::{issue_token_pair, persist_refresh_token, revoke_refresh_token, verify_access_token, TokenPair};
use crate::error::{ApiError, ApiResult};
use crate::models::User;
use crate::state::AppState;

/// `^[a-z0-9_-]{3,32}$`
fn is_valid_username(s: &str) -> bool {
    let len = s.len();
    (3..=32).contains(&len)
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn normalise_username(s: &str) -> String {
    s.trim().to_lowercase()
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    /// Argon2id-derived verifier of the password-derived key. Server hashes this
    /// again (Argon2id with server_salt) before storing.
    pub auth_verifier: String,
    /// Per-user salt used by the client for KDF (hex).
    pub kdf_salt: String,
    /// Server-side Argon2id salt for hashing `auth_verifier` (hex). Sent by client.
    pub server_salt: String,
    /// `master_key` wrapped by `password_key` (AES-256-GCM, base64).
    pub encrypted_master_key: String,
    /// nonce/iv for the wrapped master key (base64).
    pub encrypted_master_key_nonce: String,
}

#[derive(Debug, Deserialize)]
pub struct PreloginRequest {
    pub username: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub auth_verifier: String,
    /// Optional: name of the new device requesting login (unused in P1).
    pub device_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct PreloginResponse {
    pub kdf_salt: String,
    pub server_salt: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub user_id: String,
    pub username: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub kdf_salt: String,
    pub tokens: TokenPair,
}
```

- [ ] **Step 2: Replace the `register` handler body**

Replace the existing `register` fn (the one returning the placeholder) with:
```rust
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let username = normalise_username(&req.username);
    if !is_valid_username(&username) {
        return Err(ApiError::BadRequest(
            "username must be 3-32 chars of [a-z0-9_-]".into(),
        ));
    }
    tracing::info!(username = %username, "register request");

    let verifier_hash = crate::crypto::hash_verifier(&req.auth_verifier, &req.server_salt)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    let id = uuid::Uuid::new_v4().to_string();

    let insert = sqlx::query(
        "INSERT INTO users (id, username, kdf_salt, server_salt, verifier_hash, \
         encrypted_master_key, encrypted_master_key_nonce) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(&req.kdf_salt)
    .bind(&req.server_salt)
    .bind(&verifier_hash)
    .bind(&req.encrypted_master_key)
    .bind(&req.encrypted_master_key_nonce)
    .execute(&state.db)
    .await;

    match insert {
        Ok(_) => {}
        Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
            return Err(ApiError::Conflict("username already taken".into()));
        }
        Err(e) => return Err(e.into()),
    }

    let pair = issue_token_pair(&state, &id, None)?;
    persist_refresh_token(&state, &id, None, &pair.refresh_token).await?;

    Ok(Json(AuthResponse {
        user_id: id,
        username,
        encrypted_master_key: req.encrypted_master_key,
        encrypted_master_key_nonce: req.encrypted_master_key_nonce,
        kdf_salt: req.kdf_salt,
        tokens: pair,
    }))
}
```

Leave `login`, `refresh` as their existing placeholders for now (Tasks 6–7). **Delete** the `_ensure_used` dead-code helper at the bottom of the file (it referenced the old `issue_token_pair` to silence an unused import that is now genuinely used).

- [ ] **Step 3: Write failing handler tests**

Append a `#[cfg(test)] mod tests` block at the **end** of `server/src/api/auth.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use std::sync::Arc;

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

    fn req(username: &str) -> RegisterRequest {
        RegisterRequest {
            username: username.into(),
            auth_verifier: "ab".repeat(32), // 64 hex chars = 32 bytes
            kdf_salt: "cd".repeat(16),
            server_salt: "ef".repeat(16),
            encrypted_master_key: "enc".into(),
            encrypted_master_key_nonce: "nonce".into(),
        }
    }

    #[tokio::test]
    async fn register_returns_tokens_and_username() {
        let (state, _dir) = test_state_with_db().await;
        let res = register(State(state.clone()), Json(req("alice"))).await.unwrap();
        assert_eq!(res.0.username, "alice");
        assert!(!res.0.tokens.access_token.is_empty());
        assert!(!res.0.tokens.refresh_token.is_empty());
    }

    #[tokio::test]
    async fn register_rejects_duplicate_username() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), Json(req("alice"))).await.unwrap();
        match register(State(state.clone()), Json(req("Alice"))).await {
            Err(ApiError::Conflict(_)) => {}
            other => panic!("expected Conflict (409), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_rejects_invalid_username() {
        let (state, _dir) = test_state_with_db().await;
        for bad in ["ab", "a".repeat(33).as_str(), "With Space", "UPPER"] {
            match register(State(state.clone()), Json(req(bad))).await {
                Err(ApiError::BadRequest(_)) => {}
                other => panic!("username {bad:?}: expected BadRequest, got {other:?}"),
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml api::auth`
Expected: PASS (3 tests). (login/refresh still placeholders — compile only.)

- [ ] **Step 5: `cargo check` the whole crate**

Run: `cargo check --manifest-path server/Cargo.toml`
Expected: no errors. (There will be `unused import` warnings for `verify_access_token`, `revoke_refresh_token`, `User`, `Utc`, `PreloginRequest` until Tasks 5–7 use them; that is fine for now — do not add `#[allow]`.)

- [ ] **Step 6: Commit**

```bash
git add server/src/api/auth.rs
git commit -m "feat(server): implement register handler with username validation"
```

---

## Task 5: `prelogin` handler + route

**Files:**
- Modify: `server/src/api/auth.rs` (implement `prelogin`)
- Modify: `server/src/api/mod.rs:21` (add route)

**Interfaces:**
- Produces: `POST /api/auth/prelogin { username } -> { kdf_salt, server_salt }` (404 if unknown)

- [ ] **Step 1: Add the route**

In `server/src/api/mod.rs`, after the `login` route line, add:
```rust
        .route("/api/auth/prelogin", post(auth::prelogin))
```

- [ ] **Step 2: Implement `prelogin`**

In `server/src/api/auth.rs`, add after `register`:
```rust
pub async fn prelogin(
    State(state): State<AppState>,
    Json(req): Json<PreloginRequest>,
) -> ApiResult<Json<PreloginResponse>> {
    let username = normalise_username(&req.username);
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT kdf_salt, server_salt FROM users WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?;
    match row {
        Some((kdf_salt, server_salt)) => Ok(Json(PreloginResponse { kdf_salt, server_salt })),
        None => Err(ApiError::NotFound),
    }
}
```

- [ ] **Step 3: Write failing tests (add to `api/auth.rs`'s `mod tests`)**

```rust
    #[tokio::test]
    async fn prelogin_returns_salts_for_a_known_user() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), Json(req("alice"))).await.unwrap();
        let res = prelogin(
            State(state.clone()),
            Json(PreloginRequest { username: "ALICE ".into() }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.server_salt, "ef".repeat(16));
        assert_eq!(res.0.kdf_salt, "cd".repeat(16));
    }

    #[tokio::test]
    async fn prelogin_returns_not_found_for_unknown_user() {
        let (state, _dir) = test_state_with_db().await;
        match prelogin(
            State(state.clone()),
            Json(PreloginRequest { username: "ghost".into() }),
        )
        .await
        {
            Err(ApiError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml api::auth`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/api/auth.rs server/src/api/mod.rs
git commit -m "feat(server): add prelogin endpoint"
```

---

## Task 6: `login` handler

**Files:**
- Modify: `server/src/api/auth.rs` (implement `login`)

**Interfaces:**
- Produces: `login(State, Json<LoginRequest>) -> ApiResult<Json<AuthResponse>>`

- [ ] **Step 1: Implement `login`**

Replace the placeholder `login` fn with:
```rust
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let username = normalise_username(&req.username);
    tracing::info!(username = %username, "login request");

    // Don't distinguish "no such user" from "wrong password" in the response.
    let user: User = sqlx::query_as::<_, User>(
        "SELECT id, username, kdf_salt, server_salt, verifier_hash, \
         encrypted_master_key, encrypted_master_key_nonce, created_at, updated_at \
         FROM users WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::Unauthorized)?;

    let ok = crate::crypto::verify_verifier(&req.auth_verifier, &user.verifier_hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    if !ok {
        return Err(ApiError::Unauthorized);
    }

    let pair = issue_token_pair(&state, &user.id, None)?;
    persist_refresh_token(&state, &user.id, None, &pair.refresh_token).await?;

    Ok(Json(AuthResponse {
        user_id: user.id,
        username: user.username,
        encrypted_master_key: user.encrypted_master_key,
        encrypted_master_key_nonce: user.encrypted_master_key_nonce,
        kdf_salt: user.kdf_salt,
        tokens: pair,
    }))
}
```

- [ ] **Step 2: Write failing tests (add to `mod tests`)**

```rust
    fn login_req(username: &str, verifier_hex: &str) -> LoginRequest {
        LoginRequest {
            username: username.into(),
            auth_verifier: verifier_hex.into(),
            device_name: None,
        }
    }

    #[tokio::test]
    async fn login_succeeds_with_the_registered_verifier() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), Json(req("alice"))).await.unwrap();
        let res = login(
            State(state.clone()),
            Json(login_req("alice", &"ab".repeat(32))),
        )
        .await
        .unwrap();
        assert_eq!(res.0.username, "alice");
        assert!(!res.0.tokens.refresh_token.is_empty());
    }

    #[tokio::test]
    async fn login_rejects_a_wrong_verifier() {
        let (state, _dir) = test_state_with_db().await;
        register(State(state.clone()), Json(req("alice"))).await.unwrap();
        match login(
            State(state.clone()),
            Json(login_req("alice", &"00".repeat(32))),
        )
        .await
        {
            Err(ApiError::Unauthorized) => {}
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn login_rejects_an_unknown_user() {
        let (state, _dir) = test_state_with_db().await;
        assert!(matches!(
            login(
                State(state.clone()),
                Json(login_req("ghost", &"ab".repeat(32))),
            )
            .await,
            Err(ApiError::Unauthorized)
        ));
    }
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml api::auth`
Expected: PASS (8 tests).

- [ ] **Step 4: Commit**

```bash
git add server/src/api/auth.rs
git commit -m "feat(server): implement login handler"
```

---

## Task 7: `refresh` handler with rotation

**Files:**
- Modify: `server/src/api/auth.rs` (implement `refresh`)

**Interfaces:**
- Produces: `refresh(State, Json<RefreshRequest>) -> ApiResult<Json<TokenPair>>`

- [ ] **Step 1: Implement `refresh`**

Replace the placeholder `refresh` fn with:
```rust
pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> ApiResult<Json<TokenPair>> {
    let claims = verify_access_token(&state, &req.refresh_token)?;
    let hash = crate::crypto::hash_refresh_token(&req.refresh_token);

    let active: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM refresh_tokens \
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(&hash)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(&state.db)
    .await?;
    if active.is_none() {
        return Err(ApiError::Unauthorized);
    }

    revoke_refresh_token(&state, &hash).await?;
    let pair = issue_token_pair(&state, &claims.sub, claims.dev.as_deref())?;
    persist_refresh_token(&state, &claims.sub, claims.dev.as_deref(), &pair.refresh_token)
        .await?;
    Ok(Json(pair))
}
```

- [ ] **Step 2: Write failing tests (add to `mod tests`)**

```rust
    async fn register_tokens(state: &AppState, username: &str) -> TokenPair {
        let res = register(State(state.clone()), Json(req(username))).await.unwrap();
        res.0.tokens
    }

    #[tokio::test]
    async fn refresh_issues_a_new_pair_and_revokes_the_old_token() {
        let (state, _dir) = test_state_with_db().await;
        let pair = register_tokens(&state, "alice").await;

        let new_pair = refresh(
            State(state.clone()),
            Json(RefreshRequest { refresh_token: pair.refresh_token.clone() }),
        )
        .await
        .unwrap();
        assert_ne!(new_pair.0.refresh_token, pair.refresh_token);
        assert_ne!(new_pair.0.access_token, pair.access_token);
    }

    #[tokio::test]
    async fn refresh_rejects_a_replayed_old_token() {
        let (state, _dir) = test_state_with_db().await;
        let pair = register_tokens(&state, "alice").await;
        let old = pair.refresh_token.clone();
        refresh(
            State(state.clone()),
            Json(RefreshRequest { refresh_token: old.clone() }),
        )
        .await
        .unwrap();
        match refresh(
            State(state.clone()),
            Json(RefreshRequest { refresh_token: old }),
        )
        .await
        {
            Err(ApiError::Unauthorized) => {}
            other => panic!("expected Unauthorized on replay, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refresh_rejects_a_garbage_token() {
        let (state, _dir) = test_state_with_db().await;
        assert!(matches!(
            refresh(
                State(state.clone()),
                Json(RefreshRequest { refresh_token: "not.a.jwt".into() }),
            )
            .await,
            Err(ApiError::Unauthorized)
        ));
    }
```

- [ ] **Step 3: Run the full backend test suite**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: all PASS (auth/mod + api/auth + crypto + db + config + error).

- [ ] **Step 4: `cargo check`**

Run: `cargo check --manifest-path server/Cargo.toml`
Expected: no errors, no unused-import warnings (all imports now used).

- [ ] **Step 5: Commit**

```bash
git add server/src/api/auth.rs
git commit -m "feat(server): implement refresh with token rotation"
```

---

## Task 8: Frontend crypto — rename `email` → `username`

**Files:**
- Modify: `web/src/crypto/kdf.ts`
- Modify: `web/src/crypto/keys.ts`
- Modify: `web/src/crypto/kdf.test.ts`
- Modify: `web/src/crypto/keys.test.ts`

**Interfaces:**
- Produces: `normaliseUsername`, `usernameToSalt` (renamed); `derivePasswordKey(password, username)`; `wrapWithPassword(master, password, username)`; `unwrapWithPassword(wrapped, password, username)`

- [ ] **Step 1: Rename functions + params in `kdf.ts`**

In `web/src/crypto/kdf.ts`:
- Module doc comment: replace "the email" → "the username" and "from the email" → "from the username" (lines 5–7).
- Replace the `normaliseEmail` fn (lines 25–28) with:
```ts
/** Normalise a username for use as KDF salt source (lowercased, trimmed). */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}
```
- Replace `emailToSalt` (lines 30–37) with:
```ts
/** Derive a deterministic Argon2id salt (16 bytes) from the username. */
export async function usernameToSalt(username: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normaliseUsername(username)) as BufferSource,
  );
  return new Uint8Array(hash).slice(0, 16);
}
```
- Replace the `derivePasswordKey` signature + body's salt call (lines 39–57). Change the second parameter name `email` → `username` and the internal `emailToSalt(email)` → `usernameToSalt(username)`:
```ts
/** Derive the user's `password_key` (32 bytes) from password + username. */
export async function derivePasswordKey(
  password: string,
  username: string,
): Promise<RawKey> {
  assertCryptoReady();
  const salt = await usernameToSalt(username);
  const fullSalt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES);
  fullSalt.set(salt);
  return sodium.crypto_pwhash(
    KEY_BYTES,
    password,
    fullSalt,
    ARGON2_TIME_COST,
    ARGON2_MEMORY_KIB,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}
```

- [ ] **Step 2: Rename in `keys.ts`**

In `web/src/crypto/keys.ts`:
- Line 7 comment: "Argon2id(password, email)" → "Argon2id(password, username)".
- `wrapWithPassword` (lines 82–90): rename param `email` → `username` and pass it through:
```ts
export async function wrapWithPassword(
  masterKey: RawKey,
  password: string,
  username: string,
): Promise<WrappedKey> {
  const passwordKey = await derivePasswordKey(password, username);
  return wrapMasterKey(masterKey, passwordKey);
}
```
- `unwrapWithPassword` (lines 92–100): same rename:
```ts
export async function unwrapWithPassword(
  wrapped: WrappedKey,
  password: string,
  username: string,
): Promise<RawKey> {
  const passwordKey = await derivePasswordKey(password, username);
  return unwrapMasterKey(wrapped, passwordKey);
}
```

- [ ] **Step 3: Update `kdf.test.ts`**

In `web/src/crypto/kdf.test.ts`:
- Imports (lines 5–13): replace `normaliseEmail, emailToSalt` → `normaliseUsername, usernameToSalt`.
- Rename the two `describe` blocks (lines 15, 25) to `"normaliseUsername"` and `"usernameToSalt"`.
- In `normaliseUsername` tests use a username string:
```ts
  it("trims and lowercases", () => {
    expect(normaliseUsername("  Alice ")).toBe("alice");
  });
  it("is idempotent", () => {
    const once = normaliseUsername("Bob");
    expect(normaliseUsername(once)).toBe(once);
  });
```
- In `usernameToSalt` tests replace `"foo@bar.com"` / `"baz@bar.com"` with `"alice"` / `"bob"`:
```ts
describe("usernameToSalt", () => {
  it("is deterministic", async () => {
    expect(Array.from(await usernameToSalt("alice"))).toEqual(
      Array.from(await usernameToSalt("alice")),
    );
  });
  it("produces 16 bytes", async () => {
    expect((await usernameToSalt("alice")).length).toBe(16);
  });
  it("differs for different usernames", async () => {
    expect(Array.from(await usernameToSalt("alice"))).not.toEqual(
      Array.from(await usernameToSalt("bob")),
    );
  });
});
```
- In `derivePasswordKey` tests replace the second arg `"foo@bar.com"`/`"baz@bar.com"` with `"alice"`/`"bob"` (and update the "differs for different emails" test name → `"differs for different usernames"`):
```ts
  it("differs for different usernames", async () => {
    expect(Array.from(await derivePasswordKey("pw", "alice"))).not.toEqual(
      Array.from(await derivePasswordKey("pw", "bob")),
    );
  });
```

- [ ] **Step 4: Update `keys.test.ts`**

In `web/src/crypto/keys.test.ts`, in the `wrapWithPassword / unwrapWithPassword` block (lines 78–97), replace the third argument `"u@x.com"` with `"alice"` (3 occurrences):
```ts
  it("round-trip", async () => {
    const master = generateMasterKey();
    const wrapped = await wrapWithPassword(master, "correct horse", "alice");
    expect(
      Array.from(await unwrapWithPassword(wrapped, "correct horse", "alice")),
    ).toEqual(Array.from(master));
  });

  it("throws with the wrong password", async () => {
    const wrapped = await wrapWithPassword(
      generateMasterKey(),
      "right",
      "alice",
    );
    await expect(
      unwrapWithPassword(wrapped, "wrong", "alice"),
    ).rejects.toThrow();
  });
```

- [ ] **Step 5: Run the frontend crypto tests**

Run: `npm test --prefix web -- kdf keys`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/crypto/kdf.ts web/src/crypto/keys.ts web/src/crypto/kdf.test.ts web/src/crypto/keys.test.ts
git commit -m "refactor(web): rename email→username in crypto KDF"
```

---

## Task 9: Frontend API types + auth wrapper (+ `prelogin`)

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/auth.ts`

**Interfaces:**
- Produces: `PreloginResponse` type; `authApi.prelogin(username)`; all DTOs use `username`.

- [ ] **Step 1: Update `types.ts`**

In `web/src/api/types.ts`:
- `AuthResponse` (lines 13–20): replace `email: string;` with `username: string;`.
- `RegisterRequest` (lines 22–29): replace `email: string;` with `username: string;`.
- `LoginRequest` (lines 31–35): replace `email: string;` with `username: string;`.
- Add a new type after `LoginRequest`:
```ts
export interface PreloginResponse {
  kdf_salt: string; // hex
  server_salt: string; // hex
}
```

- [ ] **Step 2: Update `auth.ts`**

Replace the whole contents of `web/src/api/auth.ts` with:
```ts
import { http } from "./client";
import type {
  AuthResponse,
  LoginRequest,
  PreloginResponse,
  RegisterRequest,
  TokenPair,
} from "./types";

export const authApi = {
  register: (body: RegisterRequest) =>
    http.post<AuthResponse>("/api/auth/register", body),

  prelogin: (username: string) =>
    http.post<PreloginResponse>("/api/auth/prelogin", { username }),

  login: (body: LoginRequest) =>
    http.post<AuthResponse>("/api/auth/login", body),

  refresh: (refreshToken: string) =>
    http.post<TokenPair>("/api/auth/refresh", { refresh_token: refreshToken }),
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: errors only inside `stores/auth.ts` and the two views (they still reference `email`/`normaliseEmail` — fixed in Tasks 11–12). If errors appear *only* in those three files, proceed; otherwise fix.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/types.ts web/src/api/auth.ts
git commit -m "feat(web): username DTOs + prelogin API wrapper"
```

---

## Task 10: Frontend HTTP client — token persistence + 401 auto-refresh

**Files:**
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/client.test.ts`

**Interfaces:**
- Produces: `setRefreshToken`, `getRefreshToken`, `clearRefreshToken`, `loadStoredRefreshToken`
- Produces: `request()` auto-refreshs once on 401 (deduplicating concurrent refreshes) and replays the original request.

- [ ] **Step 1: Add refresh-token storage + refresh logic to `client.ts`**

In `web/src/api/client.ts`, replace lines 31–41 (the `BASE`/`authToken`/`setAuthToken`/`getAuthToken` block) with:
```ts
const BASE = ""; // Same-origin in production; Vite proxy in development.

const REFRESH_KEY = "df_refresh_token";

let authToken: string | null = null;
let refreshToken: string | null = null;
let inflightRefresh: Promise<boolean> | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export function setRefreshToken(token: string | null): void {
  refreshToken = token;
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function clearRefreshToken(): void {
  setRefreshToken(null);
}

/** Load a persisted refresh token from localStorage into module state. */
export function loadStoredRefreshToken(): string | null {
  refreshToken = localStorage.getItem(REFRESH_KEY);
  return refreshToken;
}

/**
 * Exchange the current refresh token for a new pair. Uses a raw fetch (not
 * `request`) so it bypasses the 401 interceptor. Concurrent callers share one
 * in-flight promise. Returns false if there is no token or the refresh failed.
 */
async function refreshAndRetry(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  const rt = refreshToken;
  if (!rt) return false;
  inflightRefresh = (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
      const pair = (await res.json()) as { access_token: string; refresh_token: string };
      setAuthToken(pair.access_token);
      setRefreshToken(pair.refresh_token);
      return true;
    } catch {
      clearRefreshToken();
      setAuthToken(null);
      return false;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}
```

- [ ] **Step 2: Make `request()` auto-refresh on 401**

In `web/src/api/client.ts`, replace the existing `request` function (lines 43–92) with:
```ts
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    rawBody,
    rawResponse,
    token, // undefined => use current authToken (re-read on replay)
    headers = {},
    signal,
  } = opts;

  const buildInit = (): RequestInit => {
    const effectiveToken = token !== undefined ? token : authToken;
    const finalHeaders: Record<string, string> = { ...headers };
    if (effectiveToken) finalHeaders.Authorization = `Bearer ${effectiveToken}`;
    if (body !== undefined && !rawBody) finalHeaders["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers: finalHeaders, signal };
    if (rawBody !== undefined) init.body = rawBody;
    else if (body !== undefined) init.body = JSON.stringify(body);
    return init;
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, buildInit());
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`, 0);
  }

  // Auto-refresh once on 401 (never on the refresh endpoint itself), then
  // replay the original request so the caller sees a success or a real error.
  if (
    res.status === 401 &&
    !path.startsWith("/api/auth/refresh") &&
    token === undefined &&
    getRefreshToken()
  ) {
    const ok = await refreshAndRetry();
    if (ok) {
      try {
        res = await fetch(`${BASE}${path}`, buildInit());
      } catch (e) {
        throw new ApiError(`Network error: ${(e as Error).message}`, 0);
      }
    }
  }

  if (res.status === 204) return undefined as T;

  if (rawResponse) {
    if (!res.ok) throw new ApiError(res.statusText, res.status);
    return res as unknown as T;
  }

  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText) || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }

  return parsed as T;
}
```

> `token === undefined` guards the refresh path: if a caller explicitly passed `token: null`/`token: "..."` we don't auto-refresh. `RequestOptions.token` type stays `string | null` (undefined means "default").

- [ ] **Step 3: Add tests**

In `web/src/api/client.test.ts`, update the imports (lines 3–9) to include the new accessors:
```ts
import {
  request,
  setAuthToken,
  getAuthToken,
  setRefreshToken,
  getRefreshToken,
  clearRefreshToken,
  ApiError,
  http as httpApi,
} from "./client";
```
Update the existing `beforeEach` (line 16–20) to also reset refresh state:
```ts
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  clearRefreshToken();
  localStorage.clear();
});
```
Append two new `describe` blocks at the end of the file:
```ts
describe("refresh-token storage", () => {
  it("persists to localStorage and reads back", () => {
    setRefreshToken("rt-1");
    expect(getRefreshToken()).toBe("rt-1");
    expect(localStorage.getItem("df_refresh_token")).toBe("rt-1");
  });
  it("clears from both memory and localStorage", () => {
    setRefreshToken("rt-1");
    clearRefreshToken();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem("df_refresh_token")).toBeNull();
  });
});

describe("401 auto-refresh", () => {
  it("refreshes once and replays the request on 401", async () => {
    setRefreshToken("old-refresh");
    setAuthToken("old-access");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }),
          { status: 200 },
        );
      }
      // guarded endpoint: first call 401, replay 200
      const guardedCalls = fetchMock.mock.calls.filter(
        (c) => !(c[0] as string).endsWith("/api/auth/refresh"),
      ).length;
      if (guardedCalls === 1) {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await request<{ ok: boolean }>("/api/files");
    expect(res).toEqual({ ok: true });
    expect(getAuthToken()).toBe("new-access");
    expect(getRefreshToken()).toBe("new-refresh");
  });

  it("clears the refresh token when refresh itself fails", async () => {
    setRefreshToken("bad");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    });
    await expect(request("/api/x")).rejects.toThrow();
    expect(getRefreshToken()).toBeNull();
  });

  it("deduplicates concurrent 401s to a single refresh", async () => {
    setRefreshToken("r");
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        return new Response(
          JSON.stringify({ access_token: "a", refresh_token: "r2" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await Promise.all([request("/api/x"), request("/api/y")]);
    expect(refreshCalls).toBe(1);
  });
});
```

- [ ] **Step 4: Run the client tests**

Run: `npm test --prefix web -- client`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts
git commit -m "feat(web): persist refresh token + 401 auto-refresh interceptor"
```

---

## Task 11: Frontend auth store — `login`, session restore, username register

**Files:**
- Modify: `web/src/stores/auth.ts`
- Create: `web/src/stores/auth.test.ts`

**Interfaces:**
- Produces: `login({ username, password })`, `register({ username, password })`, `tryRestoreSession()` (now JWT-backed), `logout()` clears refresh token.

- [ ] **Step 1: Rewrite `stores/auth.ts`**

Replace the entire contents of `web/src/stores/auth.ts` with:
```ts
/**
 * Auth store: holds the decrypted `master_key` in memory (never persisted)
 * and manages login / register / device-restore flows.
 */

import { defineStore } from "pinia";
import { ref } from "vue";

import { authApi } from "@/api/auth";
import {
  setAuthToken,
  setRefreshToken,
  clearRefreshToken,
  loadStoredRefreshToken,
  getRefreshToken,
} from "@/api/client";
import type { TokenPair } from "@/api/types";
import {
  deriveAuthVerifier,
  derivePasswordKey,
  normaliseUsername,
  randomBytes,
  usernameToSalt,
  type RawKey,
} from "@/crypto/kdf";
import {
  clearDeviceWrap,
  generateMasterKey,
  getOrCreateDeviceKey,
  loadDeviceWrap,
  persistDeviceWrap,
  unwrapMasterKey,
  wrapMasterKey,
} from "@/crypto/keys";
import { ensureCryptoReady } from "@/workers/crypto";

export const useAuthStore = defineStore("auth", () => {
  const isAuthenticated = ref(false);
  const userId = ref<string | null>(null);
  const username = ref<string | null>(null);
  const masterKey = ref<RawKey | null>(null);
  const isRestoring = ref(true);

  function setSession(
    info: { user_id: string; username: string },
    key: RawKey,
    tokens: TokenPair,
  ) {
    userId.value = info.user_id;
    username.value = info.username;
    masterKey.value = key;
    setAuthToken(tokens.access_token);
    setRefreshToken(tokens.refresh_token);
    isAuthenticated.value = true;
  }

  async function tryRestoreSession(): Promise<void> {
    try {
      await ensureCryptoReady();
      loadStoredRefreshToken();

      // Restore master_key from device wrap (if present).
      const stored = await loadDeviceWrap();
      if (stored) {
        const deviceKey = await getOrCreateDeviceKey();
        masterKey.value = await unwrapMasterKey(stored.wrap, deviceKey);
        userId.value = stored.userId;
      }

      // Obtain a fresh access token via the refresh endpoint.
      const rt = getRefreshToken();
      if (rt) {
        const pair = await authApi.refresh(rt);
        setAuthToken(pair.access_token);
        setRefreshToken(pair.refresh_token);
        isAuthenticated.value = true;
      }
    } catch (e) {
      console.warn("Failed to restore session:", e);
      clearRefreshToken();
      setAuthToken(null);
    } finally {
      isRestoring.value = false;
    }
  }

  async function register(p: { username: string; password: string }): Promise<void> {
    await ensureCryptoReady();
    const normalised = normaliseUsername(p.username);

    const passwordKey = await derivePasswordKey(p.password, normalised);
    const serverSalt = randomBytes(16);
    const authVerifier = deriveAuthVerifier(passwordKey, serverSalt);

    const master = generateMasterKey();
    const { ciphertext, iv } = await wrapMasterKey(master, passwordKey);

    // Pre-create a device wrap so the user is immediately logged-in on
    // this device without re-entering the password.
    const deviceKey = await getOrCreateDeviceKey();
    const deviceWrap = await wrapMasterKey(master, deviceKey);

    const res = await authApi.register({
      username: normalised,
      auth_verifier: toHex(authVerifier),
      kdf_salt: toHex(await usernameToSalt(normalised)),
      server_salt: toHex(serverSalt),
      encrypted_master_key: toBase64(ciphertext),
      encrypted_master_key_nonce: toBase64(iv),
    });

    await persistDeviceWrap(res.user_id, deviceWrap);
    setSession(res, master, res.tokens);
  }

  async function login(p: { username: string; password: string }): Promise<void> {
    await ensureCryptoReady();
    const normalised = normaliseUsername(p.username);

    const pre = await authApi.prelogin(normalised);
    const passwordKey = await derivePasswordKey(p.password, normalised);
    const authVerifier = deriveAuthVerifier(passwordKey, fromHex(pre.server_salt));

    const res = await authApi.login({
      username: normalised,
      auth_verifier: toHex(authVerifier),
    });

    const master = await unwrapMasterKey(
      {
        ciphertext: fromBase64(res.encrypted_master_key),
        iv: fromBase64(res.encrypted_master_key_nonce),
      },
      passwordKey,
    );

    const deviceKey = await getOrCreateDeviceKey();
    const deviceWrap = await wrapMasterKey(master, deviceKey);
    await persistDeviceWrap(res.user_id, deviceWrap);

    setSession(res, master, res.tokens);
  }

  async function logout(): Promise<void> {
    setAuthToken(null);
    clearRefreshToken();
    isAuthenticated.value = false;
    userId.value = null;
    username.value = null;
    masterKey.value = null;
    await clearDeviceWrap();
  }

  return {
    isAuthenticated,
    userId,
    username,
    masterKey,
    isRestoring,
    tryRestoreSession,
    register,
    login,
    logout,
  };
});

// --- encoding helpers (kept local to avoid a separate util import) -------

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
```

- [ ] **Step 2: Write a focused store test**

Create `web/src/stores/auth.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the crypto + worker deps so the test exercises store orchestration
// (prelogin → derive → login → unwrap → persist → setSession), not real Argon2.
vi.mock("@/crypto/kdf", () => ({
  normaliseUsername: (s: string) => s.trim().toLowerCase(),
  derivePasswordKey: vi.fn(async () => new Uint8Array(32)),
  deriveAuthVerifier: vi.fn(() => new Uint8Array(32)),
  usernameToSalt: vi.fn(async () => new Uint8Array(16)),
  randomBytes: vi.fn(() => new Uint8Array(16)),
}));
vi.mock("@/crypto/keys", () => ({
  generateMasterKey: () => new Uint8Array(32),
  wrapMasterKey: vi.fn(async () => ({
    ciphertext: new Uint8Array(8),
    iv: new Uint8Array(12),
  })),
  unwrapMasterKey: vi.fn(async () => new Uint8Array(32)),
  getOrCreateDeviceKey: vi.fn(async () => new Uint8Array(32)),
  persistDeviceWrap: vi.fn(async () => {}),
  loadDeviceWrap: vi.fn(async () => null),
  clearDeviceWrap: vi.fn(async () => {}),
}));
vi.mock("@/workers/crypto", () => ({ ensureCryptoReady: vi.fn(async () => {}) }));

import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "./auth";
import { setAuthToken, getRefreshToken } from "@/api/client";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("calls prelogin then login and sets the session", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/api/auth/prelogin")) {
        return new Response(JSON.stringify({ kdf_salt: "ab", server_salt: "cd" }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/auth/login")) {
        return new Response(
          JSON.stringify({
            user_id: "u1",
            username: "alice",
            encrypted_master_key: "eA==",
            encrypted_master_key_nonce: "bm9uY2U=",
            kdf_salt: "ab",
            tokens: {
              access_token: "AT",
              refresh_token: "RT",
              expires_in: 900,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const auth = useAuthStore();
    await auth.login({ username: "Alice", password: "pw" });

    expect(auth.isAuthenticated).toBe(true);
    expect(auth.username).toBe("alice");
    expect(getRefreshToken()).toBe("RT");
    expect(calls.some((u) => u.endsWith("/api/auth/prelogin"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/api/auth/login"))).toBe(true);
  });

  it("leaves the session unset when login fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/prelogin")) {
        return new Response(JSON.stringify({ kdf_salt: "ab", server_salt: "cd" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "bad credentials" }), { status: 401 });
    });
    const auth = useAuthStore();
    await expect(auth.login({ username: "alice", password: "bad" })).rejects.toThrow();
    expect(auth.isAuthenticated).toBe(false);
  });
});
```

- [ ] **Step 3: Run the store tests**

Run: `npm test --prefix web -- stores/auth`
Expected: PASS (2 tests).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: no errors except possibly in `LoginView.vue` / `RegisterView.vue` (fixed in Task 12).

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/auth.ts web/src/stores/auth.test.ts
git commit -m "feat(web): implement login, session restore, username register"
```

---

## Task 12: Frontend views (username inputs) + docs

**Files:**
- Modify: `web/src/views/RegisterView.vue`
- Modify: `web/src/views/LoginView.vue`
- Modify: `docs/api.md`
- Modify: `docs/crypto-design.md`

**Interfaces:** UI uses username; docs match the implemented contract.

- [ ] **Step 1: `RegisterView.vue` — username input**

In `web/src/views/RegisterView.vue`:
- Line 9: `const email = ref("");` → `const username = ref("");`
- Line 23: `await auth.register({ email: email.value, password: password.value });` → `await auth.register({ username: username.value, password: password.value });`
- Lines 43–46 (the Email label + input):
```html
        <label>
          Username
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            pattern="[a-z0-9_-]{3,32}"
            title="3-32 chars: lowercase letters, digits, underscore, hyphen"
            required
            :disabled="loading"
          />
        </label>
```

- [ ] **Step 2: `LoginView.vue` — username input**

In `web/src/views/LoginView.vue`:
- Line 9: `const email = ref("");` → `const username = ref("");`
- Line 18: `await auth.login({ email: email.value, password: password.value });` → `await auth.login({ username: username.value, password: password.value });`
- Lines 37–46 (the Email label + input):
```html
        <label>
          Username
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            required
            :disabled="loading"
          />
        </label>
```

- [ ] **Step 3: `docs/api.md` — identity + prelogin section**

In `docs/api.md`:
- In the `### POST /api/auth/register` request body (lines 14–22), change `"email": "user@example.com"` → `"username": "alice"` and add the `device_name`-less shape. Update the 200 response (lines 27–38): change `"email": "user@example.com"` → `"username": "alice"`.
- In `### POST /api/auth/login` (lines 41–47), change `{ "email": "...", "auth_verifier": "<hex>", "device_name": "laptop" }` → `{ "username": "alice", "auth_verifier": "<hex>", "device_name": "laptop" }`.
- Insert a new subsection **after** the login section and **before** `### POST /api/auth/refresh`:
```markdown
### `POST /api/auth/prelogin`

```json
{ "username": "alice" }
```

Response `200`:
```json
{ "kdf_salt": "<hex>", "server_salt": "<hex>" }
```

Returns `404` if the username is unknown. The client uses `server_salt` to
derive `auth_verifier` before calling `/login`.
```
- In the Status codes table (line 167), the `409 Conflict` row example `email already registered` → `username already taken`.

- [ ] **Step 4: `docs/crypto-design.md` — username-derived salt**

In `docs/crypto-design.md`:
- Line 14: `│   salt = first 16B of SHA-256(normalised_email)` → `│   salt = first 16B of SHA-256(normalised_username)`.
- Line 8 (the `password` comment) is fine; leave it.
- `## Crypto libraries` and constants are unchanged.

- [ ] **Step 5: Typecheck + build the frontend**

Run: `npm run typecheck --prefix web`
Expected: PASS (no errors).
Run: `npm run build --prefix web`
Expected: build succeeds (the `fixLibsodiumImport` plugin handles libsodium).

- [ ] **Step 6: Commit**

```bash
git add web/src/views/RegisterView.vue web/src/views/LoginView.vue docs/api.md docs/crypto-design.md
git commit -m "feat(web): username inputs; update auth docs for username + prelogin"
```

---

## Task 13: Full verification + manual acceptance

**Files:** none (verification only; commit only if fixes are needed).

- [ ] **Step 1: Full backend test + check**

Run: `cargo test --manifest-path server/Cargo.toml && cargo check --manifest-path server/Cargo.toml`
Expected: all tests PASS; check clean.

- [ ] **Step 2: Full frontend test + typecheck**

Run: `npm test --prefix web && npm run typecheck --prefix web`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 3: Grep audit — no `email` identity remains**

Run: `rg -n "email" server/src web/src docs/api.md docs/crypto-design.md`
Expected: only matches in `api/assets.rs`/frontend asset handling if any (unrelated), or none. Any auth-related `email` reference is a bug — fix it.

- [ ] **Step 4: Manual end-to-end**

1. Start backend: `cargo run --manifest-path server/Cargo.toml`
2. In another shell, start frontend: `npm run dev --prefix web`
3. Open `http://127.0.0.1:5173/#/register`, create account `alice` / `password`.
4. Confirm redirect to `/drive`.
5. Logout, then login as `alice`.
6. Reload the tab — should stay on `/drive` (refresh-token restore works).
7. (Optional) Temporarily set `DRAGONFOX__JWT__ACCESS_TTL_SECONDS=5` and restart the backend; confirm a `/drive` request ~10s after login still succeeds via auto-refresh.
8. Logout — `localStorage.df_refresh_token` is gone and IndexedDB `device_wrap` is cleared.

- [ ] **Step 5: Final commit (only if Step 3 surfaced fixes)**

If the grep audit or manual test required fixes, commit them. Otherwise this task has no commit.

---

## Notes for the implementer

- **Task 4 leaves unused-import warnings** for `verify_access_token`, `revoke_refresh_token`, `User`, `Utc`, `PreloginRequest` until Tasks 5–7 consume them. This is expected; do not paper over them with `#[allow(dead_code)]`.
- **`sqlx::query_as::<_, User>`** requires selecting every `User` column in order (the `SELECT` in `login` lists all 9 columns explicitly for this reason).
- **SQLite unique detection** uses `db_err.is_unique_violation()` (sqlx 0.8 trait method) rather than fragile string/code matching.
- **Refresh-token expiry** is compared as RFC-3339 strings (`expires_at > ?`); ISO-8601 sorts lexicographically, which is correct for the same-format UTC strings produced by `Utc::now().to_rfc3339()`.
- **`tryRestoreSession`** intentionally restores `master_key` and the JWT independently: a missing `device_wrap` still lets the user authenticate, and a missing refresh token still unlocks the master key (but the router guard then bounces to `/login`).
