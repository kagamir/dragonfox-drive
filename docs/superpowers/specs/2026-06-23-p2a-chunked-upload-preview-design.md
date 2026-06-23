# P2a: Chunked Upload/Download + Lightweight In-Browser Preview — Design

Status: approved (2026-06-23)
Implements: the first half of README P2. P2 is split into two sub-projects;
this is **P2a** (chunked foundation + preview). **P2b** will add MSE-based
large-video streaming with container-index parsing for byte-exact seeking.

## 1. Goal & scope

Break the P1 single-chunk / 100 MiB ceiling: support **~10 GB** end-to-end
encrypted files with parallel chunked upload, within-session resume + retry,
and in-browser preview for images / text / audio / small video. A tester can:
upload a multi-gigabyte file (with progress + cancel), resume across a
transient network drop, then click any small media/text file to preview it
inline (modal) and download any file bit-identical.

**In scope**
- Server: split the body/file-size limits; add `GET /api/files/:id/chunks`
  (resume reconciliation); multi-chunk `finalize` (already counts — verify).
- Frontend crypto: per-chunk encrypt/decrypt primitives exposed through the
  worker; manifest `plaintext_sha256` made optional.
- Upload: streaming `File.slice` + async pool (concurrency 3) + retry +
  within-session resume via server reconciliation; cancel = abort + cleanup.
- Download: multi-chunk fetch/decrypt/concatenate → blob.
- Preview: modal viewer rendering `<img>` / `<pre>` / `<audio>` / `<video>`
  from a decrypted blob URL, with per-type size caps.
- UI: `DriveView` actions + incomplete-uploads list + `FilePreviewModal`.
- Docs: update `docs/api.md` (new endpoint, limit split).

**Out of scope (deferred)**
- MSE video streaming, container-index (moov/Cues) parsing, byte-exact seek,
  IndexedDB LRU cache → **P2b**.
- Per-chunk byte-Range on `GET /chunks/:idx` (P2b needs it for fine streaming).
- Cross-session resume (re-selecting a file to continue an abandoned upload),
  File System Access API persistence, background upload.
- GC sweep for abandoned `pending` files + leftover chunks.
- Whole-file `plaintext_sha256` for multi-chunk files (see §3 decision).

## 2. Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Upload memory model | **Streaming per-chunk slice** (`File.slice(i*4MiB,…)` → encrypt → PUT → release), concurrency 3 | Only memory-constant option for 10 GB; whole-file encrypt (P1-style) would hold O(file) bytes and crash the tab. |
| Chunk size | **4 MiB** plaintext (unchanged) | Matches `crypto-design.md` / `streaming.md`; AES-GCM friendly; ~6s of 1080p — good granularity for P2b seek. |
| Resume level | **Within-session** + server reconciliation | `put_chunk` is already idempotent (`ON CONFLICT DO UPDATE`); a `GET /chunks` endpoint lets the client skip server-present indices on (re)start/retry. Cross-session needs re-accessing the File — deferred. |
| Limit config split | `max_chunk_bytes` (8 MiB, request body) **separate from** `max_file_bytes` (10 GiB, total file) | P1 conflated both into `max_upload_bytes`; a stale `0` value caused the 413-on-login regression. Distinct names make each limit's role unambiguous. |
| `plaintext_sha256` | **Omitted (empty) for new uploads** | WebCrypto has no streaming SHA; computing it over 10 GB means holding the whole file. Per-chunk AES-GCM tags already authenticate every chunk. Field stays in the manifest schema for backward-compatible reads of P1 files. |
| Preview rendering | Native elements from a decrypted **blob URL** in a modal | Simplest robust approach for image/text/audio/small-video; no custom codecs. P2b replaces the large-video path with MSE. |
| Cancel semantics | Abort in-flight XHRs **and** `DELETE` the pending file | Avoids littering `pending` rows + orphan chunks; resume is automatic for non-user-initiated failures (session kept in memory). |

## 3. Data flow

### Upload (multi-chunk, memory-constant)

```
user picks File
   │
   ▼
worker.generateKey()  ──► fileKey (32B), ivBase (12B)
   │
   ▼
masterKey.wrap(fileKey) ──► POST /api/files { total_size, chunk_count,
                         │     encrypted_file_key, encrypted_file_key_nonce } ──► file_id (pending)
                         │
                         ▼
              worker.encrypt(manifestJSON, fileKey)
                         │
                         ▼  PUT /api/files/:id/manifest
   │
   ▼
GET /api/files/:id/chunks  ──► done = Set(present indices)   ◄── resume reconciliation
   │
   ▼
async-pool(concurrency=3) over indices NOT in done:
   File.slice(i*4MiB, (i+1)*4MiB).arrayBuffer()
      │
      ▼
   worker.encryptChunk(fileKey, ivBase, i, plaintext)  ──► ciphertext
      │
      ▼   PUT /api/files/:id/chunks/:i   (XHR, onProgress → aggregate)
      │       on failure: retry ≤3 w/ exp. backoff
      ▼
   done.add(i);  progress = (done*4MiB + inFlightBytes) / size
   │
   ▼  (all indices done)
POST /api/files/:id/finalize  ──► ready
```

