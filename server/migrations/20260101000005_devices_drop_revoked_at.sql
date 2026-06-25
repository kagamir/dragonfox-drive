-- P4 follow-up: device revocation is now a hard DELETE, not a soft-set on
-- revoked_at. The audit-trail column is no longer needed; dev-phase, drop it.
ALTER TABLE devices DROP COLUMN revoked_at;
