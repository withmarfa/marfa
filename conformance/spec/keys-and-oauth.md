# Keys and sign-in

## Content reach

A named permission opens the operations it names and no item. What a credential reads and writes is its maps' alone.

### `keys-and-oauth/permissions-no-content`

When a credential holding named permissions and no content map reads or writes items, the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/key-management.test.ts › management permissions do not grant content access`, `› refuses a bulk action to a key reaching no type, and narrows one for a key writing none`, `compliance/unreadable-items.test.ts › a key reaching no type is refused a single row, whatever the id names`.

### `keys-and-oauth/direct-mint-everything`

When direct owner or local authority mints a key from a body naming no permission, map or `sources`, the server MUST give the key all twelve permissions, `*: write` in each of the five maps and no claimed source.

**Reason:** The owner holds no ceiling of their own, so a key minted with nothing named holds everything a key can.

**Tests:** `compliance/key-management.test.ts › the direct owner issues an ordinary key without a caller ceiling`.

## An item the key cannot read

### `keys-and-oauth/unreadable-as-missing`

When an operation names by id, in its path or its body, an item whose type the credential may not read, live or in the bin, the server MUST answer exactly as it answers an id no item holds, status, body and headers alike.

**Reason:** The answer says nothing of whether the row exists or what type it is. A key learns its own reach from `GET /keys/current`, never from a refusal. `items/create-id-unreadable`, `edges/end-source-hidden`, `edges/end-target-hidden`, `edges/read-id-source` and `edges/filter-backref-anchor` hold the same for a create, an edge's ends and a filter.

**Tests:** `compliance/unreadable-items.test.ts › an item the key cannot read answers as a missing one`, `compliance/type-permissions.test.ts › a key without reach on the item's type is answered as if the item, its edges and its backrefs were not there`.

### `keys-and-oauth/unreadable-replay`

When a write that answered an unreadable item's `404` is replayed under its `Idempotency-Key`, the server MUST replay the same `404`, as it replays one for an id no item holds.

**Reason:** Releasing the key, as a `403` is released, would tell the two apart.

**Tests:** `compliance/unreadable-items.test.ts › replays a hidden row's 404 under its Idempotency-Key, as it replays a missing id's`.

### `keys-and-oauth/unreadable-bulk-upsert`

When a `POST /items/bulk` entry under `upsert` names as its `id` the id of an item the credential may not read, the server MUST refuse it as a taken id alike for a live and a trashed item, naming nothing of its type.

**Tests:** `compliance/unreadable-items.test.ts › POST /items/bulk naming the id of an item it cannot read answers alike whether the item is live or trashed, and not with its type`.

### `keys-and-oauth/readable-not-writable`

If a credential that may read an item's type and not write it writes the item, then the server MUST answer `403 type_not_permitted`.

**Reason:** The credential already knows the row is there, so the refusal says nothing it did not know.

**Tests:** `compliance/unreadable-items.test.ts › a write to a type the key reads and does not write is still refused 403`, `compliance/type-permissions.test.ts › read-only scoped key cannot DELETE items of that type`.

### `keys-and-oauth/neighbors-omitted`

When `GET /items/{id}?include=neighbors` reaches neighbors whose type the credential may not read, the server MUST leave them out of `neighbors` and count them in `neighbors_omitted`.

**Reason:** A limit accepted: the count says how many there are and never their ids or types.

**Tests:** `compliance/unreadable-items.test.ts › count the neighbors the key cannot read in neighbors_omitted, and leave them out of neighbors`.

## Extension namespaces

An extension namespace is gated twice: by the type map on the item's type, as every item operation is, and then by the extension map. What a key is answered of an item's extensions is held by `items/extension-answer`, `items/extension-read`, `search-and-filters/export-extensions` and `events/metadata-namespaces`.

### `keys-and-oauth/extension-unreadable-type`

When an extension operation names an item whose type the key may not read, the server MUST answer exactly as for an item no row holds, `404 item_not_found`.

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

**Reason:** A folder is written through `/folders`, and its extensions take the write fence the item operations put on every `system.*` row (`items/system-types`).

**Tests:** `compliance/extensions.test.ts › refuses a folder's extensions to a key holding write on system.folder, as the item doors refuse the folder`.

### `keys-and-oauth/extension-namespace-map`

If a key holding the item's type and not the namespace at the level an extension operation needs uses that operation, then the server MUST answer `403 forbidden`, naming the namespace and the level in `details.grant`.

**Tests:** `compliance/extensions.test.ts › refuses a key without reach on the namespace`, `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`.

### `keys-and-oauth/extension-map-only`

The server MUST give a key reach on an extension namespace only through its extension map, by the namespace's name or `*`, whatever the key's label says.

**Tests:** `compliance/extensions.test.ts › grants no namespace to a key relabeled with its name`, `› grants no namespace to a key minted with its name for a label`, `› is reached only by a key whose extension map names it`, `› is not granted by a key whose extension map does not name it`.

## Minting

### `keys-and-oauth/mint-answer`

When `POST /keys` mints a key, the server MUST answer `201` with the key's `id`, its plaintext `key`, its `label`, its `permissions`, its claimed `sources`, its five maps and its `created_at`.

**Tests:** `compliance/key-management.test.ts › key creation response includes expected fields`, `› every key answer carries its permissions and its maps, empty where it holds nothing`, `› the direct owner issues an ordinary key without a caller ceiling`.

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

