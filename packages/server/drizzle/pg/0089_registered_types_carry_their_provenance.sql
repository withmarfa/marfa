-- Registered types gain provenance, so where a type came from becomes a
-- property of the row rather than a fact compiled into the build.
--
-- Immutability is a compiled set today: a type cannot be modified because
-- the shipped arrays say so. That admits exactly two cases — shipped and
-- not — and there is a third the platform now needs, a type an integration
-- published, which its own package may update and nobody else may touch.
--
--   `origin`            platform | integration | user. Defaults to `user`,
--                       which is what every existing row in this table is:
--                       the table has only ever held types somebody
--                       registered through the API.
--   `family`            core | integration | system, for `platform` rows
--                       only. The split is provenance rather than
--                       behaviour, but the lifecycle restrictions on
--                       `system.*` and the catalog's account of which types
--                       exist because an upstream service does both key on
--                       it, and it cannot be derived from the identifier —
--                       `readwise.document` and `core.note` look alike.
--   `owner_integration` the manifest name of the integration that published
--                       this type, for `integration` rows. What the update
--                       gate compares against.
--
-- Additive and defaulted, so the running build reads the table unchanged
-- while the migration lands. Seeding the platform vocabulary into rows is
-- deliberately NOT done here: it is done at boot from the shipped set,
-- idempotently, because embedding several dozen JSON schemas in a migration
-- would freeze a copy of them that no codegen keeps honest.
ALTER TABLE custom_types ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE custom_types ADD COLUMN IF NOT EXISTS family TEXT;
--> statement-breakpoint
ALTER TABLE custom_types ADD COLUMN IF NOT EXISTS owner_integration TEXT;
--> statement-breakpoint
-- Platform rows are looked up as a set on every boot, and by origin whenever
-- an update has to decide whether the caller owns the type.
CREATE INDEX IF NOT EXISTS idx_custom_types_origin ON custom_types (origin);
