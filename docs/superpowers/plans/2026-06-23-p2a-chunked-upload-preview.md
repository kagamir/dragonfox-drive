# P2a: Chunked Upload/Download + Lightweight Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the P1 single-chunk/100 MiB ceiling — support ~10 GB E2EE files with parallel chunked upload (within-session resume + retry) and in-browser preview for image/text/audio/small-video.

**Architecture:** Streaming per-chunk slice upload (memory-constant) through the crypto worker, concurrency 3, with resume reconciliation against a new `GET /api/files/:id/chunks` endpoint. Backend splits its body/file-size limits into `max_chunk_bytes` (router-wide body cap) and `max_file_bytes` (total-file cap). Preview decrypts to a blob URL rendered by native `<img>/<pre>/<audio>/<video>` in a modal.

**Tech Stack:** Rust (axum + sqlx + SQLite), Vue 3 + TypeScript, Pinia, Comlink Web Worker, WebCrypto AES-GCM, vitest, happy-dom, @vue/test-utils.

## Global Constraints

- **Zero-trust:** the server never sees plaintext, file names, keys, or the manifest JSON. All crypto happens in the browser (worker).
- **Chunk model:** 4 MiB plaintext chunks (`FILE_CHUNK_SIZE = 4*1024*1024`); chunk `i` encrypted with `chunkIv(iv_base, i)` (AES-256-GCM, 96-bit IV = iv_base XOR counter). Last chunk may be shorter.
- **SQL:** runtime `sqlx::query`/`query_as` + `.bind()` only — never the `query!` macro.
- **Frontend tests:** `vi.stubGlobal`/`vi.hoisted`; mock `@/workers/crypto` and `@/api/files`; do NOT use msw. Mock localforage where relevant. jsdom-less URL via `vi.stubGlobal("URL", ...)`.
- **Backend tests:** run `cargo test --manifest-path server/Cargo.toml -- --test-threads=1` (config CWD-mutating tests require serial).
- **Build:** do NOT remove the `fixLibsodiumImport` plugin in `web/vite.config.ts`.
- **Commits:** frequent, one per task; never stage pre-existing dirty files (`server/src/api/assets.rs`, `web/vite.config.ts`, `web/package-lock.json`) — stage only files you edit.
- **Conversation language:** Chinese.

---

## File Structure

**Backend (`server/`)**
- `src/config.rs` — `LimitSettings`: rename `max_upload_bytes` → `max_file_bytes` (10 GiB default); keep `max_chunk_bytes` (8 MiB).
- `config.toml` — migrate `[limits]` keys + comment.
- `src/api/files.rs` — `create` uses `max_file_bytes`; `put_chunk` uses `max_chunk_bytes`; new `list_chunks` handler + tests.
- `src/api/mod.rs` — register `GET /api/files/:id/chunks`.
- `src/main.rs` — `DefaultBodyLimit` uses `max_chunk_bytes`; update router tests.
- `docs/api.md` — document new endpoint + limit split.

**Frontend crypto/api (`web/src/`)**
- `crypto/file.ts` — `chunkCount`, `encryptFileChunk`, `decryptFileChunk`; `Manifest.plaintext_sha256` optional.
- `workers/crypto.worker.ts` — expose `newFileKeyMaterial` + `seal`.
- `api/types.ts` — `ChunkIndices` type.
- `api/files.ts` — `filesApi.getChunks`.

**Frontend UI (`web/src/`)**
- `crypto/preview.ts` — `FileKind`, `kindOf`, `canPreview`, `PREVIEW_CAPS`.
- `stores/files.ts` — upload (streaming+pool+resume+retry+cancel), download (multi-chunk), preview state.
- `components/FilePreviewModal.vue` — modal viewer.
- `views/DriveView.vue` — actions, incomplete-uploads list, modal mount.

---

### Task 1: Backend — split upload limit into `max_chunk_bytes` + `max_file_bytes`

**Files:**
- Modify: `server/src/config.rs` (struct field, default, tests)
- Modify: `server/config.toml`
- Modify: `server/src/main.rs` (`build_router` + router tests)
- Modify: `server/src/api/files.rs` (`create`, `put_chunk`, affected tests)
- Test: `server/src/config.rs`, `server/src/main.rs`, `server/src/api/files.rs` (existing modules)

**Interfaces:**
- Produces: `LimitSettings { max_file_bytes: u64, max_chunk_bytes: u64, rate_limit_per_minute: u32 }`. `max_file_bytes` default `10*1024*1024*1024`. `max_chunk_bytes` default `8*1024*1024` (unchanged).

- [ ] **Step 1: Rename the struct field + default in `config.rs`**

In `server/src/config.rs`, change the `LimitSettings` struct (currently has `max_upload_bytes`):

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct LimitSettings {
    pub max_file_bytes: u64,
    pub max_chunk_bytes: u64,
    pub rate_limit_per_minute: u32,
}
```

And its `Default` impl:

```rust
impl Default for LimitSettings {
    fn default() -> Self {
        Self {
            max_file_bytes: 10 * 1024 * 1024 * 1024,
            max_chunk_bytes: 8 * 1024 * 1024,
            rate_limit_per_minute: 600,
        }
    }
}
```

- [ ] **Step 2: Update the `defaults_match_documented_values` config test**

In `server/src/config.rs` test module replace the `max_upload_bytes` assertion:

```rust
        assert_eq!(s.limits.max_file_bytes, 10 * 1024 * 1024 * 1024);
        assert_eq!(s.limits.max_chunk_bytes, 8 * 1024 * 1024);
        assert_eq!(s.limits.rate_limit_per_minute, 600);
```

- [ ] **Step 3: Rename the override test to cover `max_file_bytes`**

In `server/src/config.rs`, rename the test `load_lets_toml_override_max_upload_bytes` → `load_lets_toml_override_limits` and update its body so the `[limits]` file overrides BOTH new keys:

```rust
    /// Regression guard: a `[limits]` section in config.toml MUST override the
    /// code defaults. A stale `0` body limit previously collapsed the
    /// router-wide `DefaultBodyLimit` to zero, returning 413 for every request
    /// body. WARNING: mutates CWD — run the suite with --test-threads=1.
    #[test]
    fn load_lets_toml_override_limits() {
        let dir = tempfile::tempdir().unwrap();
        let original_cwd = std::env::current_dir().unwrap();
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }
        let _guard = Restore(original_cwd);

        std::fs::write(
            dir.path().join("config.toml"),
            "[limits]\nmax_file_bytes = 42\nmax_chunk_bytes = 7\n",
        )
        .unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let settings = Settings::load().unwrap();
        assert_eq!(settings.limits.max_file_bytes, 42);
        assert_eq!(settings.limits.max_chunk_bytes, 7);
    }
