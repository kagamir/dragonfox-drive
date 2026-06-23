# P1: Single-Chunk File Upload / Download — Design

Status: approved (2026-06-23)
Implements: README P1 "single-chunk upload/download" (the last remaining P1
pillar after scaffolding + E2EE auth).

## 1. Goal & scope

Deliver a complete, manually-testable end-to-end-encrypted file upload +
download loop so a tester can: sign in, upload a file (drag or pick), see it
in a list with its real decrypted name, download it back bit-identical, and
delete it.

**In scope**
- Server: implement all 8 stub handlers in `server/src/api/files.rs`.
- DB: one migration adding the `file_key` persistence columns.
- Frontend: Web-Worker file encrypt/decrypt helpers, `files` store upload/
  download/remove actions, `DriveView.vue` upload UI + file list + actions.
- Docs: update `docs/api.md` (create body + put_chunk raw body).

**Out of scope (YAGNI — deferred to later phases)**
- Multi-chunk file splitting (P2).
- HTTP Range / MSE video streaming (P2).
- Encrypted folder tree (P3).
- Link sharing (P3).
- Resumable / chunked upload, progress cancellation, concurrent upload queue.
- Device management & revocation (P4).

## 2. Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| File-size model | Whole file as **one** AES-GCM chunk (`chunk_count=1`, `chunkIndex=0`) | Matches README "single-chunk"; simplest path to P1. Practical limit ~100 MiB (config-enforced). P2 adds 4 MiB splitting + Range. |
| `file_key` persistence | **New columns** `files.encrypted_file_key` + `encrypted_file_key_nonce` (master_key-wrapped) | Conforms to `crypto-design.md` ("random per file"); standard E2EE; key is independently rotatable; trivially re-wrapped for future shares. |
| Crypto execution | All file encrypt/decrypt in the **Web Worker** via Comlink | `crypto-design.md` mandates UI never blocks; worker already exposes chunk primitives. |
| File list names | `list` returns `encrypted_manifest`; client decrypts to show real names | P1 file counts are tiny; better UX than opaque ids. |
| `put_chunk` body | **Raw octet-stream body**, not multipart | Single whole-file chunk has no benefit from multipart; avoids axum `Multipart` 2 MiB default limit and an encoding layer. |

## 3. Data flow

### 3.1 Upload (whole-file single chunk)

```
user picks/drops File
  → File.arrayBuffer()
  → [worker] gen file_key(32B) + iv_base(12B random)
  → [worker] encryptChunk(file_key, chunkIv(iv_base, 0), plaintext) → ciphertext
  → [worker] wrapMasterKey(file_key, master_key) → wrapped_file_key {ct, nonce}
  → [worker] manifest = {version,name,mime,size,chunk_size,iv_base,sha256,created_at}
  → [worker] encrypt(file_key, JSON(manifest)) → encrypted_manifest {ct, nonce}
  POST /api/files {total_size, chunk_count:1, encrypted_file_key, encrypted_file_key_nonce} → {id}
  PUT /api/files/:id/manifest {encrypted_manifest, encrypted_manifest_nonce}
  PUT /api/files/:id/chunks/0   body=ciphertext   (Content-Type: application/octet-stream)   ← progress
  POST /api/files/:id/finalize → status=ready
  → refresh list
```

### 3.2 Download

```
meta from list cache (or GET /api/files/:id/manifest)
  → [worker] unwrap(wrapped_file_key, master_key) → file_key
  → [worker] decrypt(file_key, encrypted_manifest, nonce) → manifest {name, mime, iv_base, ...}
  GET /api/files/:id/chunks/0 → ciphertext
  → [worker] decryptChunk(file_key, chunkIv(iv_base, 0), ciphertext) → plaintext
  → Blob([plaintext], {type: manifest.mime}); a[download=manifest.name]
```

### 3.3 Manifest plaintext structure (matches crypto-design.md)

```json
{
  "version": 1,
  "name": "report.pdf",
  "mime": "application/pdf",
  "size": 12345,
  "chunk_size": 4194304,
  "iv_base": "<base64 12 bytes>",
  "plaintext_sha256": "<hex>",
  "created_at": "<RFC-3339>"
}
```

`chunk_size` is recorded for forward-compatibility with P2 but is not used to
split in P1 (the whole file is a single chunk regardless of size).

## 4. Server implementation

### 4.1 Migration

New file `server/migrations/20260101000002_files_file_key.sql`:

```sql
ALTER TABLE files ADD COLUMN encrypted_file_key TEXT;
ALTER TABLE files ADD COLUMN encrypted_file_key_nonce TEXT;
```

Both are written by `create` at upload start, so they are non-null for any
row that reaches `status=ready`. Existing rows (test fixtures) tolerate NULL.

### 4.2 `create` request (extended; update api.md)

```json
{
  "total_size": 12345,
  "chunk_count": 1,
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>"
}
```

`chunk_count` is validated `>= 1`; `total_size` validated `> 0` and
`<= limits.max_upload_bytes` (else 413).

### 4.3 Handler behaviour

All handlers except `list`/`create` first resolve the file row with
`SELECT ... FROM files WHERE id = ? AND owner_id = ?`; absence yields **404**
(no distinguishable 403 — owner is part of the filter, so a non-owner never
learns the row exists).

