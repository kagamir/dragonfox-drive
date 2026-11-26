-- Opaque listing revisions let clients atomically check an encrypted tree before a write.
ALTER TABLE users ADD COLUMN folder_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER folders_revision_on_insert AFTER INSERT ON folders
BEGIN
    UPDATE users SET folder_revision = folder_revision + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER folders_revision_on_update AFTER UPDATE ON folders
BEGIN
    UPDATE users SET folder_revision = folder_revision + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER folders_revision_on_delete AFTER DELETE ON folders
BEGIN
    UPDATE users SET folder_revision = folder_revision + 1 WHERE id = OLD.owner_id;
END;

ALTER TABLE users ADD COLUMN file_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER files_revision_on_insert AFTER INSERT ON files
BEGIN
    UPDATE users SET file_revision = file_revision + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER files_revision_on_update AFTER UPDATE ON files
BEGIN
    UPDATE users SET file_revision = file_revision + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER files_revision_on_delete AFTER DELETE ON files
BEGIN
    UPDATE users SET file_revision = file_revision + 1 WHERE id = OLD.owner_id;
END;