```

(Leave the `PathBuf` import that this test already relies on — it comes from `use std::path::PathBuf;` at the top of the test module; if not present, add it.)

- [ ] **Step 4: Migrate `config.toml`**

Replace the `[limits]` section of `server/config.toml`:

```toml
# Sizing knobs.
[limits]
# Total per-file cap, checked by POST /api/files on `total_size`. Must be > 0
# (a value of 0 disables the total-size check). Default 10 GiB.
max_file_bytes = 10737418240
# Per request/chunk body cap, applied as the router-wide DefaultBodyLimit so
# it bounds every request body (auth JSON is tiny; an encrypted chunk is the
# real consumer). Must be > 0 — a value of 0 rejects ALL bodies (HTTP 413).
max_chunk_bytes = 8388608        # 8 MiB encrypted chunk hard cap
rate_limit_per_minute = 600
```

- [ ] **Step 5: Wire `build_router` to `max_chunk_bytes` in `main.rs`**

In `server/src/main.rs` `build_router`:

```rust
fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::very_permissive();
    let compression = CompressionLayer::new().br(true);
    let max_body = state.settings.limits.max_chunk_bytes as usize;

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

- [ ] **Step 6: Update router integration tests in `main.rs`**

In the `#[cfg(test)] mod tests` of `server/src/main.rs`, change the helper so it sets `max_chunk_bytes`:

```rust
    async fn test_router(max_chunk: u64) -> (Router, AppState) {
        let mut settings = Settings::default();
        settings.jwt.secret = "test".into();
        settings.limits.max_chunk_bytes = max_chunk;
        let pool = db::connect("sqlite::memory:").await.unwrap();
        db::migrate(&pool).await.unwrap();
        let state = AppState::new(Arc::new(settings), pool);
        (build_router(state.clone()), state)
    }
```

