-- Workstream 1 close-out: metadata-layer permissions on api_keys.
-- Default off (`{}`) — non-admin keys must be granted `metadata.<sub>:write`
-- explicitly. Existing keys (which historically went through requireAdmin
-- on POST /types) keep that path: admin keys bypass the check, and
-- non-admin keys would have been rejected before this migration too.
-- No grandfathering needed — semantics are strictly tighter for member
-- keys, but member keys never had the capability before.

ALTER TABLE `api_keys`
  ADD COLUMN `metadata_permissions` text NOT NULL DEFAULT '{}';