**Tests:** `compliance/key-management.test.ts › refuses a mint reaching past what the caller holds`, `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`.

### `keys-and-oauth/plaintext-once`

The server MUST carry a key's plaintext `key` only in the answer to the mint that created it.

**Tests:** `compliance/key-management.test.ts › key secret is not included in list response`, `› a key holding no permission reads itself, and no other key`, `compliance/keys-update.test.ts › updates the label and the maps in place, never the source`.

### `keys-and-oauth/own-source-unique`

If a mint names as the new key's own `source` one that another unrevoked key holds as its own, then the server MUST answer `409 conflict` with `details.source` naming it.

**Reason:** A key's own source is stamped on what it writes and is how a file of fixtures or a device tells its rows apart. Two keys share a source by claiming it instead.

**Tests:** `compliance/key-management.test.ts › refuses a second key naming as its own a source already in use`.

### `keys-and-oauth/own-source-race`

When several mints name one unused `source` as their own at once, the server MUST answer exactly one of them `201` and the rest `409 conflict`.

**Tests:** `compliance/key-management.test.ts › answers mints racing for one source with one 201 and 409 conflict for the rest`.

### `keys-and-oauth/mint-permission`

If a caller holding neither `keys.mint` nor direct owner or local authority sends `POST /keys`, then the server MUST answer `403 forbidden` with `details.required_scope` naming `keys.mint`.

**Reason:** `keys.manage` lists, narrows and revokes keys across the instance, and minting a new credential is a different power.

**Tests:** `compliance/key-management.test.ts › minting requires keys.mint`.

### `keys-and-oauth/key-operations-permission`

If a caller holding none of `keys.mint`, `keys.manage` and direct owner or local authority lists, updates or revokes keys, then the server MUST answer `403 forbidden` with `details.required_scope` naming `keys.mint`.

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

**Reason:** A key's own source is stamped on every row it wrote, so a key that needs another source is a new key.

**Tests:** `compliance/keys-update.test.ts › refuses a change of source`.

### `keys-and-oauth/update-ceiling`

If a working key's update gives a key a permission, or a type, edge, metadata or profile map entry, that the caller does not hold, then the server MUST answer `403 forbidden` with `details.required_scope` naming it.

**Tests:** `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`.

### `keys-and-oauth/update-ceiling-unchanged`

If a working key's update gives a key a permission, or a type, edge, metadata or profile map entry, that the caller does not hold, then the server MUST leave the key as it was.

**Tests:** `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`.

### `keys-and-oauth/manage-narrows-only`

If a caller holding `keys.manage`, and not direct owner or local authority, updates a key to hold a permission, map entry or claimed source the key does not already hold, then the server MUST answer `403 forbidden`.

**Reason:** `keys.manage` reaches every key so that it can take access away, and a power to add access to any key would be a power to mint.

**Tests:** `compliance/keys-update.test.ts › only narrows a key for a caller acting through keys.manage`.

### `keys-and-oauth/app-key-narrows-only`

If an update would give a key an app made a permission, map entry or claimed source the key does not already hold, then the server MUST answer `403 forbidden`, whoever the caller is.

**Reason:** The consent screen tells a person that a key an app makes holds what the app held and never more, and that promise is worth something only if no credential can lift it.

**Tests:** `compliance/key-reach.test.ts › a signed-in app gives a key within its reach a permission its grant holds, and no other`, `compliance/claimed-sources.test.ts › never widens a key an app made to a new source`.

### `keys-and-oauth/key-unknown`

When `PATCH` or `DELETE /keys/{id}` names a well-formed id that no key within the caller's reach holds, the server MUST answer `404 api_key_not_found`.

**Tests:** `compliance/keys-update.test.ts › answers 404 for an unknown key and 400 for a malformed id`, `compliance/key-reach.test.ts › cannot revoke a key beyond its reach, and is answered as for no key`.

### `keys-and-oauth/key-malformed-id`

When `PATCH` or `DELETE /keys/{id}` names a malformed id, the server MUST answer `400 validation_error`.

**Tests:** `compliance/keys-update.test.ts › answers 404 for an unknown key and 400 for a malformed id`, `compliance/declared-refusals.test.ts › is refused 400 on the key and blob-location doors`.

### `keys-and-oauth/revoke-answer`

When `DELETE /keys/{id}` revokes a key, the server MUST answer `200` with `ok: true`.

**Tests:** `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`.

### `keys-and-oauth/revoke-immediate`

When a key has been revoked, the server MUST answer the next request bearing it `401 unauthorized`.

**Reason:** What the key queued or holds open ends with it: `items/job-credential-lost` holds its bulk actions and `events/credential-revoked` its event streams.

**Tests:** `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`.

### `keys-and-oauth/revoke-twice`

When `DELETE /keys/{id}` names a key that is already revoked, the server MUST answer `404 api_key_not_found`, with a message saying it was already revoked only to a caller holding `keys.manage` or direct owner or local authority.

**Reason:** A revoked key's reach cannot be measured, so a caller acting through `keys.mint` is told what it would be told of a key it never reached.

**Tests:** `compliance/key-reach.test.ts › answers a second revoke as an unknown key, and tells keys.manage the key was already revoked`.

### `keys-and-oauth/last-used-new`

When a key is minted, the server MUST answer its `last_used_at` as `null`.

**Tests:** `compliance/key-last-used.test.ts › new key has null or absent last_used_at`.