### Download / preview

```
GET /api/files/:id/manifest ──► worker.decryptManifest ──► { name, mime, size, chunk_size, iv_base }
   │
   ▼
async-pool over 0..chunk_count-1:
   GET /api/files/:id/chunks/:i ──► worker.decryptChunk(fileKey, ivBase, i) ──► plaintext[i]
   │
   ▼
new Blob(plaintext[], { type: mime }) ──► object URL
   │
   ├─► Download : <a href=url download=name>.click()
   └─► Preview  : FilePreviewModal renders <img>/<pre>/<audio>/<video> by kind
                 (close revokes the URL)
```

## 4. Backend changes (`server/`)

### 4.1 Configuration split

`Limits` (in `config.rs`) replaces `max_upload_bytes` with:

```rust
pub struct Limits {
    pub max_chunk_bytes: u64,  // per request/chunk body — default 8 MiB
    pub max_file_bytes: u64,   // total file size          — default 10 GiB
}
```

- `config.toml` `[limits]` section migrated to the two new keys.
- `DefaultBodyLimit::max(max_chunk_bytes)` becomes the router-wide body cap
  (8 MiB comfortably covers a 4 MiB chunk + GCM tag + overhead, and all auth
  JSON). The 413 regression guard (limit `0` → every body rejected) is
  preserved against `max_chunk_bytes`.
- `create` validates `total_size <= max_file_bytes` (was `max_upload_bytes`).
- `put_chunk` validates body length `<= max_chunk_bytes`.
- `max_file_bytes` default 10 GiB (`10 * 1024 * 1024 * 1024`).

### 4.2 New endpoint: `GET /api/files/:id/chunks`

Auth + owner-scoped. Returns the uploaded chunk indices so the client can
reconcile resume:

```json
{ "indices": [0, 1, 3], "chunk_count": 10, "status": "pending" }
```

- Reads `SELECT idx FROM file_chunks WHERE file_id = ? ORDER BY idx` plus the
  file's `chunk_count` + `status`.
- 404 for unknown id / non-owner (consistent with sibling endpoints).

### 4.3 Everything else

- `put_chunk`: unchanged logic (already idempotent via `ON CONFLICT DO
  UPDATE`); only the limit field name changes.
- `finalize`: already counts `file_chunks` vs `chunk_count` — works for
  multi-chunk as-is; add a multi-chunk test.
- `get_chunk`: stays whole-chunk (no byte-Range in P2a; Range is P2b).
- **Doc fix**: `docs/streaming.md` claims `get_chunk` honors `Range` today;
  it does not yet. Leave the doc as the P2b target, note the gap in code.

### 4.4 Test updates

The router-integration + config tests written for the 413 fix reference
`limits.max_upload_bytes`; they move to `max_chunk_bytes` (same semantics for
the body-limit path), and the `0 → 413` regression guard is kept. A new
config assertion checks the `max_file_bytes` default.

## 5. Frontend crypto / chunk model (`web/src/crypto/`)

- `symmetric.ts`: `encryptChunk` / `decryptChunk` / `chunkIv` already exist —
  reused unchanged.
- `file.ts` additions:
  - `chunkCount(size: number, chunkSize = FILE_CHUNK_SIZE): number`
  - `encryptFileChunk(fileKey, ivBase, index, plaintext)` → ciphertext
    (thin wrapper: `encryptChunk(fileKey, chunkIv(ivBase, index), plaintext)`)
  - `decryptFileChunk(fileKey, ivBase, index, ciphertext)` → plaintext
  - `Manifest.plaintext_sha256` becomes optional (`plaintext_sha256?`);
    new uploads leave it empty.
- `crypto.worker.ts`: exposes `encryptChunk` and `decryptChunk` over Comlink
  (per-chunk crypto off the main thread). The legacy whole-file
  `encryptFile`/`decryptFile` stay for the single-chunk fast path / existing
  tests.

## 6. Upload orchestration (`stores/files.ts`)

- New reactive `activeUploads: Ref<UploadSession[]>` (in-tab; drives the
  incomplete-uploads UI + resume).
- `UploadSession = { fileId, file, fileKey, ivBase, chunkCount, chunkSize,
  done: Set<number>, phase, progress, abort: AbortController }`.
- `upload(file)`:
  1. `ensureCryptoReady()`; worker generates `fileKey` + `ivBase`;
     `chunkCount = chunkCount(file.size)`.
  2. wrap `fileKey` → `filesApi.create(...)` → `fileId`.
  3. build manifest, worker-encrypt, `filesApi.putManifest`.
  4. `filesApi.getChunks(fileId)` → seed `done`.
  5. async-pool(3) over missing indices: slice → worker.encryptChunk →
     `putChunk(i, onProgress, abort.signal)`; retry ≤3 on failure.
  6. `filesApi.finalize(fileId)` → `refresh()`.
