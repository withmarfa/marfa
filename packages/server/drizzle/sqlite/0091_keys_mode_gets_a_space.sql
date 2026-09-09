-- Keys mode gets a real space, so a space-less key is the operator key and
-- nothing else.
--
-- `api_keys_operator_is_space_less` says an operator key holds no space. The
-- end state is the equivalence — a space-less key **is** the operator key —
-- which is what makes every other combination unwritable rather than merely
-- unminted. It could not ship with the permission model because keys mode
-- bound nothing to a space: every working credential on a single-space
-- self-host was space-less, so the equivalence would have declared each one an
-- operator key, which is the opposite of what the model is for.
--
-- Bootstrap now provisions the one space and mints a working key into it. This
-- moves the instances that already exist, and then tightens the constraint.
--
-- **The whole data move is gated on two things, and the second one matters
-- more than it looks: the instance has no space at all, and it has something
-- that needs one.** A migration runs on every deployment, and on a hosted one a
-- space-less row is not stale keys-mode data — it is instance-scoped by
-- design, shared by every tenant. Sweeping the catalogue into one tenant's
-- space would be a serious and quiet bug. So the first statement provisions a
-- space only where none exists, at a known id, and every statement after it is
-- conditioned on that row being there. On a hosted instance the insert writes
-- nothing and the moves are no-ops.
--
-- The second half of the gate is what keeps a *fresh* instance clean. A hosted
-- deployment that has never had an account has no spaces either, so "no space"
-- alone would provision one on it — a Default space nobody asked for, on an
-- instance where a space belongs to an account. Requiring something to move
-- says the same thing more honestly: this migration creates a home only when
-- there is already data that needs one. A fresh keys-mode instance is covered
-- by bootstrap, which provisions the space and mints the working key into it,
-- and a fresh hosted one is covered by sign-up.
--
-- **The gate asks about every table the body moves, not two of them.**
-- Space-less ordinary keys are the rows the constraint below refuses, so they
-- are the reason this migration exists — but an instance whose operator did
-- everything through the bootstrap key has data and has never held one, since
-- that key admitted itself past every map under the old model.
--
-- Two signals looked like enough and were not. An instance holding only the
-- operator key, the manifest catalogue and its own registered types matches
-- neither, so it gets no space and its `custom_types` stay in the space-less
-- bucket — which this file's own reasoning below calls out as the thing that
-- stops a self-hoster's types resolving. Registered types, custom edge types,
-- webhooks on both sides, blobs and edges each say "there is data here that
-- needs a home" on their own, so each is asked about.
--
-- The `items` arm carries the same two exclusions the move does, rather than
-- a looser version of them. A gate that fires on a row the move then skips
-- provisions a Default space and puts nothing in it.
--
-- **Three tables keep some of their space-less rows, and each has a
-- discriminator.**
--
-- `items` keeps two kinds, and only one of them for good. A
-- `system.integration` row is the registered manifest catalogue, written with
-- no space precisely so one registration is visible everywhere, and read
-- through the deliberate `space_id = $1 OR space_id IS NULL` widening; it
-- stays where it is. A `system.connection` row with `kind = 'app'` is an
-- OAuth grant projection, and it was held back here on the premise that keys
-- mode resolves no space for a sign-in, so a projection had nowhere truthful
-- to go. That premise did not survive: a sign-in on a keys-mode instance
-- resolves the instance's one space now, and a projection left space-less is
-- invisible to the security page and to every revoke door. The later
-- `app_grants_join_the_sole_space` moves them. Nothing changes in this file,
-- which has already run everywhere it applies.
--
-- `custom_types` keeps `origin = 'platform'` and `origin = 'integration'`. The
-- shipped set is upserted into the `''` bucket at every boot and would simply
-- be rewritten there; the same is true of a manifest's declared types, which
-- the catalogue reconcile re-registers with no space each start. Only
-- `origin = 'user'` moves, and it has to: a self-hoster's own registered types
-- stop resolving for a caller holding a space id, and an item write against
-- one then fails as an unknown type.
--
-- `api_keys` keeps its operator key, which is the point of the exercise.
--
-- **On a hosted instance the space-less ordinary keys are dropped rather than
-- moved.** They are revoked rows from before the space-mint route existed, and
-- their space is not recoverable: an instance with tenants has no single space
-- that is the truthful home for them, and picking one would be a fiction. What
-- they recorded — that a credential was created and later retired — is in the
-- audit log, which is the append-only history and is not touched. A live one
-- would fail the constraint below rather than be deleted, which is the right
-- way round: that is a credential somebody may still be using, and it needs a
-- person rather than a migration.
INSERT INTO `spaces` (`id`, `name`, `created_at`, `status`)
SELECT
  '01996d00-0000-7000-8000-000000000001',
  'Default',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'active'