### `keys-and-oauth/last-used-set`

When a key has authenticated a request, the server MUST answer its `last_used_at` on `GET /keys` as an ISO 8601 instant in UTC.

**Tests:** `compliance/key-last-used.test.ts › last_used_at is set after first use`, `› last_used_at is a valid ISO 8601 timestamp`, `› last_used_at appears in list response`.

## The command's keys

### `keys-and-oauth/command-mint-nothing`

When `marfa keys create` runs with `--no-permissions`, the command MUST mint a key holding nothing in `permissions` and in each of the five maps.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

### `keys-and-oauth/command-update-nothing`

When `marfa keys update` runs with `--no-permissions`, the command MUST name `permissions` and every map empty, so the key holds nothing in any of them.

**Reason:** A key minted too wide is narrowed to nothing in place, rather than revoked and minted again.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

### `keys-and-oauth/command-update-one-map`

When `marfa keys update` runs with one `--no-<map>` option, the command MUST empty that map and leave every other family as it was.

**Tests:** `cli/instance.test.ts › empties one key permission map at a time and retains every other family`.

### `keys-and-oauth/command-revoked-key`

When the server refuses a request the command sends under a revoked key, the command MUST exit 5 and report `unauthorized`.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

## Expiry

No operation stamps an expiry on a key, so `expires_at` is `null` on every key an operation mints. These rules hold for a key whose row carries one.

### `keys-and-oauth/expired-refused`

When a key is past its `expires_at`, the server MUST answer a request bearing it `401 unauthorized`.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`.

### `keys-and-oauth/expired-unlisted`

When a key is past its `expires_at`, the server MUST leave it out of `GET /keys`.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`.

### `keys-and-oauth/expired-unknown`

