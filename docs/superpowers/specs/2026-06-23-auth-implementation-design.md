# Auth Implementation (Register / Login / Session) — Design Spec

- **Date**: 2026-06-23
- **Status**: Approved (pre-implementation)
- **Scope**: Backend `server/` (Rust) + Frontend `web/` (Vue 3 + TS)
- **Approach**: Full session (register + login + page-refresh survival + auto
  refresh) with refresh-token **allowlist + rotation** (approach B)
- **Identifier change**: login identity is **username**, not email

---

## 1. Goal

Make a tester able to: **register → logout → login → refresh the page without
losing the session → ride out access-token expiry via auto-refresh → logout**,
so the rest of the app (drive view) can be exercised manually.

### In scope
- Backend: `register`, `prelogin`, `login`, `refresh` handlers; server-side
  Argon2id hashing; refresh-token allowlist with rotation.
- Frontend: working `login()`; token persistence; 401 auto-refresh interceptor;
  session restore on page load.
- Rename of the identity column/field across the whole stack: `email` →
  `username`.

### Out of scope (YAGNI, deferred)
- `devices` table writes / cross-device sync — `device_wrap` stays in
  IndexedDB only (no server upload). Device add/revoke UI is P2/P3.
- Prelogin account-enumeration hardening — a non-existent username returns 404
  in P1 (no fake-salt smokescreen).
- Refresh-token reuse detection (globally revoking a user's tokens when a
  already-revoked token is replayed). P1 returns 401 on replay only.
- Email field entirely — removed (no nullable email column kept).
- Rate limiting / lockout on login/prelogin (existing `rate_limit_per_minute`
  is not wired here).

---

## 2. Background (current state)

- **Backend** skeleton is complete: axum routes wired, `sqlx`+SQLite migration
  applied, `issue_token_pair` / `verify_access_token` / `AuthUser` extractor
  implemented & unit-tested. `argon2`, `sha2`, `hmac`, `hex`, `rand`, `base64`
  are declared in `Cargo.toml` but **never imported**. The three auth handlers
  return `"… not yet implemented (p1 milestone)"`. No `User` model; no SQL
  against `users`; no server-side hashing.
- **Frontend** foundation is real: Argon2id `password_key` & `auth_verifier`
  derivation, `master_key` gen + AES-GCM wrap/unwrap, IndexedDB `device_key`/
  `device_wrap` persistence. `register()` runs end-to-end. BUT `login()` is a
  hard stub (needs `server_salt` from a not-yet-existing prelogin endpoint);
  `access_token` lives only in a module variable (lost on refresh);
  `refresh_token` is parsed but never stored; `authApi.refresh()` has zero call
  sites; `derivePasswordKeySalt()` returns 16 zero bytes (placeholder).

---

## 3. Username change (cross-cutting)

The identity used for register/login/prelogin changes from `email` to
`username`. Affected surfaces:

| Layer | Change |
|---|---|
| DB | `users.email` → `users.username` (keep `UNIQUE` + index) |
| Migration | new file `ALTER TABLE users RENAME COLUMN email TO username` + rebuild index |
| Backend DTOs | `RegisterRequest.email`, `LoginRequest.email`, `AuthResponse.email`, new `PreloginRequest.username` → `username` |
| Backend SQL | every `WHERE email = ?` and `INSERT … email` → `username` |
| Backend validation | new username format check on register (see §3.1) |
| Frontend crypto | `normaliseEmail`→`normaliseUsername`; `emailToSalt`→`usernameToSalt` (salt = `SHA-256(normalised_username)[..16]`) |
| Frontend store | `register`/`login` use `username`; delete `derivePasswordKeySalt` placeholder, send real `usernameToSalt` as `kdf_salt` |
| Frontend API types | `RegisterRequest.email`, `LoginRequest.email`, `AuthResponse.email` → `username` |
| Frontend UI | `RegisterView`/`LoginView` inputs → username (label, `autocomplete="username"`, validation) |
| Docs | `docs/api.md`, `docs/crypto-design.md` updated `email`→`username` |

### 3.1 Username rules
- **Regex**: `^[a-z0-9_-]{3,32}$` (lowercase letters, digits, underscore,
  hyphen; 3–32 chars).
- **Normalisation**: `trim()` + `toLowercase()` before storage, comparison, and
  KDF salt derivation. `"  Alice "` and `"alice"` are the same account.
