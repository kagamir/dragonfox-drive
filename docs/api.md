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

`total_size` must be `<= limits.max_upload_bytes` (default 100 MiB) or the
server responds `413`.

### `PUT /api/files/:id/manifest`

```json
{
  "encrypted_manifest": "<base64>",
  "encrypted_manifest_nonce": "<base64>"
}
```

### `GET /api/files/:id/manifest`

Returns the stored (still-encrypted) manifest blob + nonce.

### `PUT /api/files/:id/chunks/:idx`

`Content-Type: application/octet-stream`. The request body is the raw
encrypted chunk bytes (single whole-file chunk in P1). Server stores it as an
opaque blob at `<data_dir>/blobs/<shard1>/<shard2>/<file_id>/chunk_<idx>`.
Responds `413` if the body exceeds `limits.max_upload_bytes`.

### `GET /api/files/:id/chunks/:idx`

Returns the raw encrypted bytes. Supports standard `Range` headers for
partial chunk fetches.

### `POST /api/files/:id/finalize`

Marks the file as `ready` after all chunks have been uploaded. Server verifies
the expected chunk count.

### `DELETE /api/files/:id`

Removes the file's metadata and all chunks on disk.

## Shares

### `POST /api/shares` (auth required)

```json
{
  "file_id": "uuid",
  "share_salt": "<hex>",
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>",
  "password_hash": "<optional hex>",
  "expires_at": "2026-12-31T00:00:00Z",
  "download_limit": 10
}
```

Response: `{ "id": "share_uuid" }`.

### `GET /api/shares/:id` (public)

Returns:
```json
{
  "id": "share_uuid",
  "file_id": "uuid",
  "share_salt": "<hex>",
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>",
  "requires_password": false,
  "expires_at": null
}
```

The recipient derives `share_key` from `share_salt` + (URL fragment password
or entered password), decrypts `file_key`, then proceeds like an owner.

### `GET /api/shares/:id/chunks/:idx` (public)

Same semantics as the authenticated chunk endpoint.

### `DELETE /api/shares/:id` (auth required)

Revokes a share.

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
