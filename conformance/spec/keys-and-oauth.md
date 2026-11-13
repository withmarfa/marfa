# Keys and sign-in

## The twelve permissions

A credential holds any of these permissions, each a row of the table below, which is written from the server's own permission list and so cannot differ from it.

<!-- permissions-table:start -->

| Permission          | What it lets a credential do                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit.read`        | Reading the audit log.                                                                                                                                  |
| `blobs.manage`      | Managing blob bytes and copies across the instance, without granting item content access.                                                               |
| `config.manage`     | Reading and replacing the instance configuration at `/config`: the enforcement levers and the cleanup-job retention overrides.                          |
| `connectors.manage` | Reading and administering connector registrations, their runs and their endpoints, deleting registrations and clearing a registration's retained state. |
| `grants.manage`     | Listing and revoking other apps' access.                                                                                                                |
| `instance.maintain` | Running housekeeping and canceling bulk jobs.                                                                                                           |
| `instance.read`     | Reading detailed health, metrics, housekeeping status, blob storage diagnostics and bulk job status.                                                    |
| `items.purge`       | Destroying a trashed item irrecoverably, through the single-item operation and the bulk one alike.                                                      |
| `keys.manage`       | Listing and revoking keys across the instance, changing their metadata or narrowing access, and setting the name and mark of any source.                |
| `keys.mint`         | Minting keys within the caller's current access, and listing, changing and revoking keys within that access.                                            |
| `schema.write`      | Removing type and edge type definitions that already exist, and replacing them, only those the credential's type or edge map grants write on.           |
| `webhooks.manage`   | Reading, registering, changing and removing the outbound subscriptions that send an instance's events out, and redelivering what they sent.             |

<!-- permissions-table:end -->

## Content reach

A named permission opens the operations it names and no item. What a credential reads and writes is its maps' alone.

### `keys-and-oauth/permissions-no-content`

When a credential holding named permissions and no content map reads or writes items, the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/key-management.test.ts › management permissions do not grant content access`, `› refuses a bulk action to a key reaching no type, and narrows one for a key writing none`, `compliance/unreadable-items.test.ts › a key reaching no type is refused a single item, whatever the id names`.

### `keys-and-oauth/direct-mint-everything`

When local authority mints a key from a body naming no permission, map or `sources`, the server MUST give the key all twelve permissions, `*: write` in each of the five maps and no claimed source.

**Reason:** The owner holds no ceiling of their own, so a key minted with nothing named holds everything a key can.

**Tests:** `compliance/key-management.test.ts › the local command issues an ordinary key without a caller ceiling`.

### `keys-and-oauth/type-write-includes-read`

While a credential's type map grants `write` on a type, the server MUST let the credential read items of that type wherever a `read` entry on it would.

**Reason:** A map entry names the most a credential may do with a type, and `write` is the level above `read`, so a credential that writes a type can read back what it writes.

**Tests:** `compliance/type-scoped-access.test.ts › note-write key can create and read notes but not bookmarks`, `› mixed permissions: read notes, read+write bookmarks`.

### `keys-and-oauth/edge-write-includes-read`

While a credential's edge map grants `write` on an edge type, the server MUST let the credential read edges of that type wherever a `read` entry on it would.

**Reason:** An edge map entry names the most a credential may do with an edge type, and `write` is the level above `read`.

**Tests:** `compliance/edge-permissions.test.ts › an edge type granted write is readable without a read entry`.

## How a type map is read

A type map's keys are exact type identifiers, subtree wildcards such as `core.media.*` and the global `*`. These rules decide which entry sets a credential's level on a type, at every operation that reads or writes items.

### `keys-and-oauth/map-exact-first`

When a credential's type map names a type exactly and a wildcard in the map also covers the type, the server MUST hold the credential to the level of the exact entry on items of that type.

**Tests:** `compliance/type-map-ranking.test.ts › decides a type by its exact entry over any wildcard that also covers it`, `› writes a type at the level of its exact entry over a wildcard`.

### `keys-and-oauth/map-longest-wildcard`

When two subtree wildcards in a credential's type map cover a type, the server MUST hold the credential to the level of the wildcard whose part before `.*` is longer on items of that type.

**Tests:** `compliance/type-map-ranking.test.ts › decides a type by the wildcard with the longer root when two cover it`.

### `keys-and-oauth/map-global-last`

When `*` is the only entry of a credential's type map that covers a type, the server MUST hold the credential to the level of `*` on items of that type.

**Tests:** `compliance/type-map-ranking.test.ts › applies the global wildcard only where no other entry covers a type`.

### `keys-and-oauth/map-exclusion-carves`

When a credential's type map names `none` for a pattern that a less specific entry granting `read` or `write` also covers, the server MUST leave the items of the types the `none` entry decides out of every read that returns a set.

**Reason:** `keys-and-oauth/map-exact-first`, `keys-and-oauth/map-longest-wildcard` and `keys-and-oauth/map-global-last` decide which entry holds, and a read by id answers such an item as missing (`keys-and-oauth/unreadable-as-missing`).

**Tests:** `compliance/type-map-ranking.test.ts › leaves out what a none entry under a granted wildcard covers, and keeps the rest`.

### `keys-and-oauth/map-wildcard-root`

When a credential's type map names a subtree wildcard, the server MUST apply the wildcard to the type named by its part before `.*` as well as to every type named under it.

**Reason:** `core.media.*` reads as media and everything under it, which is also how a granted scope lists it.

**Tests:** `compliance/type-map-ranking.test.ts › applies core.media.* to core.media itself, and not to a type outside it`.

### `keys-and-oauth/map-case-sensitive`

The server MUST match a credential's type map entry against a type identifier character for character, so that an exact entry, or the part of a subtree wildcard before `.*`, that differs from every type in case or holds a character no type identifier holds covers no type.

**Tests:** `compliance/type-map-ranking.test.ts › covers no type with an entry in another case`, `› covers no type with an entry holding a ?`.

## An item the key cannot read

### `keys-and-oauth/unreadable-as-missing`

When an operation names by id, in its path or its body, an item whose type the credential may not read, live or in the bin, the server MUST answer exactly as it answers an id no item holds, status, body and headers alike.

**Reason:** The answer says nothing of whether the item exists or what type it is. A key learns its own reach from `GET /keys/current`, never from a refusal. `items/create-id-unreadable`, `edges/end-source-hidden`, `edges/end-target-hidden`, `edges/read-id-source` and `edges/filter-backref-anchor` hold the same for a create, an edge's ends and a filter.

**Tests:** `compliance/unreadable-items.test.ts › an item the key cannot read answers as a missing one`, `compliance/type-permissions.test.ts › a key without reach on the item's type is answered as if the item, its edges and its backrefs were not there`.

### `keys-and-oauth/unreadable-replay`

When a write that answered an unreadable item's `404` is replayed under its `Idempotency-Key`, the server MUST replay the same `404`, as it replays one for an id no item holds.

**Reason:** Releasing the key, as a `403` is released, would tell the two apart.

**Tests:** `compliance/unreadable-items.test.ts › replays a hidden item's 404 under its Idempotency-Key, as it replays a missing id's`.

### `keys-and-oauth/unreadable-bulk-upsert`

When a `POST /items/bulk` entry under `upsert` names as its `id` the id of an item the credential may not read, the server MUST refuse it as a taken id alike for a live and a trashed item, naming nothing of its type.

**Tests:** `compliance/unreadable-items.test.ts › POST /items/bulk naming the id of an item it cannot read answers alike whether the item is live or trashed, and not with its type`.

### `keys-and-oauth/readable-not-writable`

If a credential that may read an item's type and not write it writes the item, then the server MUST answer `403 type_not_permitted`.

**Reason:** The credential already knows the item is there, so the refusal says nothing it did not know.

**Tests:** `compliance/unreadable-items.test.ts › a write to a type the key reads and does not write is still refused 403`, `compliance/type-permissions.test.ts › read-only scoped key cannot DELETE items of that type`.

### `keys-and-oauth/neighbors-omitted`

When `GET /items/{id}?include=neighbors` reaches neighbors whose type the credential may not read, the server MUST leave them out of `neighbors` and count them in `neighbors_omitted`.

**Reason:** A limit accepted: the count says how many there are and never their ids or types.

**Tests:** `compliance/unreadable-items.test.ts › count the neighbors the key cannot read in neighbors_omitted, and leave them out of neighbors`.

## Extension namespaces

An extension namespace is gated twice: by the type map on the item's type, as every item operation is, and then by the extension map. What a key is answered of an item's extensions is held by `items/extension-answer`, `items/extension-read`, `search-and-filters/export-extensions` and `events/metadata-namespaces`.

### `keys-and-oauth/extension-unreadable-type`

When an extension operation names an item whose type the key may not read, the server MUST answer exactly as for an id no item holds, `404 item_not_found`.

**Tests:** `compliance/extensions.test.ts › answers every door on an item whose type the key does not hold as a missing item, as the item doors answer it`.

### `keys-and-oauth/extension-unreadable-unchanged`

When an extension operation names an item whose type the key may not read, the server MUST leave the item's extensions as they were.

**Tests:** `compliance/extensions.test.ts › answers every door on an item whose type the key does not hold as a missing item, as the item doors answer it`.

### `keys-and-oauth/extension-read-only-type`

If a key that may read an item's type and not write it replaces or deletes one of the item's extension namespaces, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/extensions.test.ts › refuses a replace and a delete to a key that may read the item's type and not write it`.

### `keys-and-oauth/extension-read-only-unchanged`

If a key that may read an item's type and not write it replaces or deletes one of the item's extension namespaces, then the server MUST leave the namespace as it was.

**Tests:** `compliance/extensions.test.ts › refuses a replace and a delete to a key that may read the item's type and not write it`.

### `keys-and-oauth/extension-folder`

If a key holding write on `system.folder` replaces or deletes an extension namespace of a folder, then the server MUST answer `403 type_not_permitted`.

**Reason:** A folder is written through `/folders`, and its extensions take the write fence the item operations put on every `system.*` item (`items/system-types`).

**Tests:** `compliance/extensions.test.ts › refuses a folder's extensions to a key holding write on system.folder, as the item doors refuse the folder`.

### `keys-and-oauth/extension-namespace-map`

If a key holding the item's type and not the namespace at the level an extension operation needs uses that operation, then the server MUST answer `403 forbidden`, naming the namespace and the level in `details.grant`.

**Tests:** `compliance/extensions.test.ts › refuses a key without reach on the namespace`, `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`.

### `keys-and-oauth/extension-map-only`

The server MUST give a key reach on an extension namespace only through its extension map, by the namespace's name or `*`, whatever the key's label says.

**Tests:** `compliance/extensions.test.ts › grants no namespace to a key relabeled with its name`, `› grants no namespace to a key minted with its name for a label`, `› is reached only by a key whose extension map names it`, `› is not granted by a key whose extension map does not name it`.

### `keys-and-oauth/extension-exact-precedence`

When a key's extension map has an entry for a namespace, the server MUST grant the namespace the level of that entry and not the level of `*`.

**Tests:** `compliance/extension-permission-levels.test.ts › grants a normal %s level on its namespace in place of the wildcard's`, `› keeps an exact read ceiling when minting or updating wildcard write`.

## Minting

### `keys-and-oauth/mint-answer`

When `POST /keys` mints a key, the server MUST answer `201` with the key's `id`, its plaintext `key`, its `label`, its `permissions`, its claimed `sources`, its five maps and its `created_at`.

**Tests:** `compliance/key-management.test.ts › key creation response includes expected fields`, `› every key answer carries its permissions and its maps, empty where it holds nothing`, `› the local command issues an ordinary key without a caller ceiling`.

### `keys-and-oauth/mint-whole-set`

When a working key mints a key from a body naming no permission, map or `sources`, the server MUST give the new key the creator's permissions, five maps and claimed sources.

**Tests:** `compliance/key-management.test.ts › a mint naming no permissions, maps or claims takes the creator's whole set`, `compliance/claimed-sources.test.ts › a mint naming nothing takes the creator's claims`.

### `keys-and-oauth/mint-names-families`

When a `POST /keys` body names any of `permissions`, the five maps or `sources`, the server MUST give the key exactly what the body names in each family it names, an empty value included, and nothing in each family it leaves out.

**Reason:** A key holds what it was asked for and nothing more, so a key minted with only `permissions` reads and writes no item, and one minted with only a map holds no permission.

**Tests:** `compliance/key-management.test.ts › a mint naming only permissions holds those permissions and no reach`, `› a mint naming a map holds no permission it did not name`, `› a mint naming permissions and one map holds exactly those`, `compliance/claimed-sources.test.ts › a mint naming nothing takes the creator's claims`, `compliance/type-permissions.test.ts › scoped key can create items of permitted type`, `› scoped key cannot create items of non-permitted type`, `compliance/type-scoped-access.test.ts › note-write key can create and read notes but not bookmarks`.

### `keys-and-oauth/mint-ceiling`

If a working key's mint names a permission, or a type, edge, metadata or profile map entry, that the caller does not hold, then the server MUST answer `403 forbidden` with `details.required_scope` naming it.

**Tests:** `compliance/key-management.test.ts › refuses a mint reaching past what the caller holds`.

### `keys-and-oauth/namespace-ceiling`

If a working key's mint or update names an extension namespace at a level the caller does not hold, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/key-management.test.ts › refuses a mint reaching past what the caller holds`, `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`, `compliance/extension-permission-levels.test.ts › keeps an exact read ceiling when minting or updating wildcard write`.

### `keys-and-oauth/plaintext-once`

The server MUST carry a key's plaintext `key` only in the answer to the mint that created it.

**Tests:** `compliance/key-management.test.ts › key secret is not included in list response`, `› a key holding no permission reads itself, and no other key`, `compliance/keys-update.test.ts › updates the label and the maps in place, never the source`.

### `keys-and-oauth/plaintext-no-store`

When `POST /keys` mints a key, the server MUST send `Cache-Control: no-store` with the `201`.

**Reason:** The plaintext is in that answer and nowhere else, so no cache, shared or in the browser, may keep a copy.

**Tests:** `compliance/key-management.test.ts › the answer to a mint carries the plaintext and forbids a cache keeping it`.

### `keys-and-oauth/own-source-unique`

If a mint names as the new key's own `source` one that another key, neither revoked nor past its `expires_at`, holds as its own, then the server MUST answer `409 conflict` with `details.source` naming it.

**Reason:** A key's own source is stamped on what it writes and is how a file of fixtures or a device tells its items apart. Two keys share a source by claiming it instead.

**Tests:** `compliance/key-management.test.ts › refuses a second key naming as its own a source already in use`.

### `keys-and-oauth/own-source-held`

If a caller holding neither `keys.manage` nor direct owner or local authority mints a key naming as its own `source` one that no live key holds as its own and that a connector registration names, or that holds connector state, connector agreements or inbound endpoints, then the server MUST answer `403 forbidden` with `details.required_scope` naming `keys.manage` and `details.source` naming the source.

**Reason:** A key whose own source is held succeeds to it, taking over its inbound endpoints and deliveries (`inbound-webhooks/source-takeover-preserves`), its state and its agreements. Choosing a connector's successor belongs to whoever manages keys. A source nothing holds stays open to `keys.mint`.

**Tests:** `compliance/key-expiry.test.ts › leaves a source a connector holds to keys.manage, and a source never used to keys.mint`, `compliance/connector-state.test.ts › clears what a removed registration left, through a later registration of its source`.

### `keys-and-oauth/own-source-race`

When several mints name one unused `source` as their own at once, the server MUST answer exactly one of them `201` and the rest `409 conflict`.

**Tests:** `compliance/key-management.test.ts › answers mints racing for one source with one 201 and 409 conflict for the rest`.

### `keys-and-oauth/mint-permission`

If a caller holding neither `keys.mint` nor local authority sends `POST /keys`, then the server MUST answer `403 forbidden` with `details.required_scope` naming `keys.mint`.

**Reason:** `keys.manage` lists, narrows and revokes keys across the instance, and minting a new credential is a different power.

**Tests:** `compliance/key-management.test.ts › minting requires keys.mint`.

### `keys-and-oauth/key-operations-permission`

If a caller holding none of `keys.mint`, `keys.manage` and local authority lists, updates or revokes keys, then the server MUST answer `403 forbidden` with `details.required_scope` naming `keys.mint`.

**Tests:** `compliance/key-management.test.ts › list keys requires keys.mint`, `› revoke key requires keys.mint`, `compliance/keys-update.test.ts › refuses a caller without keys.mint`.

### `keys-and-oauth/mint-invalid-level`

If a key body names a map level the map does not take, then the server MUST answer `400 validation_error` with `details.errors[].path` naming the entry.

**Tests:** `compliance/type-scoped-access.test.ts › rejects invalid permission values in key creation`.

## Updating and revoking

### `keys-and-oauth/update-in-place`

When `PATCH /keys/{id}` names `label`, `default_tier`, `sources` or a permission family, the server MUST replace each field it names and leave each field it does not name as it was.

**Tests:** `compliance/keys-update.test.ts › updates the label and the maps in place, never the source`, `compliance/claimed-sources.test.ts › answers a key's claims on the mint, the listing and the update`.

### `keys-and-oauth/update-empty-family`

When `PATCH /keys/{id}` names a family empty, the server MUST leave the key holding nothing in that family.

**Reason:** A key minted too wide is narrowed in place rather than revoked and minted again.

**Tests:** `compliance/keys-update.test.ts › takes every permission and map from a key named empty`.

### `keys-and-oauth/update-source-fixed`

If a `PATCH /keys/{id}` body names `source`, then the server MUST answer `400 validation_error`.

**Reason:** A key's own source is stamped on every item it wrote, so a key that needs another source is a new key.

**Tests:** `compliance/keys-update.test.ts › refuses a change of source`.

### `keys-and-oauth/update-ceiling`

If a working key's update gives a key a permission, or a type, edge, metadata or profile map entry, that the caller does not hold, then the server MUST answer `403 forbidden` with `details.required_scope` naming it.

**Tests:** `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`.

### `keys-and-oauth/update-ceiling-unchanged`

If a working key's update gives a key a permission, or a type, edge, metadata or profile map entry, that the caller does not hold, then the server MUST leave the key as it was.

**Tests:** `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`.

### `keys-and-oauth/manage-narrows-only`

If a caller holding `keys.manage`, and not local authority, updates a key to hold a permission, map entry or claimed source the key does not already hold, then the server MUST answer `403 forbidden`.

**Reason:** `keys.manage` reaches every key so that it can take access away, and a power to add access to any key would be a power to mint.

**Tests:** `compliance/keys-update.test.ts › only narrows a key for a caller acting through keys.manage`.

### `keys-and-oauth/app-key-narrows-only`

If an update would give a key an app made a permission, map entry or claimed source the key does not already hold, then the server MUST answer `403 forbidden`, whoever the caller is.

**Reason:** The consent screen tells a person that a key an app makes holds what the app held and never more, and that promise is worth something only if no credential can lift it.

**Tests:** `compliance/key-reach.test.ts › a signed-in app gives a key within its reach a permission its grant holds, and no other`, `compliance/claimed-sources.test.ts › never widens a key an app made to a new source`.

### `keys-and-oauth/update-narrow-only`

If `PATCH /keys/{id}` names `narrow_only: true` and would give the key a permission, map entry or claimed source the key does not hold, then the server MUST answer `403 forbidden`, whoever the caller is.

**Reason:** A caller narrowing access may have read the key before another change. The update must not restore access the key has since lost.

**Tests:** `compliance/keys-update.test.ts › refuses an update that widens a key when it names narrow_only`.

### `keys-and-oauth/update-narrow-only-unchanged`

If `PATCH /keys/{id}` names `narrow_only: true` and would give the key a permission, map entry or claimed source the key does not hold, then the server MUST leave the key as it was.

**Tests:** `compliance/keys-update.test.ts › refuses an update that widens a key when it names narrow_only`.

### `keys-and-oauth/update-narrow-only-applies`

When `PATCH /keys/{id}` names `narrow_only: true` and would give the key nothing it does not hold, no `expires_at` later than its own or `null` when it has one, and no `enforcement_override` other than its own, the server MUST update the key as it would without `narrow_only`.

**Reason:** A denial beside a wildcard counts as held, so an update that carries each held denial forward is a narrowing, and one that drops a denial is not.

**Tests:** `compliance/keys-update.test.ts › refuses an update that widens a key when it names narrow_only`.

### `keys-and-oauth/update-narrow-only-levers`

If `PATCH /keys/{id}` names `narrow_only: true` and an `enforcement_override` other than the key's own, including `null` for a key that has one, then the server MUST answer `403 forbidden` and leave the key as it was, whoever the caller is.

**Reason:** Whether levers are looser than the key's own depends on the instance's levers, which a lever left out or `null` falls back to and which can change, so the server refuses any change to them rather than judging its direction. A caller without `config.manage` is refused for naming `enforcement_override` at all, whatever its value; one that holds it is refused only a value other than the key's own.

**Tests:** `compliance/keys-update.test.ts › refuses a change to a key's write rules when it names narrow_only`.

### `keys-and-oauth/key-unknown`

When `PATCH` or `DELETE /keys/{id}` names a well-formed id that no key within the caller's reach holds, the server MUST answer `404 api_key_not_found`.

**Tests:** `compliance/keys-update.test.ts › answers 404 for an unknown key and 400 for a malformed id`, `compliance/key-reach.test.ts › cannot revoke a key beyond its reach, and is answered as for no key`.

### `keys-and-oauth/key-malformed-id`

When `PATCH` or `DELETE /keys/{id}` names a malformed id, the server MUST answer `400 validation_error`.

**Tests:** `compliance/keys-update.test.ts › answers 404 for an unknown key and 400 for a malformed id`, `compliance/declared-refusals.test.ts › is refused 400 on the key and blob-copy doors`.

### `keys-and-oauth/revoke-answer`

When `DELETE /keys/{id}` revokes a key, the server MUST answer `200` with `ok: true`.

**Tests:** `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`.

### `keys-and-oauth/revoke-immediate`

When a key has been revoked, the server MUST answer the next request bearing it `401 unauthorized`.

**Reason:** What the key queued or holds open ends with it: `items/job-credential-lost` holds its bulk actions, `events/credential-revoked` its event streams and `search-and-filters/export-credential-ended` its exports.

**Tests:** `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`.

### `keys-and-oauth/revoke-twice`

When `DELETE /keys/{id}` names a key that is already revoked, the server MUST answer `404 api_key_not_found`, with a message saying it was already revoked only to a caller holding `keys.manage` or local authority.

**Reason:** A revoked key's reach cannot be measured, so a caller acting through `keys.mint` is told what it would be told of a key it never reached.

**Tests:** `compliance/key-reach.test.ts › answers a second revoke as an unknown key, and tells keys.manage the key was already revoked`.

### `keys-and-oauth/last-used-new`

When a key is minted, the server MUST answer its `last_used_at` as `null`.

**Tests:** `compliance/key-last-used.test.ts › new key has null or absent last_used_at`.

### `keys-and-oauth/last-used-set`

When a key's authenticated use has been recorded, the server MUST answer its `last_used_at` on `GET /keys` as the observed request time in ISO 8601 UTC.

**Reason:** Usage is recorded asynchronously and coalesced for one hour. Contention, storage failure or a full bounded queue can leave the previous timestamp or `null`; a later use retries recording without deciding whether authentication succeeds.

**Tests:** `compliance/key-last-used.test.ts › last_used_at is set after first use`, `› last_used_at is a valid ISO 8601 timestamp`, `› last_used_at appears in list response`.

## The CLI's keys

### `keys-and-oauth/command-mint-nothing`

When `marfa keys create` runs with `--no-permissions`, the CLI MUST mint a key holding nothing in `permissions` and in each of the five maps.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

### `keys-and-oauth/command-update-nothing`

When `marfa keys update` runs with `--no-permissions`, the CLI MUST name `permissions` and every map empty, so the key holds nothing in any of them.

**Reason:** A key minted too wide is narrowed to nothing in place, rather than revoked and minted again.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

### `keys-and-oauth/command-update-one-map`

When `marfa keys update` runs with one `--no-<map>` option, the CLI MUST empty that map and leave every other family as it was.

**Tests:** `cli/instance.test.ts › empties one key permission map at a time and retains every other family`.

### `keys-and-oauth/command-expires-in`

When `marfa keys create` or `marfa keys update` runs with `--expires-in`, the CLI MUST send `expires_at` as the time on its own clock plus that duration.

