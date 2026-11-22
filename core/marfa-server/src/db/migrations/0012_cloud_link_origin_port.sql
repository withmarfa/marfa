-- The port of the 127.0.0.1 listener Marfa Cloud's connector reaches, chosen as the link
-- started. Null only on a link made before the column, which the server cannot serve.
ALTER TABLE cloud_link ADD COLUMN origin_port INTEGER
    CHECK (origin_port IS NULL OR origin_port BETWEEN 1 AND 65535);
