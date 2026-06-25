# HTTP API

Base URL: same-origin in production, `http://127.0.0.1:8080` in development
(Vite proxies `/api` → backend).

All requests/responses are JSON unless noted. Errors use the envelope
`{ "error": "<message>" }` with an appropriate HTTP status.

## Authentication

### `POST /api/auth/register`

Request:
```json
{
  "username": "alice",
  "auth_verifier": "<hex>",
  "kdf_salt": "<hex>",
  "server_salt": "<hex>",
  "encrypted_master_key": "<base64 AES-GCM ciphertext>",
  "encrypted_master_key_nonce": "<base64 12-byte IV>"
}
```

Response `200`:
```json
{
  "user_id": "uuid",
  "username": "alice",
  "encrypted_master_key": "<base64>",
  "encrypted_master_key_nonce": "<base64>",
  "kdf_salt": "<hex>",
  "tokens": {
    "access_token": "<jwt>",
    "refresh_token": "<jwt>",
    "expires_in": 900
  }
}
```

### `POST /api/auth/login`

```json
{ "username": "alice", "auth_verifier": "<hex>", "device_name": "laptop" }
```

Same response shape as register.

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

### `POST /api/auth/refresh`

```json
{ "refresh_token": "<jwt>" }
```

Returns a new `TokenPair`.

## Files

All `/api/files*` endpoints require `Authorization: Bearer <access_token>`.

> **Note:** `/api/stream/:id` is a **virtual** URL handled entirely by the
> browser's Service Worker; it never reaches the backend. The SW serves the
> browser's Range requests by fetching and decrypting
> `GET /api/files/:id/chunks/:idx`. See [docs/streaming.md](streaming.md).

### `GET /api/files`

Response:
```json
{ "files": [ { "id": "...", "status": "ready", ... } ] }
```

Only opaque metadata; the manifest itself is encrypted.

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

`total_size` must be `<= limits.max_file_bytes` (default 10 GiB) or the server
responds `413`.

### `PUT /api/files/:id/manifest`

```json
{
  "encrypted_manifest": "<base64>",
  "encrypted_manifest_nonce": "<base64>"
}
```

### `GET /api/files/:id/manifest`

Returns the stored (still-encrypted) manifest blob + nonce.

### `GET /api/files/:id/chunks`

Returns the indices of chunks already stored on the server, plus the file's
declared `chunk_count` and current `status`. Used by clients to reconcile
resumable uploads (skip already-uploaded chunks).

Response:
```json
{ "indices": [0, 1, 3], "chunk_count": 10, "status": "pending" }
```

Returns `404` for an unknown id or a non-owner.

### `PUT /api/files/:id/chunks/:idx`

`Content-Type: application/octet-stream`. The request body is the raw
encrypted chunk bytes (single whole-file chunk in P1). Server stores it as an
opaque blob at `<data_dir>/blobs/<shard1>/<shard2>/<file_id>/chunk_<idx>`.
Responds `413` if the body exceeds `limits.max_chunk_bytes` (default 8 MiB).

### `GET /api/files/:id/chunks/:idx`

Returns the raw encrypted bytes. Supports standard `Range` headers for
partial chunk fetches.

### `POST /api/files/:id/finalize`

Marks the file as `ready` after all chunks have been uploaded. Server verifies
the expected chunk count.

### `DELETE /api/files/:id`

**Hard** delete: removes the file's metadata row and all of its chunks on
disk. (Aligned with the folder cascade delete in `DELETE /api/folders/:id` —
there is no soft-delete / trash.) Returns `404` if the id is unknown or not
owned by the caller.

## Folders