WHERE NOT EXISTS (SELECT 1 FROM `spaces`)
  AND (
    EXISTS (SELECT 1 FROM `api_keys` WHERE `space_id` IS NULL AND `is_operator` = 0)
    OR EXISTS (
      SELECT 1 FROM `items`
      WHERE `space_id` IS NULL
        AND `type` <> 'system.integration'
        AND NOT (`type` = 'system.connection' AND json_extract(`properties`, '$.kind') = 'app')
    )
    OR EXISTS (SELECT 1 FROM `custom_types` WHERE `space_id` = '' AND `origin` = 'user')
    OR EXISTS (SELECT 1 FROM `custom_edge_types` WHERE `space_id` = '')
    OR EXISTS (SELECT 1 FROM `outbound_webhooks` WHERE `space_id` IS NULL)
    OR EXISTS (SELECT 1 FROM `inbound_webhooks` WHERE `space_id` IS NULL)
    OR EXISTS (SELECT 1 FROM `blobs` WHERE `space_id` = '')
    OR EXISTS (SELECT 1 FROM `edges` WHERE `space_id` IS NULL)
  );
--> statement-breakpoint
UPDATE `items` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND `type` <> 'system.integration'
  AND NOT (`type` = 'system.connection' AND json_extract(`properties`, '$.kind') = 'app')
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `edges` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `blobs` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` = ''
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `custom_types` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` = '' AND `origin` = 'user'
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `custom_edge_types` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` = ''
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `outbound_webhooks` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `inbound_webhooks` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `connection_oauth_tokens` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `connection_leased_tokens` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `audit_log` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
-- **Duplicate replays are collapsed before the move, on SQLite only.**
-- `idx_bulk_action_jobs_idempotency` is UNIQUE on (`space_id`,
-- `idempotency_key`) with NULLs distinct, so while every job here is
-- space-less two replays of one `Idempotency-Key` are representable and the
-- upsert's conflict target never matches. Postgres was rebuilt NULLS NOT
-- DISTINCT in 0061 for exactly that; SQLite has no such clause and kept the
-- older shape. Moving the rows onto one space is what makes them collide, and
-- an aborted migration naming a unique index is not something a self-hoster
-- can act on. The newest row per key is the one the caller would have been
-- served, so it is the one kept.
--
-- Guarded on the provisioned space like every move around it, and for the
-- same reason turned around: this is the one destructive statement here, and
-- an instance where nothing is being moved has no collision coming. Without
-- the guard it would delete history on a hosted instance the rest of this
-- migration leaves alone.
DELETE FROM `bulk_action_jobs`
WHERE EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001')
  AND `space_id` IS NULL
  AND `idempotency_key` IS NOT NULL
  AND `id` NOT IN (
    SELECT `id` FROM `bulk_action_jobs` AS `keep`
    WHERE `keep`.`space_id` IS NULL
      AND `keep`.`idempotency_key` IS NOT NULL
      AND `keep`.`created_at` = (
        SELECT MAX(`newest`.`created_at`) FROM `bulk_action_jobs` AS `newest`
        WHERE `newest`.`space_id` IS NULL
          AND `newest`.`idempotency_key` = `keep`.`idempotency_key`
      )
    GROUP BY `keep`.`idempotency_key`
  );
--> statement-breakpoint
UPDATE `bulk_action_jobs` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `event_log` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `enrichment_state` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `idempotency_records` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
UPDATE `api_keys` SET `space_id` = '01996d00-0000-7000-8000-000000000001'
WHERE `space_id` IS NULL
  AND `is_operator` = 0
  AND EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
--> statement-breakpoint
DELETE FROM `api_keys`
WHERE `space_id` IS NULL
  AND `is_operator` = 0
  AND `revoked_at` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `spaces` WHERE `id` = '01996d00-0000-7000-8000-000000000001');
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
	CONSTRAINT `api_keys_operator_iff_space_less`
	  CHECK ((`space_id` IS NULL) = (`is_operator` = 1))
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
