-- Workstream 3 Layer 1 PR 4: per-Connection runtime credentials.
--
-- Adds two columns on api_keys to support credentials minted by the
-- control-plane lease broker on behalf of a specific Connection's
-- runtime. The control plane fetches one of these per-message before
-- dispatching to the per-Integration Worker.
--
-- is_runtime_credential — when true, the credential is gated to
-- writing only the connection.runtime extension subtree of the item
-- whose id matches connection_id.
--
-- connection_id — stamped at mint time. Cross-tenant denial: the
-- extension gate compares the path :id against this column; a runtime
-- credential cannot be used to write any other connection's runtime
-- subtree even if it nominally has access via type_permissions.

ALTER TABLE `api_keys` ADD COLUMN `is_runtime_credential` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `api_keys` ADD COLUMN `connection_id` text;
--> statement-breakpoint
CREATE INDEX `idx_api_keys_connection_id` ON `api_keys` (`connection_id`) WHERE `connection_id` IS NOT NULL;
