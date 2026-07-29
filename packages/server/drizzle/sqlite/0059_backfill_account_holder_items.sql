-- Give every existing space the account holder's graph handle.
-- See the matching PG migration `0072_backfill_account_holder_items.sql` for
-- the full rationale: an edge resolves both endpoints against `items`, so a
-- space with no `system.account_holder` row has no id an `authored-by` can
-- name. Data only, no DDL, no-op on a fresh database, re-runnable behind the
-- NOT EXISTS guard with the partial unique index on `(source, source_id)` as
-- the backstop.
--
-- `randomblob` is non-deterministic, so SQLite evaluates it per row; the
-- assembled string satisfies the same UUIDv7 grammar the route layer
-- validates path ids against.

INSERT INTO items (
  id,
  tenant_id,
  type,
  state,
  properties,
  created_at,
  updated_at,
  timestamp,
  source,
  source_id,
  version
)
SELECT
  substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 1, 8)
    || '-'
    || substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 9, 4)
    || '-7' || substr(lower(hex(randomblob(2))), 1, 3)
    || '-a' || substr(lower(hex(randomblob(2))), 1, 3)
    || '-' || lower(hex(randomblob(6))),
  t.id,
  'system.account_holder',
  'active',
  '{}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'system',
  'account-holder:' || t.id,
  1
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM items i
  WHERE i.source = 'system'
    AND i.source_id = 'account-holder:' || t.id
);