- **Validation site**: frontend (UI hints, block submit) **and** backend
  register handler (reject with `400` if it fails, defence in depth). Login
  does not re-validate the format (only normalises); a malformed username
  simply won't match a row → `401`.

### 3.2 Migration strategy
A **new** migration file (not editing the initial one — avoids sqlx checksum
mismatch on already-applied migrations, and needs no local-DB deletion):

`server/migrations/20260101000001_rename_email_to_username.sql`:
```sql
ALTER TABLE users RENAME COLUMN email TO username;
DROP INDEX idx_users_email;
CREATE INDEX idx_users_username ON users(username);
```
SQLite ≥ 3.25 (bundled by `sqlx` 0.8) supports `RENAME COLUMN`. The
`users` unique constraint is preserved across the rename (SQLite keeps the
constraint; the index is rebuilt for naming clarity).

---

## 4. Backend design

### 4.1 New file `server/src/crypto.rs` — server-side hashing
Uses the already-declared `argon2`, `hex`, `sha2` crates.

```rust
// Argon2id, m=19456 KiB (~19 MiB), t=2, p=1 (argon2 crate defaults).
// Server-side pass over the already-high-entropy client verifier.

pub fn hash_verifier(auth_verifier_hex: &str, server_salt_hex: &str)
    -> Result<String>;            // -> PHC string (encodes salt + params)

pub fn verify_verifier(auth_verifier_hex: &str, phc: &str)
    -> Result<bool>;

pub fn hash_refresh_token(token: &str) -> String;   // SHA-256 hex
```

- `hash_verifier`: decode both hex args → `SaltString::encode_b64(server_salt_bytes)` →
  `Argon2::default()` (Argon2id, V0x13, m=19456 KiB, t=2, p=1 — the crate default) →
  `hash_password(verifier_bytes, &salt)` → `to_string()` (PHC). The PHC's
  embedded salt equals `server_salt`, so `users.server_salt` (returned by
  prelogin) and the PHC stay consistent.
- `verify_verifier`: `PasswordHash::new(phc)?` →
  `Argon2::default().verify_password(verifier_bytes, &parsed_hash)` →
  `Ok(true)` / map `Error` to `Ok(false)`. Params are read back from the PHC,
  so the same default instance verifies hashes it issued.
- `hash_refresh_token`: `Sha256::digest(token_bytes)` → hex; for the
  `refresh_tokens.token_hash` allowlist column.
- **Three-layer Argon2id rationale**: on DB leak an attacker must, per
  candidate password, run password_key (64 MiB) → auth_verifier (64 MiB) →
  PHC verify (~19 MiB). Offline cracking is prohibitively slow — the design
  intent of storing a hash of the client-derived verifier.

### 4.2 New file `server/src/models.rs`
```rust
#[derive(sqlx::FromRow)]
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

#[derive(sqlx::FromRow)]
pub struct RefreshTokenRow {
    pub id: String,
    pub user_id: String,
    pub device_id: Option<String>,
    pub token_hash: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub created_at: String,
}
```

### 4.3 `auth/mod.rs` — extend token issuance
`issue_token_pair` currently signs JWTs but does not persist. It gains a DB
write so every issued refresh token lands in the allowlist.

> **SQL style**: all queries use runtime `sqlx::query` / `sqlx::query_as::<_, T>`
> with `.bind()` — matching `db/mod.rs`. **No `sqlx::query!` macros**, so no
> `DATABASE_URL` / `.sqlx` offline cache is needed at compile time.

```rust
pub async fn issue_token_pair(
    state: &AppState,
    user_id: &str,
    device_id: Option<&str>,
) -> Result<TokenPair> {
    // ... existing JWT signing (access + refresh, distinct exp) ...
    let pair = TokenPair { access_token, refresh_token, expires_in };
    // NEW: persist refresh token hash
    let hash = crate::crypto::hash_refresh_token(&pair.refresh_token);
    let new_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&new_id)
    .bind(user_id)
    .bind(device_id)
    .bind(&hash)
    .bind(refresh_expires_at_rfc3339)
    .execute(&state.db)
    .await?;
    Ok(pair)
}
```
User lookups use `sqlx::query_as::<_, User>("SELECT … FROM users WHERE username = ?").bind(name)`,
leveraging the `User::FromRow` derive in §4.2.
New helper:
```rust
pub async fn revoke_refresh_token(state: &AppState, token_hash: &str) -> Result<()>;
```
`verify_access_token` is reused for refresh tokens (same `AccessClaims` shape);
refresh-vs-access is distinguished only by `exp`/caller context, as today.

