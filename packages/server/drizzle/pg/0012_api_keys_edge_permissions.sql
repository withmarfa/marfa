-- Wave 2 PR 4 commit 15: fine-grained edge permissions.
-- api_keys.edge_permissions stores a JSON map of edge_type → 'read'|'write'.
-- Grandfather existing non-admin keys with a broad edge.*:write grant so
-- they don't silently lose access to parent_id/thread_id/about semantics
-- that PR 4 moved to first-class edges. New keys created after this
-- migration default to '{}' (opt-in per-edge grants).

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS edge_permissions TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE api_keys
SET edge_permissions = '{"*":"write"}'
WHERE role != 'admin'
  AND type_permissions != '{}'
  AND edge_permissions = '{}';