When `PATCH` or `DELETE /keys/{id}` names a key past its `expires_at`, the server MUST answer `404 api_key_not_found`, whoever the caller is.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`.

### `keys-and-oauth/expired-unchanged`

When `PATCH` or `DELETE /keys/{id}` names a key past its `expires_at`, the server MUST leave the key as it was, whoever the caller is.

**Tests:** `compliance/key-expiry.test.ts › is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke`.

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

The server MUST carry `expires_at` on `GET /keys`, `GET /keys/current` and the answer to `PATCH /keys/{id}`, `null` on every key an operation minted.

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

If a caller holding neither `config.manage` nor direct owner or local authority mints or updates a key with a body naming `enforcement_override`, then the server MUST answer `403 forbidden` with `details.required_scope` naming `config.manage`.

**Reason:** A key's levers can be looser than the instance's, so setting them is a change to how the instance is enforced, which only a caller that may change the instance's own levers makes.

**Tests:** `compliance/schema-enforcement.test.ts › refuses a mint or an update naming levers to a caller without config.manage`, `› an app holding config.manage sets a key's levers looser than the instance's, and one without it is refused`.

### `keys-and-oauth/levers-permission-unchanged`

If a caller holding neither `config.manage` nor direct owner or local authority mints or updates a key with a body naming `enforcement_override`, then the server MUST create no key and change none.

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

When direct owner or local authority mints a key, or updates a key no app made, the server MUST grant any source outside the reserved prefix.

**Tests:** `compliance/claimed-sources.test.ts › refuses a mint or an update claiming a source its caller does not hold`, `› grants a source under any other prefix, connector: included`.

### `keys-and-oauth/claims-own-elsewhere`

If a mint names as the new key's own `source` one another key claims, and the caller could not grant that claim, then the server MUST answer `403 forbidden` with `details.source` naming it.

**Reason:** A key writes under its own source as surely as under a claim, so naming it as the source would take a claim the caller was refused.

**Tests:** `compliance/claimed-sources.test.ts › refuses a key whose own source another key claims, unless its caller could grant it`.

### `keys-and-oauth/claims-reserved`

If a mint or an update names a claim or an own `source` starting with `oauth:`, in any case, then the server MUST answer `400 validation_error`, whoever the caller is.

**Reason:** A source under that prefix is read as an app's identity, which no key earns by naming it.

**Tests:** `compliance/claimed-sources.test.ts › refuses a reserved prefix, even to the owner`.

### `keys-and-oauth/claims-case`

The server MUST compare a key's own `source` with another key's claims exactly, case included.

**Tests:** `compliance/claimed-sources.test.ts › compares a key's own source with another key's claim case included`.

### `keys-and-oauth/claims-narrowed`

If a key whose claim was taken away creates or upserts by natural key under that source, then the server MUST answer `403 forbidden` with `details.source`.

**Reason:** A claim is not unique, so two separately enrolled devices can share natural keys (`items/natural-key-upsert`), and narrowing one takes effect at its next write. A row already under the source stays editable by `items/source-fixed`.

**Tests:** `compliance/claimed-sources.test.ts › stops a narrowed key writing under a source it no longer claims, and leaves its rows there editable`.

### `keys-and-oauth/claims-narrowed-unwritten`

If a key whose claim was taken away creates or upserts by natural key under that source, then the server MUST write nothing.

**Tests:** `compliance/claimed-sources.test.ts › stops a narrowed key writing under a source it no longer claims, and leaves its rows there editable`.

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

When a caller holding `keys.manage` or direct owner or local authority lists, narrows or revokes keys, the server MUST reach every key.

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

## The limit on the key operations

The limiter is off for a run, so these rules are asserted against a server booted with it on.

### `keys-and-oauth/keys-rate-cap`

Where the limiter is on, when a credential's requests to the operations under `/keys` pass the cap `RATE_LIMIT_KEYS_REQUESTS` names, the server MUST answer `429 rate_limited` with `Retry-After` in seconds.

**Tests:** `compliance/key-rate-limit.test.ts › refuses past the limit the instance set, and the key doors share one window`.

### `keys-and-oauth/keys-rate-header`

Where the limiter is on, the server MUST name the cap in force in `X-RateLimit-Limit` on every answer from the operations under `/keys`.

**Tests:** `compliance/key-rate-limit.test.ts › refuses past the limit the instance set, and the key doors share one window`.

### `keys-and-oauth/keys-rate-default`

Where the limiter is on and the instance names no cap for the key operations, the server MUST hold them to 200 requests per window.

**Tests:** `compliance/key-rate-limit.test.ts › falls back to 200 when the instance names no number`.

### `keys-and-oauth/keys-rate-own-window`

Where the limiter is on, when a credential has passed the cap on the key operations, the server MUST still answer it on an operation outside `/keys`.

**Tests:** `compliance/key-rate-limit.test.ts › closes the key doors while a data-plane read on the same credential is answered`.

## Discovery

### `keys-and-oauth/as-metadata`

The server MUST serve its authorization server metadata at `/.well-known/oauth-authorization-server/auth` without a credential, with `issuer` at its `/auth` path, `code` among `response_types_supported` and `S256` among `code_challenge_methods_supported`.

**Tests:** `compliance/oauth.test.ts › serves the authorization server metadata under the issuer path`.

### `keys-and-oauth/discovery-spellings`

The server MUST serve the same authorization server metadata at `/auth/.well-known/oauth-authorization-server`, and one OpenID configuration with the same `issuer` at both `/.well-known/openid-configuration/auth` and `/auth/.well-known/openid-configuration`.

**Tests:** `compliance/oauth.test.ts › serves each discovery document under both of its spellings, alike`.

### `keys-and-oauth/discovery-endpoints`

The server MUST name in its OpenID configuration the authorization, token, registration, revocation, introspection, userinfo, end-session and device authorization endpoints and the key set, each under the issuer.

**Tests:** `compliance/oauth.test.ts › names every endpoint under the issuer, and serves the code, refresh and device grants and no other`.

### `keys-and-oauth/discovery-grants`

The server MUST advertise exactly the authorization code, refresh token and device code grants in `grant_types_supported`.

**Tests:** `compliance/oauth.test.ts › names every endpoint under the issuer, and serves the code, refresh and device grants and no other`.

### `keys-and-oauth/jwks`

The server MUST answer `jwks_uri` with a key set holding at least one key.

**Tests:** `compliance/oauth.test.ts › names every endpoint under the issuer, and serves the code, refresh and device grants and no other`.

### `keys-and-oauth/protected-resource`

The server MUST serve `/.well-known/oauth-protected-resource` without a credential, naming its own origin as `resource` and its issuer as the only authorization server.

**Tests:** `compliance/oauth.test.ts › serves the protected resource metadata, naming this server as the resource and its issuer as the authorization server`.

### `keys-and-oauth/no-backchannel-advertised`

The server MUST advertise `backchannel_logout_supported` and `backchannel_logout_session_supported` as `false` in its discovery documents.

**Reason:** An app's tokens end with neither a browser session nor a notification of one, so a document that promised a notification would promise one that never arrives.

**Tests:** `compliance/browser-sessions.test.ts › advertises no back-channel logout, since no app is notified of a browser ending`.

## Registration

### `keys-and-oauth/register-answer`

When a client registers at `POST /auth/oauth2/register`, which takes no credential, the server MUST answer `201` with a `client_id` and the metadata it registered.

**Tests:** `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`.

### `keys-and-oauth/register-scope`

When a registration names a scope, the server MUST register and answer that scope, each literal once, in the order first named.

**Tests:** `compliance/oauth.test.ts › registers a client naming a scope at that scope, once each`.

### `keys-and-oauth/register-default-scope`

When a registration names no scope, the server MUST register the client for every scope the instance allows, every scope its discovery documents publish among them.

**Tests:** `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`.

### `keys-and-oauth/register-web-default`

When a registration names no `application_type`, the server MUST register a web client.

**Tests:** `compliance/oauth.test.ts › registers a web client, whose redirect URI must be https and off the loopback`.

### `keys-and-oauth/register-web-loopback`

If a web client's registration names a redirect URI on the loopback, by `http` or `https`, then the server MUST answer `400 invalid_redirect_uri`.

**Tests:** `compliance/oauth.test.ts › registers a web client, whose redirect URI must be https and off the loopback`.

### `keys-and-oauth/register-native-loopback`

When a native client's registration names an `http` redirect URI on the loopback, the server MUST register it.

**Tests:** `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`.

### `keys-and-oauth/register-unparseable`

If a registration names a redirect URI that does not parse, then the server MUST answer `400` with an RFC 7591 error object, `error` and `error_description`, rather than the error envelope.

**Tests:** `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`.

### `keys-and-oauth/no-backchannel-registered`

When a registration names a `backchannel_logout_uri` or `backchannel_logout_session_required`, the server MUST register the client without either and leave both out of its answer.

**Reason:** A client reads the answer as what the server registered. The registration itself is accepted, so a client library that sends its defaults still registers.

**Tests:** `compliance/browser-sessions.test.ts › registers an app without a back-channel logout address and does not echo one`.

## Authorization with consent

A signed-in person approves an app on the consent screen, and the decision ends at the app's redirect URI. Every request here carries a PKCE challenge unless the rule says otherwise.

### `keys-and-oauth/consent-screen`

When a signed-in person's authorization request names scopes no standing consent covers, the server MUST send the browser to `/auth/authorize`, a consent screen offering each scope the request names.

**Tests:** `compliance/oauth-authorize.test.ts › shows a signed-in person a consent screen offering each scope the request names`.

### `keys-and-oauth/consent-accepted`

When a person accepts on the consent screen, the server MUST send the browser to the request's redirect URI with a `code` and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends the code for an accepted consent to the redirect URI with the request's state`.