**Reason:** The duration is the CLI's, measured on its own clock; the server holds only the time it is sent.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `keys-and-oauth/command-expires-at`

When `marfa keys create` or `marfa keys update` runs with `--expires-at`, the CLI MUST send that time as `expires_at`, as it was written.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `keys-and-oauth/command-no-expiry`

When `marfa keys update` runs with `--no-expiry`, the CLI MUST send `expires_at` as `null`.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `keys-and-oauth/command-expiry-duration`

If `marfa keys create` or `marfa keys update` runs with an `--expires-in` that is not a whole number above zero and one of the units `s`, `m`, `h`, `d` or `w`, then the CLI MUST exit 1 with the code `invalid` and send nothing.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `keys-and-oauth/command-expiry-conflict`

If `marfa keys create` or `marfa keys update` runs with both `--expires-in` and `--expires-at`, then the CLI MUST exit 2 with the code `usage`.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `keys-and-oauth/command-no-expiry-conflict`

If `marfa keys update` runs with `--no-expiry` and with `--expires-in` or `--expires-at`, then the CLI MUST exit 2 with the code `usage`.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `keys-and-oauth/command-revoked-key`

When the server refuses a request the CLI sends under a revoked key, the CLI MUST exit 5 and report `unauthorized`.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

## Expiry

A key's `expires_at` is when it stops working, or `null` where it never does. `POST /keys` and `PATCH /keys/{id}` may name it.

### `keys-and-oauth/mint-expiry`

When `POST /keys` names an `expires_at` ahead of now, the server MUST mint the key with that `expires_at`.

**Tests:** `compliance/key-expiry.test.ts › is minted with the expiry named, and answers it in UTC on the mint, the listing and its own read`.

### `keys-and-oauth/mint-no-expiry`

When a caller that has no `expires_at` of its own sends `POST /keys` with no `expires_at`, the server MUST mint the key with an `expires_at` of `null`.

**Reason:** A caller with an expiry of its own gives the key it mints that expiry (`keys-and-oauth/expiry-inherited`); every other key is minted to last until it is revoked.

**Tests:** `compliance/key-expiry.test.ts › is minted with a null expiry where the caller has none and the body names none`.

### `keys-and-oauth/expiry-utc`

When `POST /keys` or `PATCH /keys/{id}` names an `expires_at`, the server MUST answer it in UTC at millisecond precision, as `YYYY-MM-DDTHH:mm:ss.sssZ`.

**Tests:** `compliance/key-expiry.test.ts › is minted with the expiry named, and answers it in UTC on the mint, the listing and its own read`.

### `keys-and-oauth/expiry-invalid`

If `POST /keys` or `PATCH /keys/{id}` names an `expires_at` string that is not an RFC 3339 date-time, as `items/occurred-at-form` states, then the server MUST answer `400 validation_error` with `details.field` `expires_at`.

**Tests:** `compliance/key-expiry.test.ts › refuses an expires_at that %s, naming the field, on a mint and on an update`, `› takes an expiry written with a lowercase t or z, as RFC 3339 allows, on a mint and on an update`.

### `keys-and-oauth/expiry-range`

If `POST /keys` or `PATCH /keys/{id}` names an `expires_at` whose UTC year is outside 0000 to 9999, then the server MUST answer `400 validation_error` with `details.field` `expires_at`.

**Tests:** `compliance/key-expiry.test.ts › refuses an expires_at that %s, naming the field, on a mint and on an update`.

### `keys-and-oauth/expiry-past`

If `POST /keys` or `PATCH /keys/{id}` names an `expires_at` that is not ahead of the time of the request, then the server MUST answer `400 validation_error` with `details.field` `expires_at`.

**Reason:** A key given a time that has passed is dead on arrival, and revoking is how a key is ended on purpose.

**Tests:** `compliance/key-expiry.test.ts › refuses an expires_at that %s, naming the field, on a mint and on an update`.

### `keys-and-oauth/expiry-refused-unchanged`

If `PATCH /keys/{id}` is refused for its `expires_at`, then the server MUST leave the key's `expires_at` as it was.

**Tests:** `compliance/key-expiry.test.ts › refuses an expires_at that %s, naming the field, on a mint and on an update`.

### `keys-and-oauth/update-expiry`

When `PATCH /keys/{id}` names an `expires_at` ahead of now, the server MUST replace the key's `expires_at` with it.

**Tests:** `compliance/key-expiry.test.ts › replaces it, clears it with null, and leaves it as it was where the update names none`.

### `keys-and-oauth/update-expiry-clear`

When `PATCH /keys/{id}` names an `expires_at` of `null`, the server MUST clear the key's `expires_at`, so the key never expires.

**Tests:** `compliance/key-expiry.test.ts › replaces it, clears it with null, and leaves it as it was where the update names none`.

### `keys-and-oauth/update-expiry-omitted`

When `PATCH /keys/{id}` names no `expires_at`, the server MUST leave the key's `expires_at` as it was.

**Tests:** `compliance/key-expiry.test.ts › replaces it, clears it with null, and leaves it as it was where the update names none`.

### `keys-and-oauth/expired-refused`

When a key is past its `expires_at`, the server MUST answer a request bearing it `401 unauthorized`.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`, `› is refused 401 once the expiry it was minted with comes`.

### `keys-and-oauth/expired-named`

When a request bears the secret of a key that is past its `expires_at` and not revoked, the server MUST carry that `expires_at` in `details.expired_at` of the `401 unauthorized`.

**Reason:** a person whose key stopped working can tell an expired key from a mistyped one and knows to use another key. Only the key's own secret reaches this answer, so it tells nothing to anyone who does not already hold the key.

**Tests:** `compliance/key-expiry.test.ts › names when it expired to a request bearing its own secret, and nothing to a secret no key holds`.

### `keys-and-oauth/unknown-secret-unnamed`

If a request bears a secret that no unrevoked key holds, then the server MUST answer `401 unauthorized` with no `details`.

**Reason:** a guessed or revoked secret learns nothing of any key.

**Tests:** `compliance/key-expiry.test.ts › names when it expired to a request bearing its own secret, and nothing to a secret no key holds`, `› names no expiry once the key is revoked`.

### `keys-and-oauth/expired-unlisted`

When a key is past its `expires_at`, the server MUST leave it out of `GET /keys`.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`.

### `keys-and-oauth/expired-source-free`

When a mint names as the new key's own `source` one that only keys past their `expires_at` hold as their own, the server MUST mint the key unless `keys-and-oauth/own-source-held` refuses it.

**Reason:** A key past its `expires_at` answers as unknown to a revoke, so nothing else could free its source for the key that replaces it.

**Tests:** `compliance/key-expiry.test.ts › gives up its own source to the next mint, and holds it until then`.

### `keys-and-oauth/expired-source-revoked`

When a mint takes a `source` from keys past their `expires_at`, the server MUST record a `key.revoke` audit entry for each of those keys, with `resource_id` naming it.

**Reason:** The mint revokes those keys, and their webhook subscriptions go with them, as with any revoke. A key's own source is held while it is not revoked.

**Tests:** `compliance/key-expiry.test.ts › gives up its own source to the next mint, and holds it until then`.

### `keys-and-oauth/expired-unknown`

When `PATCH` or `DELETE /keys/{id}` names a key past its `expires_at`, the server MUST answer `404 api_key_not_found`, whoever the caller is.

**Reason:** A key whose time has passed cannot be given a new one; a new key is minted instead.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`, `› answers 404 api_key_not_found to an update that would clear its expiry, and stays past it`.

### `keys-and-oauth/expired-unchanged`

When `PATCH` or `DELETE /keys/{id}` names a key past its `expires_at`, the server MUST leave the key as it was, whoever the caller is.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`, `› answers 404 api_key_not_found to an update that would clear its expiry, and stays past it`.

## A key's life is held to its maker's

### `keys-and-oauth/expiry-inherited`

When a key that has an `expires_at` sends `POST /keys` with no `expires_at`, the server MUST mint the key with the sender's `expires_at`.

**Reason:** A key that expires could otherwise outlast itself by minting a copy of what it holds that never expires.

**Tests:** `compliance/key-expiry.test.ts › mints a key that expires when its own does where the body names none, and no later where it names one`.

### `keys-and-oauth/expiry-mint-ceiling`

If a key that has an `expires_at` sends `POST /keys` naming an `expires_at` later than its own, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/key-expiry.test.ts › mints a key that expires when its own does where the body names none, and no later where it names one`.

### `keys-and-oauth/expiry-update-ceiling`

If a key that has an `expires_at` and does not hold `keys.manage` sends `PATCH /keys/{id}` naming an `expires_at` later than its own, or `null`, then the server MUST answer `403 forbidden` and leave the key as it was.

**Reason:** A key that could move its own expiry, or the expiry of a key it made, would hold the bound only until it chose not to. A caller holding `keys.manage` is held to the expiry of the key it changes instead (`keys-and-oauth/expiry-manage-narrows`).

**Tests:** `compliance/key-expiry.test.ts › neither lengthens nor clears the expiry of a key, its own included, and leaves the key as it was`.

### `keys-and-oauth/expiry-manage-narrows`

If a caller holding `keys.manage`, and not local authority, sends `PATCH /keys/{id}` for a key that has an `expires_at`, naming an `expires_at` later than it or `null`, then the server MUST answer `403 forbidden`.

**Reason:** `keys-and-oauth/manage-narrows-only` holds for a key's life as for its reach: a longer life is more access.

**Tests:** `compliance/key-expiry.test.ts › is given an expiry or has it shortened, and is refused a later expiry or none`.

### `keys-and-oauth/expiry-app-key-narrows`

If `PATCH /keys/{id}` is sent for a key an app made that has an `expires_at`, naming an `expires_at` later than it or `null`, then the server MUST answer `403 forbidden`, whoever the caller is.

**Reason:** `keys-and-oauth/app-key-narrows-only` holds for a key's life as for its reach.

**Tests:** `compliance/key-expiry.test.ts › is shortened and never lengthened or cleared, whoever the caller is`.

### `keys-and-oauth/expiry-owner-free`

When local authority sends `PATCH /keys/{id}` naming a later `expires_at`, or `null`, for a key no app made, the server MUST replace the key's `expires_at` with it.

**Tests:** `compliance/key-expiry.test.ts › lengthens or clears the expiry of a key that no app made`.

### `keys-and-oauth/expiry-narrow-only-narrows`

If `PATCH /keys/{id}` names `narrow_only: true` for a key that has an `expires_at`, naming an `expires_at` later than it or `null`, then the server MUST answer `403 forbidden` and leave the key as it was, whoever the caller is.

**Reason:** `keys-and-oauth/update-narrow-only` holds for a key's life as for its reach: an update based on an earlier read must not lengthen the key's current life.

**Tests:** `compliance/key-expiry.test.ts › is shortened or given when the key has none, and refused a later expiry or none`.

## Authentication

### `keys-and-oauth/no-credential`

When a request carrying no credential reaches an operation the API document publishes as taking one, the server MUST answer `401 unauthorized`, whatever its path, query and body.

**Tests:** `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `compliance/auth.test.ts › returns 401 when no auth header is provided`.

### `keys-and-oauth/unknown-credential`

When a request bears a credential that is no live key and no live access token, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/auth.test.ts › returns 401 for an invalid API key`, `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`.

### `keys-and-oauth/permission-before-body`

When an admitted credential lacks what an operation requires of every caller, the server MUST answer `403` before it judges the request's path, query or body.

**Reason:** A refusal that depended on the request would tell a caller that may not use the operation something about what lies behind it.

**Tests:** `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`.

### `keys-and-oauth/health-open`

The server MUST answer `GET /health` without a credential.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`.

### `keys-and-oauth/document-open`

The server MUST answer `GET /openapi.json` without a credential with the same document a credentialed read gets.

**Tests:** `compliance/instance.test.ts › serves its OpenAPI document, with and without a credential`.

## The calling key

### `keys-and-oauth/current-key`

When a key sends `GET /keys/current`, the server MUST answer that key's `id`, `source`, `permissions`, five maps, claimed `sources` and `default_tier`, without its plaintext, whatever the key holds.

**Reason:** A process handed a key can check it holds what it should and no more, which a key holding no permission cannot do at `GET /keys`.

**Tests:** `compliance/key-management.test.ts › a key holding no permission reads itself, and no other key`, `› every key answer carries its permissions and its maps, empty where it holds nothing`.

### `keys-and-oauth/current-key-app`

If a signed-in app's access token sends `GET /keys/current`, then the server MUST answer `403 forbidden`.

**Reason:** An access token is not a key. An app reads what it holds from the `scope` its token answer carried.

**Tests:** `compliance/declared-refusals.test.ts › cannot register a connector`.

## The shape of a key

### `keys-and-oauth/key-answer-fields`

The server MUST carry `permissions`, claimed `sources` and each of the five maps on every answer that holds a key, empty where the key holds nothing.

**Reason:** An empty list is never left for a reader to tell from a missing one, and the published `KeyResponse` and `ApiKey` declare each field required.

**Tests:** `compliance/key-management.test.ts › every key answer carries its permissions and its maps, empty where it holds nothing`.

### `keys-and-oauth/key-expires-field`

The server MUST carry `expires_at` on `POST /keys`, `GET /keys`, `GET /keys/current` and the answer to `PATCH /keys/{id}`, `null` on a key that has none.

**Tests:** `compliance/key-management.test.ts › every key answer carries its permissions and its maps, empty where it holds nothing`.

### `keys-and-oauth/app-key-origin`

The server MUST carry `oauth_client_id`, naming the app's `client_id`, on every answer that holds a key an app minted or a key minted by such a key.

**Reason:** A client that must not run on an app's key tells one by this field, and minting another key from an app's key does not shed the app's ceiling.

**Tests:** `compliance/key-oauth-client.test.ts › names the client an app minted the key through, on every door that answers a key`.

### `keys-and-oauth/app-key-origin-absent`

The server MUST leave `oauth_client_id` out of every answer that holds a key no app minted.

**Tests:** `compliance/key-oauth-client.test.ts › is absent from a key no app minted, on every door that answers a key`.

## A key's own levers

A key may carry any of the instance's three enforcement levers in `enforcement_override`, in the shape `/config` gives them: `strict_mode` with its `types`, and `source_allowlist` and `source_filter` each with `types` and `sources`.

### `keys-and-oauth/levers-replace`

Where a key carries a lever, the server MUST hold that key's writes to the key's lever in place of the instance's, looser or stricter.

**Tests:** `compliance/schema-enforcement.test.ts › replaces the instance's lever for the key, loosening as well as tightening`.

### `keys-and-oauth/levers-unset`

Where a key does not carry a lever, the server MUST hold that key's writes to the instance's lever.

**Tests:** `compliance/schema-enforcement.test.ts › leaves a lever it does not set to the instance`.

### `keys-and-oauth/levers-permission`

If a caller holding neither `config.manage` nor local authority mints or updates a key with a body naming `enforcement_override`, then the server MUST answer `403 forbidden` with `details.required_scope` naming `config.manage`.

**Reason:** A key's levers can be looser than the instance's, so setting them is a change to how the instance is enforced, which only a caller that may change the instance's own levers makes.

**Tests:** `compliance/schema-enforcement.test.ts › refuses a mint or an update naming levers to a caller without config.manage`, `› an app holding config.manage sets a key's levers looser than the instance's, and one without it is refused`.

### `keys-and-oauth/levers-permission-unchanged`

If a caller holding neither `config.manage` nor local authority mints or updates a key with a body naming `enforcement_override`, then the server MUST create no key and change none.

**Tests:** `compliance/schema-enforcement.test.ts › refuses a mint or an update naming levers to a caller without config.manage`, `› an app holding config.manage sets a key's levers looser than the instance's, and one without it is refused`.

### `keys-and-oauth/levers-not-inherited`

When a mint names no `enforcement_override`, the server MUST give the key no levers, whatever its creator carries.

**Tests:** `compliance/schema-enforcement.test.ts › is not taken from the creator by a mint naming none`.

### `keys-and-oauth/levers-replaced-whole`

When an update names `enforcement_override`, the server MUST replace the key's levers whole, and clear them when it names `null`.

**Tests:** `compliance/schema-enforcement.test.ts › reads back on the mint, the listing, the key itself and the update, is replaced whole and cleared by null`.

### `keys-and-oauth/levers-missing-field`

If a lever in a mint or an update lacks `types` or `sources`, then the server MUST answer `400 missing_required_field` with `details.field` naming it in full, such as `enforcement_override.source_filter.types`.

**Tests:** `compliance/schema-enforcement.test.ts › names the field a lever lacks, on the mint and on the update`.

### `keys-and-oauth/levers-missing-unchanged`

If a lever in a mint or an update lacks `types` or `sources`, then the server MUST create no key and change none.

**Tests:** `compliance/schema-enforcement.test.ts › names the field a lever lacks, on the mint and on the update`.

### `keys-and-oauth/levers-answered`

The server MUST answer a key's levers under `enforcement_override` on the mint, the listing, `GET /keys/current` and the update, and leave the field out for a key carrying none.

**Tests:** `compliance/schema-enforcement.test.ts › reads back on the mint, the listing, the key itself and the update, is replaced whole and cleared by null`.

## Claimed sources

A key may claim sources besides its own, and a write may name one it claims (`items/source-claimed`).

### `keys-and-oauth/claims-answered`

The server MUST take `sources` on `POST /keys` and `PATCH /keys/{id}`, and answer it on the mint, the listing and the update.

**Tests:** `compliance/claimed-sources.test.ts › answers a key's claims on the mint, the listing and the update`.

### `keys-and-oauth/claims-once`

When a mint or an update names a claim more than once, the server MUST hold it once, in the order it was first named.

**Tests:** `compliance/claimed-sources.test.ts › holds a claim named twice once, on the mint and on the update`.

### `keys-and-oauth/claims-bounds`

If a mint or an update names more than 1,000 claims, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/claimed-sources.test.ts › refuses a mint or an update claiming more than 1,000 sources`.

### `keys-and-oauth/claims-bounds-unchanged`

If a mint or an update names more than 1,000 claims, then the server MUST create no key and change none.

**Tests:** `compliance/claimed-sources.test.ts › refuses a mint or an update claiming more than 1,000 sources`.

### `keys-and-oauth/claims-entry`

If a mint names a claim that is empty once trimmed or longer than 200 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/claimed-sources.test.ts › refuses a claim that is empty or longer than a source may be, and trims one`.

### `keys-and-oauth/claims-trimmed`

When a mint names a claim with spaces around it, the server MUST store the claim trimmed.

**Tests:** `compliance/claimed-sources.test.ts › refuses a claim that is empty or longer than a source may be, and trims one`.

### `keys-and-oauth/claims-ceiling`

If a working key's mint or update claims a source other than the caller's own `source` and its own claims, then the server MUST answer `403 forbidden` with `details.source` naming the first such source.

**Tests:** `compliance/claimed-sources.test.ts › refuses a mint or an update claiming a source its caller does not hold`.

### `keys-and-oauth/claims-direct`

When local authority mints a key, or updates a key no app made, the server MUST grant any source outside the reserved prefix.

**Tests:** `compliance/claimed-sources.test.ts › refuses a mint or an update claiming a source its caller does not hold`, `› grants a source under any other prefix, connector: included`.

### `keys-and-oauth/claims-own-elsewhere`

If a mint names as the new key's own `source` one another key claims, and the caller could not grant that claim, then the server MUST answer `403 forbidden` with `details.source` naming it.

**Reason:** A key writes under its own source as surely as under a claim, so naming it as the source would take a claim the caller was refused.

**Tests:** `compliance/claimed-sources.test.ts › refuses a key whose own source another key claims, unless its caller could grant it`.

### `keys-and-oauth/claims-reserved`

If a mint or an update names a claim or an own `source` that, after trimming whitespace and ignoring case, starts with `oauth:` or `restored:`, then the server MUST answer `400 validation_error`, whoever the caller is.

**Reason:** An OAuth source names an app's identity, which no key earns by naming it. A restored source records history without granting any credential authority over it.

**Tests:** `compliance/claimed-sources.test.ts › refuses a reserved prefix, even to the owner`.

### `keys-and-oauth/claims-case`

The server MUST compare a key's own `source` with another key's claims exactly, case included.

**Tests:** `compliance/claimed-sources.test.ts › compares a key's own source with another key's claim case included`.

### `keys-and-oauth/claims-narrowed`

If a key whose claim was taken away creates or upserts by natural key under that source, then the server MUST answer `403 forbidden` with `details.source`.

**Reason:** A claim is not unique, so two separately enrolled devices can share natural keys (`items/natural-key-upsert`), and narrowing one takes effect at its next write. An item already under the source stays editable by `items/source-fixed`.

**Tests:** `compliance/claimed-sources.test.ts › stops a narrowed key writing under a source it no longer claims, and leaves its items there editable`.

### `keys-and-oauth/claims-narrowed-unwritten`

If a key whose claim was taken away creates or upserts by natural key under that source, then the server MUST write nothing.

**Tests:** `compliance/claimed-sources.test.ts › stops a narrowed key writing under a source it no longer claims, and leaves its items there editable`.

## Source names and marks

Every item carries a source code that says what wrote it. A source also has a name and an optional mark, an icon ID, to be shown by. `GET /sources` lists the sources a credential can see, and `GET /source` and `PATCH /source` read and set one.

### `keys-and-oauth/source-code-query`

The server MUST take the source code of `GET /source` and `PATCH /source` from the `source` query parameter.

**Reason:** a valid code such as `..`, or one holding `/`, `?` or `#`, would be rewritten or cut short in a path.

**Tests:** `compliance/source-names.test.ts › travels in the query, so a code a path would rewrite reaches its source`.

### `keys-and-oauth/source-code-length`

The server MUST take a nonempty source code with no Unicode `White_Space` at either end at `GET /source`, `PATCH /source` and every other door that takes one only if it is at most 200 characters long or is `restored:` followed by at most 200 characters.

**Reason:** a key holds a source of at most 200 characters, and a restore puts `restored:`, 9 more, before an app's source of that length, so no door may refuse a code the instance can hold.

**Tests:** `compliance/source-names.test.ts › takes a code as long as a restore can make one, and refuses a longer`, `compliance/source-name-characters.test.ts › counts a code in characters and takes no Unicode White_Space at either end`.

### `keys-and-oauth/source-read`

When a credential sends `GET /source` naming a source it can see, the server MUST answer the source's `source`, `name` and `name_from`, and its `mark` only where one is set.

**Tests:** `compliance/source-names.test.ts › is the name set on it, then its key's label, then its code`.

### `keys-and-oauth/source-list`

When a credential sends `GET /sources`, the server MUST answer every source it can see, in the shape `GET /source` answers each, ordered by code, in one page whose `next_cursor` is `null`.

**Tests:** `compliance/source-names.test.ts › is the name set on it, then its key's label, then its code`, `› answers source_not_found for a source the credential cannot see, and leaves it out of the list`.

### `keys-and-oauth/source-name-set`

Where a name is set on a source, the server MUST answer that name as the source's `name`, with `name_from` `set`.

**Tests:** `compliance/source-names.test.ts › is the name set on it, then its key's label, then its code`.

### `keys-and-oauth/source-name-app`

Where no name is set on the source an app signed in to the instance writes under, the server MUST answer the app's sign-in name as the source's `name`, with `name_from` `app`.

**Tests:** `compliance/source-names.test.ts › is an app's sign-in name for the source the app writes under`.

### `keys-and-oauth/source-name-key`

Where no name is set on a source that is the own `source` of a key that is neither revoked nor expired, the server MUST answer that key's label as the source's `name`, with `name_from` `key`.

**Tests:** `compliance/source-names.test.ts › is the name set on it, then its key's label, then its code`.

### `keys-and-oauth/source-name-claimed`

The server MUST NOT answer as a source's `name` the label of a key that only claims the source.

**Reason:** many keys can claim one source, and none of them is what the source names.

**Tests:** `compliance/source-names.test.ts › takes no key's label for a claimed source`.

### `keys-and-oauth/source-name-code`

Where no name is set on a source, no app writes under it and no live key holds it as its own `source`, the server MUST answer its code as its `name`, with `name_from` `code`.

**Tests:** `compliance/source-names.test.ts › is the name set on it, then its key's label, then its code`, `› keeps a set name when its source passes to a new key, and drops the revoked key's label`.

### `keys-and-oauth/source-name-kept`

