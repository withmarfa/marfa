-- The calendar read paged every event row in a space and filtered in
-- memory, because a stored `starts_at` is an instant written in whatever
-- offset its upstream used and a string comparison orders `+02:00`
-- against `Z` wrongly. These two columns carry the same instants in one
-- shape, byte-identical to what `Date.prototype.toISOString()` emits, so
-- lexical order is instant order and the window becomes a range scan.
ALTER TABLE "items" ADD COLUMN "starts_at_utc" text;
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ends_at_utc" text;
--> statement-breakpoint
-- `strftime` needs no regex guard: it answers NULL for anything it
-- cannot read, which is what the write path does with junk. It reads an
-- offset-bearing value and normalizes to UTC, reads a value with a time
-- but no zone as UTC (matching the write path, which appends `Z` rather
-- than letting the server's own zone decide), and `%f` emits `SS.SSS`,
-- so the emitted string is the same shape `toISOString()` produces. A
-- bare date lands on `T00:00:00.000Z`, which is the projection the
-- all-day model already gives it, so it needs no special case.
--
-- The two padding branches do need one: `precision` is a declared part
-- of the event shape, so an event dated from memory stores only the year
-- or month it is known to, and `strftime` answers NULL for both. Such a
-- row still belongs on a calendar. Padding to the start of the period it
-- names is what `new Date()` does with the same string.
UPDATE "items" SET
  "starts_at_utc" = strftime('%Y-%m-%dT%H:%M:%fZ', CASE
    WHEN json_extract("properties", '$.starts_at') GLOB '[0-9][0-9][0-9][0-9]'
      THEN json_extract("properties", '$.starts_at') || '-01-01'
    WHEN json_extract("properties", '$.starts_at') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      THEN json_extract("properties", '$.starts_at') || '-01'
    ELSE json_extract("properties", '$.starts_at') END),
  "ends_at_utc" = strftime('%Y-%m-%dT%H:%M:%fZ', CASE
    WHEN json_extract("properties", '$.ends_at') GLOB '[0-9][0-9][0-9][0-9]'
      THEN json_extract("properties", '$.ends_at') || '-01-01'
    WHEN json_extract("properties", '$.ends_at') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      THEN json_extract("properties", '$.ends_at') || '-01'
    ELSE json_extract("properties", '$.ends_at') END)
WHERE json_extract("properties", '$.starts_at') IS NOT NULL
   OR json_extract("properties", '$.ends_at') IS NOT NULL;
--> statement-breakpoint
-- Partial for the same reason the column is nullable: only events carry
-- a start instant, so the index stays the size of the calendar rather
-- than the size of the corpus. Leads with the space because every read
-- that reaches it carries one.
CREATE INDEX IF NOT EXISTS "idx_items_starts_at_utc"
  ON "items" ("space_id", "starts_at_utc")
  WHERE starts_at_utc IS NOT NULL;