### `keys-and-oauth/consent-declined`

When a person declines on the consent screen, the server MUST send the browser to the request's redirect URI with `error=access_denied`, the request's `state` and no code.

**Tests:** `compliance/oauth-authorize.test.ts › sends a declined consent to the redirect URI as access_denied with the request's state`.

### `keys-and-oauth/consent-ticked`

When a person accepts with only some of the offered scopes ticked, the server MUST issue a token for exactly the scopes left ticked.

**Tests:** `compliance/oauth-authorize.test.ts › issues a token for only the scopes the person left ticked`.

### `keys-and-oauth/consent-standing`

When a signed-in person's authorization request names only scopes their standing consent to the app covers, the server MUST send the browser to the redirect URI with a code and no consent screen.

**Tests:** `compliance/oauth-authorize.test.ts › answers a request a standing consent covers with a code and no consent screen`.

### `keys-and-oauth/consent-wider`

When an authorization request names a scope the person's standing consent to the app does not cover, the server MUST show the consent screen again.

**Tests:** `compliance/oauth-authorize.test.ts › asks again for a request reaching past the standing consent`.

### `keys-and-oauth/consent-prompt`

When an authorization request names `prompt=consent`, the server MUST show the consent screen whatever the standing consent covers.

**Tests:** `compliance/oauth-authorize.test.ts › asks again under prompt=consent, whatever the standing consent covers`.

### `keys-and-oauth/authorize-narrowed`

When an authorization request names a scope the instance cannot grant beside scopes it can, the server MUST drop that scope and authorize the rest.

**Reason:** A client that cached an older list of scopes is given what can still be granted, and the token answer's `scope` tells it what it got.

**Tests:** `compliance/oauth-authorize.test.ts › drops a requested scope the instance cannot grant, and authorizes the rest`.

### `keys-and-oauth/authorize-nothing-grantable`

If an authorization request names no scope the instance can grant, then the server MUST send the browser to the redirect URI with `error=invalid_scope`.

**Tests:** `compliance/oauth-authorize.test.ts › sends a request in which no scope can be granted to the redirect URI as invalid_scope`.

### `keys-and-oauth/authorize-pkce`

If an authorization request carries no PKCE challenge, then the server MUST send the browser to the redirect URI with `error=invalid_request`.

**Tests:** `compliance/oauth-authorize.test.ts › is refused at the redirect URI without a PKCE challenge`.

### `keys-and-oauth/authorize-redirect-unregistered`

If an authorization request names a redirect URI the client did not register, then the server MUST send the browser to its own `/auth/error` page with `error=invalid_redirect`, never to that URI.

**Tests:** `compliance/oauth-authorize.test.ts › is sent to the error page, never to a redirect URI the app did not register`.

### `keys-and-oauth/prompt-none-login`

If an authorization request naming `prompt=none` comes from nobody signed in, then the server MUST send the browser to the redirect URI with `error=login_required` and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends a request from nobody signed in to the redirect URI as login_required`, `compliance/signed-in-apps.test.ts › is answered login_required under prompt=none from nobody signed in, and is not caught up`.

### `keys-and-oauth/prompt-none-consent`

If a signed-in person's authorization request naming `prompt=none` names a scope no standing consent covers, then the server MUST send the browser to the redirect URI with `error=consent_required` and the request's `state`.

**Tests:** `compliance/oauth-authorize.test.ts › sends a request no consent covers to the redirect URI as consent_required`.

### `keys-and-oauth/prompt-none-code`

When a signed-in person's authorization request naming `prompt=none` names only scopes a standing consent covers, the server MUST send the browser to the redirect URI with a code.

**Tests:** `compliance/oauth-authorize.test.ts › answers a request a standing consent covers with a code`.

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

**Tests:** `compliance/oauth-authorize.test.ts › exchanges a code once, and refuses it again with invalid_grant`.

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

If an app exchanges a code issued with a challenge and sends no verifier, then the server MUST answer `400 invalid_request`, whether or not the app authenticates with a secret.

**Tests:** `compliance/oauth-authorize.test.ts › refuses a code issued with a challenge and exchanged with no verifier 400 invalid_request, whether or not the app sends a secret`.

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

## Refresh tokens

### `keys-and-oauth/refresh-offline`

When the server issues tokens for an authorization that asked for `offline_access`, the server MUST issue a refresh token beside the access token.

**Tests:** `compliance/oauth-tokens.test.ts › are issued only to an authorization that asked for offline_access`.

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

### `keys-and-oauth/resource-this-server`

When a token request names this server's origin as `resource`, with or without a trailing slash, the server MUST issue an access token this server accepts.

**Tests:** `compliance/oauth-tokens.test.ts › is accepted when it names this server, and the token works here`.

### `keys-and-oauth/resource-other-server`

If a token request names as `resource` anything other than this server's origin, then the server MUST answer `400 invalid_target`.

**Tests:** `compliance/oauth-tokens.test.ts › is refused invalid_target when it names another server`.

## Revocation and introspection

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

### `keys-and-oauth/introspect-active`

When a client authenticating with its secret introspects its own live access token, the server MUST answer `200` with `active: true`, the client's `client_id` and the token's `scope`.

**Tests:** `compliance/oauth-tokens.test.ts › answers a client its own live access token as active, with its scope, and a revoked one as inactive`.

### `keys-and-oauth/introspect-inactive`

When a client authenticating with its secret introspects a token that has ended, the server MUST answer `200` with only `active: false`.

**Tests:** `compliance/oauth-tokens.test.ts › answers a client its own live access token as active, with its scope, and a revoked one as inactive`.

### `keys-and-oauth/introspect-no-secret`

If a client that sends no secret asks `POST /auth/oauth2/introspect`, then the server MUST answer `401 invalid_client`.

**Tests:** `compliance/oauth-tokens.test.ts › refuses a client that sends no secret 401 invalid_client`.

## Userinfo

### `keys-and-oauth/userinfo-subject`

When an access token holding `openid` asks `GET /auth/oauth2/userinfo`, the server MUST answer `200` with the person's `sub`.

**Tests:** `compliance/oauth-tokens.test.ts › answers the person's subject, and the email only to a token holding email`.