When the key whose own `source` a source is ends, and a new key takes the source as its own, the server MUST keep the name set on the source.

**Reason:** the name belongs to the source, which outlives each key that writes under it.

**Tests:** `compliance/source-names.test.ts › keeps a set name when its source passes to a new key, and drops the revoked key's label`.

### `keys-and-oauth/source-label-dropped`

When the key whose own `source` a source is ends, the server MUST NOT answer that key's label as the source's `name`.

**Tests:** `compliance/source-names.test.ts › keeps a set name when its source passes to a new key, and drops the revoked key's label`.

### `keys-and-oauth/source-name-length`

If `PATCH /source` sends a `name` that is empty once trimmed, holds a control character or a bidirectional formatting character, or is longer than 200 characters once trimmed, then the server MUST answer `400 validation_error` and leave the source's name and mark as they were.

**Reason:** it is the rule a sign-in's name is held to, and an archive refuses a name that `PATCH /source` could not store, so a name measured another way would stop an export.

**Tests:** `compliance/source-names.test.ts › refuses a name an archive could not carry, and keeps what was set`, `compliance/source-name-characters.test.ts › counts a name in characters`.

### `keys-and-oauth/source-set-own`

When a credential sends `PATCH /source` naming its own `source` or a source it claims, the server MUST set the name and mark the body gives.

**Tests:** `compliance/source-names.test.ts › lets a key set its own source and one it claims, and refuses another without keys.manage`.

### `keys-and-oauth/source-set-manage`

When a credential holding `keys.manage`, or local authority, sends `PATCH /source` naming any source, the server MUST set the name and mark the body gives.

**Tests:** `compliance/source-names.test.ts › lets a key set its own source and one it claims, and refuses another without keys.manage`.

### `keys-and-oauth/source-set-refused`

If a credential without `keys.manage` sends `PATCH /source` naming a source that is neither its own `source` nor one it claims, then the server MUST answer `403 forbidden` with `details.required_scope` `keys.manage`.

**Reason:** a source's name is what the owner reads to tell what wrote an item, so only what writes under it, or what manages keys, may change it.

**Tests:** `compliance/source-names.test.ts › lets a key set its own source and one it claims, and refuses another without keys.manage`.

### `keys-and-oauth/source-set-refused-unchanged`

If a credential without `keys.manage` sends `PATCH /source` naming a source that is neither its own `source` nor one it claims, then the server MUST leave the source's name and mark as they were.

**Tests:** `compliance/source-names.test.ts › lets a key set its own source and one it claims, and refuses another without keys.manage`.

### `keys-and-oauth/source-set-omitted`

When `PATCH /source` leaves `name` or `mark` out of its body, the server MUST keep that field's value.

**Tests:** `compliance/source-names.test.ts › keeps a field left out, and clears one sent as null`.

### `keys-and-oauth/source-set-null`

When `PATCH /source` sends `name` or `mark` as `null`, the server MUST clear that field.

**Tests:** `compliance/source-names.test.ts › keeps a field left out, and clears one sent as null`.

### `keys-and-oauth/source-mark-name`

If `PATCH /source` sends a `mark` that `types/icon-name` refuses as a type's icon, then the server MUST answer `400 invalid_schema` naming it in `details.errors`.

**Reason:** a mark is drawn where a type's icon is, from the same pinned sets.

**Tests:** `compliance/source-names.test.ts › refuses a mark outside the pinned icon sets with invalid_schema, and sets nothing`.

### `keys-and-oauth/source-mark-unchanged`

If `PATCH /source` sends a `mark` that `types/icon-name` refuses as a type's icon, then the server MUST leave the source's name and mark as they were.

**Tests:** `compliance/source-names.test.ts › refuses a mark outside the pinned icon sets with invalid_schema, and sets nothing`.

### `keys-and-oauth/source-list-manage`

When a credential holding `keys.manage`, or local authority, sends `GET /sources`, the server MUST answer every source the instance holds: those of its items in any state, those with a name or mark, and those its keys hold as their own or claim, whatever types the credential reads.

**Reason:** `GET /source` answers any source to such a credential, so the list says the same.

**Tests:** `compliance/source-names.test.ts › lists every source the instance holds to a credential with keys.manage, whatever types it reads`.

### `keys-and-oauth/source-hidden`

If a credential without `keys.manage` sends `GET /source` naming a source that is not its own `source`, not one it claims, and carried by no item it can read in any state, then the server MUST answer `404 source_not_found`.

**Reason:** a source's code and name say what writes to the instance, which a credential that reads none of it has no reason to learn.

**Tests:** `compliance/source-names.test.ts › answers source_not_found for a source the credential cannot see, and leaves it out of the list`.

### `keys-and-oauth/source-hidden-unlisted`

The server MUST NOT list to a credential without `keys.manage`, on `GET /sources`, a source that is not its own `source`, not one it claims, and carried by no item it can read in any state.

**Tests:** `compliance/source-names.test.ts › answers source_not_found for a source the credential cannot see, and leaves it out of the list`.

### `keys-and-oauth/source-audit`

When `PATCH /source` succeeds, the server MUST record an audit entry with the action `source.update` and the source code as the resource.

**Tests:** `compliance/source-names.test.ts › records a change to a source's name in the audit log`.

## Which keys a credential reaches

A key is within a caller's reach when it holds nothing the caller does not: each permission in its `permissions`, its type, edge, metadata and profile maps (an exact `none` in the caller's map denying what its wildcard would reach), its extension map, and claimed sources the caller may grant. That is the ceiling a mint is held to, with the existing key in the place of the request.

### `keys-and-oauth/reach-minter`

When a caller acting through `keys.mint` updates or revokes a key beyond its reach, the server MUST answer exactly as for an id no key holds, `404 api_key_not_found` with the same message.

**Reason:** The answer says nothing of whether the key exists, as an item a key cannot read answers as a missing one.

**Tests:** `compliance/key-reach.test.ts › cannot revoke a key beyond its reach, and is answered as for no key`, `› cannot change a key beyond its reach, and is answered as for no key`, `› does not reach a key holding a permission it lacks`, `› does not reach a key claiming a source it could not grant`, `› does not reach a key holding an extension namespace it lacks`, `› a minter cannot reach a management key beyond its permissions; the owner can`.

### `keys-and-oauth/reach-list`

When a caller acting through `keys.mint` sends `GET /keys`, the server MUST list only the keys within its reach, itself among them.

**Tests:** `compliance/key-reach.test.ts › lists only the keys within its reach, itself included`.

### `keys-and-oauth/reach-within`

When a caller acting through `keys.mint` updates or revokes a key within its reach, a key holding the same as the caller and the caller itself included, the server MUST make the change.

**Tests:** `compliance/key-reach.test.ts › revokes and changes keys within its reach, a peer included, and revokes itself`.

### `keys-and-oauth/reach-manage`

When a caller holding `keys.manage` or local authority lists, narrows or revokes keys, the server MUST reach every key.

**Tests:** `compliance/key-reach.test.ts › a minter cannot reach a management key beyond its permissions; the owner can`, `compliance/keys-update.test.ts › only narrows a key for a caller acting through keys.manage`.

### `keys-and-oauth/reach-app`

When a signed-in app lists, updates or revokes keys, the server MUST measure each key against the app's grant, so that the key it mints naming no family is within its reach and a key holding anything its grant does not cover is not.

**Tests:** `compliance/key-reach.test.ts › a signed-in app reaches the key it mints naming no reach, and no wider key`.

## Signed-in apps and keys

### `keys-and-oauth/app-mint-ceiling`

If a signed-in app mints or updates a key to hold reach its grant's scopes do not cover, then the server MUST answer `403 forbidden` with `details.required_scope` naming the first scope it lacks.

**Tests:** `compliance/key-reach.test.ts › a signed-in app gives a key within its reach a permission its grant holds, and no other`.

### `keys-and-oauth/app-update-held`

When a signed-in app updates a key no app made, within its reach, to hold a permission its grant holds, the server MUST make the change.

**Tests:** `compliance/key-reach.test.ts › a signed-in app gives a key within its reach a permission its grant holds, and no other`.

### `keys-and-oauth/app-no-namespace`

If a signed-in app mints a key naming any extension namespace, then the server MUST answer `403 forbidden`.

**Reason:** No scope names an extension namespace, so no grant covers one.

**Tests:** `compliance/key-reach.test.ts › a signed-in app gives a key within its reach a permission its grant holds, and no other`.

## The rate limiter

One limiter, held in the server's memory, counts every limit in this chapter. Every count starts afresh when the server starts. The limiter holds a bounded number of windows for each kind of limit. When one kind is full, it drops that kind's window that ends soonest, and the key that window counted starts afresh. It never drops the windows that count password sign-in attempts at an account from every address once the instance has an owner, with a known device cookie or without one, the owner's device code lookup window or the instance-wide windows. The limits on a credential's requests are off for a run, so their rules are asserted against a server booted with the limiter on.

### `keys-and-oauth/keys-rate-cap`

Where the limiter is on, when a credential's requests to the operations under `/keys` pass the cap `rate_limit_keys_requests` names within a window, the server MUST answer `429 rate_limited`.

**Tests:** `compliance/key-rate-limit.test.ts › refuses past the limit the instance set, and the key doors share one window`.

### `keys-and-oauth/keys-rate-default`

Where the limiter is on and the instance names no cap for the key operations, the server MUST hold them to 200 requests per window.

**Tests:** `compliance/key-rate-limit.test.ts › falls back to 200 when the instance names no number`.

### `keys-and-oauth/keys-rate-own-window`

Where the limiter is on, when a credential has passed the cap on the key operations, the server MUST still answer it on an operation outside `/keys`.

**Tests:** `compliance/key-rate-limit.test.ts › closes the key doors while a data-plane read on the same credential is answered`.

### `keys-and-oauth/credential-rate-cap`

Where the limiter is on, when one key's or one app's requests to all operations together pass `rate_limit_requests` within a window, the server MUST answer each further request in that window `429 rate_limited`.

**Reason:** A key or an app that loops cannot take the instance's attention from the others, and the key operations have a cap of their own beneath it.

**Tests:** `compliance/credential-rate-limit.test.ts › refuses a key past the cap across operations, and counts none of its refused requests against another key`.

### `keys-and-oauth/credential-rate-default`

Where the limiter is on and the instance names no cap for a credential's requests, the server MUST hold a key or an app to 4000 requests per window.

**Tests:** `compliance/credential-rate-limit.test.ts › falls back to 4000 when the instance names no number`.

### `keys-and-oauth/credential-rate-own-window`

Where the limiter is on, when one credential has passed `rate_limit_requests`, the server MUST still answer another credential's requests.

**Tests:** `compliance/credential-rate-limit.test.ts › refuses a key past the cap across operations, and counts none of its refused requests against another key`.

### `keys-and-oauth/rate-limit-retry-after`

When the server answers `429 rate_limited`, the server MUST carry in `Retry-After` the whole seconds, from 1 to 86400, until the latest end among the limits that are spent, rounded up.

**Reason:** The wait is a real number of seconds and not an invitation to retry at once. A request refused by one limit can meet another that is spent for longer, so a client that waits less meets a second refusal.

**Tests:** `compliance/key-rate-limit.test.ts › refuses past the limit the instance set, and the key doors share one window`, `compliance/credential-rate-limit.test.ts › refuses a key past the cap across operations, and counts none of its refused requests against another key`.

### `keys-and-oauth/rate-limit-retry-detail`

When the server answers `429 rate_limited` in the error envelope to a request made with a key or an app's access token, the server MUST name in `details.retry_after` the number of seconds `Retry-After` carries.

**Tests:** `compliance/key-rate-limit.test.ts › refuses past the limit the instance set, and the key doors share one window`, `compliance/credential-rate-limit.test.ts › refuses a key past the cap across operations, and counts none of its refused requests against another key`.

## Discovery

### `keys-and-oauth/as-metadata`

The server MUST serve its authorization server metadata at `/.well-known/oauth-authorization-server/auth` without a credential, with `issuer` at its `/auth` path, `code` among `response_types_supported` and `S256` among `code_challenge_methods_supported`.

**Tests:** `compliance/oauth.test.ts › serves the authorization server metadata under the issuer path`.

### `keys-and-oauth/discovery-spellings`

The server MUST serve at `/auth/.well-known/oauth-authorization-server` the same authorization server metadata it serves at `/.well-known/oauth-authorization-server/auth`.

**Tests:** `compliance/oauth.test.ts › serves the authorization server metadata under both of its spellings, alike`.

### `keys-and-oauth/discovery-endpoints`

The server MUST name in its authorization server metadata the authorization, token, registration, revocation and device authorization endpoints, each under the issuer.

**Tests:** `compliance/oauth.test.ts › names every endpoint under the issuer, and serves the code, refresh and device grants and no other`.

### `keys-and-oauth/discovery-grants`

The server MUST advertise exactly the authorization code, refresh token and device code grants in `grant_types_supported`.

**Tests:** `compliance/oauth.test.ts › names every endpoint under the issuer, and serves the code, refresh and device grants and no other`.

### `keys-and-oauth/protected-resource`

The server MUST serve `/.well-known/oauth-protected-resource` without a credential, naming its own origin as `resource` and its issuer as the only authorization server.

**Tests:** `compliance/oauth.test.ts › serves the protected resource metadata, naming this server as the resource and its issuer as the authorization server`.

### `keys-and-oauth/protected-resource-mcp`

The server MUST serve `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource/mcp/schema` and `/.well-known/oauth-protected-resource/mcp/admin` without a credential, each naming its MCP endpoint's URI, the server's origin followed by `/mcp`, `/mcp/schema` or `/mcp/admin`, as `resource` and its issuer as the only authorization server.

**Reason:** RFC 9728 places a resource's metadata at the well-known path followed by the resource's own path, which is where an MCP client looks for it.

**Tests:** `compliance/oauth.test.ts › serves protected resource metadata for each MCP endpoint, naming the endpoint as the resource`.

### `keys-and-oauth/protected-resource-mcp-scopes`

When the server serves the protected resource metadata of `/mcp/schema` or `/mcp/admin`, the server MUST name in its `scopes_supported` every scope the metadata of `/mcp` names and the scopes that endpoint's own tools need: `metadata.types:write`, `schema.write` and `system.view:write` for `/mcp/schema`, and `instance.read`, `connectors.manage`, `audit.read`, `keys.mint` and `webhooks.manage` for `/mcp/admin`.

**Reason:** an MCP client asks for the scopes the metadata names, so an endpoint that does not name its tools' scopes is signed into without them.

**Tests:** `compliance/oauth.test.ts › advertises each MCP tool group's scopes in its endpoint's metadata, and not at /mcp`.

### `keys-and-oauth/protected-resource-mcp-default`

When the server serves the protected resource metadata of its origin or of `/mcp`, the server MUST name in its `scopes_supported` exactly `content:read`, `content:write`, `edge.*:read`, `edge.*:write` and `offline_access`.

**Reason:** An MCP client that is not told which scopes to ask for asks for every scope the metadata names, so the metadata names what `keys-and-oauth/register-default-scope` registers a client that names none for. A tool that needs more is answered with the scope it lacks (`keys-and-oauth/mcp-challenge-scope`).

**Tests:** `compliance/oauth.test.ts › advertises at the origin and at /mcp the owner's content and links alone, as a client naming no scope is registered for`.

### `keys-and-oauth/discovery-metadata-documents`

The server MUST advertise `client_id_metadata_document_supported` as `true` in its authorization server metadata.

**Reason:** An MCP client names itself by a client ID metadata document only when the server advertises that it accepts one, and otherwise falls back to registration.

**Tests:** `compliance/oauth.test.ts › advertises client ID metadata documents beside public clients`.

## Registration

### `keys-and-oauth/register-answer`

When a client registers at `POST /auth/oauth2/register`, which takes no credential, the server MUST answer `201` with a `client_id` and the metadata it registered.

**Tests:** `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`, `compliance/oauth-registration-schema.test.ts › describes the public metadata registration accepts and echoes`.

### `keys-and-oauth/register-unsupported-metadata`

When client metadata at `POST /auth/oauth2/register` holds a member the server does not support, such as `dpop_bound_access_tokens`, `subject_type`, `software_statement` or `resources`, the server MUST answer `201` without that member.

**Reason:** RFC 7591 section 2 has a server ignore metadata it does not understand, and section 3.1.1 a software statement it does not support, and an answer without the member tells the client it was not honored.

**Tests:** `compliance/oauth-registration-schema.test.ts › registers a client whose metadata the server does not support, and leaves that metadata out of its answer`.

### `keys-and-oauth/register-resource-uri`

If client metadata at `POST /auth/oauth2/register` names in `resources` a value that is not an absolute URI without a fragment, then the server MUST answer `400 invalid_target`.

**Reason:** RFC 8707 section 2 holds a resource indicator to an absolute URI with no fragment.

**Tests:** `compliance/oauth-registration-schema.test.ts › describes the refusal of a resource that is not an absolute URI`.

### `keys-and-oauth/register-auth-methods`

When valid client metadata at `POST /auth/oauth2/register` names `token_endpoint_auth_method` as `none` or leaves it out, the server MUST register the client with `none`.

**Tests:** `compliance/oauth-client-auth-methods.test.ts › registers a public client, the method a registration names or leaves out`.

### `keys-and-oauth/register-other-auth-method`

If client metadata at `POST /auth/oauth2/register` names a `token_endpoint_auth_method` other than `none`, then the server MUST answer `400 invalid_client_metadata` with an `error_description` naming that method.

**Reason:** An app proves itself at each sign-in with PKCE and holds no secret, so registration refuses any other method before an app relies on it.

**Tests:** `compliance/oauth-client-auth-methods.test.ts › refuses every method but none, naming the method`.

### `keys-and-oauth/discovery-auth-methods`

The server MUST advertise `none` as its only token and revocation authentication method in its authorization server metadata.

**Tests:** `compliance/oauth-client-auth-methods.test.ts › advertises only the client authentication methods it accepts`.

### `keys-and-oauth/register-scope`

When the server accepts a registration that names a scope, the server MUST register and answer that scope, each literal once, in the order first named.

**Tests:** `compliance/oauth.test.ts › registers a client naming a scope at that scope, once each`.

### `keys-and-oauth/register-offline-no-refresh`

If a registration names `offline_access` in its scope and its `grant_types` name neither `refresh_token` nor `authorization_code`, then the server MUST answer `400 invalid_client_metadata` with an `error_description` that names the `refresh_token` registration the client lacks.

**Reason:** Such a client may not exchange a refresh token, so `offline_access` is a scope it could never use.

**Tests:** `compliance/device-offline-access.test.ts › refuses a registration naming offline_access for grant types that cannot refresh, and names refresh_token`.

### `keys-and-oauth/register-default-scope`

When a registration or a client ID metadata document names no scope, the server MUST register the client for exactly `content:read`, `content:write`, `edge.*:read`, `edge.*:write` and `offline_access`, leaving out `offline_access` for a client whose `grant_types` name neither `refresh_token` nor `authorization_code`.

**Reason:** An app that asks for nothing in particular is offered the owner's content and the links between items, and none of the `system` types, the twelve permissions, the metadata or the profile: an app that needs one names it. A client that may not exchange a refresh token is refused `offline_access` by `keys-and-oauth/device-offline-no-refresh`, so a default that held the scope would register the client for a scope it can never use.

**Tests:** `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`, `› registers a client naming an empty or blank scope for the owner's data alone`, `compliance/device-offline-access.test.ts › registers a client that may not refresh, naming no scope, for the owner's data alone without offline_access, and answers its device flow an access token alone`, `compliance/approval-screens.test.ts › offers an app that names no scope the owner's content and links, read only beside read and edit or chosen types, and no permission`.

### `keys-and-oauth/register-unknown-scope`

When a registration names only scopes the instance cannot grant, the server MUST register the client for those scopes and for no other.

**Reason:** A registration that names scopes has asked for something, so it is never read as one that names none, and an authorization request that falls back to it has nothing to grant (`keys-and-oauth/authorize-nothing-grantable`).

**Tests:** `compliance/oauth.test.ts › registers a client naming only scopes it cannot be granted at those scopes, not the default`.

### `keys-and-oauth/register-web-default`

When a registration names no `application_type`, the server MUST register a web client.

**Tests:** `compliance/oauth.test.ts › registers a web client, whose redirect URI must be https and off the loopback`.

### `keys-and-oauth/register-web-loopback`

If a web client's registration names a redirect URI on the loopback, by `http` or `https`, then the server MUST answer `400 invalid_redirect_uri`.

**Tests:** `compliance/oauth.test.ts › registers a web client, whose redirect URI must be https and off the loopback`.

### `keys-and-oauth/register-native-loopback`

When a native client's registration names an `http` redirect URI on the loopback, the server MUST register it.

**Tests:** `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`, `compliance/oauth-registration-schema.test.ts › describes the public metadata registration accepts and echoes`.

### `keys-and-oauth/redirect-loopback-any-port`

When an authorization request names an `http` redirect URI on the loopback that differs from one the client registered on the loopback only in its port, the server MUST take it as the registered redirect URI.

**Reason:** A native app listens on whatever port the system gives it when it signs in (RFC 8252, section 7.3), so it cannot register the port in advance.

**Tests:** `compliance/sign-in-door-limits.test.ts › takes a loopback redirect URI on any port for one registered on the loopback`.

### `keys-and-oauth/register-native-private-use`

When a native client's registration names a redirect URI in a private-use scheme that is a reverse domain name, with a path and no authority, such as `com.example.app:/callback`, the server MUST register it.

**Reason:** RFC 8252 section 7.1: an app on a phone receives its sign-in at a scheme it claims, named for a domain its developer controls, because it cannot listen on the loopback.

**Tests:** `compliance/oauth.test.ts › registers a native client's private-use redirect URI in reverse-domain form, and refuses one in any other form`.

### `keys-and-oauth/register-native-private-form`

If a native client's registration names a redirect URI in a scheme other than `http` or `https` that is not a reverse domain name, or that has an authority, then the server MUST answer `400 invalid_redirect_uri`.

**Reason:** RFC 8252 section 7.1: a scheme not named for a domain can be claimed by another app on the device, and a private-use URI has no naming authority, so a single slash follows the scheme.

**Tests:** `compliance/oauth.test.ts › registers a native client's private-use redirect URI in reverse-domain form, and refuses one in any other form`.

### `keys-and-oauth/register-web-private-use`

If a web client's registration names a redirect URI in a private-use scheme, then the server MUST answer `400 invalid_redirect_uri`.

**Reason:** Only an app installed on a device can claim a scheme there, so a web client has no way to receive a code sent to one.

**Tests:** `compliance/oauth.test.ts › refuses a web client a private-use redirect URI that a native client may register`.

### `keys-and-oauth/register-unparseable`

If a registration names a redirect URI that does not parse, then the server MUST answer `400` with an RFC 7591 error object, `error` and `error_description`, rather than the error envelope.

**Tests:** `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`.

### `keys-and-oauth/register-body-cap`

If a body sent to `POST /auth/oauth2/register` is larger than 32768 bytes, then the server MUST answer `413 request_too_large`.

**Reason:** Registration takes no credential and answers every origin, and what it stores lives until the reaper removes it, so one request is bounded well below the general cap. Marfa's own clients register in about 200 bytes.

**Tests:** `compliance/web-page-register.test.ts › refuses a registration over 32768 bytes, and takes one just under it`.

### `keys-and-oauth/register-redirect-limit`

If a registration at `POST /auth/oauth2/register` names more than 10 redirect URIs, then the server MUST answer `400` with an RFC 7591 error object whose `error` is `invalid_redirect_uri`.

**Reason:** The consent screen names every origin a client's redirect URIs span, and a web page or hosted assistant registers one or two.

**Tests:** `compliance/web-page-register.test.ts › refuses a registration naming more than 10 redirect URIs, and takes one naming 10`.

### `keys-and-oauth/register-session-ignored`

When a registration at `POST /auth/oauth2/register` carries the owner's browser session cookie, from any origin, the server MUST register the client as it registers the same metadata sent without one.

**Reason:** Registration answers every origin, so a page the owner visits can send the owner's cookie along; the cookie must neither refuse the registration nor give the client anything the owner did not approve.

**Tests:** `compliance/web-page-register.test.ts › registers a client sent with the owner's session cookie as it registers one sent without`.

### `keys-and-oauth/register-idle-removed`

When the `credential-cleanup` job runs, the server MUST remove each registered client that no grant names, that holds no access or refresh token, and that was neither registered nor offered on the consent screen or the device approval page within `dcr_client_retention_days`.

