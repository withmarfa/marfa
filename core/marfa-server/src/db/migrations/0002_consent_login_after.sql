-- A browser session begun before this is too old to authorize the app.
ALTER TABLE oauth_consents ADD COLUMN login_after TEXT;
