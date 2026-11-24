-- The browser session that confirmed the code matches the device's. Only that session may
-- see the approval page or answer it.
ALTER TABLE oauth_device_codes ADD COLUMN checked_by TEXT
    REFERENCES sign_ins (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS oauth_device_codes_checked_by ON oauth_device_codes (checked_by)
    WHERE checked_by IS NOT NULL;