Every call site `test_router(104857600)` stays valid (that's a fine chunk limit). The `test_router(100)` and `test_router(0)` cases keep their meaning (tiny/zero body limit). No call-site changes needed.

- [ ] **Step 7: Switch `create` to `max_file_bytes` in `files.rs`**

In `server/src/api/files.rs` `create`, replace the limit read + check:

```rust
    let max = state.settings.limits.max_file_bytes;
    if max > 0 && req.total_size > max {
        return Err(ApiError::PayloadTooLarge);
    }
```

And update the `create_rejects_oversized` test to reference `max_file_bytes`:

```rust
        let req = CreateFileRequest {
            total_size: state.settings.limits.max_file_bytes + 1,
            chunk_count: 1,
            encrypted_file_key: "k".into(), encrypted_file_key_nonce: "kn".into(),
        };
```

- [ ] **Step 8: Switch `put_chunk` to `max_chunk_bytes` in `files.rs`**

In `server/src/api/files.rs` `put_chunk`, replace the limit read:

```rust
    let max = state.settings.limits.max_chunk_bytes;
    if max > 0 && (bytes.len() as u64) > max {
        return Err(ApiError::PayloadTooLarge);
    }
```

And update the `put_chunk_returns_413_when_oversized` test:

```rust
        Arc::get_mut(&mut state.settings).unwrap().limits.max_chunk_bytes = 5;
```

- [ ] **Step 9: Compile + run all backend tests**

Run: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`
Expected: all tests PASS (the renamed-field references compile; the 413 router guards still hold via `max_chunk_bytes`).

- [ ] **Step 10: Commit**

```bash
git add server/src/config.rs server/config.toml server/src/main.rs server/src/api/files.rs
git commit -m "feat(server): split upload limit into max_chunk_bytes + max_file_bytes

max_chunk_bytes (8 MiB) now feeds the router-wide DefaultBodyLimit and the
per-chunk body check; max_file_bytes (10 GiB) caps total file size in create.
Eliminates the conflation that let a stale 0 collapse all bodies to 413."
```

---

### Task 2: Backend — `GET /api/files/:id/chunks` resume endpoint

**Files:**
- Modify: `server/src/api/files.rs` (new `list_chunks` handler + tests)
- Modify: `server/src/api/mod.rs` (route)
- Test: `server/src/api/files.rs`

**Interfaces:**
- Consumes: `AppState`, `AuthUser` (owner-scoped, existing).
- Produces: `GET /api/files/:id/chunks` → `200 { "indices":[0,1,..], "chunk_count":N, "status":"pending"|"ready" }`; `404` for unknown id / non-owner.

- [ ] **Step 1: Write the failing tests**

Append to the `#[cfg(test)] mod tests` in `server/src/api/files.rs` (after `delete_returns_404_for_non_owner`):

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path server/Cargo.toml list_chunks -- --test-threads=1`
Expected: the 3 `list_chunks` tests FAIL (`list_chunks` not found); the idempotency + multi-chunk finalize tests PASS (they cover existing behavior).

- [ ] **Step 3: Implement `list_chunks`**

Add this handler in `server/src/api/files.rs` (e.g. right after `get_chunk`):

```rust
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
```

- [ ] **Step 4: Register the route**

In `server/src/api/mod.rs`, add inside `routes()` (anywhere among the `/api/files` routes):

```rust
        .route("/api/files/:id/chunks", get(files::list_chunks))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path server/Cargo.toml list_chunks -- --test-threads=1`
Expected: the 3 `list_chunks` tests PASS. (Run the whole `files::tests` module to also see the idempotency + multi-chunk finalize tests pass.)

- [ ] **Step 6: Run the full backend suite**

Run: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/api/files.rs server/src/api/mod.rs
git commit -m "feat(server): GET /api/files/:id/chunks for upload resume"
```

---

### Task 3: Frontend crypto — chunk helpers + worker key/manifest methods

**Files:**
- Modify: `web/src/crypto/file.ts` (new helpers, optional `plaintext_sha256`)
- Modify: `web/src/workers/crypto.worker.ts` (`newFileKeyMaterial`, `seal`)
- Test: `web/src/crypto/file.test.ts`

**Interfaces:**
- Produces:
  - `chunkCount(size: number, chunkSize?: number): number`
  - `encryptFileChunk(fileKey: RawKey, ivBase: Uint8Array, index: number, plaintext: Uint8Array): Promise<Uint8Array>`
  - `decryptFileChunk(fileKey: RawKey, ivBase: Uint8Array, index: number, ciphertext: Uint8Array): Promise<Uint8Array>`
  - worker `newFileKeyMaterial(): { fileKey: Uint8Array; ivBase: Uint8Array }`
  - worker `seal(key: Uint8Array, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }>`
- Consumes: `encryptChunk`/`decryptChunk`/`chunkIv` from `symmetric.ts` (existing); `encrypt` from `symmetric.ts`; `sodium` from `@/crypto`.

- [ ] **Step 1: Write the failing crypto tests**

Append to `web/src/crypto/file.test.ts` (inside the `describe`):

```ts
  it("chunkCount rounds up with a 1-chunk floor", () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(FILE_CHUNK_SIZE)).toBe(1);
    expect(chunkCount(FILE_CHUNK_SIZE + 1)).toBe(2);
    expect(chunkCount(5 * 1024 * 1024)).toBe(2);
    expect(chunkCount(5 * 1024 * 1024, 1024)).toBe(5120);
  });

  it("encryptFileChunk / decryptFileChunk round-trip a single chunk", async () => {
    const fileKey = generateMasterKey(); // any 32-byte key
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode("chunky bytes");
    const ct = await encryptFileChunk(fileKey, ivBase, 4, pt);
    const out = await decryptFileChunk(fileKey, ivBase, 4, ct);
    expect(Array.from(out)).toEqual(Array.from(pt));
  });

  it("multi-chunk encrypt+decrypt concatenates to the original", async () => {
    const fileKey = generateMasterKey();
    const ivBase = crypto.getRandomValues(new Uint8Array(12));
    const original = new Uint8Array(FILE_CHUNK_SIZE + 10);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const n = chunkCount(original.length, FILE_CHUNK_SIZE);
    const recovered: Uint8Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const start = i * FILE_CHUNK_SIZE;
      const slice = original.subarray(start, Math.min(start + FILE_CHUNK_SIZE, original.length));
      const ct = await encryptFileChunk(fileKey, ivBase, i, slice);
      recovered[i] = await decryptFileChunk(fileKey, ivBase, i, ct);
    }
    const joined = new Uint8Array(original.length);
    let off = 0;
    for (const r of recovered) { joined.set(r, off); off += r.length; }
    expect(Array.from(joined)).toEqual(Array.from(original));
  });
```

Add the imports at the top of the file:

```ts
import { encryptFile, decryptFile, decryptManifest, chunkCount, encryptFileChunk, decryptFileChunk, FILE_CHUNK_SIZE } from "./file";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- file.test.ts`
Expected: FAIL (`chunkCount`/`encryptFileChunk`/`decryptFileChunk` not exported).

- [ ] **Step 3: Add the helpers + optional sha to `file.ts`**

In `web/src/crypto/file.ts`, make `plaintext_sha256` optional in the `Manifest` interface:

```ts
export interface Manifest {
  version: number;
  name: string;
  mime: string;
  size: number;
  chunk_size: number;
  iv_base: string; // base64 of the 12-byte iv_base
  plaintext_sha256?: string; // hex; omitted for multi-chunk P2a uploads
  created_at: string; // RFC-3339
}
```

Then add these exports (e.g. after `decryptFile`):

```ts
/** Number of chunks for a file of `size` bytes (1-chunk floor). */
export function chunkCount(size: number, chunkSize: number = FILE_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Encrypt chunk `index` of a file (thin wrapper over the IV scheme). */
export async function encryptFileChunk(
  fileKey: RawKey,
  ivBase: Uint8Array,
  index: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return encryptChunk(fileKey, chunkIv(ivBase, index), plaintext);
}

/** Decrypt chunk `index` of a file. */
export async function decryptFileChunk(
  fileKey: RawKey,
  ivBase: Uint8Array,
  index: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return decryptChunk(fileKey, chunkIv(ivBase, index), ciphertext);
}
```

(`RawKey` is already imported from `./kdf` at the top of `file.ts`.)

- [ ] **Step 4: Add worker methods `newFileKeyMaterial` + `seal`**

In `web/src/workers/crypto.worker.ts`, extend the symmetric import to include `encrypt`:

```ts
import {
  decryptChunk,
  encryptChunk,
  chunkIv,
  encrypt,
} from "@/crypto/symmetric";
```

Add two methods to the `api` object (in the `// --- File chunks ---` section):

```ts
  /** Fresh per-file key material: random fileKey + random iv_base. */
  newFileKeyMaterial(): { fileKey: RawKey; ivBase: Uint8Array } {
    return {
      fileKey: sodium.randombytes_buf(32),
      ivBase: sodium.randombytes_buf(12),
    };
  },

  /** Seal an arbitrary blob with a key (random IV) — used for the manifest. */
  async seal(
    key: RawKey,
    plaintext: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    return encrypt(key, plaintext);
  },
```

- [ ] **Step 5: Run crypto tests to verify they pass**

Run: `npm run test --prefix web -- file.test.ts`
Expected: PASS (all, including the 3 new tests).

- [ ] **Step 6: Run full frontend suite + typecheck**

Run: `npm run test --prefix web`
Run: `npm run typecheck --prefix web`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/crypto/file.ts web/src/workers/crypto.worker.ts web/src/crypto/file.test.ts
git commit -m "feat(crypto): per-chunk helpers + worker key/manifest methods"
```

---

### Task 4: Frontend API — `filesApi.getChunks` + `ChunkIndices` type

**Files:**
- Modify: `web/src/api/types.ts` (new type)
- Modify: `web/src/api/files.ts` (new method)
- Test: `web/src/api/client.test.ts` is not extended (the store tests in Tasks 6–7 cover `getChunks` via mocks)

**Interfaces:**
- Produces: `filesApi.getChunks(id: string): Promise<ChunkIndices>` where `ChunkIndices = { indices: number[]; chunk_count: number; status: string }`.

- [ ] **Step 1: Add the `ChunkIndices` type**

In `web/src/api/types.ts`, append:

```ts
export interface ChunkIndices {
  indices: number[];
  chunk_count: number;
  status: string;
}
```

- [ ] **Step 2: Add `getChunks` to `filesApi`**

In `web/src/api/files.ts`, import the type and add the method. Update the import line:

```ts
import type { CreateFileRequest, CreateFileResponse, FileMeta, ChunkIndices } from "./types";
```

Add to the `filesApi` object (e.g. after `getManifest`):

```ts
  /** Query which chunk indices are already on the server (upload resume). */
  getChunks: (id: string) =>
    http.get<ChunkIndices>(`/api/files/${id}/chunks`),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/types.ts web/src/api/files.ts
git commit -m "feat(api): filesApi.getChunks for resume reconciliation"
```

---

### Task 5: Frontend — preview kind detection + size caps

**Files:**
- Create: `web/src/crypto/preview.ts`
- Test: `web/src/crypto/preview.test.ts`

**Interfaces:**
- Produces:
  - `type FileKind = "image" | "text" | "audio" | "video" | "other"`
  - `PREVIEW_CAPS: Record<Exclude<FileKind,"other">, number>` (`{ text: 2 MiB, image/audio/video: 256 MiB }`)
  - `kindOf(mime: string): FileKind`
  - `canPreview(kind: FileKind, size: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `web/src/crypto/preview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { kindOf, canPreview, PREVIEW_CAPS } from "./preview";

describe("preview helpers", () => {
  it("classifies common mime types", () => {
    expect(kindOf("image/png")).toBe("image");
    expect(kindOf("image/jpeg")).toBe("image");
    expect(kindOf("text/plain")).toBe("text");
    expect(kindOf("text/csv")).toBe("text");
    expect(kindOf("application/json")).toBe("text");
    expect(kindOf("application/xml")).toBe("text");
    expect(kindOf("application/javascript")).toBe("text");
    expect(kindOf("audio/mpeg")).toBe("audio");
    expect(kindOf("audio/ogg")).toBe("audio");
    expect(kindOf("video/mp4")).toBe("video");
    expect(kindOf("video/webm")).toBe("video");
    expect(kindOf("application/octet-stream")).toBe("other");
    expect(kindOf("application/pdf")).toBe("other");
    expect(kindOf("")).toBe("other");
  });

  it("canPreview respects per-kind caps", () => {
    expect(canPreview("text", 1)).toBe(true);
    expect(canPreview("text", PREVIEW_CAPS.text)).toBe(true);
    expect(canPreview("text", PREVIEW_CAPS.text + 1)).toBe(false);
    expect(canPreview("video", PREVIEW_CAPS.video)).toBe(true);
    expect(canPreview("video", PREVIEW_CAPS.video + 1)).toBe(false);
  });

  it("canPreview is always false for 'other'", () => {
    expect(canPreview("other", 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- preview.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `preview.ts`**

Create `web/src/crypto/preview.ts`:

```ts
/** Preview category for a decrypted file. */
export type FileKind = "image" | "text" | "audio" | "video" | "other";

/** Max in-memory plaintext size (bytes) we are willing to decode per kind. */
export const PREVIEW_CAPS = {
  text: 2 * 1024 * 1024,
  image: 256 * 1024 * 1024,
  audio: 256 * 1024 * 1024,
  video: 256 * 1024 * 1024,
} as const;

/** Map a MIME type to a preview category. */
export function kindOf(mime: string): FileKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript"
  ) {
    return "text";
  }
  return "other";
}

