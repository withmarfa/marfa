-- Custom item types become tenant-namespaced.
--
-- The `custom_types` table moves from a global PK on `id` to a composite PK
-- on (tenant_id, id) so two tenants can register the same type id
-- independently — each owns its own type vocabulary. A custom type registered
-- by one tenant is invisible to another's lookups (the in-memory registry is
-- keyed per tenant to match), so one tenant cannot create or validate items
-- against a type it never defined.
--
-- `tenant_id` becomes `NOT NULL DEFAULT ''` rather than nullable to keep the
-- composite PK simple, mirroring the `blobs` and `custom_edge_types` tables.
-- Empty string `''` is the sentinel for single-tenant self-host / platform
-- registrations. Existing NULL rows are backfilled to `''`; rows that already
-- carry a real tenant id keep it, so multi-tenant data survives the rebuild
-- unchanged.
--
-- SQLite can't ALTER a PRIMARY KEY in place — the table rebuild dance is
-- required: create new, copy, drop old, rename.

CREATE TABLE `__new_custom_types` (
  `tenant_id` text NOT NULL DEFAULT '',
  `id` text NOT NULL,
  `schema` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_custom_types` (`tenant_id`, `id`, `schema`, `created_at`, `updated_at`)
  SELECT COALESCE(`tenant_id`, ''), `id`, `schema`, `created_at`, `updated_at` FROM `custom_types`;
--> statement-breakpoint
DROP TABLE `custom_types`;
--> statement-breakpoint
ALTER TABLE `__new_custom_types` RENAME TO `custom_types`;
