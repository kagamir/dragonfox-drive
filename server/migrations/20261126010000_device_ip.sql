-- An existing session acquires its address on its next authenticated request.
ALTER TABLE devices ADD COLUMN ip_address TEXT;
