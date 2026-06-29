-- Initial schema for DragonFox Drive.
-- The server is zero-trust: it stores NO plaintext file names, paths, keys,
-- or passwords. Every column below is either public metadata (sizes, indices),
-- an opaque encrypted blob, or a server-side hash of a client-derived verifier.
--
-- This file is the consolidated initial schema: it folds in every migration up
-- to and including the P4 device-revocation work (username rename, per-file
-- file_key, encrypted folder tree, device-column cleanup).

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Users
-- =============================================================================
CREATE TABLE users (
    id                          TEXT PRIMARY KEY,
    -- Identity column (P1 auth milestone renamed this from `email`).
    username                    TEXT NOT NULL UNIQUE,
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

CREATE INDEX idx_users_username ON users(username);

-- =============================================================================
-- Devices (for device-level keys & revocation)
-- =============================================================================
-- Device revocation is a hard DELETE, so there is no revoked_at column. The
-- per-browser device_key is an IndexedDB-only concept, so the server stores no
-- device_wrap; pubkey (reserved X25519 device auth) is likewise unused.
CREATE TABLE devices (
    id                          TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                        TEXT NOT NULL,
    last_seen_at                TEXT,
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
    -- Per-file file_key, wrapped by the user's master_key. Written by `create`
    -- at upload start, so non-null for any ready file.
    encrypted_file_key              TEXT,
    encrypted_file_key_nonce        TEXT,
    -- Encrypted parent folder pointer (AES-GCM with master_key); NULL ≡ root.
    encrypted_parent_id             TEXT,
    encrypted_parent_id_nonce       TEXT,
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
-- Folders (P3: encrypted folder tree)
-- =============================================================================
-- The server stores only opaque rows: it cannot read folder names (encrypted
-- with the folder's own folder_key) and cannot see the tree structure
-- (parent_id is encrypted with the user's master_key).
CREATE TABLE folders (
    id                          TEXT PRIMARY KEY,
    owner_id                    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Parent folder id, AES-GCM-encrypted with the user's master_key. NULL ≡ root.
    encrypted_parent_id         TEXT,
    encrypted_parent_id_nonce   TEXT,
    -- This folder's folder_key, wrapped by the PARENT's folder_key
    -- (or by master_key when encrypted_parent_id is NULL).
    encrypted_folder_key        TEXT NOT NULL,
    encrypted_folder_key_nonce  TEXT NOT NULL,
    -- Folder name, encrypted with this folder's OWN folder_key.
    encrypted_name              TEXT NOT NULL,
    encrypted_name_nonce        TEXT NOT NULL,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_folders_owner ON folders(owner_id);

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