All `/api/folders*` endpoints require `Authorization: Bearer <access_token>`.
Folders are zero-knowledge: the server stores only opaque encrypted blobs and
never sees names or structure. The client downloads every folder row and
builds the tree locally (see [crypto-design.md](crypto-design.md#folder-tree-p3)).

> All endpoints in this section are owner-scoped: any id the caller does not
> own returns `404`, never `403` (no information leak). A file's
> `encrypted_parent_id`/`encrypted_parent_id_nonce` columns (see
> `GET /api/files`) are `null` for a root file and point at a folder otherwise.

### `GET /api/folders`

Returns **every** folder owned by the caller — the client builds the tree.

Response:
```json
{
  "folders": [
    {
      "id": "uuid",
      "encrypted_parent_id": "<base64 or null>",
      "encrypted_parent_id_nonce": "<base64 or null>",
      "encrypted_folder_key": "<base64>",
      "encrypted_folder_key_nonce": "<base64>",
      "encrypted_name": "<base64>",
      "encrypted_name_nonce": "<base64>",
      "created_at": "2026-06-22T10:00:00Z",
      "updated_at": "2026-06-22T10:00:00Z"
    }
  ]
}
```

`encrypted_parent_id` is `null` for a root folder. It is encrypted with
`master_key` (never the folder's own key); `encrypted_folder_key` is wrapped
by the parent folder's `folder_key` (or `master_key` for a root folder);
`encrypted_name` is encrypted with the folder's own `folder_key`.

### `POST /api/folders`

```json
{
  "encrypted_folder_key": "<base64>",
  "encrypted_folder_key_nonce": "<base64>",
  "encrypted_name": "<base64>",
  "encrypted_name_nonce": "<base64>",
  "encrypted_parent_id": "<base64>",
  "encrypted_parent_id_nonce": "<base64>"
}
```

For a root folder, omit `encrypted_parent_id` and `encrypted_parent_id_nonce`
(or send them as `null`).

Response: `{ "id": "uuid" }`.

### `PATCH /api/folders/:id`

Renames and/or moves a folder. The client supplies the already re-encrypted
fields; the server does no crypto. Send only the fields you want to change:

```json
{
  "encrypted_name": "<base64>",
  "encrypted_name_nonce": "<base64>",
  "encrypted_parent_id": "<base64 or null>",
  "encrypted_parent_id_nonce": "<base64 or null>",
  "encrypted_folder_key": "<base64>",
  "encrypted_folder_key_nonce": "<base64>"
}
```

- **Rename:** send `encrypted_name` + `encrypted_name_nonce`.
- **Move:** send the new `encrypted_parent_id`(+`_nonce`). On a move the
  client must re-wrap the folder's key under the new parent (or `master_key`
  for a root move), so send `encrypted_folder_key` +
  `encrypted_folder_key_nonce` too. Move to root by sending
  `encrypted_parent_id` and `encrypted_parent_id_nonce` as `null`.
- At least one field besides the implicit `updated_at` must be present, or
  the server responds `400`.
- Returns `404` if the id is unknown or not owned by the caller.

Response: `{ "ok": true }`.

### `DELETE /api/folders/:id`

Cascade **hard** delete of a folder and its entire descendant set. The server
does not know the tree shape, so the client computes the full descendant set
and lists it in the body:

```json
{
  "folder_ids": ["<root of the subtree>", "<child folder>"],
  "file_ids": ["<descendant file>"]
}
```

- The path `:id` (the deletion target) **must** appear in `folder_ids`.
- Every listed id must be owned by the caller. If any id in `folder_ids` or
  `file_ids` is not owned, the whole operation is rolled back and the server
  responds `404` (the affected row counts won't match).
- Folder rows and file rows are deleted transactionally; chunks for the
  deleted files are removed from disk afterwards.

Response:
```json
{ "ok": true, "deleted_folders": 3, "deleted_files": 5 }
```

### `PATCH /api/files/:id`

Moves a file to a new parent folder (or to root). The client supplies the
already re-wrapped `file_key` (under the new parent's `folder_key`, or
`master_key` for a root file) and the new encrypted parent pointer; the
server does no crypto.

```json
{
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>",
  "encrypted_parent_id": "<base64 or null>",
  "encrypted_parent_id_nonce": "<base64 or null>"
}
```

Move to root by sending `encrypted_parent_id` and `encrypted_parent_id_nonce`
as `null` (or omitting them). Returns `404` if the id is unknown or not owned
by the caller.

Response: `{ "ok": true }`.

## Shares

### `POST /api/shares` (auth required)

```json
{
  "file_id": "uuid",
  "share_salt": "<base64>",
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>",
  "password_hash": "<optional hex SHA-256(share_key)>",
  "expires_at": "RFC-3339 | null",
  "download_limit": <u32 | null>
}
```
Validates the file is owned, `ready`, and has a manifest; `expires_at` must be
future; `download_limit >= 1`. Response: `{ "id": "share_uuid" }`.

### `GET /api/shares` (auth required)

Query: `?file_id=<uuid>`. Lists the caller's shares for that file (management
metadata only — no ciphertext):

```json
{ "shares": [ { "id": "...", "state": "active|expired|exhausted|revoked",
  "requires_password": false, "expires_at": null, "download_limit": null,
  "download_count": 0, "revoked_at": null, "created_at": "..." } ] }
```

### `GET /api/shares/:id` (public)

The "open". Not found → `404`. Non-active → `200 { id, state, requires_password }`
(no key, no manifest, **no count**). Active + no password → `200` with the full
`{ share_salt, encrypted_file_key(+_nonce), encrypted_manifest(+_nonce),
requires_password:false, state:"active" }` **and increments `download_count`**.
Active + password → `200 { id, state:"active", requires_password:true,
share_salt }` (key withheld, **no count**).

### `POST /api/shares/:id/verify` (public)

Body: `{ "password_verifier": "<hex SHA-256(share_key)>" }`. Only for
password-protected shares (`400` otherwise). Non-active → `403`. Wrong verifier
→ `401` (no count). Match → **increments `download_count`** and returns
`{ state:"active", encrypted_file_key(+_nonce), encrypted_manifest(+_nonce) }`.

### `GET /api/shares/:id/chunks/:idx` (public)

Checks the share is **not revoked and not expired** (intentionally NOT
`exhausted`: exhaustion only blocks new opens, not in-flight streams) and the
file is `ready`, then returns raw encrypted bytes (Range supported). Does not
require the password — chunks are opaque ciphertext. Does not increment.

### `DELETE /api/shares/:id` (auth required)

Sets `revoked_at` (soft). `404` if not the owner.

### Counting rule

`download_count` increments exactly once per **file_key disclosure**: on `GET`
(no-password) or on successful `verify` (password). Chunks never count.

## Status codes

| Code | Meaning                                 |
|------|-----------------------------------------|
| 200  | Success                                 |
| 400  | Malformed request body / parameters     |
| 401  | Missing or invalid bearer token         |
| 403  | Authenticated but not the resource owner |
| 404  | Resource not found                      |
| 409  | Conflict (e.g. username already taken)|
| 413  | Chunk exceeds `max_chunk_bytes`         |
| 500  | Internal server error (logged)          |