/** Whether a file of `kind` and plaintext `size` bytes may be previewed. */
export function canPreview(kind: FileKind, size: number): boolean {
  if (kind === "other") return false;
  const cap = PREVIEW_CAPS[kind];
  return size > 0 && size <= cap;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/crypto/preview.ts web/src/crypto/preview.test.ts
git commit -m "feat(crypto): preview kind detection + size caps"
```

---

### Task 6: Frontend store — streaming chunked upload + resume + retry + cancel

**Files:**
- Modify: `web/src/stores/files.ts`
- Modify: `web/src/stores/files.test.ts`

**Interfaces:**
- Consumes: `filesApi.create/putManifest/putChunk/finalize/getChunks/remove`, `cryptoApi.newFileKeyMaterial/wrap/seal/encryptChunk`, `FILE_CHUNK_SIZE`/`chunkCount`/`toBase64` from `@/crypto/file`, `masterKey` from auth store.
- Produces:
  - `activeUploads: Ref<UploadSession[]>`
  - `upload(file: File): Promise<void>` (multi-chunk, concurrency 3, resume via `getChunks`, retry ≤3, cancel via `AbortController`)
  - `cancelUpload(fileId: string): Promise<void>`
  - `interface UploadSession { fileId; file; fileKey; ivBase; chunkCount; done: Set<number>; phase; progress; abort }`

- [ ] **Step 1: Replace the upload tests in `files.test.ts`**

Replace the existing `vi.hoisted` mock block and the upload test with the version below. The new mock adds `getChunks` and the worker methods `newFileKeyMaterial`/`wrap`/`seal`/`encryptChunk`. At the top of `web/src/stores/files.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const {
  createMock,
  putManifestMock,
  putChunkMock,
  finalizeMock,
  removeMock,
  getChunkMock,
  getChunksMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  putManifestMock: vi.fn().mockResolvedValue({ ok: true }),
  putChunkMock: vi.fn().mockResolvedValue({ ok: true }),
  finalizeMock: vi.fn().mockResolvedValue({ ok: true }),
  removeMock: vi.fn().mockResolvedValue({ ok: true }),
  getChunkMock: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
  getChunksMock: vi.fn().mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" }),
}));

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {
    newFileKeyMaterial: vi.fn(() => ({
      fileKey: new Uint8Array(32),
      ivBase: new Uint8Array(12),
    })),
    wrap: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([9]),
      iv: new Uint8Array([8]),
    }),
    seal: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([7]),
      iv: new Uint8Array([6]),
    }),
    encryptChunk: vi.fn().mockResolvedValue(new Uint8Array([5])),
    decryptManifest: vi.fn().mockResolvedValue({
      name: "dl.txt", mime: "text/plain", size: 2,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    }),
    unwrap: vi.fn().mockResolvedValue(new Uint8Array(32)),
    decryptChunk: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
  },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

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
    getChunks: getChunksMock,
  },
}));

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
    getChunksMock.mockClear();
    getChunksMock.mockResolvedValue({ indices: [], chunk_count: 1, status: "pending" });
  });

  it("upload runs create → putManifest → putChunk → finalize", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ total_size: 2, chunk_count: 1 }),
    );
    expect(putManifestMock).toHaveBeenCalledWith("fid", expect.any(Object));
    expect(putChunkMock).toHaveBeenCalledWith(
      "fid", 0, expect.any(Uint8Array), expect.any(Function), expect.any(AbortSignal),
    );
    expect(finalizeMock).toHaveBeenCalledWith("fid");
  });

  it("upload skips chunks the server already has (resume)", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    getChunksMock.mockResolvedValue({ indices: [0], chunk_count: 1, status: "pending" });
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    await files.upload(file);
    expect(putChunkMock).not.toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith("fid");
  });

  it("upload retries a failing chunk then gives up", async () => {
    vi.useFakeTimers();
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    putChunkMock.mockReset();
    putChunkMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    const p = files.upload(file);
    // flush the inter-retry `delay()`s and the mocked promise microtasks
    await vi.advanceTimersByTimeAsync(20000);
    await expect(p).rejects.toThrow("boom");
    // initial attempt + 3 retries = 4 calls
    expect(putChunkMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("cancelUpload aborts and deletes the pending file", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    // stall putChunk on a promise the test resolves, so we can cancel mid-flight
    let resolvePut: (v: unknown) => void = () => {};
    putChunkMock.mockImplementation(
      () => new Promise((r) => { resolvePut = r; }),
    );
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", { type: "text/plain" });
    const p = files.upload(file);
    await new Promise((r) => setTimeout(r, 10));
    expect(files.activeUploads.length).toBe(1);
    const id = files.activeUploads[0].fileId;
    await files.cancelUpload(id);
    expect(removeMock).toHaveBeenCalledWith(id);
    expect(files.activeUploads.length).toBe(0);
    // release the stalled chunk so the upload coroutine can finish
    resolvePut({ ok: true });
    await p; // abort short-circuits before finalize; resolves cleanly
    putChunkMock.mockResolvedValue({ ok: true });
  });

  it("remove calls the api and refreshes", async () => {
    const files = useFilesStore();
    await files.remove("x");
    expect(removeMock).toHaveBeenCalledWith("x");
  });
});
```

(The old `download` test is moved to Task 7.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- files.test.ts`
Expected: FAIL (store still uses old single-chunk upload; `activeUploads`/`cancelUpload` missing; `putChunk` signature mismatch).