**Reason:** Registration takes no credential and answers every origin, so any page the owner visits can add registrations; a short retention bounds what is left behind without a cap that a page could fill to block real registrations.

**Tests:** `compliance/web-page-register.test.ts › removes a registration nobody approved once it is idle past the retention, and keeps an approved, a revoked and an offered one`, `compliance/oauth-refusals.test.ts › answers 400 invalid_client for a pending code whose client is no longer registered`.

### `keys-and-oauth/register-granted-kept`

While a grant names a registered client, live or revoked, the server MUST keep the client registered.

**Reason:** A revoked grant is kept, with the client it names, until the credential clean-up removes it after `revoked_grant_retention_days`, so it never names a client that is gone.

**Tests:** `compliance/web-page-register.test.ts › removes a registration nobody approved once it is idle past the retention, and keeps an approved, a revoked and an offered one`.

### `keys-and-oauth/register-offered-kept`

When the consent screen or the device approval page offers a registered client, the server MUST keep the client registered for `dcr_client_retention_days` from then, however long ago it registered.

**Reason:** A page may keep its registration between visits, so a registration older than the retention can be the one the owner is deciding on; the job must not remove it from under the decision.

**Tests:** `compliance/web-page-register.test.ts › removes a registration nobody approved once it is idle past the retention, and keeps an approved, a revoked and an offered one`, `› keeps a registration the device approval page offered after it aged`.

### `keys-and-oauth/no-backchannel-registered`

When a registration names a `backchannel_logout_uri` or `backchannel_logout_session_required`, the server MUST register the client without either and leave both out of its answer.

**Reason:** A client reads the answer as what the server registered. The registration itself is accepted, so a client library that sends its defaults still registers.

**Tests:** `compliance/browser-sessions.test.ts › registers an app without a back-channel logout address and does not echo one`.

### `keys-and-oauth/metadata-document-private-host`

If an authorization request names as `client_id` an `https` URL whose host is `localhost` or a loopback, private or link-local IP address, then the server MUST answer `400 invalid_client`.

**Reason:** The server fetches the document a `client_id` URL names, so a host on its own network would let any page make the server read from that network.

**Tests:** `compliance/oauth-authorize.test.ts › is refused 400 invalid_client at %s`.

## Authorization with consent

A signed-in person approves an app on the consent screen, and the decision ends at the app's redirect URI. Every request here carries a PKCE challenge unless the rule says otherwise.

### `keys-and-oauth/consent-screen`

When a signed-in person's authorization request names scopes no standing consent covers, the server MUST send the browser to `/auth/authorize`, a consent screen offering each scope the request names that no standing consent covers.

**Reason:** A scope the person's standing consent already covers is shown as held and not offered again (`keys-and-oauth/approval-held-shown`). The server adds it to an approval while the consent still covers it (`keys-and-oauth/approval-held-now`).

**Tests:** `compliance/oauth-authorize.test.ts › shows a signed-in person a consent screen offering each scope the request names`, `compliance/approval-screens.test.ts › shows a scope the app holds in full without offering it as a choice, and does not post it, on the consent screen`.

### `keys-and-oauth/consent-accepted`

When a person approves on the consent screen and `keys-and-oauth/consent-nothing-denies` does not apply, the server MUST send the browser to the request's redirect URI with a `code` and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends the code for an accepted consent to the redirect URI with the request's state`.

### `keys-and-oauth/consent-declined`

When a person declines on the consent screen, the server MUST send the browser to the request's redirect URI with `error=access_denied`, the request's `state` and no code.

**Tests:** `compliance/oauth-authorize.test.ts › sends a declined consent to the redirect URI as access_denied with the request's state`.

### `keys-and-oauth/consent-nothing-denies`

Where a request names a scope other than `offline_access` that the app's standing consent does not cover, when a person approves on the consent screen with none of those scopes chosen, or with types chosen in place of all data or content and none of them turned on, and the post does not name `access` as `full` (`keys-and-oauth/approval-full-grants-request`), the server MUST send the browser to the request's redirect URI with `error=access_denied`, the request's `state` and no code.

**Reason:** Approving with everything turned off is declining, so the app is told what declining tells it, and no consent is recorded for an app that can do nothing with it. What a post carries without a choice is not a choice: `offline_access`, and every scope the app holds when the approval commits. An app that comes back and has everything newly asked turned off is denied, and keeps what it holds. A request that names nothing else offers nothing to turn off, and approving it is a yes.

**Tests:** `compliance/approval-screens.test.ts › answers an approval with nothing chosen as access_denied, as declining is answered`, `› answers an approval with everything newly asked turned off as access_denied for an app that already holds access, on the consent screen`, `› approves a request that names only offline_access, which offers nothing to turn off`, `› answers choosing types with none turned on as access_denied, as declining is answered, on both pages`, `› denies and keeps what an app holds when it asks again for all data and nothing new is chosen`.

### `keys-and-oauth/consent-ticked`

When a person approves on the consent screen with only some of the scopes the request names chosen, and the post does not name `access` as `full`, the server MUST issue a token for exactly the scopes chosen, plus the reads `keys-and-oauth/approval-write-read` adds and the held scopes `keys-and-oauth/approval-held-now` adds.

**Reason:** Types chosen in place of all data or content are a narrowing of that scope, and `keys-and-oauth/authorize-narrowed-types` states them.

**Tests:** `compliance/oauth-authorize.test.ts › issues a token for only the scopes the person chose`, `compliance/web-page-origin.test.ts › issues a narrowed page only what the person chose, though its origin is allowed`.

### `keys-and-oauth/consent-standing`

When a signed-in person's authorization request names only scopes their standing consent to the app covers, the server MUST send the browser to the redirect URI with a code and no consent screen.

**Tests:** `compliance/oauth-authorize.test.ts › answers a request a standing consent covers with a code and no consent screen`.

### `keys-and-oauth/consent-wider`

When an authorization request names a scope the person's standing consent to the app does not cover, the server MUST show the consent screen again, with the dialog `keys-and-oauth/consent-page-confirm` names when the request needs a recent sign-in.

**Tests:** `compliance/oauth-authorize.test.ts › asks again for a request reaching past the standing consent`.

### `keys-and-oauth/consent-prompt`

When an authorization request names `prompt=consent`, the server MUST show the consent screen whatever the standing consent covers.

**Tests:** `compliance/oauth-authorize.test.ts › asks again under prompt=consent, whatever the standing consent covers`.

### `keys-and-oauth/authorize-narrowed`

When an authorization request names a scope the instance cannot grant beside scopes it can, the server MUST drop that scope and authorize the rest.

**Reason:** A client that cached an older list of scopes is given what can still be granted, and the token answer's `scope` tells it what it got.

**Tests:** `compliance/oauth-authorize.test.ts › drops a requested scope the instance cannot grant, and authorizes the rest`.

### `keys-and-oauth/authorize-type-registered`

When an authorization request names `<type>:read` or `<type>:write` for a type registered while the server runs, from a client whose registration covers the scope, the server MUST offer the scope on the consent screen and grant it when the person accepts it, without a restart.

**Reason:** An app that registers its own types asks for them at once, so the scopes the server can grant follow the type registry, not the registry at boot.

**Tests:** `compliance/oauth-authorize.test.ts › is offered and granted at once, to an app registered before it`.

### `keys-and-oauth/authorize-narrowed-types`

When a person approves on the consent screen types chosen under an all-data or content scope the request named, the server MUST NOT let the token the code is exchanged for reach an item type the person left off.

**Reason:** A type under `*:read` or `content:read` is a narrowing of what was asked, not an addition to it, so it is granted though the request never wrote it, and the scope that covers it is not granted beside it. A scope that no named all-data or content scope covers, such as a write beside `*:read` or a permission, is refused by `keys-and-oauth/approval-types-beyond`, so this grants nothing a request that kept `*:read` or `content:read` would not have granted.

**Tests:** `compliance/approval-screens.test.ts › does not let a token for the types chosen reach a type left off`, `› issues an app that names no scope a token for exactly the types chosen read only, which reads them, is refused the rest and writes nothing`.

### `keys-and-oauth/authorize-narrowed-refresh`

When an app refreshes a token that was issued for types chosen in place of an all-data or content scope, the server MUST issue the new token for those types and not for that scope.

**Tests:** `compliance/approval-screens.test.ts › refreshes a token for the types chosen without widening them to all data`, `› issues an app that names no scope a token for exactly the types chosen read only, which reads them, is refused the rest and writes nothing`.

### `keys-and-oauth/authorize-nothing-grantable`

Where the redirect URI is on the loopback or in a private-use scheme, or the signed-in person's standing consent to the app covers it, if an authorization request names no scope the instance can grant, then the server MUST send the browser to the redirect URI with `error=invalid_scope`.

**Tests:** `compliance/oauth-authorize.test.ts › sends a request in which no scope can be granted to the redirect URI as invalid_scope`.

### `keys-and-oauth/authorize-pkce`

Where the redirect URI is on the loopback or in a private-use scheme, or the signed-in person's standing consent to the app covers it, if an authorization request carries no PKCE challenge, then the server MUST send the browser to the redirect URI with `error=invalid_request`.

**Tests:** `compliance/oauth-authorize.test.ts › is refused at the redirect URI without a PKCE challenge`.

### `keys-and-oauth/authorize-redirect-unregistered`

If an authorization request names a redirect URI the client did not register, then the server MUST send the browser to its own `/auth/error` page with `error=invalid_redirect`, never to that URI.

**Tests:** `compliance/oauth-authorize.test.ts › is sent to the error page, never to a redirect URI the app did not register`, `› sends a request naming a private-use redirect URI the app did not register to the error page`.

### `keys-and-oauth/authorize-error-web-unapproved`

If an authorization request is refused for a redirect URI the client registered that is a web address off the loopback, and the signed-in person's standing consent to the app does not cover that URI, then the server MUST send the browser to its own `/auth/error` page with the error, never to that URI.

**Reason:** RFC 9700 section 4.11.2: anyone can register an app with a web address, so sending an error there would make the server an open redirector. A loopback or private-use URI reaches a program on the person's device, and a standing consent means the person chose that address.

**Tests:** `compliance/oauth-authorize.test.ts › sends a refusal for a web app nobody approved to the error page, and to its redirect URI once the person approves it`.

### `keys-and-oauth/authorize-response-issuer`

When the server sends the browser to a redirect URI with an authorization response, a code or an error, the server MUST carry `iss` in it, equal to the `issuer` its authorization server metadata names.

**Reason:** the metadata sets `authorization_response_iss_parameter_supported` to `true` (RFC 9207), and a client that relies on it, as an MCP host does, rejects a response without `iss`.

**Tests:** `compliance/oauth-authorize.test.ts › sends its issuer with the code and with each error it sends to a redirect URI`.

### `keys-and-oauth/authorize-error-description`

When the server sends the browser to a redirect URI with an authorization error, the server MUST carry an `error_description` in it that says in words why the request was refused.

**Reason:** the error code alone does not tell a person who reads the app's failure screen what to change.

**Tests:** `compliance/oauth-authorize.test.ts › says why in an error_description with each error it sends to a redirect URI`.

### `keys-and-oauth/authorize-private-use`

When a person accepts an authorization request that names a private-use redirect URI the client registered, the server MUST send the browser to that URI, with the scheme and path as registered, carrying the code and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends the code to the private-use redirect URI the app registered, which the app exchanges there`.

### `keys-and-oauth/prompt-none-login`

Where the redirect URI is on the loopback or in a private-use scheme, if an authorization request naming `prompt=none` comes from nobody signed in, then the server MUST send the browser to the redirect URI with `error=login_required` and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends a request from nobody signed in to the redirect URI as login_required`, `compliance/signed-in-apps.test.ts › is answered login_required under prompt=none from nobody signed in, and is not caught up`.

### `keys-and-oauth/prompt-none-consent`

Where the redirect URI is on the loopback or in a private-use scheme, or the signed-in person's standing consent to the app covers it, if a signed-in person's authorization request naming `prompt=none` names a scope no standing consent covers, then the server MUST send the browser to the redirect URI with `error=consent_required` and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends a request no consent covers to the redirect URI as consent_required`.

### `keys-and-oauth/prompt-none-code`

When a signed-in person's authorization request naming `prompt=none` names only scopes a standing consent covers, the server MUST send the browser to the redirect URI with a code.

**Tests:** `compliance/oauth-authorize.test.ts › answers a request a standing consent covers with a code`.

### `keys-and-oauth/consent-older-reads`

When a browser session that signed in more than five minutes ago accepts on the consent screen with only scopes that read (`<type>:read` for an item type or a pattern of types, `edge.<type>:read` for an edge type or a pattern of edge types, `metadata:read`, `metadata.<sub-resource>:read`, `content:read`, `profile:read`, `profile.<row>:read` and `offline_access`), the server MUST send the browser to the redirect URI with a code.

**Reason:** Reading what the person already keeps is not a power over the instance, so a browser left signed in is trusted with it. Every write and every one of the twelve permissions is left out, and so is any scope this build cannot read.

**Tests:** `compliance/recent-sign-in-consent.test.ts › approves from a session that signed in more than five minutes ago the scopes that only read, and the scopes left off`.

### `keys-and-oauth/consent-recent-needed`

If a browser session that signed in more than five minutes ago accepts on the consent screen with a scope that `keys-and-oauth/consent-older-reads` does not list and the app's standing consent does not cover, then the server MUST answer `403 forbidden` with the message `Sign in again to perform this operation`, whatever the request's `Accept`, and issue no code.

**Reason:** A browser left signed in, or a copied cookie, cannot hand an app a write or a power over the instance without the password. The page recognises the refusal and asks the person to confirm it's them (`authentication/confirm-replaces`), then sends the approval once more.

**Tests:** `compliance/recent-sign-in-consent.test.ts › refuses a session that signed in more than five minutes ago 403 for a permission or a write, and a fresh session approves the same request`, `› refuses a browser that approves a request for a permission or a write on a screen left open past five minutes 403, whatever it asks for, and issues no code`.

### `keys-and-oauth/consent-recent-held`

When a browser session that signed in more than five minutes ago accepts on the consent screen with only scopes the app's standing consent covers, the server MUST send the browser to the redirect URI with a code.

**Tests:** `compliance/recent-sign-in-consent.test.ts › approves from a session that signed in more than five minutes ago a permission the app was approved for before, and refuses a second one`.

### `keys-and-oauth/consent-page-confirm`

When a signed-in owner opens `/auth/authorize` for a request that names a scope `keys-and-oauth/consent-older-reads` does not list and the app's standing consent does not cover, the server MUST answer `200` with the consent screen holding the "Confirm it's you" dialog, whatever the age of the session.

**Reason:** The screen is shown to a session older than five minutes, which confirms it's the owner when Approve is pressed, and to a fresh one, because a screen left open can pass its five minutes before the person decides.

**Tests:** `compliance/recent-sign-in-consent.test.ts › shows a session that signed in more than five minutes ago the request for a permission or a write, with the way to confirm it's them`.

### `keys-and-oauth/consent-page-reads`

When a browser session that signed in more than five minutes ago opens `/auth/authorize` for a request whose scopes `keys-and-oauth/consent-older-reads` lists, or the app's standing consent covers, the server MUST answer `200` with the consent screen holding no "Confirm it's you" dialog.

**Tests:** `compliance/recent-sign-in-consent.test.ts › shows a session that signed in more than five minutes ago a request that only reads, with no question`.

## What the approval pages offer

The consent screen at `/auth/authorize` and the device approval page at `/auth/device/consent` are the two pages a person approves an app on. Their choices come from the request's scopes and from the consent the app already holds. Every choice is a form field named `scopes` whose value is a scope the request names, except the types chosen in place of all data or content, which are fields named `types` whose values are scopes that an all-data or content scope the request names covers. So what a form posts is the request narrowed. Where a request names something to choose, a form also posts a field named `access`, whose value is `full` or `choose`.

### `keys-and-oauth/approval-full-access`

Where a request names a scope other than `offline_access` that the app's standing consent does not cover, the server MUST offer, on the consent screen and the device approval page, the access choices Full access and Choose access as a form field named `access` with the values `full` and `choose`, with Full access selected.

**Reason:** Most people want to give an app what it asked for. Full access says so in one choice, and Choose access keeps every control for the person who wants less. A request that names nothing else offers nothing to choose, so it carries no `access` field. Nor does a request whose every scope the app's standing consent already covers.

**Tests:** `compliance/approval-screens.test.ts › offers full access selected, and choosing access, on both pages`, `› offers no choice of access where the request names nothing to choose`, `› offers no choice of access where the app's standing consent covers every scope, on both pages`.

### `keys-and-oauth/approval-full-grants-request`

When a person approves with `access` posted as `full`, the server MUST grant every scope the request names, whatever scopes and types the form carries.

**Reason:** Full access is a decision about the request, not about the form, so a form that carries stale or extra fields cannot narrow it. The rule for a recent sign-in (`keys-and-oauth/consent-recent-needed`, `keys-and-oauth/device-recent-needed`) applies to the scopes that result.

**Tests:** `compliance/approval-screens.test.ts › issues a token for the whole request when the person approves with full access and posts no scope`, `› approves a device code for the whole request with full access and no scope`.

### `keys-and-oauth/approval-full-never-wider`

When a person approves with `access` posted as `full`, the server MUST NOT grant a scope the request does not name.

**Reason:** A form can carry any scope, so full access is read against the signed request and never against the form.

**Tests:** `compliance/approval-screens.test.ts › never grants a scope the request did not name, whatever the form adds`, `› never grants a scope the device code did not carry, whatever the form adds`.

### `keys-and-oauth/approval-access-unstated`

Where an approval post carries no `access` field or a value other than `full`, the server MUST read the decision from the scopes and types the post carries, as `keys-and-oauth/consent-ticked`, `keys-and-oauth/consent-nothing-denies` and `keys-and-oauth/device-nothing-denies` state.

**Reason:** A post that does not say Full access can only narrow, so a script written before the choice existed keeps its meaning.

**Tests:** `compliance/approval-screens.test.ts › witness: the same post without full access is a denial`, `› reads the scopes a post carries when access is a value other than full, on both pages`.

### `keys-and-oauth/approval-one-control`

While an app holds no access to an item type, where a request names both the read and the write of it, the server MUST offer that type, on the consent screen or the device approval page, as one control with the choices no access, read only and read and edit.

**Reason:** Two boxes for one type let a person turn on writing and turn off reading, which is not a level anyone means. Once the app holds the read, `keys-and-oauth/approval-levels-held` takes no access away and the control starts at read only.

**Tests:** `compliance/approval-screens.test.ts › offers a type asked at both levels as one control on both pages`.

### `keys-and-oauth/approval-edit-words`

Where the consent screen or the device approval page offers the choice read and edit for an item type or for content, the server MUST say beside the choices for data that edit includes adding and deleting items.

**Reason:** Read and edit is the write level, which creates, changes and deletes items, a delete moving the item to the bin. Destroying a trashed item for good takes the separate power `items.purge`, which the page offers on its own. Editing a definition, a link type or the profile adds and deletes no item, so those choices do not bring the line: `metadata.types:write` registers and changes types, and deleting one takes `schema.write`.

**Tests:** `compliance/approval-screens.test.ts › says that editing includes adding and deleting items, where a level to edit is offered, on both pages`.

### `keys-and-oauth/approval-levels-asked`

The server MUST NOT offer, on the consent screen or the device approval page, a level for a type above the highest level the request names for it.

**Tests:** `compliance/approval-screens.test.ts › offers no level above the one the request names, on both pages`.

### `keys-and-oauth/approval-only-asked`

The server MUST NOT offer, on the consent screen or the device approval page, a choice for a scope the request does not name.

**Reason:** Links between items, an app's own metadata and the profile appear only when an app asks for them.

**Tests:** `compliance/approval-screens.test.ts › offers only the scopes the request names, on both pages`.

### `keys-and-oauth/approval-open-ended`

Where a request names a scope that reaches types registered later, the server MUST say beside its control, on the consent screen or the device approval page, that it covers anything added later.

**Tests:** `compliance/approval-screens.test.ts › says beside a scope that reaches later types that it does, on both pages`.

### `keys-and-oauth/approval-powers-off`

The server MUST offer each permission a request names, among the Choose access controls on the consent screen or the device approval page, turned off.

**Reason:** A person who narrows hands a permission over only by turning it on. Full access (`keys-and-oauth/approval-full-grants-request`) hands over the whole request in one choice.

**Tests:** `compliance/approval-screens.test.ts › offers every permission turned off, on both pages`.

### `keys-and-oauth/approval-powers-marked`

Where a request names `instance.maintain`, `schema.write` or `items.purge`, the server MUST mark each on the consent screen and the device approval page as unable to be undone, among the Choose access controls and in the words of the Full access choice.

**Reason:** These delete data or definitions with no way back, and a person who chooses Full access hands them over without opening the controls.

**Tests:** `compliance/approval-screens.test.ts › marks the permissions that delete for good, and no other, on both pages`, `› says under Full access that a power can't be undone only where the request names one, on both pages`.

### `keys-and-oauth/approval-held-shown`

While an app holds consent, the server MUST show on the consent screen and the device approval page what the app holds, apart from what the request newly asks for.

**Tests:** `compliance/approval-screens.test.ts › shows what the app holds apart from what it asks for, on both pages`.

### `keys-and-oauth/approval-levels-held`

While an app holds access to a type, the server MUST NOT offer, on the consent screen or the device approval page, a level for that type below the level the app holds.

**Reason:** Neither page lowers an app's access.

**Tests:** `compliance/approval-screens.test.ts › offers no level below what the app holds, on both pages`.

### `keys-and-oauth/approval-keep-held`

While an app holds the read of an item type or of the profile and not its write, and a request names the write of it, the server MUST offer, on the consent screen or the device approval page, the choice read only, which posts no scope, beside the choice read and edit.

**Reason:** The page offers no level below what the app holds, so without this choice a person who holds the read could not decline the write: the only choice left would be the write. Choosing the held read leaves the standing consent as it is and asks nothing new. It posts no scope even where the request names the read, so a screen left open while the person disconnects the app does not count the read as newly chosen.

**Tests:** `compliance/approval-screens.test.ts › offers the held read beside the write, on both pages, for an item type's write asked while its read is held`, `› offers the held read beside the write, on both pages, for a type's write asked beside a wildcard read the app holds`, `› offers the held read beside the write, on both pages, for the profile's write asked while its read is held`, `› gives back no held read through Read only beside the write once the app is disconnected`.

### `keys-and-oauth/approval-never-lowers`

When a person approves on the consent screen or the device approval page, the server MUST keep every scope the app already holds.

**Reason:** The page shows what is held and cannot lower it, so a submission that omits a held scope does not lower it either. The token the approval makes carries what was chosen and the held scopes the request names.

**Tests:** `compliance/approval-screens.test.ts › keeps what the app holds when a narrower choice is approved on the consent screen`, `› keeps what the app holds when a narrower choice is approved on the device approval page`.

### `keys-and-oauth/approval-held-now`

When a person approves on the consent screen or the device approval page, the server MUST add to the approval only the scopes the request names that the app's standing consent covers when the approval commits.

**Reason:** The page posts the person's choices and the mechanisms, not the access the app holds. A screen left open while the person disconnects the app, in another tab, then gives nothing back: with the held scopes gone and nothing newly chosen the approval is a denial, and with a choice the app gets that choice and nothing it held.

**Tests:** `compliance/approval-screens.test.ts › adds the access the app still holds to what is approved on the consent screen`, `› adds the access the app still holds to what is approved on the device approval page`, `› gives back nothing the person ended, and denies where nothing new is chosen, on the consent screen`, `› refuses the device code of a screen left open once the app is disconnected, and grants nothing`.

### `keys-and-oauth/approval-write-read`

When an approval names a write scope for an item type and the request also names the read scope of that type, the server MUST issue the token for both.

**Reason:** A write includes the read, so "read and edit" gives a token the same scopes as before a level was one control.

**Tests:** `compliance/approval-screens.test.ts › issues the read a chosen write includes`.

### `keys-and-oauth/approval-beyond-shown`

If an approval posted from the consent screen or the device approval page names a scope the request did not name, then the server MUST answer `400` and grant nothing.

**Reason:** A form can only narrow the request. A post asking for more than the page showed is refused whole, so not even the scopes beside the extra one are granted.

