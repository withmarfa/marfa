-- Backfill schema_version on existing items.
-- Wave-1 left the column nullable; Wave-2 PR 1 makes the runtime always stamp
-- it on insert and the wire format declares it required. Existing rows on the
-- V0 instance (177 seed items as of 2026-04-14) carry NULL; this UPDATE
-- normalises them to schema_version = 1 so reads never need to fall back.
UPDATE items SET schema_version = 1 WHERE schema_version IS NULL;