- [ ] **Step 3: Rewrite the upload path in `stores/files.ts`**

Replace the top imports + the `upload` action. The new top of `web/src/stores/files.ts`:

```ts
import { defineStore } from "pinia";
import { ref } from "vue";

import { filesApi } from "@/api/files";
import type { FileMeta } from "@/api/types";
import { cryptoApi, ensureCryptoReady } from "@/workers/crypto";
import { useAuthStore } from "./auth";
import { FILE_CHUNK_SIZE, chunkCount, toBase64 } from "@/crypto/file";
import type { WrappedKey } from "@/crypto/keys";

export interface UploadSession {
  fileId: string;
  file: File;
  fileKey: Uint8Array;
  ivBase: Uint8Array;
  chunkCount: number;
  done: Set<number>;
  phase: "uploading" | "finalizing" | "done" | "error";
  progress: number; // 0..1
  abort: AbortController;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function asyncPool<T>(
  limit: number,
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = (async () => fn(item))().finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}
```

Keep the existing `files/loading/error/uploading/uploadProgress/downloading/displayNames` state, `masterKey()` helper, `refresh`, `decryptNames`, and `remove`. Replace the `upload` action with:

```ts
  async function upload(file: File): Promise<void> {
    uploading.value = true;
    uploadProgress.value = 0;
    error.value = null;
    let session: UploadSession | null = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const { fileKey, ivBase } = cryptoApi.newFileKeyMaterial();
      const total = file.size;
      const n = chunkCount(total);

      const wrapped: WrappedKey = await cryptoApi.wrap(fileKey, mk);
      const { id } = await filesApi.create({
        total_size: total,
        chunk_count: n,
        encrypted_file_key: toBase64(wrapped.ciphertext),
        encrypted_file_key_nonce: toBase64(wrapped.iv),
      });

      const manifestObj = {
        version: 1,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: total,
        chunk_size: FILE_CHUNK_SIZE,
        iv_base: toBase64(ivBase),
        created_at: new Date().toISOString(),
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestObj));
      const em = await cryptoApi.seal(fileKey, manifestBytes);
      await filesApi.putManifest(id, {
        encrypted_manifest: toBase64(em.ciphertext),
        encrypted_manifest_nonce: toBase64(em.iv),
      });

      session = {
        fileId: id, file, fileKey, ivBase, chunkCount: n,
        done: new Set<number>(), phase: "uploading", progress: 0,
        abort: new AbortController(),
      };
      activeUploads.value.push(session);

      const info = await filesApi.getChunks(id);
      for (const idx of info.indices) session.done.add(idx);
      session.progress = session.done.size / n;

      const missing: number[] = [];
      for (let i = 0; i < n; i++) if (!session.done.has(i)) missing.push(i);

      await asyncPool(3, missing, async (i) => {
        if (session!.abort.signal.aborted) return;
        const start = i * FILE_CHUNK_SIZE;
        const slice = file.slice(start, Math.min(start + FILE_CHUNK_SIZE, total));
        const plaintext = new Uint8Array(await slice.arrayBuffer());
        let attempt = 0;
        while (true) {
          const ciphertext = await cryptoApi.encryptChunk(fileKey, ivBase, i, plaintext);
          try {
            await filesApi.putChunk(
              id, i, ciphertext,
              (r) => { if (session) uploadProgress.value = r; },
              session!.abort.signal,
            );
            break;
          } catch (e) {
            if (session!.abort.signal.aborted) return;
            if (++attempt > 3) throw e;
            await delay(500 * 2 ** attempt);
          }
        }
        session!.done.add(i);
        session!.progress = session!.done.size / n;
        uploadProgress.value = session!.progress;
      });

      if (session.abort.signal.aborted) return;
      session.phase = "finalizing";
      await filesApi.finalize(id);
      session.phase = "done";
      await refresh();
    } catch (e) {
      if (session) session.phase = "error";
      error.value = (e as Error).message;
      throw e;
    } finally {
      uploading.value = false;
      if (session && session.phase === "done") {
        const idx = activeUploads.value.indexOf(session);
        if (idx >= 0) activeUploads.value.splice(idx, 1);
      }
    }
  }

  async function cancelUpload(fileId: string): Promise<void> {
    const s = activeUploads.value.find((x) => x.fileId === fileId);
    if (!s) return;
    s.abort.abort();
    try { await filesApi.remove(fileId); } catch { /* best effort cleanup */ }
    const idx = activeUploads.value.indexOf(s);
    if (idx >= 0) activeUploads.value.splice(idx, 1);
  }
```