**Tests:** `compliance/approval-screens.test.ts › refuses a consent decision that names a scope the request did not, and grants nothing`, `› refuses a device approval that names a scope the code did not carry, and leaves the code pending`.

### `keys-and-oauth/approval-all-data-types`

Where a request names the all-data scope `*:read` or `*:write`, or the content scope `content:read` or `content:write`, the server MUST offer on the consent screen and the device approval page the choice to choose types beside the levels the request names for that scope, and one control for each item type registered on the instance that the app's registration can be approved for by name, except the types under the `system` and `marfa` roots and the types the app already holds in full.

**Reason:** All your data, including types added later, is one choice, and an owner who would give less chooses the types instead. Your content is all data but the `system` and `marfa` types, and it is what an app that names no scope is registered for (`keys-and-oauth/register-default-scope`), so its row offers the same types, and the owner of an app such as an MCP client can narrow it to some of them. A type under `system` or `marfa` holds the instance's own bookkeeping and is not data the person keeps, so it is never a choice, though all data reaches it. A type the app holds in full is shown under what the app already holds (`keys-and-oauth/approval-held-shown`) and offered no control. An app registered with a list of scopes is offered every registered type, because naming a type its list's all-data or content scope covers adds nothing to what it may ask for. An app registered with no list is offered only the types the server's supported scopes name, those it was started with, so a type registered since, such as a `user` or publisher type, gets no control and is reached only by all data or content. Registering through `POST /auth/oauth2/register` always stores a list, the scopes named or, where it names none, those `keys-and-oauth/register-default-scope` states, so only an app registered another way has none.

**Tests:** `compliance/approval-screens.test.ts › offers all data as one choice with the choice to choose types, and a control for each type, on both pages`, `› offers no choice of types for a request that does not name all data`, `› keeps the types an app holds when it asks again for all data, and shows them as held`, `› offers an app that names no scope the owner's content and links, read only beside read and edit or chosen types, and no permission`, `› offers content with the choice to choose types, at no level above the one asked, on both pages`.

### `keys-and-oauth/approval-types-levels`

The server MUST NOT offer, for a type chosen in place of all data or content, a level above the highest level the request names for that scope.

**Tests:** `compliance/approval-screens.test.ts › offers a type no higher than the level asked for all data`, `› offers content with the choice to choose types, at no level above the one asked, on both pages`.

### `keys-and-oauth/approval-types-grant`

When a person approves on the consent screen or the device approval page with types chosen in place of all data or content, the server MUST issue a token for exactly the types turned on, plus the reads `keys-and-oauth/approval-write-read` adds and the held scopes `keys-and-oauth/approval-held-now` adds, and not the all-data or content scope.

**Tests:** `compliance/approval-screens.test.ts › issues a token for exactly the types chosen, and not all data, on the consent screen`, `› issues a token for exactly the types chosen, and not all data, on the device approval page`, `› issues an app that names no scope a token for exactly the types chosen read only, which reads them, is refused the rest and writes nothing`, `› issues a token for exactly the types chosen in place of content, and not content, on the device approval page`.

### `keys-and-oauth/approval-types-unchosen`

When a person approves on the consent screen or the device approval page with all data or content chosen and not types, the server MUST issue a token for that scope and no scope from the type controls.

**Reason:** A page without a script posts every control, so the controls for types that were not chosen are posted too and mean nothing, even one that names a type deleted since the page was drawn.

**Tests:** `compliance/approval-screens.test.ts › issues a token for all data and none of the type controls when types were not chosen`.

### `keys-and-oauth/approval-types-beyond`

If an approval names, for a type chosen in place of all data or content, a scope that no all-data or content scope the request names covers, or a type the page did not offer, then the server MUST answer `400` and grant nothing.

**Reason:** A form can only narrow the request: the write of a type is not covered by a request for `*:read` or `content:read`, and a `system` or `marfa` type or a permission is not a type the person was offered. The post is refused whole, as `keys-and-oauth/approval-beyond-shown` refuses one.

**Tests:** `compliance/approval-screens.test.ts › refuses a type the request does not reach, and grants nothing, on the consent screen`, `› refuses a type the request does not reach, and grants nothing, on the device approval page`, `› refuses a type that content read only does not reach, and grants nothing, on the consent screen`.

### `keys-and-oauth/approval-types-keep`

While an app holds scopes for item types and a request names all data or content, when a person approves on the consent screen or the device approval page, the server MUST keep the scopes the app holds for those types, whether the person kept that scope or chose types.

**Reason:** `keys-and-oauth/approval-never-lowers` holds when all data or content is the ask. A type the app holds in full is shown as held and offered no control, and one it holds in part is offered no level below the one it holds.

**Tests:** `compliance/approval-screens.test.ts › keeps the types an app holds when it asks again for all data, and shows them as held`, `› keeps the types an app holds on the device approval page when it asks again for all data`.

### `keys-and-oauth/approval-same-label`

When the consent screen or the device approval page shows an item type under a label that a row on the page for a different item type, or a row the page names itself, such as Profile or Links between items, also carries, the server MUST show the identifier of the type under its label.

**Reason:** An instance can register a type labeled like a shipped one, such as `core.task` and `aic.ticket.task` both labeled "Task", or like one of the page's own rows. Rows that read alike give the person nothing to choose between.

**Tests:** `compliance/approval-screens.test.ts › shows each of them with its identifier, and a type with a label of its own without one, on both pages`, `› gives a type the identifier when a page's own row shares its label, and that row none`.

### `keys-and-oauth/approval-same-label-described`

When the consent screen or the device approval page shows the identifier of an item type under the label of the type's control, the server MUST name that line as the control's description.

**Reason:** The label is the control's name, so a screen reader reads two such controls alike unless their description tells them apart.

**Tests:** `compliance/approval-screens.test.ts › describes the control of each of them by its identifier, and keeps the label as its name`.

### `keys-and-oauth/approval-own-label`

When the consent screen or the device approval page shows an item type under a label that no row on the page for a different item type, and no row the page names itself, carries, the server MUST NOT show the identifier of that type under its label.

**Reason:** A label that is its own needs no identifier, so the page stays as short as it was. One type can have two rows, such as a row of its own beside the list of types chosen in place of all data or content, or a row for what the app holds beside one for what it is asked, and two rows of one type are not a clash.

**Tests:** `compliance/approval-screens.test.ts › shows each of them with its identifier, and a type with a label of its own without one, on both pages`, `› shows no identifier where only one type of a label is on the page, though the instance has two`, `› shows no identifier under either row, because both are the same type`.

### `keys-and-oauth/approval-page-row-no-identifier`

When the consent screen or the device approval page shows a row it names itself, such as Profile or Links between items, the server MUST NOT show an item type's identifier under that row's title, though an item type has the same label.

**Reason:** The title of such a row is the name of what it is, and the identifier is how the types beside it are told apart from it.

**Tests:** `compliance/approval-screens.test.ts › gives a type the identifier when a page's own row shares its label, and that row none`.

### `keys-and-oauth/access-words`

The server MUST name the levels of access on the consent screen and the device approval page as "Read and edit", "Read only" and "No access", and each of the twelve permissions by the title in `GLOSSARY.md`, "Access words".

**Reason:** Access reads the same wherever a person meets it: on these pages and in the CLI's output (`keys-and-oauth/access-words-cli`). The words are kept in `GLOSSARY.md`, one description of access in the server builds every page that shows it, and `ci/access-words.test.ts` holds the glossary's tables to the server's words and the CLI's, which no fixture here can reach.

**Tests:** `compliance/approval-screens.test.ts › offers a type asked at both levels as one control on both pages`, `› describes each permission in the same words on both pages`.

### `keys-and-oauth/access-words-cli`

Where the CLI prints what a key or an app holds in its readable output, the CLI MUST name each level of access it prints as "Read and edit", "Read only" or "No access", and each permission by the title the approval pages use.

**Tests:** `cli/access-words.test.ts › prints what a key holds in the words the approval pages use`.

## A client's registration

### `keys-and-oauth/catch-up-signed-in`

When a signed-in person's authorization request names a scope the instance publishes to every client and the client is not registered for, the server MUST add that scope to the client's registration.

**Reason:** A client registered before the instance published a scope is not refused a scope it was never told it lacked.

**Tests:** `compliance/signed-in-apps.test.ts › is caught up to a published scope once a person is signed in, and the grant carries it`, `› keeps the published scope it was caught up to, so a request naming none carries it`.

### `keys-and-oauth/catch-up-nobody`

When an authorization request from nobody signed in names a scope the client is not registered for, the server MUST send the browser to `/auth/sign-in` with the request, every scope it named included, as `return_to`.

**Reason:** The request runs again once the person signs in, and is caught up then.

**Tests:** `compliance/signed-in-apps.test.ts › is registered at the scope it asked for, which an authorize from nobody signed in leaves as it was`.

### `keys-and-oauth/catch-up-nobody-unchanged`

When an authorization request from nobody signed in names a scope the client is not registered for, the server MUST leave the client's registration as it was.

**Reason:** Without the person, anybody holding a client's public id and a registered callback could widen what that client's next consent screen offers.

**Tests:** `compliance/signed-in-apps.test.ts › is registered at the scope it asked for, which an authorize from nobody signed in leaves as it was`.

### `keys-and-oauth/catch-up-prompt-none`

When an authorization request naming `prompt=none` from nobody signed in names a scope the client is not registered for, the server MUST leave the registration as it was.

**Tests:** `compliance/signed-in-apps.test.ts › is answered login_required under prompt=none from nobody signed in, and is not caught up`.

## The code exchange

### `keys-and-oauth/code-exchange`

When an app exchanges a code at `POST /auth/oauth2/token` with the verifier that matches its challenge, while the grant the code was issued under stands, the server MUST answer `200` with a bearer `access_token`.

**Tests:** `compliance/oauth-authorize.test.ts › exchanges a code once, and refuses it again with invalid_grant`, `› sends the code to the private-use redirect URI the app registered, which the app exchanges there`.

### `keys-and-oauth/code-grant-revoked`

If an app exchanges a code after the grant it was issued under was revoked, then the server MUST answer `400 invalid_grant`.

**Reason:** With `offline_access` a code yields a refresh token that rotates without end, so a code that outlived its grant would turn a revocation back into a standing grant.

**Tests:** `compliance/auth-grants.test.ts › is refused invalid_grant when exchanged after the grant was revoked`.

### `keys-and-oauth/code-once`

If an app exchanges a code a second time, then the server MUST answer `400 invalid_grant`.

**Tests:** `compliance/oauth-authorize.test.ts › exchanges a code once, and refuses it again with invalid_grant`.

### `keys-and-oauth/code-verifier`

If an app exchanges a code with a verifier that does not match its challenge, then the server MUST answer `400 invalid_grant`.

**Reason:** RFC 7636 asks for `invalid_grant`, and a `401` is the answer RFC 6749 keeps for a client that failed to authenticate.

**Tests:** `compliance/oauth-authorize.test.ts › refuses a code verifier that does not match the challenge 400 invalid_grant, and issues no token`.

### `keys-and-oauth/code-verifier-missing`

If an app exchanges a code issued with a challenge and sends no verifier, then the server MUST answer `400 invalid_request`.

**Tests:** `compliance/oauth-authorize.test.ts › refuses a code issued with a challenge and exchanged with no verifier 400 invalid_request`.

### `keys-and-oauth/code-needs-browser`

If an app exchanges a code after the browser session that approved it has ended, then the server MUST answer `400 invalid_request`.

**Reason:** A code is the browser's own step in an approval, and a browser that has ended cannot finish one.

**Tests:** `compliance/browser-sessions.test.ts › refuses an authorization code once the browser that approved it has ended, and accepts one whose browser lives`.

### `keys-and-oauth/token-no-client`

If a request to `POST /auth/oauth2/token` carries no proof of the client, then the server MUST answer `400 invalid_request`.

**Tests:** `compliance/oauth.test.ts › refuses a token request with no proof of the client`.

### `keys-and-oauth/token-unsupported-grant`

If a request to `POST /auth/oauth2/token` names a grant type the server does not serve, then the server MUST answer `400 unsupported_grant_type`.

**Tests:** `compliance/oauth.test.ts › refuses a grant type it does not support`.

### `keys-and-oauth/client-credential-refused`

If a request to `POST /auth/oauth2/token`, `POST /auth/device/code` or `POST /auth/oauth2/revoke` carries an `Authorization` header, or a `client_secret`, `client_assertion` or `client_assertion_type` field, empty or not, then the server MUST answer `401 invalid_client`, whatever else the request holds or lacks.

**Reason:** Every client is public and proves itself with its code verifier or its device code, so a credential of the client's own is one no registered client holds, and each door refuses it the same way.

**Tests:** `compliance/oauth-client-auth-methods.test.ts › refuses a client that presents a credential of its own 401 invalid_client, at the device code, token and revocation doors`, `› refuses a client credential before it judges what the request lacks, at the device code, token and revocation doors`.

## Refresh tokens

### `keys-and-oauth/refresh-offline`

When the server issues tokens to a client whose `grant_types` name `refresh_token` or `authorization_code`, for an authorization that asked for `offline_access`, the server MUST issue a refresh token beside the access token.

**Reason:** `grant_types` names the grants a client uses at the token endpoint (RFC 7591), so a client may exchange a refresh token only where it names `refresh_token`, or names `authorization_code` and refreshes what that grant issues.

**Tests:** `compliance/oauth-tokens.test.ts › are issued only to an authorization that asked for offline_access`, `compliance/device-offline-access.test.ts › answers offline_access a refresh token, which exchanges, for a client registered for the refresh grant`, `› answers offline_access a refresh token, which exchanges, for a client registered for the code grant and not the refresh grant`.

### `keys-and-oauth/refresh-online-none`

When the server issues tokens for an authorization that did not ask for `offline_access`, the server MUST NOT issue a refresh token.

**Tests:** `compliance/oauth-tokens.test.ts › are issued only to an authorization that asked for offline_access`.

### `keys-and-oauth/refresh-rotates`

When an app exchanges a live refresh token, the server MUST answer `200` with a new refresh token and an access token for the same scopes.

**Tests:** `compliance/oauth-tokens.test.ts › rotate: a refresh answers a new refresh token and an access token that works`.

### `keys-and-oauth/refresh-replay`

If an app exchanges a refresh token that an earlier refresh already rotated, then the server MUST answer `400 invalid_grant`.

**Tests:** `compliance/oauth-tokens.test.ts › refuse a replayed refresh token invalid_grant, and end every token of its chain`.

### `keys-and-oauth/refresh-replay-chain`

When the server refuses a replayed refresh token, the server MUST end every access token and refresh token issued in that token's chain.

**Reason:** A replay means two parties hold one chain, and the server cannot tell which of them is the app.

**Tests:** `compliance/oauth-tokens.test.ts › refuse a replayed refresh token invalid_grant, and end every token of its chain`.

### `keys-and-oauth/refresh-unknown`

If an app exchanges a refresh token the server never issued, then the server MUST answer `400 invalid_grant`.

**Reason:** A terminal refusal stops a client that would retry a server error without end.

**Tests:** `compliance/oauth-tokens.test.ts › refuse a refresh token the server never issued invalid_grant`.

## The resource parameter

An app names as `resource` (RFC 8707) the server it will call: this server's origin, or one of its MCP endpoints, the origin followed by exactly `/mcp`, `/mcp/schema` or `/mcp/admin`.

### `keys-and-oauth/resource-this-server`

When a token request names this server's origin as `resource`, with or without a trailing slash, the server MUST issue an access token this server accepts.

**Tests:** `compliance/oauth-tokens.test.ts › is accepted when it names this server, and the token works here`.

### `keys-and-oauth/resource-case`

When a token request names this server's origin or one of its MCP endpoints with the scheme or host in other letter case, the server MUST issue an access token this server accepts.

**Reason:** RFC 3986 section 6.2.2.1: a URI's scheme and host compare without case, while its path compares exactly, so `/MCP` names no MCP endpoint.

**Tests:** `compliance/oauth-tokens.test.ts › is accepted when the scheme and host are in capitals`.

### `keys-and-oauth/resource-mcp`

When an authorization request and the token request that redeems its code each name one of this server's MCP endpoints as `resource`, the server MUST issue an access token this server accepts.

**Tests:** `compliance/oauth-tokens.test.ts › is accepted at authorization and at the token request when it names an MCP endpoint, and the token works here`.

### `keys-and-oauth/resource-other-server`

If a token request names as `resource` anything other than this server's origin or one of its MCP endpoints, such as another server, `/mcp/`, `/MCP` or `/mcp/other`, then the server MUST answer `400 invalid_target`.

**Tests:** `compliance/oauth-tokens.test.ts › is refused invalid_target when it names another server`.

### `keys-and-oauth/resource-one-audience`

When the server issues an access token, the server MUST accept that token at its API and at each MCP endpoint it serves, whichever of its resources the token request named as `resource`.

**Reason:** The API and the MCP endpoints are addresses of one protected resource, and an MCP endpoint calls the API with the token it was sent.

**Tests:** `compliance/oauth-tokens.test.ts › accepts a token at the API and at /mcp, whichever of the server's resources it was issued for`.

### `keys-and-oauth/access-token-lifetime`

When the server issues an access token, the server MUST answer `expires_in` of 3600.

**Reason:** An app refreshes, or asks again, within the hour, so a token that leaks is good for an hour at most.

**Tests:** `compliance/sign-in-door-limits.test.ts › issues an access token that lasts an hour`.

### `keys-and-oauth/resource-one-value`

If a token request names `resource` more than once, then the server MUST answer `400 invalid_target`.

**Reason:** Every token the server issues is accepted at all of its resources (`keys-and-oauth/resource-one-audience`), so a second value would ask for nothing the first does not give.

**Tests:** `compliance/oauth-tokens.test.ts › is refused invalid_target when a token request names more than one`.

### `keys-and-oauth/resource-authorize-refused`

Where the redirect URI is on the loopback or in a private-use scheme, or the signed-in person's standing consent to the app covers it, if an authorization request names as `resource` anything other than this server's origin or one of its MCP endpoints, with a redirect URI the client registered or its client ID metadata document lists, then the server MUST send the browser to that redirect URI with `error=invalid_target`, the request's `state` and no code.

**Tests:** `compliance/oauth-tokens.test.ts › is refused at authorization to the redirect URI the app registered, with the request's state`.

### `keys-and-oauth/resource-authorize-unregistered`

If an authorization request names as `resource` anything other than this server's origin or one of its MCP endpoints, with a redirect URI the client neither registered nor lists in its client ID metadata document, then the server MUST answer `400 invalid_target` without a redirect.

**Reason:** RFC 6749 section 4.1.2.1: a redirect URI the client did not register is never sent an answer.

**Tests:** `compliance/oauth-tokens.test.ts › is refused at authorization 400 invalid_target when the redirect URI is not one the app registered`.

## The MCP endpoints' challenges

### `keys-and-oauth/mcp-challenge-credential`

If a request to an MCP endpoint the server serves carries no credential the server accepts, then the server MUST answer `401 unauthorized` with `WWW-Authenticate: Bearer resource_metadata="<url>"`, naming the URL of that endpoint's protected resource metadata.

**Reason:** RFC 9728 section 5.1: the challenge is how an MCP client finds where to sign in.

**Tests:** `compliance/mcp.test.ts › answers a request without a credential with 401 and a Bearer challenge naming the endpoint's resource metadata`.

### `keys-and-oauth/mcp-challenge-scope`

If a tool call to an MCP endpoint the server serves carries an app's access token, and the API refuses the call before the call changes anything for a scope the token lacks and an app can be granted, then the server MUST answer `403` with a `WWW-Authenticate` Bearer challenge holding `error="insufficient_scope"`, that scope as `scope` (the refusal's `details.required_scope` where it names one, else the scope of the type or edge type its `details.grant` names) and the endpoint's `resource_metadata`.

**Reason:** RFC 6750 section 3.1: the challenge names what to ask for, so an MCP client can ask the person for more without starting over. A call that already changed something is answered with the tool's error instead, since calling it again would repeat that change. An API key is not issued through sign-in, so it has no sign-in to step up, and a refusal to one stays the tool's error.

**Tests:** `compliance/oauth-tokens.test.ts › challenges a tool call the token lacks a scope for with 403 insufficient_scope, naming the scope and the endpoint's metadata`, `compliance/oauth-tokens.test.ts › asks an app holding metadata.types:write alone for the namespace wildcard covering the new name, and registers it for an app holding both`.

### `keys-and-oauth/mcp-challenge-unregistered`

If a tool call to an MCP endpoint the server serves carries an app's access token, and the API refuses the call for a scope no app can be granted, such as the scope of a type or edge type nothing registered, then the server MUST answer with the tool's error and no `insufficient_scope` challenge.

**Reason:** the API asks for the grant before it looks the name up, so a misspelled type would otherwise ask the person to approve access to a name no write can use, and the call would fail again once they did.

**Tests:** `compliance/oauth-tokens.test.ts › answers a tool call naming a type nothing registered with the tool's error, not a challenge`, `compliance/oauth-tokens.test.ts › answers a name in a namespace nothing grants with the tool's error, not a challenge`.

## Revocation

### `keys-and-oauth/revoke-answer-ok`

When `POST /auth/oauth2/revoke` names a token the server holds, the server MUST answer `200`.

**Tests:** `compliance/oauth-tokens.test.ts › of an access token ends it at once`, `› of a refresh token ends the app's grant: its tokens, its listing and the person's consent`.

### `keys-and-oauth/revoke-access-token`

When an app revokes an access token at `POST /auth/oauth2/revoke`, the server MUST refuse that token `401 unauthorized` from then on.

**Tests:** `compliance/oauth-tokens.test.ts › of an access token ends it at once`.

### `keys-and-oauth/revoke-refresh-token`

When an app revokes its refresh token at `POST /auth/oauth2/revoke`, the server MUST end the app's grant: its tokens, its entry in `GET /auth/grants` and the person's consent.

**Reason:** RFC 7009 is the one way an app says "disconnect me", and an app that used it was still connected while the grant's records stood.

**Tests:** `compliance/oauth-tokens.test.ts › of a refresh token ends the app's grant: its tokens, its listing and the person's consent`.

### `keys-and-oauth/revoke-unknown-token`

When a revocation names a token the server does not hold, never issued, already revoked or already gone, the server MUST answer `200` as RFC 7009 has it, whatever `token_type_hint` says.

**Tests:** `compliance/oauth.test.ts › answers 200 to revoking a token it does not hold, and 400 to a revocation naming no token`, `compliance/oauth-tokens.test.ts › of an access token ends it at once`.

### `keys-and-oauth/revoke-no-token`

If a revocation names no token, then the server MUST answer `400 invalid_request`.

**Tests:** `compliance/oauth.test.ts › answers 200 to revoking a token it does not hold, and 400 to a revocation naming no token`.

## Grants

`grants.manage` lists and revokes the apps a person approved.

### `keys-and-oauth/grants-list`

When a caller holding `grants.manage` sends `GET /auth/grants`, the server MUST answer every app the person approved, each with its `id`, `kind`, `client_id`, `scopes`, `status` and `granted_at`, in one page whose `next_cursor` is `null`.

**Tests:** `compliance/auth-grants.test.ts › lists each app the person approved, with its client, scopes and status, in one page`.

### `keys-and-oauth/grants-page-fields`

When `GET /auth/grants` lists a grant, the server MUST give it `client_name`, the name the app registered or `null`, and `origins`, the origin of each redirect URI a web client registered, empty for a native client.

**Tests:** `compliance/web-page-origin.test.ts › names the page's origin on the consent screen and in the grants listing`, `› reads the origin as scheme, host and port, whatever path, port or trailing slash the redirect URI carries`, `› allows no origin for a native app's redirect URI`.

### `keys-and-oauth/grants-kind`

When `GET /auth/grants` lists a grant, the server MUST report `kind` as `cli` for a client registered with the `software_id` `so.marfa.cli`, otherwise `web` for a client with approved web origins, otherwise `app`.

**Reason:** The `marfa` command line registers that `software_id` (RFC 7591 section 2). Its grant and its name do not tell it from another program that signs in with the device grant, so a client with another `software_id`, or none, is an app, device grant or not. Any client can send any `software_id`, so the kind labels the app for the owner and decides no access. This classifies the registered app without changing its stored connection kind or its owner's sign-in category.

**Tests:** `compliance/auth-grants.test.ts › classifies registered native, web, command line and other device apps`.

