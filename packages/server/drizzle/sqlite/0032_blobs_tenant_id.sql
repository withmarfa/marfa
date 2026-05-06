-- T-049: blob storage tenant scoping.
--
-- The `blobs` metadata table moves from PK on `hash` to a composite PK on
-- (tenant_id, hash) so the same hash bytes can have separate rows per
-- tenant. The storage backend (filesystem / S3) still keys by hash, so
-- different tenants uploading the same bytes share the underlying file
-- but each tenant's metadata row is private — `GET /blobs/:hash` looks
-- up the row keyed by the caller's tenant_id and returns 404 when no row
-- matches, regardless of whether other tenants have a row for the same
-- hash.
--
-- `tenant_id` is `NOT NULL DEFAULT ''` rather than nullable to keep the
-- composite PK simple. Empty string `''` is the sentinel for instance-
-- wide / single-tenant / platform-admin rows. Existing rows are
-- backfilled to `''` so single-tenant deployments continue to work
-- unchanged.
--
-- SQLite can't ALTER a PRIMARY KEY in place — the table rebuild dance is
-- required: rename old, create new, copy, drop old.

CREATE TABLE `__new_blobs` (
  `tenant_id` text NOT NULL DEFAULT '',
  `hash` text NOT NULL,
  `mime_type` text NOT NULL,
  `size` integer NOT NULL,
  `storage_path` text NOT NULL,
  PRIMARY KEY (`tenant_id`, `hash`)
);
--> statement-breakpoint
INSERT INTO `__new_blobs` (`tenant_id`, `hash`, `mime_type`, `size`, `storage_path`)
  SELECT '', `hash`, `mime_type`, `size`, `storage_path` FROM `blobs`;
--> statement-breakpoint
DROP TABLE `blobs`;
--> statement-breakpoint
ALTER TABLE `__new_blobs` RENAME TO `blobs`;