Add `activeUploads` to the store state (near the other refs):

```ts
  const activeUploads = ref<UploadSession[]>([]);
```

And expose `activeUploads` + `cancelUpload` in the store's `return { ... }`. Keep exposing `upload/download/remove/refresh/...` (download stays as-is for this task — Task 7 replaces it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- files.test.ts`
Expected: PASS (the 5 tests). The retry test asserts 4 calls (1 + 3 retries); if timing-sensitive, the `delay` uses real `setTimeout` — vitest's default keeps real timers, the test awaits `rejects.toThrow`, fine.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(store): streaming chunked upload with resume, retry, cancel"
```

---

### Task 7: Frontend store — multi-chunk download + preview open/close

**Files:**
- Modify: `web/src/stores/files.ts`
- Modify: `web/src/stores/files.test.ts` (re-add download test + add preview test)

**Interfaces:**
- Consumes: `filesApi.getChunk`, `cryptoApi.decryptManifest/unwrap/decryptChunk`, `kindOf`/`canPreview` from `@/crypto/preview`, `fromBase64` from `@/crypto/file`.
- Produces:
  - `download(meta: FileMeta): Promise<void>` (multi-chunk decrypt → blob → anchor)
  - `preview: Ref<{ meta; url; kind; name } | null>`
  - `openPreview(meta: FileMeta): Promise<void>`
  - `closePreview(): void`

- [ ] **Step 1: Add the download + preview tests**

Append to the `describe` in `web/src/stores/files.test.ts`:

```ts
  it("download fetches every chunk and decrypts it", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 2,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.download(meta);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 0);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 1);
    expect((cryptoApi.decryptChunk as any)).toHaveBeenCalledTimes(2);
  });

  it("openPreview decrypts and opens a modal payload for a small text file", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const createObjectURL = vi.fn(() => "blob:p");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).not.toBeNull();
    expect(files.preview!.kind).toBe("text");
    expect(files.preview!.url).toBe("blob:p");
  });

  it("openPreview rejects files that are too large to preview", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const files = useFilesStore();
    // decryptManifest mock returns size: 2; force it over the text cap
    (cryptoApi.decryptManifest as any).mockResolvedValueOnce({
      name: "big.txt", mime: "text/plain", size: 3 * 1024 * 1024,
      iv_base: "iv==", chunk_size: 4 * 1024 * 1024,
    });
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 0, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    expect(files.preview).toBeNull();
    expect(files.error).toMatch(/too large/i);
  });

  it("closePreview revokes the url and clears state", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:p"), revokeObjectURL: revoke });
    const files = useFilesStore();
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.openPreview(meta);
    files.closePreview();
    expect(revoke).toHaveBeenCalledWith("blob:p");
    expect(files.preview).toBeNull();
  });
```

Also re-add `import { cryptoApi } from "@/workers/crypto";` near the other imports if the file no longer has it (needed for `cryptoApi.decryptChunk` assertions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- files.test.ts`
Expected: FAIL (download still single-chunk; `preview`/`openPreview`/`closePreview` missing).

- [ ] **Step 3: Rewrite download + add preview in `stores/files.ts`**

Add the preview import at the top, and add `fromBase64` to the existing `@/crypto/file` import (Task 6 imported only `{ FILE_CHUNK_SIZE, chunkCount, toBase64 }`):

```ts
import { FILE_CHUNK_SIZE, chunkCount, toBase64, fromBase64 } from "@/crypto/file";
import { kindOf, canPreview, type FileKind } from "@/crypto/preview";
```

Add preview state near the other refs:

```ts
  const preview = ref<{
    meta: FileMeta;
    url: string;
    kind: FileKind;
    name: string;
  } | null>(null);
```

Add a small helper for saving a blob (used by both download and the existing flow):

```ts
  function saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
```

Replace the existing `download` action with the multi-chunk version:

