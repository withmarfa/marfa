-- Workstream 1 close-out: metadata-layer permissions on api_keys.
-- api_keys.metadata_permissions stores a JSON map of subresource → 'read'|'write'.
-- Default `{}` — no grants — means non-admin keys cannot mutate the metadata
-- surface (e.g. POST /types). Admin keys bypass the check; OAuth tokens carry
-- the same map projected from `metadata.<sub>:<verb>` scopes on their grant.
-- No backfill: the only admission path that consults this map (POST /types)
-- was previously admin-only, so existing non-admin keys never had the
-- capability — semantics are strictly tighter without breaking prior callers.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS metadata_permissions TEXT NOT NULL DEFAULT '{}';
