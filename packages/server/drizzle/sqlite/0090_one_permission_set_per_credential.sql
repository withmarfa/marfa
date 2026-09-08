-- Every credential holds one permission set, and nothing checks a role.
--
-- Until now a key's reach came from two places that disagreed: the permission
-- maps on its row, and a `role` that let it ignore them. This drops the second
-- and gives the row somewhere to hold what the first could not express — the
-- eleven space permissions, which a sign-in has carried on its grant since the
-- grammar landed and a key had no column for at all.
--
-- **The criterion tests the operator flag rather than the space binding.**
-- Keys mode binds nothing to a space, so every working credential there is
-- space-less; a criterion reading `space_id IS NOT NULL` would stamp none of
-- them and leave such an instance reaching nothing, unrepairably. The bypass
-- this replaces made no space test either. What the flag excludes is exactly
-- the operator key.
--
-- **The stamp is what makes the drop safe, and its criterion is the bypass
-- rather than empty maps.** A key whose role admitted it past its maps was
-- reaching everything whatever those maps said, so the maps are decorative on
-- exactly those rows and the honest reading of "what could this key do
-- yesterday" is "everything in its space". A staging row proves the
-- distinction matters: it holds `{"*":"write"}` on types and nothing on edges,
-- metadata or extensions, and an empty-maps test would have left it unstamped
-- and silently narrowed it.
--
-- Three kinds of credential are outside the stamp, each for its own reason.
-- A runtime credential carries `member` and its manifest-bounded maps, which
-- are the whole of what it should reach. A key minted through a sign-in was
-- already held to its maps. And the operator key takes nothing at all: running
-- the instance is fenced outside the permission model rather than expressed as
-- a full set inside it.
--
-- **The rebuild is the standard table-swap dance from 0062**, because SQLite
-- can neither drop a column from a table with the constraints this one is
-- gaining nor add a CHECK in place. It does four things at once — rename the
-- flag, add the two carriers, drop the two retired columns and add the
-- constraint — so the table is rebuilt exactly once rather than four times.
--
-- **The constraint makes the escalation shape unrepresentable.** The instance
-- tier is the absence of a space binding, so a row claiming the tier while
-- bound to a space asks to be judged by both rules at once, and nothing until
-- now held the two together. The delete clears the revoked ones; a live one
-- fails the rebuild, which is the right failure, because a credential reaching
-- past the space it was minted into is the alternative.
--
-- **The converse is left alone, and deliberately.** A space-less key that is
-- not an operator key is what keys mode is made of, so an equivalence here
-- would make every credential on a single-space self-host an operator key, and
-- a delete written to match it would take that instance's entire revoked-key
-- history with it. Keys mode gains a real space in its own change, and the
-- constraint tightens to an equivalence there.
UPDATE `api_keys`
SET type_permissions      = '{"*":"write"}',
    edge_permissions      = '{"*":"write"}',
    metadata_permissions  = '{"*":"write"}',
    extension_permissions = '{"*":"write"}'
WHERE revoked_at IS NULL
  AND scope_enforced = 0
  AND role IN ('instance_admin', 'space_admin')
  AND NOT (space_id IS NULL AND is_platform = 1);
--> statement-breakpoint
DELETE FROM `api_keys`
WHERE revoked_at IS NOT NULL
  AND is_platform = 1
  AND space_id IS NOT NULL;
--> statement-breakpoint
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
	CONSTRAINT `api_keys_operator_is_space_less`
	  CHECK (`is_operator` = 0 OR `space_id` IS NULL)
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
  "is_platform", "is_runtime_credential", "connection_id", "item_source",
  CASE
    WHEN revoked_at IS NULL AND scope_enforced = 0
         AND role IN ('instance_admin', 'space_admin')
         AND NOT (space_id IS NULL AND is_platform = 1)
    THEN '["space.webhooks","space.connections","space.schema","space.usage","space.settings","space.audit_read","space.item_purge","space.upstream_access","space.credentials","space.keys","space.app_grants"]'
    ELSE '[]'
  END,
  "type_permissions", "extension_permissions",
  "edge_permissions", "metadata_permissions",
  CASE
    WHEN revoked_at IS NULL AND scope_enforced = 0
         AND role IN ('instance_admin', 'space_admin')
         AND NOT (space_id IS NULL AND is_platform = 1)
    THEN '{"*":"write"}'
    ELSE '{}'
  END,
  NULL,
  "created_at", "expires_at", "revoked_at", "last_used_at"
FROM `api_keys`;
--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_connection_id` ON `api_keys` (`connection_id`) WHERE `connection_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_runtime_credential` ON `api_keys` (`is_runtime_credential`) WHERE `is_runtime_credential`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_keys_source_per_space` ON `api_keys` (`space_id`, `source`) WHERE revoked_at IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- One account holds one space and the first person in it holds everything, so
-- this column answered a question with three possible values and only ever
-- gave one of them. A permission set per person is the multi-person feature
-- and is not this.
ALTER TABLE `users` DROP COLUMN `role`;