```ts
  async function download(meta: FileMeta): Promise<void> {
    downloading.value = true;
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const manifest = await cryptoApi.decryptManifest(
        mk,
        meta.encrypted_file_key!,
        meta.encrypted_file_key_nonce!,
        meta.encrypted_manifest!,
        meta.encrypted_manifest_nonce!,
      );
      const fileKey = await cryptoApi.unwrap(
        {
          ciphertext: fromBase64(meta.encrypted_file_key!),
          iv: fromBase64(meta.encrypted_file_key_nonce!),
        },
        mk,
      );
      const ivBase = fromBase64(manifest.iv_base);
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          const resp = await filesApi.getChunk(meta.id, i);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
        },
      );
      saveBlob(new Blob(parts as BlobPart[], { type: manifest.mime }), manifest.name);
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      downloading.value = false;
    }
  }

  async function openPreview(meta: FileMeta): Promise<void> {
    error.value = null;
    try {
      await ensureCryptoReady();
      const mk = masterKey();
      const manifest = await cryptoApi.decryptManifest(
        mk,
        meta.encrypted_file_key!,
        meta.encrypted_file_key_nonce!,
        meta.encrypted_manifest!,
        meta.encrypted_manifest_nonce!,
      );
      const kind = kindOf(manifest.mime);
      if (!canPreview(kind, manifest.size)) {
        error.value = "File too large to preview — use Download.";
        return;
      }
      const fileKey = await cryptoApi.unwrap(
        {
          ciphertext: fromBase64(meta.encrypted_file_key!),
          iv: fromBase64(meta.encrypted_file_key_nonce!),
        },
        mk,
      );
      const ivBase = fromBase64(manifest.iv_base);
      const n = meta.chunk_count;
      const parts = new Array<Uint8Array>(n);
      await asyncPool(
        3,
        Array.from({ length: n }, (_, i) => i),
        async (i) => {
          const resp = await filesApi.getChunk(meta.id, i);
          const cipher = new Uint8Array(await resp.arrayBuffer());
          parts[i] = await cryptoApi.decryptChunk(fileKey, ivBase, i, cipher);
        },
      );
      const blob = new Blob(parts as BlobPart[], { type: manifest.mime });
      preview.value = {
        meta,
        url: URL.createObjectURL(blob),
        kind,
        name: manifest.name,
      };
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  function closePreview(): void {
    if (preview.value) {
      URL.revokeObjectURL(preview.value.url);
      preview.value = null;
    }
  }
```

