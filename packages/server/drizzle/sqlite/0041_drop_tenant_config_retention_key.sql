-- T-115: drop the dead per-type retention map from `TenantConfig`.
-- See the matching PG migration `0048_drop_tenant_config_retention_key.sql`
-- for full rationale. Strips the `retention` JSON key from existing
-- `tenants.config` rows; no-op on fresh databases.

UPDATE tenants
SET config = json_remove(config, '$.retention')
WHERE json_type(config, '$.retention') IS NOT NULL;