### `keys-and-oauth/userinfo-email`

When an access token asks `GET /auth/oauth2/userinfo`, the server MUST answer the person's `email` only if the token holds `email` or a profile scope that reads it.

**Tests:** `compliance/oauth-tokens.test.ts › answers the person's subject, and the email only to a token holding email`.

### `keys-and-oauth/userinfo-no-openid`

If an access token without `openid` asks `GET /auth/oauth2/userinfo`, then the server MUST answer `400 invalid_scope`.

**Tests:** `compliance/oauth-tokens.test.ts › refuses a token without openid 400 invalid_scope, and a request with no token 401`.

### `keys-and-oauth/userinfo-no-token`

If a request with no access token asks `GET /auth/oauth2/userinfo`, then the server MUST answer `401`.

**Tests:** `compliance/oauth-tokens.test.ts › refuses a token without openid 400 invalid_scope, and a request with no token 401`.

## Grants

`grants.manage` lists and revokes the apps a person approved.

### `keys-and-oauth/grants-list`

When a caller holding `grants.manage` sends `GET /auth/grants`, the server MUST answer every app the person approved, each with its `id`, `kind`, `client_id`, `scopes`, `status` and `granted_at`, in one page whose `next_cursor` is `null`.

**Tests:** `compliance/auth-grants.test.ts › lists each app the person approved, with its client, scopes and status, in one page`.

### `keys-and-oauth/grants-permission`

If a caller without `grants.manage` lists or revokes grants, then the server MUST answer `403 forbidden` with `details.required_scope` naming `grants.manage`.

**Reason:** A key is an app's own credential and a grant is another app's, so a credential trusted to rotate a key is not one that may revoke every other app.

**Tests:** `compliance/auth-grants.test.ts › refuses a caller without grants.manage 403, naming it, and a request with no credential 401`.

### `keys-and-oauth/grants-no-credential`

If a request with no credential sends `GET /auth/grants`, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/auth-grants.test.ts › refuses a caller without grants.manage 403, naming it, and a request with no credential 401`.

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

### `keys-and-oauth/grant-revoke-keys`

When a grant is revoked with `revoke_keys=1`, the server MUST also revoke every key carrying that app's origin, whatever the caller's reach.

**Reason:** A key an app minted is held to the app's grant, so taking those keys with the grant reaches no further than revoking the grant does.

**Tests:** `compliance/auth-grants.test.ts › with revoke_keys=1 also revokes every key the app minted, a key's descendant included`.

### `keys-and-oauth/grant-unknown`

If `DELETE /auth/grants/{id}` names an id that is no app's grant, then the server MUST answer `404 oauth_grant_not_found`.

**Tests:** `compliance/oauth-refusals.test.ts › answers 404 oauth_grant_not_found for an id that is no app's grant, and revokes one that is`.

### `keys-and-oauth/app-rate-window`

Where the limiter is on, the server MUST count every request a signed-in app makes for one person in one window, whichever access token it carries.

**Reason:** Refreshing a token does not start a fresh window.

**Tests:** `compliance/signed-in-apps.test.ts › is limited by its grant, so a refreshed token shares the window of the one before it`.

## The device grant

### `keys-and-oauth/device-code-issued`

When a client asks `POST /auth/device/code` for a scope it may be granted, the server MUST answer `200` with a `device_code`, a `user_code`, a `verification_uri` and `verification_uri_complete` at `/auth/device`, `expires_in` of 600 and `interval` of 5.

**Tests:** `compliance/device-grant.test.ts › is issued with its codes, where to enter it, ten minutes to live and a five-second interval`.

### `keys-and-oauth/device-unpublished-scope`

If a client asks `POST /auth/device/code` for a scope the instance does not publish, then the server MUST answer `400 invalid_scope`.