### `keys-and-oauth/grant-narrow-authority`

If a request other than the private local command's sends `PATCH /auth/grants/{id}`, then the server MUST refuse it, `401 unauthorized` where it carries no credential and `403 forbidden` where it carries one.

**Tests:** `compliance/auth-grants.test.ts › requires the local command and reports an unknown grant`.

### `keys-and-oauth/grant-narrow-ceiling`

When the owner sends `PATCH /auth/grants/{id}` with `scopes` and `expected_scopes`, the server MUST refuse `403 forbidden` if the resulting type, link, metadata, profile or permission scope set exceeds the live grant's effective access.

**Reason:** Removing an overriding entry can widen a wildcard, so the comparison is of effective access rather than literal membership.

**Tests:** `compliance/auth-grants.test.ts › narrows access, ends overbroad tokens, refuses widening and stale choices, and asks before restoring access`.

### `keys-and-oauth/grant-narrow-stale`

If `expected_scopes` at `PATCH /auth/grants/{id}` differs from the live consent or projected grant's scopes when the update commits, then the server MUST refuse `409 conflict` without changing access.

**Tests:** `compliance/auth-grants.test.ts › narrows access, ends overbroad tokens, refuses widening and stale choices, and asks before restoring access`.

### `keys-and-oauth/grant-narrow-commit`

When `PATCH /auth/grants/{id}` narrows a live grant, the server MUST commit its consent, projection, token withdrawal, pending code withdrawal and audit together under the grant's consent lock.

**Tests:** `compliance/auth-grants.test.ts › rolls back narrowed access and tokens when its audit cannot be written`.

### `keys-and-oauth/grant-narrow-tokens`

When `PATCH /auth/grants/{id}` reduces a grant, the server MUST end access tokens and refresh chains whose scopes exceed the resulting grant, along with outstanding authorization and device codes.

**Reason:** Covered token chains remain usable; a chain that ends must authorize again at the remaining access, and increasing it requires fresh approval.

**Tests:** `compliance/auth-grants.test.ts › preserves covered token chains and withdraws overbroad chains and pending codes`, `compliance/auth-grants.test.ts › narrows access, ends overbroad tokens, refuses widening and stale choices, and asks before restoring access`.

### `keys-and-oauth/grant-narrow-answer`

When `PATCH /auth/grants/{id}` succeeds, the server MUST answer `200` with the resulting `scopes`.

**Tests:** `compliance/auth-grants.test.ts › narrows access, ends overbroad tokens, refuses widening and stale choices, and asks before restoring access`.

### `keys-and-oauth/grant-narrow-missing`

If `PATCH /auth/grants/{id}` names no live app grant of the owner, then the server MUST answer `404 oauth_grant_not_found`.

**Tests:** `compliance/auth-grants.test.ts › requires the local command and reports an unknown grant`.

### `keys-and-oauth/grants-permission`

If a caller without `grants.manage` lists or revokes grants, then the server MUST answer `403 forbidden` with `details.required_scope` naming `grants.manage`.

**Reason:** A key is an app's own credential and a grant is another app's, so a credential trusted to rotate a key is not one that may revoke every other app.

**Tests:** `compliance/auth-grants.test.ts › refuses a caller without grants.manage 403, naming it, and a request with no credential 401`, `› refuses a caller without grants.manage 403 whatever query it sends, at both doors`.

### `keys-and-oauth/grants-no-credential`

If a request with no credential sends `GET /auth/grants`, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/auth-grants.test.ts › refuses a caller without grants.manage 403, naming it, and a request with no credential 401`.

### `keys-and-oauth/grants-items-read`

While a credential does not hold `grants.manage`, the server MUST answer every operation that reads items, edges or events as it answers a credential whose type map does not reach `system.connection`, whatever the credential's type map grants.

**Reason:** A `system.connection` item is an app the owner approved, with its `client_id` and the scopes it holds, which is what `GET /auth/grants` lists, so it is read with the permission that listing takes (`keys-and-oauth/grants-permission`).

**Tests:** `compliance/auth-grants.test.ts › shows a system.connection item at no door to a credential without grants.manage, though it reads every type`, `› shows an app's system.connection items only where it holds grants.manage, whatever data scope it holds`.

### `keys-and-oauth/grants-items-type-refused`

If a credential without `grants.manage` names `system.connection` as a type an item listing reads, then the server MUST answer `403 forbidden` with `details.required_scope` naming `grants.manage`.

**Reason:** A type map could not open the listing, so the refusal names the permission that does.

**Tests:** `compliance/auth-grants.test.ts › refuses a listing of system.connection to a credential without grants.manage, naming the permission`.

### `keys-and-oauth/grant-revoke-answer`

When a caller holding `grants.manage` revokes a grant at `DELETE /auth/grants/{id}`, the server MUST answer `204`.

**Tests:** `compliance/auth-grants.test.ts › ends the app's tokens and the person's consent, and leaves the keys it minted working`, `compliance/oauth-refusals.test.ts › answers 404 oauth_grant_not_found for an id that is no app's grant, and revokes one that is`.

### `keys-and-oauth/grant-revoke-ends-grant`

When a grant is revoked at `DELETE /auth/grants/{id}`, the server MUST end it: refuse the app's tokens `401 unauthorized`, stop listing the grant and show the consent screen to the app's next authorization request.

**Tests:** `compliance/auth-grants.test.ts › ends the app's tokens and the person's consent, and leaves the keys it minted working`.

### `keys-and-oauth/grant-revoke-keeps-keys`

When a grant is revoked without `revoke_keys`, the server MUST leave every key the app minted, and every key those keys minted, working.

**Reason:** A key an app made is a key like any other once minted, and the caller of this operation has nobody to ask whether those keys should go too.

**Tests:** `compliance/auth-grants.test.ts › ends the app's tokens and the person's consent, and leaves the keys it minted working`.

### `keys-and-oauth/refresh-revoke-keeps-keys`

When an app revokes its refresh token at `POST /auth/oauth2/revoke`, the server MUST leave every key the app minted, and every key those keys minted, working.

**Reason:** An app that disconnects itself says nothing about the keys it handed out, and those keys may serve someone else by now.

**Tests:** `compliance/auth-grants.test.ts › leaves the keys an app minted working when the app revokes its refresh token`.

### `keys-and-oauth/grant-retire-keeps-keys`

When the inactivity retirement retires a grant, the server MUST leave every key the app minted, and every key those keys minted, working.

**Reason:** The retirement measures the app's own use, and a key the app minted is used on its own account, so the app going quiet says nothing about the key.

**Tests:** `compliance/auth-grants.test.ts › leaves the keys an idle app minted working when the inactivity retirement retires its grant`.

### `keys-and-oauth/grant-revoke-keys`

When a grant is revoked with `revoke_keys=1`, the server MUST revoke in the same write every key the app minted and every key those keys minted, whatever the caller's reach.

**Reason:** A key an app minted is held to the app's grant, so taking those keys with the grant reaches no further than revoking the grant does.

**Tests:** `compliance/auth-grants.test.ts › with revoke_keys=1 also revokes every key the app minted, a key's descendant included`.

### `keys-and-oauth/grant-unknown`

If `DELETE /auth/grants/{id}` names an id that is no app's grant, then the server MUST answer `404 oauth_grant_not_found`.

**Tests:** `compliance/oauth-refusals.test.ts › answers 404 oauth_grant_not_found for an id that is no app's grant, and revokes one that is`.

### `keys-and-oauth/app-rate-window`

Where the limiter is on, the server MUST count every request a signed-in app makes for one person in one window, whichever access token it carries.

**Reason:** Refreshing a token does not start a fresh window.

**Tests:** `compliance/app-rate-window.test.ts › is limited by its grant, so a refreshed token shares the window of the one before it`.

## Web pages

A web page connects as an app does, registered as a web client, whose redirect URIs registration holds to `https` off the loopback. The owner's approval is what lets the page's address call the instance from a browser. These rules cover the `Access-Control-Allow-Origin` header the server answers a request that carries an `Origin`; what the page may then do is what its credential holds.

### `keys-and-oauth/page-origin-allowed`

While `GET /auth/grants` lists a grant to a web client, the server MUST answer each request whose `Origin` is the origin of a redirect URI the client registered, a preflight included, with `Access-Control-Allow-Origin` naming that origin.

**Reason:** The address is the one the page registered and the approval page showed, never the `Origin` a browser reports, because registration takes no credential and only the owner's approval makes an address trusted. It lasts as long as some listed grant names it, so two pages on one address keep it until the last is disconnected.

**Tests:** `compliance/web-page-origin.test.ts › allows a page's origin once the owner approves it, on a preflight and on a request`, `› lets the page exchange its code at the token endpoint from its own origin, with no credentials allowed`, `› allows each origin of a page registered on two, once the owner approves it`, `› keeps allowing the page on a reload, which a standing consent answers with a code`, `› keeps allowing the page across a restart`, `› keeps an origin two pages share until the last of them is disconnected`, `› keeps an origin approved twice until its one grant is disconnected`, `› names the page's origin on the device approval page, and allows it once approved there`, `compliance/web-page-register.test.ts › completes the flow from a page that was never registered: discover, register, approve, exchange and read`.

### `keys-and-oauth/page-origin-refused`

If a request to an operation that `keys-and-oauth/discovery-every-origin` and `keys-and-oauth/register-every-origin` do not name carries an `Origin` that is off the loopback, that `cors_origins` does not name, and that is the origin of no redirect URI of a web client `GET /auth/grants` lists, then the server MUST answer it, a preflight included, without `Access-Control-Allow-Origin`.

**Reason:** Nothing is allowed until the owner approves it: a page not yet approved, one the owner denied or disconnected, and a native app's redirect URI, which is where a program on a device listens rather than a page, are all refused.

**Tests:** `compliance/web-page-origin.test.ts › refuses a page's origin before approval, after a denial, and for another origin`, `› allows a page's origin once the owner approves it, on a preflight and on a request`, `› keeps allowing the page across a restart`, `› keeps an origin two pages share until the last of them is disconnected`, `› keeps an origin approved twice until its one grant is disconnected`, `› allows no origin for a native app's redirect URI`, `› allows a configured origin, and refuses an unapproved one beside it`, `› names the page's origin on the device approval page, and allows it once approved there`, `compliance/web-page-register.test.ts › still refuses that origin on a data operation and at the token endpoint before approval`.

### `keys-and-oauth/origin-no-credentials`

The server MUST NOT answer any request with `Access-Control-Allow-Credentials`.

**Reason:** A page on an allowed origin reads only what the credential it sends reaches, never an answer to a request the owner's cookie rode on.

**Tests:** `compliance/web-page-origin.test.ts › lets the page exchange its code at the token endpoint from its own origin, with no credentials allowed`.

### `keys-and-oauth/discovery-every-origin`

When a request carries an `Origin`, the server MUST answer `GET /.well-known/oauth-authorization-server/auth`, `GET /auth/.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource` and the protected resource metadata of each MCP endpoint, `GET /.well-known/oauth-protected-resource/mcp`, `/mcp/schema` and `/mcp/admin`, with `Access-Control-Allow-Origin: *`.

**Reason:** A page that is not yet approved has to find the endpoints before it can ask for approval, and these documents take no credential and say nothing that belongs to the owner.

**Tests:** `compliance/web-page-register.test.ts › answers the discovery documents and registration to any origin, with every origin allowed and no credentials`, `› completes the flow from a page that was never registered: discover, register, approve, exchange and read`.

### `keys-and-oauth/register-every-origin`

When a request to `POST /auth/oauth2/register` carries an `Origin`, the server MUST answer it with `Access-Control-Allow-Origin: *`.

**Reason:** A page registers itself from the browser before it opens the approval window, so registration answers every origin; a browser lets no page read an answer that carries `*` to a request sent with cookies.

**Tests:** `compliance/web-page-register.test.ts › answers the discovery documents and registration to any origin, with every origin allowed and no credentials`, `› completes the flow from a page that was never registered: discover, register, approve, exchange and read`.

### `keys-and-oauth/register-preflight`

When a preflight from any origin asks to send `POST` to `/auth/oauth2/register`, the server MUST answer it with `Access-Control-Allow-Origin: *`, `POST` as the only allowed method and `Content-Type` as the only allowed header.

**Tests:** `compliance/web-page-register.test.ts › allows a preflight for registration with POST and Content-Type, and nothing more`.

### `keys-and-oauth/page-origin-serialized`

The server MUST take the origin of a redirect URI as its scheme, its host in lowercase and its port, leaving out the scheme's default port and ignoring the path, the query and a trailing slash.

**Tests:** `compliance/web-page-origin.test.ts › reads the origin as scheme, host and port, whatever path, port or trailing slash the redirect URI carries`.

### `keys-and-oauth/origin-configured`

When a request carries an `Origin` that `cors_origins` names, the server MUST answer it, a preflight included, with `Access-Control-Allow-Origin` naming that origin.

**Tests:** `compliance/web-page-origin.test.ts › allows a configured origin, and refuses an unapproved one beside it`, `compliance/contract-header.test.ts › sends its contract version on a preflight from an origin the instance allows`.

## The device grant

### `keys-and-oauth/device-code-issued`

When a client asks `POST /auth/device/code` for a scope it may be granted, the server MUST answer `200` with a `device_code`, a `user_code`, a `verification_uri` and `verification_uri_complete` at `/auth/device`, `expires_in` of 600 and `interval` of 5.

**Tests:** `compliance/device-grant.test.ts › is issued with its codes, where to enter it, ten minutes to live and a five-second interval`.

### `keys-and-oauth/device-scope-required`

When a device authorization request omits `scope` or names no scope after whitespace is removed, the server MUST refuse it with HTTP 400 and `invalid_scope`, with an `error_description` telling the client to name the scopes to request.

**Reason:** A code with no requested scope cannot produce an approved grant. Refusing initiation prevents a consent screen from offering an approval that cannot issue a token.

**Tests:** `compliance/device-grant.test.ts › is refused 400 invalid_scope when no scopes are named`.

### `keys-and-oauth/device-code-at-rest`

The server MUST NOT hold a device code it issued as the code itself.

**Reason:** Whoever presents the code once the person approves is handed the tokens, so a copy of the server's database must not be enough to present it. Access and refresh tokens are held the same way.

**Tests:** `compliance/device-grant.test.ts › is held by the server as something other than the code it issued, and still polls`.

### `keys-and-oauth/device-unpublished-scope`

If a client asks `POST /auth/device/code` for a scope the instance does not publish, then the server MUST answer `400 invalid_scope`.

**Tests:** `compliance/device-grant.test.ts › is refused 400 invalid_scope for a scope the instance does not publish`.

### `keys-and-oauth/device-offline-no-refresh`

If a client whose `grant_types` name neither `refresh_token` nor `authorization_code` asks `POST /auth/device/code` for `offline_access`, then the server MUST answer `400 invalid_scope`.

**Reason:** The client could never exchange a refresh token, and an access token alone would leave it to sign the person in again with no way to know why.

**Tests:** `compliance/device-grant.test.ts › is refused 400 invalid_scope for offline_access when its client may not refresh`.

### `keys-and-oauth/device-published-scope`

When a client asks `POST /auth/device/code` for a scope the instance publishes to every client and the client is not registered for, the server MUST issue the code.

**Reason:** A client registered before the instance published a scope can still be approved for it.

**Tests:** `compliance/signed-in-apps.test.ts › is issued a code for a published scope it is not registered for, and its registration is as it was`.

### `keys-and-oauth/device-no-catch-up`

When a client asks `POST /auth/device/code` for a scope the client is not registered for, the server MUST leave the client's registration as it was.

**Reason:** Nobody is signed in when a device asks, and a client's public id is all the request needs, so a change here would let a stranger widen what the client's later approval screens offer.

**Tests:** `compliance/signed-in-apps.test.ts › is issued a code for a published scope it is not registered for, and its registration is as it was`.

### `keys-and-oauth/device-pending`

When a client polls `POST /auth/oauth2/token` with a device code nobody has decided, as the code's first poll or at least the interval after its previous one, the server MUST answer `400 authorization_pending`.

**Tests:** `compliance/device-grant.test.ts › answers authorization_pending to a poll of a code nobody has decided`, `compliance/signed-in-apps.test.ts › is issued a code for a published scope it is not registered for, and its registration is as it was`.

### `keys-and-oauth/device-slow-down`

If a client polls with a device code sooner than the interval after its previous poll, then the server MUST answer `400 slow_down`.

**Tests:** `compliance/device-grant.test.ts › answers slow_down to a poll sooner than the interval after the previous one`.

### `keys-and-oauth/device-denied`

When a client polls with a device code the person denied, the server MUST answer `400 access_denied`.

**Tests:** `compliance/device-grant.test.ts › answers access_denied to a poll of a code the person denied`.

### `keys-and-oauth/device-nothing-denies`

Where a device code names a scope other than `offline_access` that the app's standing consent does not cover, when a person approves it with none of those scopes chosen and the post does not name `access` as `full`, the server MUST deny the code, so that the next poll of it is answered `400 access_denied`.

**Reason:** The same rule as `keys-and-oauth/consent-nothing-denies`, so a request is answered the same way on either page.

**Tests:** `compliance/approval-screens.test.ts › denies a device code approved with nothing chosen`, `› denies a device code approved with everything newly asked turned off by an app that already holds access, on the device approval page`, `› approves a request that names only offline_access, which offers nothing to turn off`.

### `keys-and-oauth/device-expired`

When a client polls with a device code past its expiry, the server MUST answer `400 expired_token`.

**Tests:** `compliance/device-grant.test.ts › answers expired_token to a poll of a code past its expiry`.

### `keys-and-oauth/device-approved`

When a client polls with a device code a person approved, as the code's first poll since or at least the interval after its previous one, while the grant the approval made stands, the server MUST answer `200` with an access token for the scopes the person approved.

**Tests:** `compliance/device-grant.test.ts › answers the first poll after the approval, an interval after the last, with an access token for the approved scopes`.

### `keys-and-oauth/device-grant-revoked`

If a client polls with a device code a person approved after the grant the approval made was revoked, then the server MUST answer `400 invalid_grant`.

**Tests:** `compliance/device-grant.test.ts › answers invalid_grant to a poll after the person's grant was revoked between the approval and the poll`.

### `keys-and-oauth/device-spent`

If a client polls with a device code an earlier poll exchanged for an access token, then the server MUST answer `400 invalid_grant`, whatever the time since its previous poll.

**Tests:** `compliance/device-grant.test.ts › answers invalid_grant to a poll of a code a token was already issued for`.

### `keys-and-oauth/device-approval-catch-up`

When a signed-in person approves a device code, the server MUST add to the client's registration the approved scopes it does not hold, and no others, before the device's exchange.

**Reason:** The registration is what a request naming no scope asks for, so what a person approves on a device reaches the client's later requests as an approval in a browser does.

**Tests:** `compliance/signed-in-apps.test.ts › is registered only for what the person approved, which a narrower approval leaves out`, `› is registered for the published scope once the person approves it, and the token carries it`.

### `keys-and-oauth/device-older-reads`

When a browser session that signed in more than five minutes ago approves a device code with only scopes that `keys-and-oauth/consent-older-reads` lists, the server MUST approve the code.

**Tests:** `compliance/recent-sign-in-consent.test.ts › approves from a session that signed in more than five minutes ago the scopes that only read, and not the ones left off`.

### `keys-and-oauth/device-recent-needed`

If a browser session that signed in more than five minutes ago approves a device code with a scope that `keys-and-oauth/consent-older-reads` does not list and the app's standing consent does not cover, then the server MUST answer `403 forbidden` with the message `Sign in again to perform this operation`, whatever the request's `Accept`, and leave the code pending.

**Reason:** As on the authorization screen, a browser left signed in cannot hand a device a write or a power over the instance.

**Tests:** `compliance/recent-sign-in-consent.test.ts › refuses a session that signed in more than five minutes ago 403 for a permission, and a fresh session approves the same code`, `› refuses a session that signed in more than five minutes ago 403 for a write, and a fresh session approves the same code`, `› refuses a browser that approves a device code for a permission or a write on a screen left open past five minutes 403, whatever it asks for, and leaves the code pending`.

### `keys-and-oauth/device-recent-held`

When a browser session that signed in more than five minutes ago approves a device code with only scopes the app's standing consent covers, the server MUST approve the code.

**Tests:** `compliance/recent-sign-in-consent.test.ts › approves from a session that signed in more than five minutes ago a permission the app was approved for before`.

### `keys-and-oauth/device-page-confirm`

When a signed-in owner opens `/auth/device/consent` for a code whose request names a scope `keys-and-oauth/consent-older-reads` does not list and the app's standing consent does not cover, the server MUST answer `200` with the approval screen holding the "Confirm it's you" dialog, whatever the age of the session.

**Tests:** `compliance/recent-sign-in-consent.test.ts › shows a session that signed in more than five minutes ago the request for a permission or a write, with the way to confirm it's them`.

### `keys-and-oauth/device-page-reads`

When a browser session that signed in more than five minutes ago opens `/auth/device/consent` for a code whose scopes `keys-and-oauth/consent-older-reads` lists, or the app's standing consent covers, the server MUST answer `200` with the approval screen holding no "Confirm it's you" dialog.

**Tests:** `compliance/recent-sign-in-consent.test.ts › shows a session that signed in more than five minutes ago a request that only reads, with no question`.

### `keys-and-oauth/device-client-gone`

If a signed-in person opens the device approval page for a pending code whose client is no longer registered, then the server MUST answer `400 invalid_client`.

**Tests:** `compliance/oauth-refusals.test.ts › answers 400 invalid_client for a pending code whose client is no longer registered`.

## The sign-in surface

### `keys-and-oauth/browser-origin`

If `POST /auth/sign-in`, `POST /auth/device`, `POST /auth/device/consent` or `POST /auth/authorize/decision` receives a form whose `Origin`, or `Referer` where it carries no `Origin`, is neither the issuer's origin nor one `cors_origins` names, an approved web page's origin and `null` included, then the server MUST answer `403 forbidden` before it reads the form.

**Reason:** A form posted under the owner's cookie acts as the owner, so approving a web page lets it call the instance with the credential it holds and never with the owner's browser session.

**Tests:** `compliance/sign-in-surface.test.ts › refuses a form post from an origin it does not trust, on every browser door`, `compliance/web-page-origin.test.ts › refuses an approved page's origin on the browser forms and at password sign-in, where a configured origin passes`.

### `keys-and-oauth/browser-no-origin`

When a form post to `POST /auth/device`, `POST /auth/device/consent` or `POST /auth/authorize/decision` carries neither `Origin` nor `Referer`, the server MUST answer it as that operation answers a form rather than refuse it for its origin.

**Tests:** `compliance/sign-in-surface.test.ts › refuses a form post from an origin it does not trust, on every browser door`.

### `keys-and-oauth/return-to-elsewhere`

When the sign-in page or the sign-in form receives a `return_to` that a browser would resolve to another origin, or to a path a browser reads as another host, the server MUST use `/` in its place.

**Tests:** `compliance/sign-in-surface.test.ts › sends a signed-in browser only to a path on the instance`.

### `keys-and-oauth/return-to-kept`

When the sign-in form receives a `return_to` that resolves to a path on the instance, the server MUST redirect to its path, query and fragment.

**Tests:** `compliance/sign-in-surface.test.ts › sends a signed-in browser only to a path on the instance`.

### `keys-and-oauth/sign-in-address-limit`

If one address has made ten counted password sign-in attempts at an account in fifteen minutes, then the server MUST answer its next attempt `429` with `Retry-After`, before it judges the password.

**Reason:** The refusal comes before the password is judged, so it cannot tell anyone whether the password was right.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/sign-in-form-limit`

If the sign-in form's attempt is refused by a sign-in limit, then the server MUST redirect with `error=too_many_attempts`.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/sign-in-form-limit-cookie`

If the sign-in form's attempt is refused by a sign-in limit, then the server MUST set no session cookie.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/sign-in-form-limit-wait`

If the sign-in form's attempt is refused by a sign-in limit, then the server MUST redirect with `retry_after` holding the whole seconds, from 1 to 86400, until another attempt will be allowed, which is the latest end among the sign-in limits that are spent, the value `Retry-After` carries on the same refusal.

