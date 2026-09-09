-- The database says a space-less credential holds nothing.
--
-- The one model has two halves about the instance tier and the database held
-- one of them. `api_keys_operator_iff_space_less` says a space-less key is the
-- operator key and nothing else. That running the instance is not a permission,
-- and so the tier that runs it carries none, was enforced at two doors in
-- `routes/keys.ts` and asserted once by 0092, and a rule with no structural
-- form is what let those two doors write past it for months in the first
-- place. This is the second half in the shape the first one has.
--
-- Every mint path and every fixture already complies and 0092 cleared the rows
-- that did not, so this refuses nothing that exists. It is worth adding for the
-- reason the first half was: a rule the database holds cannot be reintroduced
-- by a route somebody adds without reading the one that came before.
--
-- **Literal comparison, not a semantic one.** SQLite has no way to ask an
-- object's size inside a CHECK, and both stores write these columns through
-- `JSON.stringify`, so `{}` and `[]` are the exact bytes an empty map and an
-- empty list take. A hand-written row spelling one of them differently is
-- refused, which is the right way round for a column nothing else writes.
--
-- SQLite cannot add a CHECK to an existing table, so this is the table rebuild
-- 0091 already uses, carrying both constraints forward.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text,
	`key_hash` text NOT NULL,
	`label` text NOT NULL,
	`source` text NOT NULL DEFAULT '',
	`default_tier` text NOT NULL DEFAULT 'library',
	`is_operator` integer NOT NULL DEFAULT 0,
	`is_runtime_credential` integer NOT NULL DEFAULT 0,
	`connection_id` text,
	`item_source` text,
	`space_permissions` text NOT NULL DEFAULT '[]',
	`type_permissions` text NOT NULL DEFAULT '{"*":"write"}',
	`extension_permissions` text NOT NULL DEFAULT '{}',
	`edge_permissions` text NOT NULL DEFAULT '{}',
	`metadata_permissions` text NOT NULL DEFAULT '{}',
	`profile_permissions` text NOT NULL DEFAULT '{}',
	`oauth_client_id` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_used_at` text,
	CONSTRAINT `api_keys_operator_iff_space_less`
	  CHECK ((`space_id` IS NULL) = (`is_operator` = 1)),
	CONSTRAINT `api_keys_space_less_holds_nothing`
	  CHECK (`space_id` IS NOT NULL OR (
	    `type_permissions`      = '{}'  AND
	    `edge_permissions`      = '{}'  AND
	    `metadata_permissions`  = '{}'  AND
	    `extension_permissions` = '{}'  AND
	    `profile_permissions`   = '{}'  AND
	    `space_permissions`     = '[]'))
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`(
  "id", "space_id", "key_hash", "label", "source", "default_tier",
  "is_operator", "is_runtime_credential", "connection_id", "item_source",
  "space_permissions", "type_permissions", "extension_permissions",
  "edge_permissions", "metadata_permissions", "profile_permissions", "oauth_client_id",
  "created_at", "expires_at", "revoked_at", "last_used_at")
SELECT
  "id", "space_id", "key_hash", "label", "source", "default_tier",
  "is_operator", "is_runtime_credential", "connection_id", "item_source",
  "space_permissions", "type_permissions", "extension_permissions",
  "edge_permissions", "metadata_permissions", "profile_permissions", "oauth_client_id",
  "created_at", "expires_at", "revoked_at", "last_used_at"
FROM `api_keys`;
--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_connection_id` ON `api_keys` (`connection_id`) WHERE `connection_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_runtime_credential` ON `api_keys` (`is_runtime_credential`) WHERE `is_runtime_credential`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_keys_source_per_space` ON `api_keys` (`space_id`, `source`) WHERE revoked_at IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;