**Tests:** `compliance/device-grant.test.ts › is refused 400 invalid_scope for a scope the instance does not publish`.

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

### `keys-and-oauth/device-client-gone`

If a signed-in person opens the device approval page for a pending code whose client is no longer registered, then the server MUST answer `400 invalid_client`.

**Tests:** `compliance/oauth-refusals.test.ts › answers 400 invalid_client for a pending code whose client is no longer registered`.

## The sign-in surface

### `keys-and-oauth/browser-origin`

If `POST /auth/sign-in`, `POST /auth/device`, `POST /auth/device/consent` or `POST /auth/authorize/decision` receives a form whose `Origin`, or `Referer` where it carries no `Origin`, is neither the issuer's origin nor one of the instance's CORS origins, `null` included, then the server MUST answer `403 forbidden` before it reads the form.

**Tests:** `compliance/sign-in-surface.test.ts › refuses a form post from an origin it does not trust, on every browser door`.

### `keys-and-oauth/browser-no-origin`

When a browser form post carries neither `Origin` nor `Referer`, the server MUST answer it as that operation answers a form rather than refuse it for its origin.

**Tests:** `compliance/sign-in-surface.test.ts › refuses a form post from an origin it does not trust, on every browser door`.

### `keys-and-oauth/return-to-elsewhere`

When the sign-in page or the sign-in form receives a `return_to` that a browser would resolve to another origin, or to a path a browser reads as another host, the server MUST use `/` in its place.

**Tests:** `compliance/sign-in-surface.test.ts › sends a signed-in browser only to a path on the instance`.

### `keys-and-oauth/return-to-kept`

When the sign-in form receives a `return_to` that resolves to a path on the instance, the server MUST redirect to its path, query and fragment.

**Tests:** `compliance/sign-in-surface.test.ts › sends a signed-in browser only to a path on the instance`.

### `keys-and-oauth/sign-in-address-limit`

If one address has made ten password sign-in attempts at an account in fifteen minutes, then the server MUST answer its next attempt `429` with `Retry-After`, before it judges the password.

**Reason:** Every attempt counts, the right password included, so the answer cannot tell a guesser it found the password.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/sign-in-form-limit`

If the sign-in form's attempt is refused by a sign-in limit, then the server MUST redirect with `error=too_many_attempts`.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/sign-in-form-limit-cookie`

If the sign-in form's attempt is refused by a sign-in limit, then the server MUST set no session cookie.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/sign-in-account-limit`

If every address together has made a hundred counted password sign-in attempts at an account in an hour, then the server MUST answer the next attempt from any address `429` with `Retry-After`.

**Reason:** An attempt one address makes past its own limit is not counted here, so one guessing address cannot hold the owner out.

**Tests:** `compliance/sign-in-limits.test.ts › holds every address together to a hundred attempts at an account in an hour, counting none an address made past its own limit`.

### `keys-and-oauth/sign-in-other-address`

When one address is held to its sign-in limit, the server MUST still answer a sign-in from another address on the password.

**Tests:** `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.

### `keys-and-oauth/address-ipv6`

The server MUST count an IPv6 address by its /64 for the password sign-in limits.

**Tests:** `compliance/sign-in-limits.test.ts › counts an IPv6 address as its /64`.

### `keys-and-oauth/device-lookup-address-limit`

If one address has looked device codes up ten times in fifteen minutes, across the entry form, the consent screen and its decision, then the server MUST redirect its next lookup with `error=too_many_attempts` before the code is looked up.

**Tests:** `compliance/sign-in-surface.test.ts › limits device code lookups per address, on the entry form and the consent screen alike`.

### `keys-and-oauth/device-lookup-instance-limit`

If every address together has made a hundred counted device code lookups in fifteen minutes, then the server MUST redirect the next lookup from any address with `error=too_many_attempts`.

**Reason:** A sweep tries each code once, so a count per code never fires. A lookup one address makes past its own limit is not counted here.

**Tests:** `compliance/sign-in-limits.test.ts › hold every address together to a hundred in fifteen minutes, counting none an address made past its own limit`.

## What the sign-in pages say

### `keys-and-oauth/caution-consent`

When the consent screen names an app, the server MUST show a caution that Marfa has not verified the app.

**Reason:** Registration needs no credential, so any program can pick any name.

**Tests:** `compliance/unverified-apps.test.ts › is shown with the caution on the consent page, whether or not it authenticates with a secret`.

### `keys-and-oauth/caution-device`

When the device approval page names an app, the server MUST show a caution that Marfa has not verified the app.

**Reason:** The device flow is where a code from a stranger is likeliest to be typed in, and a caution on one page and not the other leaves the second as the way round the first.

**Tests:** `compliance/unverified-apps.test.ts › is shown with the caution on the device approval page, whether or not it authenticates with a secret`.

### `keys-and-oauth/caution-secret`

The server MUST show the unverified-app caution for an app that authenticates with a secret as for one that does not.

**Reason:** An app that authenticates with a secret registered itself under a name it chose, as any other app did.

**Tests:** `compliance/unverified-apps.test.ts › is shown with the caution on the consent page, whether or not it authenticates with a secret`, `› is shown with the caution on the device approval page, whether or not it authenticates with a secret`, `› is shown with the caution on the sign-in page, whether or not it authenticates with a secret`.

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

**Tests:** `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`, `compliance/unverified-apps.test.ts › is shown with the caution on the sign-in page, whether or not it authenticates with a secret`.

### `keys-and-oauth/sign-in-unsigned-no-app`

When the sign-in page is opened by a request that is not an authorization the instance signed, a link edited after it was signed or one carrying no signature included, the server MUST name no app.

**Reason:** The name is whatever the app registered under, so one taken from an unsigned request would put a stranger's words on a page the real instance serves.

**Tests:** `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`.

### `keys-and-oauth/signed-in-page`

When a person who holds a session opens `GET /auth/sign-in` and no authorization sent them, the server MUST answer a page saying they are signed in, holding no sign-in form.

**Tests:** `compliance/sign-in-surface.test.ts › tells a person who is signed in so, and shows the form to one an authorization sent to sign in again`.

### `keys-and-oauth/signed-in-reauth`

When a person who holds a session opens `GET /auth/sign-in` and an authorization sent them, the server MUST answer the sign-in form.

**Reason:** The provider sends a signed-in person to sign in again when an app asks for a fresh sign-in, and only a new session satisfies it.

**Tests:** `compliance/sign-in-surface.test.ts › tells a person who is signed in so, and shows the form to one an authorization sent to sign in again`.

### `keys-and-oauth/link-unverified`

If the consent screen receives an authorization whose signature the instance did not make, or that was edited after it was signed, then the server MUST answer `400` with the page saying the request could not be verified, not that it has expired.

**Tests:** `compliance/sign-in-surface.test.ts › tells a link edited after it was signed that it is invalid, not that it has expired`.

### `keys-and-oauth/link-expired`

If the consent screen receives an authorization the instance signed whose window has closed, then the server MUST answer the page saying the request has expired.

**Tests:** waiting on #1444.

### `keys-and-oauth/end-session-page`

When a request naming `text/html` in `Accept` before any `application/json` asks `GET /auth/oauth2/end-session` with no session and no `id_token_hint`, the server MUST answer `200` with an HTML page saying the person is signed out.

**Tests:** `compliance/sign-in-surface.test.ts › shows a browser at end-session with no session a page, and a program the provider's JSON`.

