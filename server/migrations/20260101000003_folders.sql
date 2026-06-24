-- P3: encrypted folder tree. The server stores only opaque rows: it cannot read
-- folder names (encrypted with the folder's own folder_key) and it cannot see
-- the tree structure (parent_id is encrypted with the user's master_key).
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

-- Files gain an encrypted parent pointer; NULL ≡ root (zero data migration).
ALTER TABLE files ADD COLUMN encrypted_parent_id       TEXT;
ALTER TABLE files ADD COLUMN encrypted_parent_id_nonce TEXT;
