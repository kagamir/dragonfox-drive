-- Persist the per-file file_key, wrapped by the user's master_key.
-- Written by `create` at upload start, so non-null for any ready file.
ALTER TABLE files ADD COLUMN encrypted_file_key TEXT;
ALTER TABLE files ADD COLUMN encrypted_file_key_nonce TEXT;
