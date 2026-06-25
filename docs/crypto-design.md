# Crypto Design

DragonFox Drive is **zero-trust**: the server is treated as a passive storage
and authentication oracle. It can never read user data, file names, or any key
material.

## Key hierarchy

```
                        ┌─────────────┐
                        │  password   │  (user memory, never sent to server)
                        └──────┬──────┘
                               │ Argon2id(m=64MiB, t=3, p=1)
                               │   salt = first 16B of SHA-256(normalised_username)
                               ▼
                        ┌─────────────┐
                        │ password_key│  (32 B, client-only)
                        └──────┬──────┘
                               │
              ┌────────────────┼─────────────────┐
              │ HKDF/Separate  │ Argon2id again  │
              │ KDF            │ with server_salt│
              ▼                ▼                 │
        ┌──────────┐  ┌──────────────────┐       │
        │ (n/a yet)│  │ auth_verifier    │       │
        └──────────┘  │ → sent to server │       │
                      │ → server hashes  │       │
                      │   again & stores │       │
                      └──────────────────┘       │
                                                 │
                  AES-GCM unwrap                 │
                  of master_key  ◄───────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │ master_key  │  (32 B random, root of trust)
                        └──────┬──────┘
                               │ AES-GCM wrap per file
                               ▼
                        ┌─────────────┐
                        │  file_key   │  (32 B random per file)
                        └──────┬──────┘
                               │ AES-GCM on each 4 MiB chunk
                               ▼
                          encrypted chunks on server
```

## Wrapping variants for `master_key`

`master_key` is stored on the server wrapped by `password_key` (so any device
can unlock with the password). For passwordless re-login, the browser also
keeps a local-only `device_wrap` in IndexedDB.

| Wrap name        | Key used for AES-GCM       | Where it lives        | Purpose                              |
|------------------|----------------------------|-----------------------|--------------------------------------|
| `password_wrap`  | `password_key`             | Server (users row)    | Any-device login with password       |
| `device_wrap`    | `device_key` (per-browser) | Browser IndexedDB     | Passwordless re-login on this device |

- `device_key` is a random 32 B stored only in IndexedDB (localforage); the
  server never sees it and never stores a copy of `device_wrap`.
- A new device logs in with password (which creates a fresh `device_wrap` in
  that browser's IndexedDB and a new row in the server's `devices` table).
- Revoking a device: `DELETE /api/devices/:id` hard-deletes the `devices` row
  (cascading to its `refresh_tokens` via the foreign key). The browser's
  IndexedDB `device_wrap` becomes useless as soon as the access token expires
  (or immediately, since the per-request check rejects the next API call).

## File encryption (per-chunk AES-GCM)

Each file is split into **4 MiB** chunks (`chunk_size = 4 * 1024 * 1024`).

For file with key `K` and `iv_base` (random 96-bit):

- Chunk `i` IV: `iv = iv_base` with the last 4 bytes XOR'd with `i`.
  This is a counter-style construction; chunks remain independently
  decryptable for HTTP Range access (essential for video seeking).
- Chunk ciphertext: `AES-256-GCM(K, iv_i, plaintext_i)`
- Each chunk carries its own 16-byte authentication tag (~0.4% overhead).

This construction lets the client request **any chunk by index** over HTTP
Range, decrypt it independently, and feed it to a `MediaSource` buffer.

## Manifest

Per-file metadata lives in an **encrypted manifest** stored on the server as
an opaque blob. The server cannot read its contents:

```json
{
  "version": 1,
  "name": "holiday.mp4",
  "mime": "video/mp4",
  "size": 12345678,
  "chunk_size": 4194304,
  "iv_base": "<base64(12 bytes)>",
  "plaintext_sha256": "<hex>",
  "created_at": "2026-06-22T10:00:00Z"
}
```

The manifest is encrypted with `file_key` and uploaded alongside the chunks.

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

## Link sharing

Sharing a file does **not** expose `file_key` directly. Instead, the client
re-wraps it:

1. Generate (or accept) a `share_password`.
2. `share_salt` = random 16 B.
3. `share_key = Argon2id(share_password, share_salt)` (client-side).
4. `encrypted_file_key_for_share = AES-GCM(share_key, file_key)`.
5. POST to `/api/shares`: `{ file_id, share_salt, encrypted_file_key_for_share, ... }`.
6. Resulting URL: `https://drive/#/s/<share_id>?k=<base64(share_password)>`.

The URL fragment is **never** sent to the server. The recipient's browser
fetches `share_salt` + `encrypted_file_key_for_share` from the server, uses
the URL-fragment password to derive `share_key`, decrypts `file_key`, and
plays the file exactly like the owner would.

Optionally, the server stores `argon2(share_key, server_salt)` for
password-protected shares where the link itself does not contain the key.

**Final construction (implemented):** the server-side verifier is
`hex(SHA-256(share_key))` (no extra Argon2id pass — brute-forcing the stored
hash already costs one Argon2id per guess to recompute `share_key`). Two modes:
(1) link carries the key — `?k=<base64(share_password)>` in the URL fragment,
`password_hash` null; (2) password mode — no `?k=`, server stores
`password_hash`, recipient posts `password_verifier = hex(SHA-256(share_key))`
to `/api/shares/:id/verify`. The chunk endpoint is public and password-less
(ciphertext is useless without `file_key`); only `expires_at`/`revoked_at`
hard-block chunks. `download_count` increments once per key disclosure.

## Threat model

| Adversary                | What they can learn                          |
|--------------------------|----------------------------------------------|
| Server operator (online) | Account existence, file sizes, chunk count,  |
|                          | access timestamps, approximate upload times. |
| Server operator (DB leak)| Same as above + Argon2id hashes of auth      |
|                          | verifiers (offline brute force possible).    |
| Network MITM             | Nothing beyond the above (TLS).              |
| Compromised browser      | Full plaintext (same as any E2EE scheme).    |

The server **cannot** decrypt file contents or file names even with full
database and disk access. The user's password is the sole secret.

## Crypto libraries

| Operation              | Library                | Reason                            |
|------------------------|------------------------|-----------------------------------|
| Argon2id (KDF)         | libsodium-wrappers-sumo (WASM) | WebCrypto has no Argon2.   |
| AES-256-GCM (chunks)   | WebCrypto (native)     | Fastest, native browser crypto.   |
| HKDF, SHA-256, random  | WebCrypto              | Native.                           |
| X25519 (future device) | libsodium              | Mature.                           |

All CPU-intensive operations run in a Web Worker (`workers/crypto.worker.ts`)
via Comlink so the UI thread never blocks.

## Constants

| Constant                  | Value      |
|---------------------------|------------|
| Argon2 memory cost        | 64 MiB     |
| Argon2 time cost          | 3          |
| Argon2 parallelism        | 1 (WASM)   |
| Chunk size                | 4 MiB      |
| AES key length            | 256 bits   |
| AES-GCM IV length         | 96 bits    |
| AES-GCM tag length        | 128 bits   |

Tuning notes: 64 MiB Argon2id costs ~300-800 ms on a modern desktop browser.
This is paid on register/login; subsequent visits use `device_wrap` and skip
Argon2 entirely.