- Progress aggregation: `progress = (done.size * chunkSize + inFlightBytes) /
  size`, clamped; each chunk's XHR `upload.onprogress` feeds `inFlightBytes`.
- **Resume**: transient failure → retry the chunk (session in memory);
  (re)start → `GET /chunks` reconciliation skips server-present indices.
- **Cancel** (user button): `abort` cancels in-flight XHRs; best-effort
  `DELETE /api/files/:id` removes the pending row + chunks; session removed
  from `activeUploads`.
- Navigate-away: `pending` row lingers (no GC — known limitation).

## 7. Download & preview

- `download(meta)`: fetch + decrypt all chunks → `Blob({ type: mime })` →
  `<a download>`. Memory O(file size); very-large download UX is improved by
  P2b streaming (noted as a known limitation, not a blocker).
- `openPreview(meta)`: ensure manifest decrypted (fetch on demand) →
  `kindOf(mime)` → decrypt to blob URL → open modal.
- `kindOf(mime)`:
  - `image/*` → `image`
  - `text/*`, `application/json`, `application/xml`, `application/javascript`
    → `text`
  - `audio/*` → `audio`
  - `video/*` → `video`
  - else → `other` (no preview; Download only)
- Preview size caps (in-memory decode budget):
  - `text` ≤ **2 MiB**
  - `image` / `audio` / `video` ≤ **256 MiB**
  - over cap → modal shows "too large to preview, use Download".
- `FilePreviewModal.vue` renders the right element for `kind`; Esc / click
  backdrop / close button closes and `URL.revokeObjectURL`s.

## 8. UI (`DriveView.vue` + modal)

- File row actions: `[Open]` (when `canPreview(kind, size)` and `ready`),
  `[Download]` (`ready`), `[Delete]`.
- New "Incomplete uploads" section: lists `activeUploads` with a progress bar
  and `[Cancel]`.
- `<FilePreviewModal>` mounted at the page root, driven by a reactive
  `{ meta, url, kind } | null`.
- Helpers: `kindOf(mime)`, `canPreview(kind, size)`.

## 9. Edge cases & backward compatibility

- P1 single-chunk files (`chunk_count = 1`): new download/preview path fetches
  chunk 0 only → works unchanged.
- `plaintext_sha256`: new uploads omit it; readers ignore a missing field.
- Duplicate/retried `put_chunk` on the same index: idempotent, no dupe row.
- `finalize` before all chunks present: server rejects (count mismatch).
- Non-owner access to any endpoint: 404 (existing owner isolation).
- Cancel cleans the server pending row; transient failure keeps it
  (auto-resume within the session).
- `max_upload_bytes` is no longer read by code after the rename; `config.toml`
  is migrated in the same change.

## 10. Testing strategy

### Backend (`cargo test`, run with `--test-threads=1` for CWD tests)
- `create` accepts `total_size` up to `max_file_bytes`; rejects above; accepts
  `chunk_count > 1`.
- `GET /chunks`: correct indices + `chunk_count` + `status`; non-owner 404;
  empty set for a fresh pending file.
- `put_chunk` idempotency: re-PUT same index updates the row, no duplicate.
- Multi-chunk `finalize` success; missing-chunk rejection.
- Updated router-integration + config tests: `max_upload_bytes` →
  `max_chunk_bytes`; keep the `0 → 413` regression guard; assert
  `max_file_bytes` default.

### Frontend (vitest; conventions: `vi.stubGlobal`, no msw, mock localforage,
`vi.hoisted` for the worker)
- `encryptFileChunk` / `decryptFileChunk` round-trip; multi-chunk concatenate
  equals original plaintext; `chunkIv` differs per index.
- Worker exposes `encryptChunk` / `decryptChunk` (Comlink mocked).
- `upload` store action (mocked `filesApi`): asserts create → manifest →
  parallel puts → finalize sequence; `GET /chunks` skips already-present
  indices; failed chunk retries; progress aggregates correctly.
- `download` store action: multi-chunk decrypt + concatenate.
- Preview: `kindOf` classification; over-cap message; Esc closes and revokes
  the object URL.

## 11. Open questions / risks

- **10 GB download memory**: assembling a single 10 GB Blob may strain the
  tab. Mitigation for P2a: preview caps keep media in-budget; raw download of
  a 10 GB file works best-effort and is improved by P2b's streaming save.
- **Abandoned uploads litter storage**: no GC in P2a; documented as a known
  limitation. A future TTL sweep (`status='pending' AND updated_at < ...`)
  is trivial to add.
- **Concurrency vs. server write contention**: 3 parallel PUTs target
  distinct chunk files/rows — no contention expected; verified by the
  idempotency test.