### 4.4 `api/auth.rs` — implement handlers + DTOs
DTOs (`email` → `username`):
```rust
pub struct RegisterRequest {
    pub username: String,
    pub auth_verifier: String,
    pub kdf_salt: String,
    pub server_salt: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
}
pub struct PreloginRequest { pub username: String }
pub struct LoginRequest    { pub username: String, pub auth_verifier: String, pub device_name: Option<String> }
pub struct AuthResponse {
    pub user_id: String,
    pub username: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub kdf_salt: String,
    pub tokens: TokenPair,
}
pub struct PreloginResponse { pub kdf_salt: String, pub server_salt: String }
```

Handlers:

- **`register`**:
  1. Normalise + validate `username` (regex §3.1) → else `400`.
  2. `hash_verifier(auth_verifier, server_salt)` → PHC.
  3. `INSERT INTO users (id, username, kdf_salt, server_salt, verifier_hash, encrypted_master_key, encrypted_master_key_nonce)`
     with `id = Uuid::new_v4()`.
  4. On `sqlx::Error::Database` unique violation → `ApiError::Conflict` (409).
  5. `issue_token_pair(state, &id, None)` (writes allowlist).
  6. Return `AuthResponse`.

- **`prelogin`**: normalise `username` → `SELECT kdf_salt, server_salt FROM users WHERE username = ?`
  → `404` if no row → else `PreloginResponse`.

- **`login`**:
  1. Normalise `username` → `SELECT * FROM users WHERE username = ?` → `401` if missing
     (do **not** distinguish "no such user" from "wrong password" in the
     response body — both 401 with a generic message).
  2. `verify_verifier(auth_verifier, user.verifier_hash)` → false ⇒ `401`.
  3. `issue_token_pair(state, &user.id, None)`.
  4. Return `AuthResponse` (echoes `encrypted_master_key`/nonce/`kdf_salt` so
     the client can `unwrapMasterKey` with its `password_key`).

