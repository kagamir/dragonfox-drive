-- Initial schema for DragonFox Drive.
-- The server is zero-trust: it stores NO plaintext file names, paths, keys,
-- or passwords. Every column below is either public metadata (sizes, indices),
-- an opaque encrypted blob, or a server-side hash of a client-derived verifier.

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Users
-- =============================================================================
CREATE TABLE users (
    id                          TEXT PRIMARY KEY,
    email                       TEXT NOT NULL UNIQUE,
    -- Per-user client KDF salt (hex). Used by the browser to derive password_key.
    kdf_salt                    TEXT NOT NULL,
    -- Server-side Argon2id salt (hex) used to hash auth_verifier.
    server_salt                 TEXT NOT NULL,
    -- Argon2id(auth_verifier, server_salt) - server never sees auth_verifier plaintext.
    verifier_hash               TEXT NOT NULL,
    -- master_key wrapped by password_key (base64 AES-GCM ciphertext).
    encrypted_master_key        TEXT NOT NULL,
    encrypted_master_key_nonce  TEXT NOT NULL,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);

-- =============================================================================
-- Devices (for device-level keys & revocation)
-- =============================================================================
CREATE TABLE devices (
    id                          TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                        TEXT NOT NULL,
    -- Optional device public key (X25519) for future device-to-device operations.
    pubkey                      TEXT,
    -- master_key wrapped by device_key (base64 AES-GCM).
    device_wrap                 TEXT,
    device_wrap_nonce           TEXT,
    last_seen_at                TEXT,
    revoked_at                  TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- =============================================================================
-- Files
-- =============================================================================
CREATE TABLE files (
    id                              TEXT PRIMARY KEY,
    owner_id                        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status                          TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'uploading' | 'ready' | 'deleted'
    total_size                      INTEGER NOT NULL DEFAULT 0,
    chunk_count                     INTEGER NOT NULL DEFAULT 0,
    -- Opaque encrypted manifest (base64 AES-GCM). Contains name, mime, etc.
    encrypted_manifest              BLOB,
    encrypted_manifest_nonce        TEXT,
    client_version                  INTEGER NOT NULL DEFAULT 1,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_files_owner ON files(owner_id);
CREATE INDEX idx_files_status ON files(status);

-- =============================================================================
-- File chunks (one row per encrypted 4 MiB chunk)
-- =============================================================================
CREATE TABLE file_chunks (
    file_id                         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    idx                             INTEGER NOT NULL,
    cipher_size                     INTEGER NOT NULL,
    storage_path                    TEXT NOT NULL,
    etag                            TEXT,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (file_id, idx)
);

CREATE INDEX idx_chunks_file ON file_chunks(file_id);

-- =============================================================================
-- Public link shares
-- =============================================================================
CREATE TABLE shares (
    id                              TEXT PRIMARY KEY,
    file_id                         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    owner_id                        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Public KDF salt for share_key derivation (hex).
    share_salt                      TEXT NOT NULL,
    -- file_key re-wrapped by share_key (base64).
    encrypted_file_key              TEXT NOT NULL,
    encrypted_file_key_nonce        TEXT NOT NULL,
    -- Optional hash of share_key (server-side access gate, base64).
    password_hash                   TEXT,
    expires_at                      TEXT,
    download_limit                  INTEGER,
    download_count                  INTEGER NOT NULL DEFAULT 0,
    revoked_at                      TEXT,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_shares_file ON shares(file_id);
CREATE INDEX idx_shares_owner ON shares(owner_id);

-- =============================================================================
-- Refresh-token allowlist (for revocation)
-- =============================================================================
CREATE TABLE refresh_tokens (
    id                              TEXT PRIMARY KEY,
    user_id                         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id                       TEXT REFERENCES devices(id) ON DELETE CASCADE,
    token_hash                      TEXT NOT NULL UNIQUE,
    expires_at                      TEXT NOT NULL,
    revoked_at                      TEXT,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