**Reason:** The sign-in page tells the owner how long to wait. The address limit and the account limit end at different times, and an address that has spent both is refused again at the end of the shorter wait.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`, `compliance/sign-in-limits.test.ts › holds every address together to a hundred attempts at an account in an hour, counting none an address made past its own limit`.

### `keys-and-oauth/sign-in-lockout-page`

When `GET /auth/sign-in` carries `error=too_many_attempts` and a `retry_after` of whole seconds from 1 to 86400, the server MUST answer a page that states the wait in whole minutes, rounded up, and says that a passkey signs in during the lock.

**Reason:** A fixed number of minutes would be wrong for one of the two limits, and the passkey is the way in that a password lock does not close (`authentication/passkey-password-lock`).

**Tests:** `compliance/sign-in-surface.test.ts › tells a locked-out person how long to wait, in whole minutes rounded up, and that a passkey still signs in`.

### `keys-and-oauth/sign-in-only-wrong-counted`

When a password sign-in attempt, or a password sent to `POST /auth/confirm`, proves to be the right password, the server MUST leave it counted in none of the password sign-in limits.

**Reason:** Only wrong passwords are counted, so the owner's own sign-ins and confirmations spend nothing. Each attempt is counted when it arrives and taken back once its password proves right, so attempts sent together are all held to the limits.

**Tests:** `compliance/sign-in-limits.test.ts › counts only wrong passwords, so the owner's own sign-ins and confirmations spend nothing`.

### `keys-and-oauth/sign-in-account-limit`

If every address together has made a hundred counted password sign-in attempts at an account in an hour without a known device cookie, then the server MUST answer the next such attempt from any address `429` with `Retry-After`.

**Reason:** An attempt one address makes past its own limit is not counted here, so one guessing address cannot hold the owner out.

**Tests:** `compliance/sign-in-limits.test.ts › holds every address together to a hundred attempts at an account in an hour, counting none an address made past its own limit`.

### `keys-and-oauth/sign-in-device-cookie`

When a password sign-in or a password sent to `POST /auth/confirm` signs the owner in, the server MUST set a device cookie, named `__Host-marfa_device` over HTTPS and `marfa_device` on this machine, with `HttpOnly`, `SameSite=Lax` and a `Max-Age` of 400 days, that holds only a random id, the time it was set and a signature from the instance's secret.

**Reason:** The cookie marks a browser the right password has signed in from, and names no person.

**Tests:** `compliance/sign-in-limits.test.ts › keeps a known device signing in while strangers are limited`.

### `keys-and-oauth/sign-in-known-device`

While the account limit (`keys-and-oauth/sign-in-account-limit`) is spent, when a password sign-in carries a device cookie the server set for the current credentials within the last 400 days, the server MUST NOT refuse the attempt for the account limit.

**Reason:** A known device keeps signing in while strangers are limited, so the account limit cannot hold the owner out.

**Tests:** `compliance/sign-in-limits.test.ts › keeps a known device signing in while strangers are limited`.

### `keys-and-oauth/sign-in-known-device-limit`

If one device cookie has made ten counted password sign-in attempts at an account in fifteen minutes, then the server MUST answer its next attempt `429` with `Retry-After`, before it judges the password.

**Tests:** `compliance/sign-in-limits.test.ts › holds a known device to ten wrong passwords across addresses`.

### `keys-and-oauth/sign-in-known-devices-limit`

If every device cookie together has made a hundred counted password sign-in attempts at an account in an hour, then the server MUST answer the next attempt that carries a device cookie `429` with `Retry-After`, before it judges the password.

**Reason:** A device cookie only lifts the account limit for a browser the password signed in from, so many cookies together are held to the same hundred as every address without one.

**Tests:** `compliance/sign-in-limits.test.ts › holds every known device together to a hundred wrong passwords an hour`.

### `keys-and-oauth/sign-in-device-reset`

When the owner's password is recovered, the server MUST count each later password sign-in that carries a device cookie set before the recovery as one with no device cookie.

**Reason:** A device cookie stands only for the current password, so a recovery leaves no browser known.

**Tests:** `compliance/sign-in-limits.test.ts › forgets every known device when the password is recovered`.

### `keys-and-oauth/sign-in-unknown-device`

If a password sign-in carries a device cookie the server did not sign, or set more than 400 days ago, then the server MUST count the attempt as one with no device cookie.

**Tests:** `compliance/sign-in-limits.test.ts › keeps a known device signing in while strangers are limited`.

### `keys-and-oauth/device-cookie-not-a-session`

If a request carries a device cookie and no session, then the server MUST answer it as a request with no credential.

**Reason:** The device cookie only changes how sign-in attempts are counted, and proves nothing about who sent the request.

**Tests:** `compliance/sign-in-limits.test.ts › keeps a known device signing in while strangers are limited`.

### `keys-and-oauth/sign-in-other-address`

When one address is held to its sign-in limit, the server MUST still answer a sign-in from another address on the password.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/address-ipv6`

The server MUST count an IPv6 address by its /64 for the password sign-in limits.

**Tests:** `compliance/sign-in-limits.test.ts › counts an IPv6 address as its /64`.

### `keys-and-oauth/sign-in-other-emails-limit`

If one address has made ten password sign-in attempts in fifteen minutes at emails that are not the owner's, then the server MUST answer its next attempt at an email that is not the owner's `429` with `Retry-After`, before it judges the password.

**Reason:** Every email but the owner's has no account to guess, so all of them share one count, and an address cannot spread its attempts over made-up emails.

**Tests:** `compliance/sign-in-door-limits.test.ts › counts password sign-ins at every email but the owner's together, and still judges the owner's password`.

### `keys-and-oauth/sign-in-decoy-queue`

If eight password sign-ins at emails that are not the owner's are already waiting for their password check, then the server MUST answer the next such sign-in `429` with `Retry-After`.

**Reason:** A sign-in at an email with no account still does the work of a password check, so it cannot be told from a wrong password by its time; those checks wait in a queue of their own, so they can never hold up the owner's.

**Tests:** waiting on #2892.

### `keys-and-oauth/register-address-limit`

Where `rate_limit_enabled` is `true`, if one address has sent ten `POST /auth/oauth2/register` requests in a minute, then the server MUST answer its next one `429` with `Retry-After`.

**Reason:** Registration needs no credential, and each one stores a client.

**Tests:** `compliance/sign-in-door-limits.test.ts › answers the eleventh client registration from one address in a minute 429`.

### `keys-and-oauth/device-code-address-limit`

Where `rate_limit_enabled` is `true`, if one address has sent thirty `POST /auth/device/code` requests in a minute, then the server MUST answer its next one `429` with `Retry-After`.

**Reason:** A device code request needs no credential, and each one stores a code a person may be asked to type.

**Tests:** `compliance/sign-in-door-limits.test.ts › answers the thirty-first device code from one address in a minute 429`.

### `keys-and-oauth/client-document-limits`

If one address has made ten requests in a minute that fetch a client ID metadata document, or every address together thirty, then the server MUST NOT fetch the document for the next such request.

**Reason:** Each request makes the server fetch from an address the caller names, so the count holds what one caller can make the server send.

**Tests:** waiting on #2892.

### `keys-and-oauth/client-document-limit-answer`

If a client document limit keeps the server from fetching a client's metadata document, then the server MUST answer the request as it would with the copy it keeps of that client, or, with none kept, refuse it with `temporarily_unavailable`.

**Tests:** waiting on #2892.

### `keys-and-oauth/device-lookup-address-limit`

If one address has made ten device code lookups without the owner's live browser session in fifteen minutes, across the entry form, the consent screen and its decision, then the server MUST redirect its next lookup without that authority with `error=too_many_attempts` before the code is looked up.

**Tests:** `compliance/sign-in-surface.test.ts › limits anonymous device code entry per address and owner consent per owner`.

### `keys-and-oauth/device-lookup-wait`

If a device code lookup is refused by a device lookup limit, then the server MUST redirect with `retry_after` holding the whole seconds, from 1 to 86400, until another lookup will be allowed, which is the latest end among the device lookup limits that are spent.

**Reason:** The anonymous address limit, the anonymous instance limit and the two owner limits each end at their own time, and a lookup refused by one can meet another that is spent for longer, so the page can say how long to wait only if the redirect names the later end.

**Tests:** `compliance/sign-in-surface.test.ts › limits anonymous device code entry per address and owner consent per owner`, `compliance/device-owner-limits.test.ts › shares ten lookups across owner sessions, addresses and routes`, `compliance/sign-in-limits.test.ts › names the later end when a lookup meets a spent address limit and a spent instance limit`.

### `keys-and-oauth/device-lookup-page`

When `GET /auth/device` carries `error=too_many_attempts` and a `retry_after` of whole seconds from 1 to 86400, the server MUST answer a page that states the wait in whole minutes, rounded up.

**Tests:** `compliance/sign-in-surface.test.ts › tells a person who has tried too many device codes how long to wait, in whole minutes rounded up`.

### `keys-and-oauth/device-code-not-right`

When `GET /auth/device` carries `error=invalid_code`, the server MUST answer a page saying the code isn't right or has expired, and to check it against the device or start again on the device for a new one.

**Reason:** The server removes a device code once it has expired, when the device next asks for a token, so a code that has expired and been removed reads as one the server never issued. The page cannot tell the two apart, so it names both.

**Tests:** `compliance/sign-in-surface.test.ts › says an unknown code as wrong or expired, and a code the server holds as expired as expired`.

### `keys-and-oauth/device-code-expired`

When `GET /auth/device` carries `error=expired_code`, the server MUST answer a page saying the code has expired and to start again on the device for a new one.

**Reason:** Checking what was typed cannot put an expired code right, so the page sends the person back to the device and not to the keyboard. The server answers this only while it still holds the expired code.

**Tests:** `compliance/sign-in-surface.test.ts › says an unknown code as wrong or expired, and a code the server holds as expired as expired`.

### `keys-and-oauth/device-code-lifetime`

The server MUST say, on the page where a device code is typed, that codes end after 10 minutes, the `expires_in` of 600 it issues them with.

**Tests:** `compliance/sign-in-surface.test.ts › says how long codes last`.

### `keys-and-oauth/device-page-code`

When `GET /auth/device` carries `user_code`, the server MUST answer a page whose code field holds it.

**Reason:** `verification_uri_complete` carries the code, so a person who follows it only checks the code against the device.

**Tests:** `compliance/sign-in-door-limits.test.ts › fills the device page's code field with the user_code it is opened with`.

### `keys-and-oauth/device-lookup-instance-limit`

If every address together has made a hundred counted device code lookups without the owner's live browser session in fifteen minutes, then the server MUST redirect the next lookup without that authority from any address with `error=too_many_attempts` before the code is looked up.

**Reason:** A sweep tries each code once, so a count per code never fires. A lookup one address makes past its own limit is not counted here.

**Tests:** `compliance/sign-in-limits.test.ts › hold every address together to a hundred in fifteen minutes, counting none an address made past its own limit`.

### `keys-and-oauth/device-lookup-owner-lane`

When a caller with a verified, live browser session of the claimed owner looks a device code up on the entry form, the consent screen or its decision, the server MUST count the lookup in an owner lane independent of the anonymous address and instance limits.

**Reason:** Anonymous callers cannot close the owner's device approval path by spending its address or instance allowance.

**Tests:** `compliance/device-owner-limits.test.ts › admits owner entry and consent and exchanges the grant after anonymous address and aggregate exhaustion`.

### `keys-and-oauth/device-lookup-owner-limit`

If the claimed owner has made ten counted device code lookups in fifteen minutes, across browser sessions, addresses, the entry form, the consent screen and its decision, then the server MUST redirect the owner's next lookup with `error=too_many_attempts` before the code is looked up.

**Tests:** `compliance/device-owner-limits.test.ts › shares ten lookups across owner sessions, addresses and routes`.

### `keys-and-oauth/device-lookup-owner-instance-limit`

If the owner lane has made a hundred counted device code lookups in fifteen minutes, excluding lookups refused by the owner's own limit, then the server MUST redirect the next owner lookup with `error=too_many_attempts` before the code is looked up.

**Reason:** Both lanes have a collective bound, even though one claimed owner reaches the per-owner bound first.

**Tests:** `compliance/device-owner-limits.test.ts › holds the owner lane aggregate to its limit and resets its fifteen-minute window`.

### `keys-and-oauth/device-lookup-owner-proof`

If a device code lookup carries only an unverified, expired or revoked owner cookie, an ordinary key or an OAuth access token, including a bearer beside a live owner cookie, then the server MUST NOT count it in the owner lane.

**Tests:** `compliance/device-owner-limits.test.ts › keeps a %s cookie in the anonymous lane`, `› admits owner entry and consent and exchanges the grant after anonymous address and aggregate exhaustion`.

### `keys-and-oauth/device-lookup-owner-concurrent`

When concurrent device code lookups use the owner's live browser session, the server MUST admit no more lookups than remain in the owner's fifteen-minute allowance.

**Tests:** `compliance/device-owner-limits.test.ts › shares ten lookups across owner sessions, addresses and routes`.

### `keys-and-oauth/device-lookup-owner-window`

When an owner's device code lookup window or the owner lane's collective window reaches fifteen minutes, the server MUST count its next lookup in a fresh window.

**Tests:** `compliance/device-owner-limits.test.ts › shares ten lookups across owner sessions, addresses and routes`, `› holds the owner lane aggregate to its limit and resets its fifteen-minute window`.

## Password sign-in

`POST /auth/sign-in` takes the sign-in page's form, which it answers with a redirect, or a JSON body.

### `keys-and-oauth/password-sign-in-answer`

When `POST /auth/sign-in` sends, as JSON, the owner's `email` and `password` and signs the owner in, the server MUST answer `200` with only `{"ok": true}` and set the owner's session cookie, `HttpOnly` and `SameSite=Lax`.

**Reason:** A script that signs in needs the cookie and nothing else, and the session it opens is listed at `GET /owner/sign-ins`.

**Tests:** `compliance/sign-in-surface.test.ts › answers a password sign-in sent as JSON with only ok, and its session cookie`.

### `keys-and-oauth/password-sign-in-fields`

If `POST /auth/sign-in` sends, as JSON, a key other than `email` and `password`, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields`, and set no cookie.

**Tests:** `compliance/sign-in-surface.test.ts › refuses a password sign-in sent as JSON with a field it does not take, and sets no cookie`.

### `keys-and-oauth/session-cookie-name`

Where the sign-in address is plain HTTP on this machine, the server MUST name the owner's session cookie `marfa_session`.

**Reason:** A browser takes a `__Host-` cookie only over HTTPS.

**Tests:** `compliance/sign-in-surface.test.ts › answers a password sign-in sent as JSON with only ok, and its session cookie`.

### `keys-and-oauth/session-cookie-https`

Where the sign-in address is HTTPS, the server MUST set the owner's session cookie as `__Host-marfa_session`, with `Secure`, `Path=/` and no `Domain`.

**Reason:** The prefix binds the cookie to the instance's host, so no other host under the same domain can set or read it.

**Tests:** `compliance/session-cookie-https.test.ts › is __Host-marfa_session, Secure, on path / and with no Domain`.

### `keys-and-oauth/session-renewal-not-on-error`

If the server answers a request that would renew a browser session with a `5xx` status, then the server MUST NOT send the renewal cookie.

**Reason:** The request may not have done what it set out to do, and a renewal on it would keep a session alive on the strength of a failure.

**Tests:** waiting on #2892.

### `keys-and-oauth/session-cookie-other-name`

If a request carries a live browser session's token under a cookie name other than the one the sign-in address calls for, then the server MUST answer the request as one that carries no session.

**Tests:** `compliance/session-cookie-https.test.ts › signs no one in when its token comes under the name a plain HTTP address uses`.

### `keys-and-oauth/sign-in-unsaid-origin`

If `POST /auth/sign-in` or `POST /auth/passkeys/sign-in` carries neither `Origin` nor `Referer`, then the server MUST answer `403 forbidden`.

**Reason:** A door that opens a browser session takes a post, as a form or as JSON, only from a page it trusts, so a post that does not say where it came from is refused.

**Tests:** `compliance/sign-in-surface.test.ts › refuses a sign-in that says neither Origin nor Referer, as a form or as JSON, and sets no cookie`, `compliance/passkeys.test.ts › refuses a passkey sign-in that says neither Origin nor Referer, and opens no session`.

### `keys-and-oauth/sign-out-answer`

When `POST /auth/sign-out` ends the browser session, the server MUST answer `200` with only `{"ok": true}`.

**Tests:** `compliance/sign-in-surface.test.ts › answers a sign-out with only ok, and ends the session cookie`.

### `keys-and-oauth/library-origin`

If `POST /auth/sign-in` carries an `Origin` that is neither the issuer's origin nor one `cors_origins` names, an approved web page's origin included, then the server MUST answer `403`.

**Reason:** A password sign-in sets the owner's session cookie, so the origins it trusts are the operator's and never widen with an approval.

**Tests:** `compliance/web-page-origin.test.ts › refuses an approved page's origin on the browser forms and at password sign-in, where a configured origin passes`.

## What the sign-in pages say

### `keys-and-oauth/caution-consent`

When the consent screen names an app, the server MUST show a caution that Marfa has not verified the app.

**Reason:** Registration needs no credential, so any program can pick any name.

**Tests:** `compliance/unverified-apps.test.ts › is shown with the caution on the consent page`.

### `keys-and-oauth/caution-device`

When the device approval page names an app, the server MUST show a caution that Marfa has not verified the app.

**Reason:** The device flow is where a code from a stranger is likeliest to be typed in, and a caution on one page and not the other leaves the second as the way round the first.

**Tests:** `compliance/unverified-apps.test.ts › is shown with the caution on the device approval page`.

### `keys-and-oauth/consent-names-page`

When the consent screen offers access to a web client, the server MUST name on it the origin of each redirect URI the client registered, written without its `https://` scheme where it has one.

**Reason:** Approving the page allows those addresses, so the owner confirms the address and not only the name the page chose.

**Tests:** `compliance/web-page-origin.test.ts › names the page's origin on the consent screen and in the grants listing`, `› names both origins of a page registered on two, on the consent screen and the device approval page`.

### `keys-and-oauth/device-names-page`

When the device approval page offers access to a web client, the server MUST name on it the origin of each redirect URI the client registered, written without its `https://` scheme where it has one.

**Reason:** Approving a web client on this page allows its addresses as approving it on the consent screen does.

**Tests:** `compliance/web-page-origin.test.ts › names the page's origin on the device approval page, and allows it once approved there`, `› names both origins of a page registered on two, on the consent screen and the device approval page`.

### `keys-and-oauth/sign-in-email-kept`

When a sign-in through the form fails, the server MUST redirect the browser to the sign-in page carrying the typed email.

**Tests:** `compliance/sign-in-surface.test.ts › returns the typed email after a wrong password, and never the password`.

### `keys-and-oauth/sign-in-email-shown`

When the sign-in page is opened carrying an email, the server MUST show that email in the email field.

**Tests:** `compliance/sign-in-surface.test.ts › returns the typed email after a wrong password, and never the password`.

### `keys-and-oauth/sign-in-no-password`

The server MUST NOT carry a typed password in the sign-in form's redirect or show it on the sign-in page.

**Reason:** A password in an address is kept in history and in logs.

**Tests:** `compliance/sign-in-surface.test.ts › returns the typed email after a wrong password, and never the password`.

### `keys-and-oauth/sign-in-names-app`

When an authorization the instance signed, whose window is open, sends a person to the sign-in page, the server MUST name the app on it.

**Reason:** A person signing in for an app should be able to see which app it is.

**Tests:** `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`.

### `keys-and-oauth/sign-in-caution`

When the sign-in page names an app, the server MUST show the unverified-app caution beside it.

**Reason:** The name is as unvetted on the page before the sign-in as on the page after it.

**Tests:** `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`, `compliance/unverified-apps.test.ts › is shown with the caution on the sign-in page`.

### `keys-and-oauth/sign-in-unsigned-no-app`

When the sign-in page is opened by a request that is not an authorization the instance signed, a link edited after it was signed or one carrying no signature included, the server MUST name no app.

**Reason:** The name is whatever the app registered under, so one taken from an unsigned request would put a stranger's words on a page the real instance serves.

**Tests:** `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`.

### `keys-and-oauth/signed-in-page`

When a person who holds a session opens `GET /auth/sign-in` without `prompt=login` and no authorization sent them, the server MUST answer a page saying they are signed in, holding no sign-in form.

**Tests:** `compliance/sign-in-surface.test.ts › tells a person who is signed in so, and shows the form to one an authorization sent to sign in again`.

### `keys-and-oauth/signed-in-reauth`

When a person who holds a session opens `GET /auth/sign-in` and an authorization sent them, the server MUST answer the sign-in form.

**Reason:** The provider sends a signed-in person to sign in again when an app asks for a fresh sign-in, and only a new session satisfies it.

**Tests:** `compliance/sign-in-surface.test.ts › tells a person who is signed in so, and shows the form to one an authorization sent to sign in again`.

### `keys-and-oauth/sign-in-page-reprompt`

When a browser with a live session opens `/auth/sign-in` with `prompt=login`, the server MUST show the sign-in form.

**Reason:** An app can ask for a new sign-in with `prompt=login`, and only a new session satisfies it, so the page cannot answer that the person is already signed in.

**Tests:** `compliance/recent-sign-in-consent.test.ts › shows the sign-in form to a browser that holds a session and opens the sign-in page with prompt=login`.

### `keys-and-oauth/link-unverified`

If the consent screen receives an authorization whose signature the instance did not make, or that was edited after it was signed, then the server MUST answer `400` with the page saying the request could not be verified, not that it has expired.

**Tests:** `compliance/sign-in-surface.test.ts › tells a link edited after it was signed that it is invalid, not that it has expired`.

### `keys-and-oauth/link-expired`

If the consent screen receives an authorization the instance signed whose window has closed, then the server MUST answer the page saying the request has expired.

**Tests:** `compliance/sign-in-surface.test.ts › tells a link whose window has closed that the request has expired`.

### `keys-and-oauth/same-words`

The server MUST label each scope of a grant, reading only or reading and writing, in the same words on the consent screen and on the device approval page.

**Reason:** A person approving access reads it once and should recognize it wherever else they meet it.

**Tests:** `compliance/unverified-apps.test.ts › is named in the same words on the consent page and the device approval page, reach included`.

### `keys-and-oauth/reach-line`

When the consent screen or the device approval page offers a grant reaching types not yet registered, the server MUST state on its row, in the same words on both, that it grows, naming the types it covers today.

**Reason:** A grant that grows as types are added is larger than it reads, and the fact cannot depend on which page a person approved it on.

**Tests:** `compliance/unverified-apps.test.ts › is named in the same words on the consent page and the device approval page, reach included`.

### `keys-and-oauth/reach-line-one-type`

When the consent screen or the device approval page offers a grant of one type, the server MUST NOT state a reach beyond that type.

**Tests:** `compliance/unverified-apps.test.ts › is named in the same words on the consent page and the device approval page, reach included`.

## The owner's sign-ins

A sign-in is one way the owner's Marfa can be reached: a browser session of the owner, an app the owner approved, or a live key. The owner lists every sign-in at `GET /owner/sign-ins`, renames an app or a key at `PATCH /owner/sign-ins/{id}`, and ends any one at `DELETE /owner/sign-ins/{id}`, through the private local command.

### `keys-and-oauth/sign-ins-list`

When the private local command asks `GET /owner/sign-ins`, the server MUST answer `200` with every live browser session of the owner with `kind` `browser`, every live app grant of the owner with `kind` `app`, and every live key with `kind` `key`.

**Tests:** `compliance/owner-sign-ins.test.ts › lists every live browser session of the owner`, `› lists every app and key beside the browsers, each with a name, a kind and its last use`, `› lists, renames and ends a sign-in through the local command`.

### `keys-and-oauth/sign-ins-fields`

When `GET /owner/sign-ins` answers, the server MUST give each sign-in its `id`, `kind`, `name`, `created_at`, `last_used_at`, `expires_at`, `ip_address`, `user_agent` and `minted_by`, and no other field.

**Tests:** `compliance/owner-sign-ins.test.ts › lists every live browser session of the owner`, `› lists every app and key beside the browsers, each with a name, a kind and its last use`.

### `keys-and-oauth/sign-ins-app-expiry`

When `GET /owner/sign-ins` lists an app, the server MUST give `expires_at` as its `last_used_at`, or `granted_at` if never used, plus the instance's grant inactivity days (`grant_inactivity_days`, 365 unless set), or `null` when that is zero.

**Reason:** This is the inactivity boundary; the retirement sweep ends the grant after the boundary is passed.

