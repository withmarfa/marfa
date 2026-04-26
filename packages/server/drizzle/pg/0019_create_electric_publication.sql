-- Postgres logical-replication publication for ElectricSQL.
--
-- Used by the new /sync/shapes/:family proxy and the @mymehq/sync-client
-- package. Electric replicates the listed tables from this database into
-- per-API-key shapes.
--
-- Prerequisite: wal_level = logical at the server level. This setting
-- requires a Postgres restart to change. If wal_level is set to 'replica',
-- this migration's CREATE PUBLICATION will succeed but Electric will
-- error on connect — handle the wal_level change BEFORE running this
-- migration.
--
-- Idempotent: re-running this migration is a no-op.
--
-- Coverage:
--   * items     — typed records
--   * edges     — typed relationships
--   * metadata  — tag / extension sidecar
--
-- Notably NOT included:
--   * versions, audit_log, event_log — server-internal, not client-relevant
--   * api_keys, oauth_*, webhooks, settings — server-only state
--   * tenants, users — multi-tenant control plane

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'myme_electric_pub') THEN
    CREATE PUBLICATION myme_electric_pub FOR TABLE items, edges, metadata;
  END IF;
END
$$;
