-- Rename the identity column from email to username (P1 auth milestone).
-- SQLite >= 3.25 supports ALTER TABLE ... RENAME COLUMN; the UNIQUE constraint
-- is preserved across the rename. The index is rebuilt for naming clarity.
ALTER TABLE users RENAME COLUMN email TO username;
DROP INDEX idx_users_email;
CREATE INDEX idx_users_username ON users(username);