**Tests:** `compliance/auth-grants.test.ts › reports the inactivity boundary from last use or approval on the app sign-in`.

### `keys-and-oauth/sign-ins-order`

When `GET /owner/sign-ins` answers, the server MUST list the sign-ins oldest `created_at` first, across every kind.

**Tests:** `compliance/owner-sign-ins.test.ts › lists every app and key beside the browsers, each with a name, a kind and its last use`.

### `keys-and-oauth/sign-ins-browser-name`

When `GET /owner/sign-ins` lists a browser session, the server MUST give it the `name` its `user_agent` reads as, the browser and the operating system, such as `Safari on macOS`.

**Tests:** `compliance/owner-sign-ins.test.ts › names a browser from the browser it reports`.

### `keys-and-oauth/sign-ins-app-name`

When `GET /owner/sign-ins` lists an app, the server MUST give it the `name` the owner gave it at `PATCH /owner/sign-ins/{id}`, or, where the owner gave none, the `client_name` the app registered with.

**Reason:** Each install of an app registers on its own, so the name it registers with can say which machine it is on. The owner's name for an app is kept on the app's `system.connection` item, which a credential reads only with `grants.manage` (`keys-and-oauth/grants-items-read`).

**Tests:** `compliance/owner-sign-ins.test.ts › lists every app and key beside the browsers, each with a name, a kind and its last use`, `› gives an app the owner's own name, which the listing shows`.

### `keys-and-oauth/sign-ins-key-name`

When `GET /owner/sign-ins` lists a key, the server MUST give it its `label` as its `name`.

**Reason:** A key holding `keys.mint` can change the label of a key within its reach at `PATCH /keys/{id}`, and an app holding it chooses the labels of the keys it mints, so a key's name is what its minter last chose.

**Tests:** `compliance/owner-sign-ins.test.ts › lists every app and key beside the browsers, each with a name, a kind and its last use`.

### `keys-and-oauth/sign-ins-unprintable-name`

If the name a sign-in would be listed by at `GET /owner/sign-ins` holds a control character or a bidirectional formatting character, or is longer than 200 characters, then the server MUST give the sign-in the next name in its order instead: for an app, its registered `client_name`, then its client ID; for a key, its `id`.

**Reason:** Whoever registers an app or mints a key chooses its name, and a name shown in a terminal or a page must not move the cursor, erase a line or reorder the text after it to pass for another sign-in.

**Tests:** `compliance/owner-sign-ins.test.ts › names an app by its client id when its registered name holds control characters`, `› names a key by its id when its label holds a bidirectional override or is too long`.

### `keys-and-oauth/sign-ins-minted-by`

When `GET /owner/sign-ins` lists a key that an app minted while that app is a live sign-in of the owner, the server MUST give the key a `minted_by` of the app's sign-in `id`, and every other sign-in a `minted_by` of `null`.

**Tests:** `compliance/owner-sign-ins.test.ts › names the app that minted a key while the app is signed in`.

### `keys-and-oauth/sign-ins-last-used`

When `GET /owner/sign-ins` lists an app or a key with a recorded use, the server MUST give it the time of a recorded use as its `last_used_at`.

**Tests:** `compliance/owner-sign-ins.test.ts › lists every app and key beside the browsers, each with a name, a kind and its last use`.

### `keys-and-oauth/sign-ins-no-token`

The server MUST NOT carry a browser session's token or cookie value in an answer of `GET /owner/sign-ins`.

**Reason:** Whoever holds the token is signed in as that browser.

**Tests:** `compliance/owner-sign-ins.test.ts › carries no session's token, which the browser's cookie holds`.

### `keys-and-oauth/sign-ins-no-credential`

The server MUST NOT carry a key, an app's access token or an app's refresh token in an answer of `GET /owner/sign-ins`.

**Reason:** The listing names a sign-in so the owner can end it, and never hands over what it signs in with.

**Tests:** `compliance/owner-sign-ins.test.ts › carries no key and no app token, which the app and the key hold`.

### `keys-and-oauth/sign-ins-dead-key`

The server MUST NOT list a key that is revoked or past its `expires_at` at `GET /owner/sign-ins`.

**Tests:** `compliance/owner-sign-ins.test.ts › lists no revoked key`, `› lists no key past its expires_at`.

### `keys-and-oauth/sign-ins-browser-only`

If a request to `GET /owner/sign-ins`, `PATCH /owner/sign-ins/{id}` or `DELETE /owner/sign-ins/{id}` carries a key or an app's access token, then the server MUST answer `403 forbidden`.

**Reason:** These doors reach every sign-in, the owner's browsers included, and a key or an app that could end them could leave itself the only way in. A key or an app acts on other keys and apps only at `/keys` and `/auth/grants`, within the permissions it holds. The private local command holds the right to every sign-in.

**Tests:** `compliance/owner-sign-ins.test.ts › refuses a key and an app's token 403, and no credential 401`.

### `keys-and-oauth/sign-in-end`

When the private local command asks `DELETE /owner/sign-ins/{id}` naming a live sign-in of the owner, the server MUST answer `200` with `ok` `true`.

**Tests:** `compliance/owner-sign-ins.test.ts › ends that browser's session, whose next request is refused, and leaves the other signed in`, `› ends an app at once: its next request is refused and its refresh token is dead, and nothing else is`, `› ends a key at once, and leaves every other sign-in`, `› lists, renames and ends a sign-in through the local command`.

### `keys-and-oauth/sign-in-end-refused`

When `DELETE /owner/sign-ins/{id}` has ended a browser session, the server MUST answer that browser's next request as a request with no session.

**Tests:** `compliance/owner-sign-ins.test.ts › ends that browser's session, whose next request is refused, and leaves the other signed in`.

### `keys-and-oauth/sign-in-end-app`

When `DELETE /owner/sign-ins/{id}` has ended an app, the server MUST answer `401` to the next request that carries an access token issued to that app for the owner.

**Tests:** `compliance/owner-sign-ins.test.ts › ends an app at once: its next request is refused and its refresh token is dead, and nothing else is`.

### `keys-and-oauth/sign-in-end-app-refresh`

When `DELETE /owner/sign-ins/{id}` has ended an app, the server MUST answer `400 invalid_grant` to the exchange of a refresh token issued to that app for the owner.

**Reason:** An app that could refresh would sign itself back in without the owner.

**Tests:** `compliance/owner-sign-ins.test.ts › ends an app at once: its next request is refused and its refresh token is dead, and nothing else is`.

### `keys-and-oauth/sign-in-end-app-keys`

When `DELETE /owner/sign-ins/{id}` ends an app without `revoke_keys` set to `true`, the server MUST keep every key that app minted, and every key those keys minted, working.

**Reason:** As at `DELETE /auth/grants/{id}`, a key is minted on purpose and listed as a sign-in of its own, so ending an app ends its own tokens and leaves its keys to be ended with it or on their own.

**Tests:** `compliance/owner-sign-ins.test.ts › stay working when the app ends without revoke_keys`.

### `keys-and-oauth/sign-in-end-app-revoke-keys`

When `DELETE /owner/sign-ins/{id}` with `revoke_keys` set to `true` ends an app, the server MUST answer `401` to the next request that carries a key that app minted or a key that such a key minted.

**Tests:** `compliance/owner-sign-ins.test.ts › end with the app when revoke_keys is true, a key's descendant included, and no other key does`.

### `keys-and-oauth/sign-in-end-revoke-keys-not-app`

If `DELETE /owner/sign-ins/{id}` has `revoke_keys` set to `true` and names a live browser session or a live key, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/owner-sign-ins.test.ts › refuses revoke_keys on a browser and a key 400, and ends neither`.

### `keys-and-oauth/sign-in-end-key`

When `DELETE /owner/sign-ins/{id}` has ended a key, the server MUST answer `401` to the next request that carries that key.

**Tests:** `compliance/owner-sign-ins.test.ts › ends a key at once, and leaves every other sign-in`, `› lists, renames and ends a sign-in through the local command`.

### `keys-and-oauth/sign-in-end-others`

When `DELETE /owner/sign-ins/{id}` ends a sign-in, the server MUST keep every other sign-in of the owner signed in.

**Tests:** `compliance/owner-sign-ins.test.ts › ends that browser's session, whose next request is refused, and leaves the other signed in`, `› ends an app at once: its next request is refused and its refresh token is dead, and nothing else is`, `› ends a key at once, and leaves every other sign-in`, `› end with the app when revoke_keys is true, a key's descendant included, and no other key does`.

### `keys-and-oauth/sign-in-end-versions`

When `DELETE /owner/sign-ins/{id}` ends an app or a key, the server MUST keep every version that sign-in wrote as it was.

**Reason:** Ending a sign-in stops what it can do next, and changes nothing it already did.

**Tests:** `compliance/owner-sign-ins.test.ts › leaves every version the app and the key wrote as it was`.

### `keys-and-oauth/sign-in-end-unknown`

If `DELETE /owner/sign-ins/{id}` names no live sign-in of the owner, then the server MUST answer `404 sign_in_not_found`.

**Reason:** A sign-in that already ended answers the same as one that never existed, so the second of two ends of one sign-in says that nothing ended.

**Tests:** `compliance/owner-sign-ins.test.ts › answers 404 sign_in_not_found for a session already ended and an id no session has`, `› answers 404 sign_in_not_found to the second end of an app and of a key`, `› lists no key past its expires_at`.

### `keys-and-oauth/sign-in-end-restart`

When the server restarts, the server MUST keep refusing every app and key that `DELETE /owner/sign-ins/{id}` ended before the restart.

**Tests:** `compliance/owner-sign-ins.test.ts › keeps an ended and an expired session, an ended app and an ended key refused, and a live session's last use and expiry`.

### `keys-and-oauth/sign-in-rename`

When the private local command asks `PATCH /owner/sign-ins/{id}` naming a live app or key of the owner, the server MUST answer `200` with the sign-in, whose `name` is the `name` the request gave with the spaces at each end removed.

**Tests:** `compliance/owner-sign-ins.test.ts › gives an app the owner's own name, which the listing shows`, `› lists, renames and ends a sign-in through the local command`.

### `keys-and-oauth/sign-in-rename-listed`

When `PATCH /owner/sign-ins/{id}` has renamed an app, the server MUST list the app at `GET /owner/sign-ins` under that name.

**Tests:** `compliance/owner-sign-ins.test.ts › gives an app the owner's own name, which the listing shows`.

### `keys-and-oauth/sign-in-rename-key`

When `PATCH /owner/sign-ins/{id}` renames a key, the server MUST make the new name the key's `label`.

**Tests:** `compliance/owner-sign-ins.test.ts › gives a key a new label`.

### `keys-and-oauth/sign-in-rename-browser`

If `PATCH /owner/sign-ins/{id}` names a live browser session of the owner, then the server MUST answer `400 validation_error`.

**Reason:** A browser's name is read from the browser, and the session keeps nothing else to name it by.

**Tests:** `compliance/owner-sign-ins.test.ts › refuses to rename a browser 400 validation_error`.

### `keys-and-oauth/sign-in-rename-invalid`

If the body of `PATCH /owner/sign-ins/{id}` has a `name` that is empty once trimmed, longer than 200 characters or holds a control character or a bidirectional formatting character, or has a field other than `name`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/owner-sign-ins.test.ts › refuses an empty, overlong, unprintable or missing name and another field 400`.

### `keys-and-oauth/sign-in-rename-missing`

If the body of `PATCH /owner/sign-ins/{id}` has no `name`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/owner-sign-ins.test.ts › refuses an empty, overlong, unprintable or missing name and another field 400`.

### `keys-and-oauth/sign-in-rename-unknown`

If `PATCH /owner/sign-ins/{id}` names no live sign-in of the owner, then the server MUST answer `404 sign_in_not_found`.

**Tests:** `compliance/owner-sign-ins.test.ts › answers 404 sign_in_not_found for an ended sign-in and an id no sign-in has`, `› answers 404 sign_in_not_found to the rename of a browser session that has expired`.

## A browser session's idle week

A browser session expires seven days and one minute after its last recorded use. A use is recorded at most once a minute; a use that storage refuses does not renew the expiry. The session's cookie lasts longer, so the stored session is what ends it.

### `keys-and-oauth/session-use-recorded`

When the server admits a request on a browser session whose last recorded use is a minute old or older and storage accepts its renewal, the server MUST record that request's time as the session's `last_used_at`.

**Reason:** Renewal also changes the session's authority deadline, so its live-session check and expiry update remain atomic. A refused renewal admits a read without extending the stored expiry, which remains seven days and one minute after the last recorded use.

**Tests:** `compliance/owner-sign-ins.test.ts › records a request as the last use and moves the expiry to a week and a minute after it, where a renewal a day old would not`, `› does not record a use within a minute of the last one`.

### `keys-and-oauth/session-use-expiry`

When the server records a use of a browser session, the server MUST set the session's `expires_at` to seven days and one minute after that use.

**Reason:** A session renewed only once its last renewal is a day old would end a week after that renewal rather than a week after its last use.

**Tests:** `compliance/owner-sign-ins.test.ts › records a request as the last use and moves the expiry to a week and a minute after it, where a renewal a day old would not`.

### `keys-and-oauth/session-sign-in-expiry`

When a password sign-in creates a browser session, the server MUST set the session's `expires_at` to seven days and one minute after the sign-in.

**Tests:** `compliance/owner-sign-ins.test.ts › gives a new session a week and a minute, and its cookie 400 days`.

### `keys-and-oauth/session-cookie-lifetime`

When a password sign-in sets a browser session's cookie, the server MUST give the cookie a `Max-Age` of 400 days.

**Reason:** The stored session is the only clock, so the cookie only has to outlive it. A cookie that tracked the session's expiry would be dropped while the session lived whenever the answer that renewed it did not reach the browser.

**Tests:** `compliance/owner-sign-ins.test.ts › gives a new session a week and a minute, and its cookie 400 days`.

### `keys-and-oauth/session-use-cookie`

When the server records a use of a browser session, the server MUST send the browser's session cookie again with a `Max-Age` of 400 days, in any answer other than `401` or one that ends that session.

**Reason:** A session in use for longer than 400 days keeps its cookie. An answer that refuses the request still records the use, a `401` means the session ended while the request was in flight, and an answer that ends the session clears its cookie instead.

**Tests:** `compliance/owner-sign-ins.test.ts › sends the cookie again for 400 days when it records a use, in a refusal too`.

### `keys-and-oauth/session-use-unwritten`

If the storage is full, read-only or held by another writer when the server records a use of a live browser session, then the server MUST still admit the request on it.

**Reason:** Recording a use is bookkeeping, and a full or busy disk must not sign the owner out of reading. A write the request makes meets the same storage and answers as it would. Any other failure to record the use refuses the request.

**Tests:** `compliance/owner-sign-ins.test.ts › admits a request whose use cannot be recorded, and records the next once it can`.

### `keys-and-oauth/session-idle-kept`

While a browser session that nothing has ended has a recorded use less than seven days ago, the server MUST admit a request on it.

**Tests:** `compliance/owner-sign-ins.test.ts › admits a session last used just under a week ago`.

### `keys-and-oauth/session-idle-ends`

If a browser session has not been used for seven days and one minute, then the server MUST answer a request on it as a request with no session.

**Tests:** `compliance/owner-sign-ins.test.ts › refuses a session unused for a week and a minute`.

### `keys-and-oauth/session-end-restart`

When the server restarts, the server MUST keep refusing every browser session that was ended or had expired before the restart.

**Tests:** `compliance/owner-sign-ins.test.ts › keeps an ended and an expired session, an ended app and an ended key refused, and a live session's last use and expiry`.

### `keys-and-oauth/session-use-restart`

When the server restarts, the server MUST keep each live browser session's `last_used_at` and `expires_at`.

**Tests:** `compliance/owner-sign-ins.test.ts › keeps an ended and an expired session, an ended app and an ended key refused, and a live session's last use and expiry`.

## Browser sessions and apps

A browser session ends by sign-out, by the owner ending it, by local password recovery, or by going unused for a week.

### `keys-and-oauth/app-outlives-browser`

When a person's browser session ends, the server MUST keep valid every access token an app holds for that person.

**Reason:** An app is not the browser that approved it, and an app with no refresh grant has no way back in. Only a revocation of the grant ends an app's access.

**Tests:** `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› local recovery revokes browser sessions and keeps apps connected`, `compliance/owner-sign-ins.test.ts › through going unused for a week leaves every app connected`.

### `keys-and-oauth/refresh-outlives-browser`

When a person's browser session ends, the server MUST answer the exchange of a refresh token an app holds for that person `200` with tokens that are valid.

**Tests:** `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› local recovery revokes browser sessions and keeps apps connected`, `compliance/owner-sign-ins.test.ts › through going unused for a week leaves every app connected`.

### `keys-and-oauth/consent-outlives-browser`

When a person's browser session ends, the server MUST keep the person's consent to every app.

**Reason:** Consent is the person's decision about the app and not about the browser they made it in.

**Tests:** `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› local recovery revokes browser sessions and keeps apps connected`.

### `keys-and-oauth/app-outlives-restart`

When the server restarts with the same secret and address, the server MUST keep valid every access token and refresh token an app holds.

**Tests:** `compliance/browser-sessions.test.ts › leaves every app connected across a restart of the server`.

### `keys-and-oauth/sign-out-lookup-fault`

If `POST /auth/sign-out` cannot look its session up, then the server MUST answer `500`.

**Reason:** A success would claim a session ended that the database could not end. A retry once the fault clears signs out.

**Tests:** `compliance/credential-faults.test.ts › that cannot look its session up answers 500 and clears no cookie, and a retry signs out`.

### `keys-and-oauth/sign-out-lookup-cookie`

If `POST /auth/sign-out` cannot look its session up, then the server MUST clear no cookie.

**Tests:** `compliance/credential-faults.test.ts › that cannot look its session up answers 500 and clears no cookie, and a retry signs out`.

### `keys-and-oauth/sign-out-delete-fault`

If `POST /auth/sign-out` cannot delete its session, then the server MUST answer `500`.

**Tests:** `compliance/credential-faults.test.ts › that cannot delete its session answers 500 and clears no cookie, and a retry signs out`.

### `keys-and-oauth/sign-out-delete-cookie`

If `POST /auth/sign-out` cannot delete its session, then the server MUST clear no cookie.

**Tests:** `compliance/credential-faults.test.ts › that cannot delete its session answers 500 and clears no cookie, and a retry signs out`.

### `keys-and-oauth/sign-out-audit-fault`

If the audit record of a browser session's end cannot be committed, then the server MUST leave the session signed in.

**Reason:** A session that ended with nothing to account for it cannot take effect, and one the person was told had ended has to have.

**Tests:** `compliance/credential-faults.test.ts › whose end cannot be audited answers 500 and leaves the session signed in, and a retry signs out`.

### `keys-and-oauth/sign-out-audit-answer`

If the audit record of a browser session's end cannot be committed, then the server MUST answer `500`.

**Tests:** `compliance/credential-faults.test.ts › whose end cannot be audited answers 500 and leaves the session signed in, and a retry signs out`.

## Audit records

### `keys-and-oauth/audit-key-changes`

When the mint, the update or the revoke of a key answers success, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when the mint, the update and the revoke of a key answer`.

### `keys-and-oauth/audit-grant-changes`

When a consent, a token issue or a grant's revocation answers success, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a consent, a token and a grant's revocation answer`.

### `keys-and-oauth/audit-setup-proof`

When the private local command issues a setup code, or a browser exchanges one, the server MUST already hold its audit record, readable at `GET /audit`, as it answers.

**Reason:** The owner claim the proof leads to is held by `instance-claim/concurrent-claim`.

**Tests:** `compliance/owner.test.ts › replaces unclaimed setup proof on restart`.

### `keys-and-oauth/audit-registration`

When a client's registration answers `201`, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a client's registration answers`.

### `keys-and-oauth/audit-code`

When an authorization answers with a code, the server MUST already hold the code's audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when an authorization answers with a code`.

### `keys-and-oauth/audit-sign-in`

When a password sign-in answers `200`, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a password sign-in answers`.

### `keys-and-oauth/audit-device-approval`

When a person's approval of a device code answers, the server MUST already hold the audit record of the grant it made, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a device approval answers`.

### `keys-and-oauth/audit-grant-retired`

When the inactivity retirement retires a grant, the server MUST already hold the audit record of the retirement, readable at `GET /audit`, as the run answers.

**Reason:** A grant unused for the instance's window, a year unless it says otherwise, is ended as a person's own revocation ends it.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when the inactivity retirement retires a grant`.

### `keys-and-oauth/audit-sign-in-end`

When `DELETE /owner/sign-ins/{id}` answers `200`, the server MUST already hold the audit record of the sign-in's end, readable at `GET /audit`.

**Tests:** `compliance/owner-sign-ins.test.ts › is in the audit log when it answers`, `› is in the audit log when it ends an app or a key`.

### `keys-and-oauth/audit-failed-sign-in`

When the server refuses a password sign-in, the server MUST already hold the audit record of the failure, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when the refusal of a failed sign-in answers`.

### `keys-and-oauth/audit-refresh-replay`

When the server refuses a replayed refresh token, the server MUST already hold the audit record of the replay, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when the refusal of a replayed refresh token answers`.

### `keys-and-oauth/audit-narrowed`

When the server narrows an authorization request to what it can grant, the server MUST already hold the audit record of the narrowing, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when an authorization narrowed to what can be granted answers`.

### `keys-and-oauth/audit-grant-reused`

When an authorization a standing consent covers answers with a code, the server MUST already hold the audit record of the reused grant, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a request a standing consent covers answers with a code`.

### `keys-and-oauth/audit-rollback`

If the audit record of a change to a key cannot be committed, then the server MUST leave the key as it was.

**Reason:** A change nobody can account for is undisclosed authority, so the change and its record are kept or lost together.

**Tests:** `compliance/credential-faults.test.ts › refuses a key change whose audit record cannot be committed, and leaves the key as it was`.

### `keys-and-oauth/audit-rollback-answer`

If the audit record of a change to a key cannot be committed, then the server MUST answer `500`.

**Tests:** `compliance/credential-faults.test.ts › refuses a key change whose audit record cannot be committed, and leaves the key as it was`.

### `keys-and-oauth/audit-rollback-consent`

If the audit record of a consent cannot be committed, then the server MUST make no grant, so no consent stands.

**Tests:** `compliance/credential-faults.test.ts › whose audit record cannot be committed grants nothing and publishes no event`.

### `keys-and-oauth/audit-rollback-consent-answer`

If the audit record of a consent cannot be committed, then the server MUST answer `500`.

**Tests:** `compliance/credential-faults.test.ts › whose audit record cannot be committed grants nothing and publishes no event`.

### `keys-and-oauth/audit-rollback-event`

If the audit record of a consent cannot be committed, then the server MUST publish no event for the grant it would have made.

**Tests:** `compliance/credential-faults.test.ts › whose audit record cannot be committed grants nothing and publishes no event`.

### `keys-and-oauth/audit-rollback-withdrawal`

If the audit record of a grant's withdrawal cannot be committed, then the server MUST leave the grant and its tokens standing.

**Tests:** `compliance/credential-faults.test.ts › whose audit record cannot be committed answers 500, leaves the grant and its tokens, and publishes no event`.

### `keys-and-oauth/audit-rollback-withdrawal-answer`

If the audit record of a grant's withdrawal cannot be committed, then the server MUST answer `500`.

**Tests:** `compliance/credential-faults.test.ts › whose audit record cannot be committed answers 500, leaves the grant and its tokens, and publishes no event`.

### `keys-and-oauth/audit-rollback-withdrawal-event`

If the audit record of a grant's withdrawal cannot be committed, then the server MUST publish no event for the withdrawal.

**Tests:** `compliance/credential-faults.test.ts › whose audit record cannot be committed answers 500, leaves the grant and its tokens, and publishes no event`.

### `keys-and-oauth/audit-unknown-outcome`

While the outcome of a change to a credential is unknown, the server MUST withhold its success answer, any plaintext credential, any authorization code redirect and any cookie change.

**Reason:** An unanswered commit is not proof of a rollback.

**Tests:** `compliance/credential-faults.test.ts › withholds a key's success answer and its plaintext, and a retry mints it`, `compliance/credential-faults.test.ts › withholds the redirect of an authorization code, and a retry of the consent gets one`, `compliance/credential-faults.test.ts › withholds a sign-out's cookie change, and a retry clears the cookie`.
