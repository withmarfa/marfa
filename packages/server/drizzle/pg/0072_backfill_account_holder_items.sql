-- Give every existing space the account holder's graph handle.
--
-- An edge resolves both endpoints against `items`, and a profile's identity
-- lives in the disjoint `users` id-space, so until a space has a
-- `system.account_holder` row there is no id to put at the end of an
-- `authored-by`. New spaces get the row from the sign-up provisioning hook;
-- this covers the ones provisioned before that hook existed.
--
-- Data only, no DDL, so it produces no SCHEMA_SQL delta. No-op on a fresh
-- database, which has no tenants.
--
-- Re-runnable. The NOT EXISTS guard skips a space that already has one, and
-- the partial unique index on `(source, source_id)` is the backstop if the
-- guard were ever bypassed: a second row for the same space cannot be
-- inserted at all. `source` / `source_id` carry the same natural key the
-- application writes, which is what makes that index load-bearing here.
--
-- The id is assembled by hand rather than taken from gen_random_uuid()
-- because it has to satisfy the UUIDv7 grammar the route layer validates
-- path ids against: an item whose id fails that check is unreachable through
-- GET /items/{id} and rejected as an edge target. Leading 48 bits are the
-- current time in milliseconds, the version nibble is 7, the variant nibble
-- is a fixed value from the 10xx range, and the three random runs come from
-- separate gen_random_uuid() calls. Those calls are inlined rather than
-- lifted into the join below because a volatile expression has to be
-- evaluated per row, and inlining is the form that cannot be read any other
-- way.

INSERT INTO "items" (
  "id",
  "tenant_id",
  "type",
  "state",
  "properties",
  "created_at",
  "updated_at",
  "timestamp",
  "source",
  "source_id",
  "version"
)
SELECT
  substr(g.ms, 1, 8) || '-' || substr(g.ms, 9, 4)
    || '-7' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3)
    || '-a' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 3)
    || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  t."id",
  'system.account_holder',
  'active',
  '{}',
  g.iso,
  g.iso,
  g.iso,
  'system',
  'account-holder:' || t."id",
  1
FROM "tenants" t
CROSS JOIN LATERAL (
  SELECT
    lpad(to_hex((extract(epoch FROM now()) * 1000)::bigint), 12, '0') AS ms,
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso
) g
WHERE NOT EXISTS (
  SELECT 1 FROM "items" i
  WHERE i."source" = 'system'
    AND i."source_id" = 'account-holder:' || t."id"
);
