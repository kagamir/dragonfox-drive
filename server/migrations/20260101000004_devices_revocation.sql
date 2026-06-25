-- P4 device management & revocation.
-- Drop the never-used device_wrap columns: per the design doc, the per-browser
-- device_key is purely an IndexedDB concept and the server has no business
-- storing a wrap that is only ever useful to the browser that already has it.
-- `pubkey` was reserved for future X25519 device auth and is also unused.

ALTER TABLE devices DROP COLUMN pubkey;
ALTER TABLE devices DROP COLUMN device_wrap;
ALTER TABLE devices DROP COLUMN device_wrap_nonce;