### `keys-and-oauth/end-session-json`

When a request that does not name `text/html` before `application/json` asks `GET /auth/oauth2/end-session` with no session, the server MUST answer `400` with the provider's JSON refusal.

**Tests:** `compliance/sign-in-surface.test.ts › shows a browser at end-session with no session a page, and a program the provider's JSON`.

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

## Browser sessions and apps

A browser session ends by sign-out, by ending one, the other or every session, by a password change that keeps the current session, by local password recovery, or by the provider's end-session once confirmed.

### `keys-and-oauth/app-outlives-browser`

When a person's browser session ends, the server MUST keep valid every access token an app holds for that person.

**Reason:** An app is not the browser that approved it, and an app with no refresh grant has no way back in. Only a revocation of the grant ends an app's access.

**Tests:** `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› through ending the other sessions leaves every app connected`, `› through ending every session leaves every app connected`, `› through the provider's end-session, once confirmed, leaves every app connected`, `› through a password change that ends the other sessions leaves every app connected`, `› local recovery revokes browser sessions and keeps apps connected`.

### `keys-and-oauth/refresh-outlives-browser`

When a person's browser session ends, the server MUST answer the exchange of a refresh token an app holds for that person `200` with tokens that are valid.

**Tests:** `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› through ending the other sessions leaves every app connected`, `› through ending every session leaves every app connected`, `› through the provider's end-session, once confirmed, leaves every app connected`, `› through a password change that ends the other sessions leaves every app connected`, `› local recovery revokes browser sessions and keeps apps connected`.

### `keys-and-oauth/consent-outlives-browser`

When a person's browser session ends, the server MUST keep the person's consent to every app.

**Reason:** Consent is the person's decision about the app and not about the browser they made it in.

**Tests:** `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› through ending the other sessions leaves every app connected`, `› through ending every session leaves every app connected`, `› through the provider's end-session, once confirmed, leaves every app connected`, `› through a password change that ends the other sessions leaves every app connected`, `› local recovery revokes browser sessions and keeps apps connected`.

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

**Tests:** `compliance/owner.test.ts › keeps code-attempt counters through restart and replaces unclaimed setup proof`.

### `keys-and-oauth/audit-registration`

When a client's registration answers `201`, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a client's registration answers`.

### `keys-and-oauth/audit-code`

When an authorization answers with a code, the server MUST already hold the code's audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when an authorization answers with a code`.

### `keys-and-oauth/audit-sign-in`

When a password sign-in answers `200`, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a password sign-in answers`.

### `keys-and-oauth/audit-password-change`

When the owner's password change answers `200`, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a password change answers`.

### `keys-and-oauth/audit-profile-change`

When a change to the owner's profile answers `200`, the server MUST already hold its audit record, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a profile change answers`.

### `keys-and-oauth/audit-device-approval`

When a person's approval of a device code answers, the server MUST already hold the audit record of the grant it made, readable at `GET /audit`.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when a device approval answers`.

### `keys-and-oauth/audit-grant-retired`

When the inactivity retirement retires a grant, the server MUST already hold the audit record of the retirement, readable at `GET /audit`, as the run answers.

**Reason:** A grant unused for the instance's window, a year unless it says otherwise, is ended as a person's own revocation ends it.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when the inactivity retirement retires a grant`.

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

**Tests:** waiting on #1444.
