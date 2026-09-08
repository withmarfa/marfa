-- Every credential holds one permission set, and nothing checks a role.
--
-- Until now a key's reach came from two places that disagreed: the permission
-- maps on its row, and a `role` that let it ignore them. This drops the second
-- and gives the row somewhere to hold what the first could not express — the
-- eleven space permissions, which a sign-in has carried on its grant since the
-- grammar landed and a key had no column for at all.
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
-- **The criterion tests the operator flag rather than the space binding**, and
-- the difference is the whole of what a single-space self-host keeps. Keys mode
-- binds nothing to a space, so every working credential on such an instance is
-- space-less — and a criterion reading `space_id IS NOT NULL` would stamp none
-- of them, leaving an instance whose keys reached everything yesterday reaching
-- nothing today, with no route able to repair it: the permission list is
-- settable only at a mint, clamped to a creator whose own list is now empty.
-- The bypass this replaces made no space test either, so matching it here is
-- restoring the criterion rather than widening it. What the flag excludes is
-- exactly the operator key: space-less and instance-tier, which is the pair
-- the constraint below holds together.
--
-- **The last statement makes the escalation shape unrepresentable.** The
-- instance tier is the absence of a space binding, so a row claiming the tier
-- while bound to a space asks to be judged by both rules at once, and nothing
-- until now held the two together. A self-hoster carrying a live one fails
-- this migration rather than discovering later that a credential reaches past
-- the space it was minted into; the delete above takes the revoked ones, which
-- can never authenticate and are not worth failing a migration over.
--
-- **The converse is left alone, and deliberately.** A space-less key that is
-- not an operator key is what keys mode is made of: a single-space self-host
-- binds nothing to a space, so an equivalence here would make every credential
-- on such an instance an operator key, and a delete written to match it would
-- take that instance's entire revoked-key history with it. Keys mode gains a
-- real space in its own change, and the constraint tightens to an equivalence
-- there, where those rows move into the space rather than being dropped.
ALTER TABLE "api_keys" RENAME COLUMN "is_platform" TO "is_operator";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "space_permissions" text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "oauth_client_id" text;
--> statement-breakpoint
-- Category 2, Your profile. A key had nowhere to hold this: the field was on
-- the wire type and a first-party key reached the category through its role
-- instead. With the role gone the map is the only answer, so without a column
-- no key could ever be granted the category at all.
ALTER TABLE "api_keys" ADD COLUMN "profile_permissions" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE "api_keys"
SET type_permissions      = '{"*":"write"}',
    edge_permissions      = '{"*":"write"}',
    metadata_permissions  = '{"*":"write"}',
    extension_permissions = '{"*":"write"}',
    profile_permissions   = '{"*":"write"}',
    space_permissions     = '["space.webhooks","space.connections","space.schema","space.usage","space.settings","space.audit_read","space.item_purge","space.upstream_access","space.credentials","space.keys","space.app_grants"]'
WHERE revoked_at IS NULL
  AND scope_enforced = false
  AND role IN ('instance_admin', 'space_admin')
  AND NOT (space_id IS NULL AND is_operator);
--> statement-breakpoint
DELETE FROM "api_keys"
WHERE revoked_at IS NOT NULL
  AND is_operator
  AND space_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "role";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "scope_enforced";
--> statement-breakpoint
-- One account holds one space and the first person in it holds everything, so
-- this column answered a question with three possible values and only ever
-- gave one of them. A permission set per person is the multi-person feature
-- and is not this.
ALTER TABLE "users" DROP COLUMN "role";
--> statement-breakpoint
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_operator_is_space_less"
  CHECK (NOT is_operator OR space_id IS NULL);