| Handler | Behaviour |
|---------|-----------|
| `list` | `SELECT` owner's files where `status != 'deleted'`; return full meta incl. encrypted manifest + file_key columns. |
| `create` | validate body; `INSERT files(id=uuid, owner_id, status='pending', total_size, chunk_count, encrypted_file_key, encrypted_file_key_nonce)`; return `{id, upload_url}`. |
| `put_manifest` | owner check; `UPDATE files SET encrypted_manifest=?, encrypted_manifest_nonce=?, updated_at=now`. |
| `get_manifest` | owner check; `SELECT encrypted_manifest, encrypted_manifest_nonce`. |
| `put_chunk` | owner check; read raw `Bytes`; enforce `len <= max_upload_bytes` (413); `storage::write_chunk`; `INSERT INTO file_chunks(file_id, idx, cipher_size, storage_path)`. Idempotent on re-upload via `ON CONFLICT (file_id, idx) DO UPDATE SET cipher_size=excluded, storage_path=excluded`. |
| `get_chunk` | owner check + `status='ready'`; `storage::read_chunk` → body with `Content-Type: application/octet-stream`. (Range header tolerated by the browser's fetch layer; full body returned.) |
| `finalize` | owner check; `SELECT count(*) FROM file_chunks WHERE file_id=?`; require `== chunk_count` else 400; `UPDATE files SET status='ready', updated_at=now`. |
| `delete` | owner check; `UPDATE files SET status='deleted'`; `storage::delete_file_chunks`. (Soft-delete keeps the row for audit; hard delete of chunks on disk.) |

### 4.4 Configuration

- `limits.max_upload_bytes` default changes from `0` to `100 * 1024 * 1024`
  (100 MiB). `0` previously meant "unset"; an explicit cap prevents accidental
  memory blowup since the whole file lands in one body.
- The axum router layers `DefaultBodyLimit::max(max_upload_bytes)` so the
  `Bytes` extractor accepts the single-chunk body.

### 4.5 Error mapping (already in `error.rs`)

- Non-owner / missing file → `ApiError::NotFound` (404).
- Oversized body → `ApiError::PayloadTooLarge` (413).
- Finalize count mismatch → `ApiError::BadRequest` (400).
- sqlx errors auto-convert via the existing `From<sqlx::Error>`.

## 5. Frontend implementation

### 5.1 Web Worker (`web/src/workers/crypto.worker.ts`)

Add three high-level Comlink methods reusing existing primitives
(`generateFileKey`, `randomBytes`, `wrapMasterKey`, `encrypt`, `encryptChunk`,
`chunkIv`, and their decrypt counterparts):

```ts
encryptFile(masterKey, plaintext: Uint8Array, name: string, mime: string)
  → { ciphertext, wrappedFileKey: {ct, nonce}, encryptedManifest: {ct, nonce} }

decryptManifest(masterKey, wrappedFileKey, encryptedManifest) → Manifest

decryptFile(masterKey, wrappedFileKey, encryptedManifest, ciphertext)
  → Uint8Array   // convenience: decryptManifest then decryptChunk
```

A `Manifest` TypeScript interface is added (mirrors §3.3). Base64 / hex
encoding helpers live alongside (the store converts wire strings ↔ bytes).

### 5.2 `stores/files.ts`

State additions: `uploading: Ref<boolean>`, `uploadProgress: Ref<number>` (0..1),
`downloading: Ref<boolean>`.

- `upload(file: File, masterKey: RawKey)` — reads `arrayBuffer`, calls
  `worker.encryptFile`, then `filesApi.create → putManifest → putChunk
  (with XHR `onprogress` → `uploadProgress`) → finalize`, then `refresh()`.
  Errors surface via `error` ref and rethrow so the view can toast.
- `download(meta: FileMeta, masterKey: RawKey)` — `filesApi.getChunk` →
  `worker.decryptFile` → `Blob` → synthetic `<a download>` click.
- `remove(id: string)` — `filesApi.delete` → `refresh()`.
- After `refresh()`, decrypt each row's manifest in the worker to populate a
  derived `displayNames: Record<id,string>` (best-effort; failures leave the
  id).

`masterKey` is read from the `auth` store (already held in memory after login).

### 5.3 `api/types.ts` + `api/files.ts`

- `CreateFileRequest` gains `encrypted_file_key`, `encrypted_file_key_nonce`.
- `FileMeta` gains the same two fields.
- `filesApi.putChunk` switches from `FormData` to a raw body PUT
  (`Content-Type: application/octet-stream`, body = ciphertext bytes).
- `filesApi.putChunk` gains an optional `onProgress: (ratio: number) => void`
  wired to the underlying XHR.

### 5.4 `DriveView.vue`

- Drop zone + hidden `<input type="file">` triggered by click.
- Upload progress bar bound to `files.uploadProgress`.
- File list: decrypted name (fallback to id), formatted size, created date.
  Per-row **Download** and **Delete** buttons.
- Empty state: "No files yet — drop one here."
- Loading / error banners reuse existing CSS variables.

### 5.5 Docs

`docs/api.md` updated: `create` body gains the two file_key fields; `put_chunk`
described as raw octet-stream body (no multipart).

## 6. Testing strategy

### Server (Rust)
Each handler gets at least one happy-path test plus the relevant error path,
using the established `test_state_with_db` helper and a synthetic `AuthUser`:
- `list` returns only the caller's files (other owner hidden).
- `create` inserts a pending row.
- `put_manifest` / `get_manifest` round-trip.
- `put_chunk` writes a chunk row + bytes; 413 when body exceeds limit.
- `finalize` flips to ready; 400 when chunk count mismatched.
- `delete` soft-deletes + removes on-disk chunks.
- Ownership: a second user's requests 404 on someone else's file.

### Frontend (Vitest)
- Worker: `encryptFile` → `decryptFile` byte-identical round-trip across
  several sizes (empty, 1 B, 1 MiB).
- `files` store: `upload` and `download` against a mocked `filesApi`,
  asserting the call sequence and final state.

### Smoke (manual)
Register → upload a small file → reload page (session restored) → file still
listed with decrypted name → download → verify byte-identical → delete → gone.

## 7. Open questions

None. All decisions resolved during brainstorming.