- **`refresh`** (approach B — rotation):
  1. `verify_access_token(&refresh_token)` (signature + exp) → `401` on fail.
  2. `hash = hash_refresh_token(&refresh_token)`.
  3. `SELECT id FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now`
     → no row ⇒ `401`.
  4. `UPDATE refresh_tokens SET revoked_at = now WHERE token_hash = ?` (revoke old).
  5. `issue_token_pair(state, user_id, device_id)` (issues + persists new).
  6. Return new `TokenPair`.
  - **Replay note**: a second call with the now-revoked old token hits step 3
    and returns 401. Global revocation-on-reuse (revoke all the user's tokens)
    is explicitly deferred.

### 4.5 `api/mod.rs` — route
```rust
.route("/api/auth/prelogin", post(auth::prelogin))
```
alongside the existing register/login/refresh routes.

---

## 5. Frontend design

### 5.1 `src/api/auth.ts`
Add:
```ts
prelogin: (username: string) =>
  http.post<PreloginResponse>("/api/auth/prelogin", { username }),
```
and update `register`/`login` body types to use `username`.

### 5.2 `src/crypto/kdf.ts`
- Rename `normaliseEmail` → `normaliseUsername`, `emailToSalt` → `usernameToSalt`.
  Bodies identical (trim + lowercase; `SHA-256(name)[..16]`).
- `derivePasswordKey(password, username)` derives its internal salt via
  `usernameToSalt(normaliseUsername(username))`.

### 5.3 `src/stores/auth.ts`
- **Delete** `derivePasswordKeySalt` (16-zero-byte placeholder). `kdf_salt` sent
  at register = `toHex(usernameToSalt(normalised))`.
- **`login({ username, password })`** (replaces the stub):
  1. `normaliseUsername`; `await prelogin(username)` → `{ server_salt, kdf_salt }`.
  2. `passwordKey = derivePasswordKey(password, username)`.
  3. `authVerifier = deriveAuthVerifier(passwordKey, server_salt)` → hex.
  4. `authApi.login({ username, auth_verifier: authVerifier })`.
  5. `masterKey = unwrapMasterKey(resp.encrypted_master_key, resp.encrypted_master_key_nonce, passwordKey)`.
  6. Persist session (see §5.4) + device wrap (existing `persistDeviceWrap`).
  7. Set store state (`isAuthenticated`, `userId`, `email`→`username`, `masterKey`).
- **`register`**: send `username` instead of `email`; same crypto otherwise.

### 5.4 Token persistence (`src/api/client.ts` + store)
- `refresh_token` stored in `localStorage` (`df_refresh_token`).
- `access_token` stays in the module variable (`authToken`) — memory only.
- New exports: `setRefreshToken`, `getRefreshToken`, `clearRefreshToken`.

### 5.5 `src/api/client.ts` — 401 auto-refresh interceptor
Wrap `request()` so that on a `401` response (and if a refresh token exists and
we're not already retrying):
1. `POST /api/auth/refresh` with the stored refresh token.
2. On success: update `authToken` + `localStorage` refresh token (rotation),
   replay the original request once.
3. On failure: `clearRefreshToken`, clear store auth state, redirect to
   `/login?redirect=<current>`.
A module-level `_refreshing` promise deduplicates concurrent 401s (N parallel
requests share one refresh).

### 5.6 `src/stores/auth.ts` — `tryRestoreSession()`
1. If `localStorage` has a refresh token: call `/api/auth/refresh` → obtain
   fresh `access_token`; set `isAuthenticated = true`.
2. Independently, restore `masterKey` from IndexedDB `device_wrap` (existing
   logic, unchanged) using `device_key`.
3. If refresh fails (token revoked/expired): clear storage; user lands on
   `/login` via the router guard.
This replaces the current "restore master_key only, no JWT" behaviour.

### 5.7 Views
- `RegisterView.vue` / `LoginView.vue`: replace email input with username input
  (`label`, `autocomplete="username"`, `pattern`/client-side regex
  `^[a-z0-9_-]{3,32}$`, error hint). Keep password + (register) confirm fields.

---

## 6. Data flows

**Register**
```
client: username + password
  → password_key  = Argon2id(password, salt=SHA-256(username)[..16])
  → server_salt   = random(16B)
  → auth_verifier = Argon2id(password_key, server_salt)        [hex]
  → master_key    = random(32B)
  → enc(master_key) under password_key
  POST /api/auth/register { username, auth_verifier, kdf_salt, server_salt, enc, nonce }
server: hash_verifier → INSERT users → issue_token_pair (allowlist write)
  → { user_id, username, enc, nonce, kdf_salt, tokens }
client: unwrap master_key; persist device_wrap (IndexedDB) + refresh_token (localStorage)
```

**Login**
```
client: POST /api/auth/prelogin { username } → { server_salt, kdf_salt }
  → password_key, auth_verifier (as above)
  POST /api/auth/login { username, auth_verifier }
server: verify_verifier → issue_token_pair
  → { …, enc, nonce, kdf_salt, tokens }
client: unwrap master_key; persist tokens
```

**Page refresh**
```
App mount → tryRestoreSession:
  localStorage refresh_token → POST /api/auth/refresh → new tokens
  IndexedDB device_wrap + device_key → master_key
  → isAuthenticated=true, drive view renders
```

**Access-token expiry (mid-session)**
```
any API call → 401
  → interceptor: POST /api/auth/refresh (rotates) → replay original
  → if refresh fails → clear session → /login
```

---

## 7. Error handling

| Case | Status | Mapping |
|---|---|---|
| Malformed/missing field, bad username format | 400 | `ApiError::BadRequest` |
| Username already taken (register) | 409 | `ApiError::Conflict` (unique-violation) |
| Wrong password / unknown user (login) | 401 | `ApiError::Unauthorized` (generic msg) |
| Refresh token invalid/expired/revoked | 401 | `ApiError::Unauthorized` |
| Prelogin unknown username | 404 | `ApiError::NotFound` |
| Server Argon2/hash failure | 500 | `ApiError::Internal` (logged, no detail leak) |

All go through the existing, tested `ApiError` → `IntoResponse` classification.

---

## 8. Testing

### Backend (inline `mod tests`, in-memory SQLite + real Argon2)
- `crypto.rs`: `hash_verifier`/`verify_verifier` round-trip; wrong verifier →
  `false`; different `server_salt` → different PHC.
- `auth/mod.rs`: `issue_token_pair` now inserts a `refresh_tokens` row;
  `revoke_refresh_token` sets `revoked_at`.
- `api/auth.rs` (integration-style against in-memory `AppState`):
  - register → 200 + row in `users` + row in `refresh_tokens`.
  - duplicate username → 409.
  - register with bad username (`"A b"`, `"ab"`, `"a"*33`) → 400.
  - prelogin known/unknown → 200 / 404.
  - login wrong password → 401; correct → 200 + new allowlist row.
  - refresh once → 200 + new pair, old `token_hash` now `revoked_at` set;
    refresh again with the **old** token → 401.

### Frontend (`vitest` + `msw` + `happy-dom`)
- `crypto/kdf.test.ts`: update names; `usernameToSalt` deterministic, 16 bytes,
  differs per username.
- `stores/auth.test.ts` (new): `login` flow with msw stubs for prelogin + login
  → asserts `authApi.login` called with derived `auth_verifier` and that
  `masterKey` is populated post-await; `tryRestoreSession` with a stubbed
  refresh token → `isAuthenticated` true.
- `api/client.test.ts`: 401 → triggers one refresh (msw) → replays original and
  resolves; refresh 401 → clears token + rejects; concurrent 401s issue a
  single refresh.

### Manual acceptance
- `npm run dev --prefix web` + `cargo run --manifest-path server/Cargo.toml`;
  register a user, logout, login, reload the tab (stays on `/drive`), wait 16
  min (or shorten `access_ttl_seconds` temporarily) and confirm a file-list
  request still succeeds via auto-refresh.

---

## 9. File layout

**Backend**
```
server/
├── migrations/
│   └── 20260101000001_rename_email_to_username.sql   # new
└── src/
    ├── main.rs                                       # mod declarations + crypto/models
    ├── crypto.rs                                     # new
    ├── models.rs                                     # new
    ├── auth/mod.rs                                   # +allowlist write, +revoke helper
    └── api/
        ├── mod.rs                                    # +prelogin route
        └── auth.rs                                   # implement 4 handlers + DTOs
```

**Frontend**
```
web/src/
├── api/
│   ├── auth.ts                                       # +prelogin, username fields
│   ├── client.ts                                     # +refresh interceptor, token storage
│   └── types.ts                                      # username fields, PreloginResponse
├── crypto/kdf.ts                                     # rename email→username fns
├── stores/auth.ts                                    # login impl, session restore, drop placeholder
└── views/
    ├── RegisterView.vue                              # username input + validation
    └── LoginView.vue                                 # username input + validation
```

**Docs**
```
docs/
├── api.md                                            # email→username, +prelogin section
└── crypto-design.md                                  # salt = SHA-256(username)
```

---

## 10. Acceptance criteria

1. `cargo test --manifest-path server/Cargo.toml` is green.
2. `npm test --prefix web` is green.
3. `npm run typecheck --prefix web` is green.
4. `cargo check --manifest-path server/Cargo.toml` is green.
5. Manual flow works end-to-end: register → logout → login → page reload stays
   authenticated → access-token expiry auto-recovers.
6. A replayed (old) refresh token after rotation is rejected with 401.
7. No `email` identifier remains in code or docs (grep clean, modulo git
   history).

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Rotation + network drop leaves client holding a revoked token (old revoked server-side, new never received) | Accepted for P1 manual testing. User re-logs in. Documented in `login` view is unnecessary — rare and recoverable. |
| `access_token` in memory only → lost on reload, but refresh-on-mount recovers it transparently. | `tryRestoreSession` calls `/api/auth/refresh` before the router lands. |
| `localStorage` XSS exposure of refresh token | Accepted for P1. Token theft yields only encrypted blobs (no `master_key`). HttpOnly cookies considered for a later hardening pass. |
| Concurrent 401s trigger N refreshes, racing rotation | Interceptor dedupes via a shared `_refreshing` promise; only the first 401 rotates, others await its result. |
| `usernameToSalt` rename breaks existing registered rows | No existing users in dev DB; fresh start. Migration only renames the column. |
| SQLite `RENAME COLUMN` unsupported | Bundled SQLite in `sqlx` 0.8 is ≥ 3.25; verified by acceptance criterion 1. |
