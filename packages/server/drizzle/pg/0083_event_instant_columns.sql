-- The calendar read paged every event row in a space and filtered in
-- memory, because a stored `starts_at` is an instant written in whatever
-- offset its upstream used and a string comparison orders `+02:00`
-- against `Z` wrongly. These two columns carry the same instants in one
-- shape, byte-identical to what `Date.prototype.toISOString()` emits, so
-- lexical order is instant order and the window becomes a range scan.
--
-- The session zone is pinned for the length of this migration. Only the
-- naive branch of the backfill needs it — a value carrying a time but no
-- zone casts to `timestamptz` under whatever the session's TimeZone is,
-- and the write-path normalizer reads naive as UTC. The two have to agree
-- byte for byte or a backfilled row and a rewritten one land on different
-- instants. `SET LOCAL` is the right scope because the Drizzle
-- postgres-js migrator runs the whole pending batch inside one
-- transaction, so this reverts on commit rather than outliving the run.
SET LOCAL TimeZone = 'UTC';
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "starts_at_utc" text;
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "ends_at_utc" text;
--> statement-breakpoint
-- The regex is a guard, not a parser: `::timestamptz` raises on a value
-- it cannot read, and one unparseable row would abort the whole
-- migration. The field carries no write-time format check, so junk
-- already exists and has to normalize to NULL the way the write path
-- does. The two truncated branches exist because `precision` is a
-- declared part of the event shape: an event dated from memory stores
-- only the year or month it is known to, and such a row still belongs on
-- a calendar. Padding to the start of the period it names is what
-- `new Date()` does with the same string.
UPDATE "items" SET
  "starts_at_utc" = CASE
    WHEN "properties"->>'starts_at' ~ '^\d{4}$'
      THEN to_char(((("properties"->>'starts_at') || '-01-01')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHEN "properties"->>'starts_at' ~ '^\d{4}-\d{2}$'
      THEN to_char(((("properties"->>'starts_at') || '-01')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHEN "properties"->>'starts_at' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$'
      THEN to_char((("properties"->>'starts_at')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ELSE NULL END,
  "ends_at_utc" = CASE
    WHEN "properties"->>'ends_at' ~ '^\d{4}$'
      THEN to_char(((("properties"->>'ends_at') || '-01-01')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHEN "properties"->>'ends_at' ~ '^\d{4}-\d{2}$'
      THEN to_char(((("properties"->>'ends_at') || '-01')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHEN "properties"->>'ends_at' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$'
      THEN to_char((("properties"->>'ends_at')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ELSE NULL END
WHERE "properties" ? 'starts_at' OR "properties" ? 'ends_at';
--> statement-breakpoint
-- Partial for the same reason the column is nullable: only events carry
-- a start instant, so the index stays the size of the calendar rather
-- than the size of the corpus. Leads with the space because every read
-- that reaches it carries one.
CREATE INDEX IF NOT EXISTS "idx_items_starts_at_utc"
  ON "items" ("space_id", "starts_at_utc")
  WHERE starts_at_utc IS NOT NULL;
--> statement-breakpoint
-- Back to whatever the deployment's own default is, so nothing after
-- this migration in the same batch inherits the pin.
SET LOCAL TimeZone = DEFAULT;
