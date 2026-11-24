-- NULL is automatic detection on the client, including for all existing rows.
ALTER TABLE folders ADD COLUMN encrypted_type TEXT;
ALTER TABLE folders ADD COLUMN encrypted_type_nonce TEXT
    CHECK ((encrypted_type IS NULL) = (encrypted_type_nonce IS NULL));