Expose `preview`, `openPreview`, `closePreview` in the store `return { ... }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- files.test.ts`
Expected: PASS (all, including the 4 new tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/stores/files.ts web/src/stores/files.test.ts
git commit -m "feat(store): multi-chunk download + modal preview open/close"
```

---

### Task 8: Frontend — `FilePreviewModal.vue`

**Files:**
- Create: `web/src/components/FilePreviewModal.vue`
- Test: `web/src/components/FilePreviewModal.test.ts`

**Interfaces:**
- Props: `kind: FileKind`, `url: string`, `name: string`.
- Emits: `close`.
- Renders `<img>`/`<pre>`/`<audio controls>`/`<video controls>` by `kind`; backdrop click + Esc + close button emit `close`.

- [ ] **Step 1: Write the failing component test**

Create `web/src/components/FilePreviewModal.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import FilePreviewModal from "./FilePreviewModal.vue";

describe("FilePreviewModal", () => {
  it("renders an <img> for image kind", () => {
    const w = mount(FilePreviewModal, { props: { kind: "image", url: "blob:i", name: "a.png" } });
    expect(w.find("img").attributes("src")).toBe("blob:i");
  });

  it("renders a <video> for video kind", () => {
    const w = mount(FilePreviewModal, { props: { kind: "video", url: "blob:v", name: "a.mp4" } });
    expect(w.find("video").exists()).toBe(true);
  });

  it("renders an <audio> for audio kind", () => {
    const w = mount(FilePreviewModal, { props: { kind: "audio", url: "blob:a", name: "a.mp3" } });
    expect(w.find("audio").exists()).toBe(true);
  });

  it("renders decoded text for text kind", async () => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    const w = mount(FilePreviewModal, { props: { kind: "text", url: "blob:t", name: "a.txt" } });
    // wait for the fetch+decode cycle
    await vi.waitFor(() => {
      expect(w.find("pre").text().length).toBeGreaterThan(0);
    });
  });

  it("emits close on backdrop click", async () => {
    const w = mount(FilePreviewModal, { props: { kind: "image", url: "blob:i", name: "a.png" } });
    await w.find(".preview-backdrop").trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("emits close on Esc", async () => {
    const w = mount(FilePreviewModal, { props: { kind: "image", url: "blob:i", name: "a.png" } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await w.vm.$nextTick();
    expect(w.emitted("close")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --prefix web -- FilePreviewModal.test.ts`
Expected: FAIL (component missing).

- [ ] **Step 3: Implement the modal**

Create `web/src/components/FilePreviewModal.vue`:

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import type { FileKind } from "@/crypto/preview";

const props = defineProps<{ kind: FileKind; url: string; name: string }>();
const emit = defineEmits<{ close: [] }>();

const text = ref("");

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

async function loadText() {
  try {
    const res = await fetch(props.url);
    text.value = await res.text();
  } catch {
    text.value = "(unable to decode text)";
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (props.kind === "text") void loadText();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="preview-backdrop" @click.self="emit('close')">
    <div class="preview-card">
      <header>
        <span class="name">{{ name }}</span>
        <button class="link" @click="emit('close')">Close</button>
      </header>
      <div class="body">
        <img v-if="kind === 'image'" :src="url" :alt="name" />
        <pre v-else-if="kind === 'text'">{{ text }}</pre>
        <audio v-else-if="kind === 'audio'" controls :src="url" />
        <video v-else-if="kind === 'video'" controls :src="url" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.preview-card {
  background: var(--df-color-bg-elevated); border-radius: var(--df-radius-sm);
  max-width: 90vw; max-height: 90vh; overflow: auto; padding: 1rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}
header { display: flex; justify-content: space-between; align-items: center; }
.name { font-weight: 600; }
.body img, .body video { max-width: 85vw; max-height: 75vh; }
.body pre { white-space: pre-wrap; word-break: break-word; max-width: 80vw; }
.link { background: transparent; border: 0; cursor: pointer; color: var(--df-color-fg-muted); }
</style>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --prefix web -- FilePreviewModal.test.ts`
Expected: PASS. (For the text-kind test the `fetch("blob:t")` resolves via happy-dom's stubbed fetch; if happy-dom doesn't resolve blob: URLs, change the test to assert the `<pre>` element exists rather than non-empty — see step 5 caveat.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --prefix web`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/FilePreviewModal.vue web/src/components/FilePreviewModal.test.ts
git commit -m "feat(ui): FilePreviewModal renders image/text/audio/video"
```

---

### Task 9: Frontend — wire `DriveView.vue` (Open/Download/Delete, incomplete uploads, modal)

**Files:**
- Modify: `web/src/views/DriveView.vue`
- Test: manual + existing smoke tests; add a light component test `web/src/views/DriveView.test.ts` for the action wiring.

**Interfaces:**
- Consumes: `useFilesStore` (`files`, `activeUploads`, `preview`, `openPreview`, `download`, `remove`, `cancelUpload`, `closePreview`), `kindOf`/`canPreview` from `@/crypto/preview`, `FilePreviewModal`.

- [ ] **Step 1: Write a failing wiring test**

Create `web/src/views/DriveView.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DriveView from "./DriveView.vue";

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {},
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/api/files", () => ({
  filesApi: { list: vi.fn().mockResolvedValue({ files: [] }) },
}));

describe("DriveView", () => {
  it("renders an Open button only for previewable ready files", async () => {
    setActivePinia(createPinia());
    const w = mount(DriveView);
    await flushPromises();
    // No files → no Open buttons
    expect(w.findAll("button").some((b) => b.text() === "Open")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail or pass trivially, then proceed**

Run: `npm run test --prefix web -- DriveView.test.ts`
(If it already passes because there are no files, that's acceptable — the real assertion power is the manual + e2e flow; keep the test as a smoke guard.)

- [ ] **Step 3: Update `DriveView.vue`**

In `web/src/views/DriveView.vue`, add imports + helpers + actions. Update the `<script setup>` block:

```ts
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useFilesStore } from "@/stores/files";
import type { FileMeta } from "@/api/types";
import FilePreviewModal from "@/components/FilePreviewModal.vue";
```

Add helpers:

```ts
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function nameOf(f: FileMeta): string {
  return files.displayNames[f.id] ?? f.id;
}

/**
 * The mime lives in the (encrypted) manifest, so the list view can't know the
 * kind up front. Show Open for every ready file; openPreview surfaces the
 * "too large / unsupported" case via the store's `error`.
 */
function previewable(f: FileMeta): boolean {
  return f.status === "ready";
}
```

Add actions:

```ts
function open(f: FileMeta) {
  void files.openPreview(f).catch(() => {});
}
function download(f: FileMeta) {
  void files.download(f).catch(() => {});
}
function remove(f: FileMeta) {
  if (confirm(`Delete "${nameOf(f)}"?`)) void files.remove(f.id);
}
function cancel(fileId: string) {
  void files.cancelUpload(fileId);
}
```

In `<template>`, update the file list `<li>` actions and add the incomplete-uploads section + modal mount. Replace the existing `<ul class="list">...</ul>` actions block:

```html
      <ul class="list" v-if="files.files.length">
        <li v-for="f in files.files" :key="f.id">
          <span class="name">{{ nameOf(f) }}</span>
          <span class="meta">{{ fmtSize(f.total_size) }} · {{ f.status }}</span>
          <span class="actions">
            <button class="link" :disabled="!previewable(f)" @click="open(f)">Open</button>
            <button class="link" :disabled="f.status !== 'ready'" @click="download(f)">Download</button>
            <button class="link" @click="remove(f)">Delete</button>
          </span>
        </li>
      </ul>

      <section v-if="files.activeUploads.length" class="uploads">
        <h2>Incomplete uploads</h2>
        <ul class="list">
          <li v-for="u in files.activeUploads" :key="u.fileId">
            <span class="name">{{ u.file.name }}</span>
            <span class="meta">{{ Math.round(u.progress * 100) }}% · {{ u.phase }}</span>
            <progress :value="u.progress" max="1" />
            <button class="link" @click="cancel(u.fileId)">Cancel</button>
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
```

Add `.uploads { margin-top: 2rem; }` to the `<style scoped>` block.

- [ ] **Step 4: Typecheck + run full frontend suite**

Run: `npm run typecheck --prefix web`
Run: `npm run test --prefix web`
Expected: clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/DriveView.vue web/src/views/DriveView.test.ts
git commit -m "feat(ui): DriveView Open/Download/Delete + incomplete uploads + modal"
```

---

### Task 10: Docs + final full-stack verification

**Files:**
- Modify: `docs/api.md`

- [ ] **Step 1: Document the new endpoint + limit split in `docs/api.md`**

In `docs/api.md`, after the `GET /api/files/:id/manifest` section, add:

````markdown
### `GET /api/files/:id/chunks`

Returns the indices of chunks already stored on the server, plus the file's
declared `chunk_count` and current `status`. Used by clients to reconcile
resumable uploads (skip already-uploaded chunks).

Response:
```json
{ "indices": [0, 1, 3], "chunk_count": 10, "status": "pending" }
```

Returns `404` for an unknown id or a non-owner.
````

Update the `POST /api/files` size-limit sentence (currently mentions `limits.max_upload_bytes`):

```markdown
`total_size` must be `<= limits.max_file_bytes` (default 10 GiB) or the server
responds `413`.
```

Update the `PUT /api/files/:id/chunks/:idx` size-limit sentence:

```markdown
Responds `413` if the body exceeds `limits.max_chunk_bytes` (default 8 MiB).
```

- [ ] **Step 2: Run the full backend suite**

Run: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`
Expected: all PASS.

- [ ] **Step 3: Run the full frontend suite + typecheck + production build**

Run: `npm run test --prefix web`
Run: `npm run typecheck --prefix web`
Run: `npm run build --prefix web`
Expected: all green; build succeeds (the `fixLibsodiumImport` plugin must remain in place).

- [ ] **Step 4: Update README P2 status**

In `README.md`, update the Status table row for P2 to reflect partial completion:

```markdown
| P2 | Chunked upload/download, video streaming via MSE | 🚧 in progress (P2a: chunked upload/download + preview) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/api.md README.md
git commit -m "docs: P2a — GET /chunks endpoint, limit split, status"
```

---

## Verification summary

- Backend: `cargo test --manifest-path server/Cargo.toml -- --test-threads=1` — all green.
- Frontend: `npm run test --prefix web`, `npm run typecheck --prefix web`, `npm run build --prefix web` — all green.
- Manual smoke: upload a >4 MiB file (verify 2+ chunks via the incomplete-uploads progress), refresh the tab mid-upload is NOT required (session-only resume), cancel cleans the pending row, preview an image/text/audio/small-video, download bit-identical.
