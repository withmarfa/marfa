-- Drop dormant Row Level Security from existing Postgres deployments.
--
-- Earlier versions of pg/connection.ts created RLS policies on items,
-- api_keys, metadata, and versions. They had no runtime effect because
-- the connection user owns the tables and table owners bypass RLS by
-- default — see the long comment in pg/connection.ts for the full
-- rationale. We don't ship dormant security primitives.
--
-- Tenant scoping is enforced in application code. The Backlog carries
-- the plan for activating real RLS (non-owner role + SET ROLE +
-- per-request SET LOCAL) if/when hosted-multi-tenant becomes a need.

DROP POLICY IF EXISTS tenant_isolation_items ON items;
DROP POLICY IF EXISTS tenant_isolation_api_keys ON api_keys;
DROP POLICY IF EXISTS tenant_isolation_metadata ON metadata;
DROP POLICY IF EXISTS tenant_isolation_versions ON versions;

ALTER TABLE items DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE metadata DISABLE ROW LEVEL SECURITY;
ALTER TABLE versions DISABLE ROW LEVEL SECURITY;
