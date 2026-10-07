# Keys and OAuth

## The keys a run holds

1. The operator key holds no content permissions, so the data plane refuses it outright: a read is refused `403 type_not_permitted` exactly as a write is, on the listings as on a single row, on every door naming an item or an edge by id whatever the id names, and on `POST /edges/bulk` before any entry is judged. A credential whose type map reaches no type is not a credential with nothing to see, and a `200` carrying an empty page said the wrong one of those. The operator doors take it and refuse a working key `403 forbidden`. `compliance/key-management.test.ts › the operator key is refused the data plane, reading as well as writing`, `› refuses a bulk action to a key reaching no type, and narrows one for a key writing none`, `compliance/unreadable-items.test.ts › a key reaching no type is refused a single row, whatever the id names`, `compliance/platform-types.test.ts › lists no drift on an instance whose platform types match the build`, `› refuses the listing to a working key and to no credential`, `compliance/restore-archive.test.ts › requires the operator key`.
2. The operator key is what the suite provisions with, and its own mint is not held to the widening rule below: a key it mints naming no permissions, maps or claims (4) carries every content family at `*: write` and every permission, though the operator key's own row holds none of them. Every fixture file gets its working key that way. `compliance/key-management.test.ts › the operator key mints past its own reach, which is how a run is provisioned`.

## Minting

3. A working key's `POST /keys` with `label` and `source` and no permissions, maps or claims (4) answers `201` with the key holding the caller's whole set: `permissions`, `type_permissions`, `edge_permissions`, `extension_permissions`, `metadata_permissions` and `profile_permissions` equal to the creator's own. `compliance/key-management.test.ts › a mint naming no permissions, maps or claims takes the creator's whole set`, `› key creation response includes expected fields`.
4. WHEN a `POST /keys` body that mints a working key names any family, the server MUST give the key exactly what the body names in each named family and nothing in each family the body leaves out. The families are `permissions`, `type_permissions`, `edge_permissions`, `extension_permissions`, `metadata_permissions`, `profile_permissions` and `sources`, and a family named with an empty value is named.

   Reason: a key holds what it was asked for and nothing more. A key minted with only `permissions` holds no map entry and no claimed source, so it reads and writes no item and registers no type. A key minted with only a type map holds no permission. A body that names no family takes the creator's whole set (3).

   Tests: `compliance/key-management.test.ts › a mint naming only permissions holds those permissions and no reach`, `› a mint naming a map holds no permission it did not name`, `› a mint naming permissions and one map holds exactly those`, `compliance/type-permissions.test.ts › scoped key can create items of permitted type`, `› scoped key cannot create items of non-permitted type`, `compliance/type-scoped-access.test.ts › note-write key can create and read notes but not bookmarks`.

5. A working key's mint may not widen: a permission or a map entry the caller does not hold answers `403 forbidden` with `details.required_scope` naming it. `compliance/key-management.test.ts › refuses a mint reaching past what the caller holds`.
6. The plaintext `key` is returned on creation only; `GET /keys` never carries it. `compliance/key-management.test.ts › key secret is not included in list response`.
7. `source` is the key's own, and no other unrevoked key holds it as its own, though keys claiming it write under it too (34): a second key naming as its own a `source` that is already another unrevoked key's own answers `409 conflict` with `details.source`, and so do all but one of several mints racing for one `source`, the one answering `201`. It is stamped on every row the key writes unless the write names another source the key claims (34), and a body naming one the key does not claim is refused rather than stamped (`items/source-unclaimed`), so a key's writes carry no source it was not given. `compliance/field-enforcement.test.ts › source: a body naming a source the key does not claim is refused, naming it`, `compliance/key-management.test.ts › refuses a second key naming as its own a source already in use`, `› answers mints racing for one source with one 201 and 409 conflict for the rest`, `compliance/claimed-sources.test.ts › refuses a key whose own source another key claims, unless its caller could grant it`.
8. A key without `keys.mint` cannot list, mint, update or revoke keys: `403 forbidden` with `details.required_scope: "keys.mint"`. Holding it opens those doors and no more: which keys behind them a caller lists, updates or revokes is its reach (38). `compliance/key-management.test.ts › list keys requires keys.mint`, `› revoke key requires keys.mint`, `› minting requires keys.mint`, `compliance/keys-update.test.ts › refuses a caller without keys.mint`.
9. An invalid permission value in a mint body answers `400 validation_error`, with `details.errors[].path` naming the map entry. `compliance/type-scoped-access.test.ts › rejects invalid permission values in key creation`.

## Updating and revoking

10. `PATCH /keys/{id}` changes `label`, `default_tier`, the permission maps and the claimed `sources` (34) in place, and the change reads back on `GET /keys`; a family named empty holds nothing afterwards, so a key minted too wide is narrowed in place (`marfa keys update --no-permissions` names `permissions` and every map empty); `source` is immutable and its presence in the body answers `400 validation_error`. `compliance/keys-update.test.ts › updates the label and the maps in place, never the source`, `› takes every permission and map from a key named empty`, `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`, `› refuses a change of source`, `compliance/claimed-sources.test.ts › refuses a mint or an update claiming a source its caller does not hold`.
11. A key cannot widen itself past what it holds: `403 forbidden` with `details.required_scope` naming the reach it lacks, or `details.source` naming a claim it lacks (34). `compliance/keys-update.test.ts › refuses a key widening itself past what it holds`, `compliance/claimed-sources.test.ts › refuses a mint or an update claiming a source its caller does not hold`.
12. An unknown key id answers `404 api_key_not_found`, as a key beyond the caller's reach does (38); a malformed id answers `400 validation_error`. `compliance/keys-update.test.ts › answers 404 for an unknown key and 400 for a malformed id`.
13. `DELETE /keys/{id}` revokes at once: the next request bearing the key answers `401 unauthorized`. A bulk-action job the key queued writes nothing further, and a key narrowed by `PATCH /keys/{id}` (10) narrows the job with it (`items/job-credential-lost` and `items/job-type-lost`). An event stream the key holds open ends before it sends anything written after the revoke, and narrows with the key (`events.md` 20). `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`, `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`.
14. `last_used_at` is null or absent on a new key, is set to an ISO 8601 instant after the key's first use, and appears in the listing. `compliance/key-last-used.test.ts › new key has null or absent last_used_at`, `› last_used_at is set after first use`, `› last_used_at is a valid ISO 8601 timestamp`, `› last_used_at appears in list response`.

## Authentication

15. A request with no credential answers `401 unauthorized` on every published door but the registration door and the root; an unknown or revoked credential answers the same. `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `› are published, and answer a request with no credential`, `compliance/auth.test.ts › returns 401 when no auth header is provided`, `› returns 401 for an invalid API key`, `compliance/key-management.test.ts › revoke key: create, use, revoke, retry fails with 401`. A sign-in's access token naming no person answers the same, because an app is a credential only as an app and the person it signed in as; no fixture can mint such a token, so `packages/server/src/routes/signed-in-app-credential.test.ts › is refused as no credential at all` covers it.
16. The credential check runs before the body check and before the row lookup, so a bare request answers `401` whatever is wrong with its body or its query and whatever rows it names, and an unknown item id is indistinguishable from a live one. `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them` (the reason it sends an unparseable body and ids nothing carries). A door that asks the same of every caller asks it next, before anything about the request is read, so a credential that may not use the door answers `403` whatever is wrong with its path, its query or its body. What a door asks is one of: the operator key (1, 30); one permission (18, 19); `schema.write` or the metadata map for a type's replacement (18, `types/evolve-free`); `keys.mint` or the operator key (the key doors, 8); the metadata map a registration takes (18); a working key of the caller's own (connector registration); a key rather than a signed-in app's token (`GET /keys/current`, 35); write on `system.folder` (the three folder writes, `items/folder-grant`); write on some type, or the operator key (`POST /blobs`); read on some type, or the operator key (the three blob reads); and, on every other door of the data plane, `POST /items/bulk-actions` included, read on some type, which the operator key does not hold (1); a bulk action then narrows what it matches to what the key may write. Each refusal is `403 forbidden`, or `403 type_not_permitted` where the rule is about types. Of the 127 doors the instance serves, 75 ask such a rule; 2 more ask `grants.manage` without reading anything first; 25 ask nothing of a credential before the row the path names, and then admit by that row: the type and edge-type registries to every credential; the connector listing narrowed to the caller's own registration, or all registrations for the operator; a connector and its runs to its own key or the operator; the rest of a connector's doors to its own key, and some of them and a bulk-action job to the operator key too; and 25 take no credential. `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`.
17. `/health` and `/openapi.json` answer without a credential, and the document is the same one a credentialed read gets. `compliance/instance.test.ts › answers /health without a credential and names its components`, `› serves its OpenAPI document, with and without a credential`.

## Permission gates on other doors

18. Type and edge-type registration take the metadata map, `metadata.types:write` and `metadata.edge_types:write`, refused `403 forbidden` with `details.metadata_subresource`; type deletion takes `schema.write`, refused `403 forbidden` with `details.required_scope`; a type's replacement takes `schema.write`, or `metadata.types:write` for the changes `types/evolve-free` allows, and a key holding neither is refused the same way. `compliance/type-registry.test.ts › rejects type registration from a key without metadata.types:write`, `› refuses both schema.write doors to a key without it, and declares the refusal`, `compliance/type-evolution.test.ts › refuses the delete to a key without schema.write, force included`, `compliance/edge-types.test.ts › a key without metadata.edge_types:write cannot register an edge type`.
19. Outbound webhooks take `webhooks.manage` on every door; the audit log takes `audit.read`; the instance configuration takes `config.manage`; a purge, single or bulk, takes `items.purge`. Each refusal is `403 forbidden` with `details.required_scope`. `compliance/webhooks.test.ts › refuses a key without webhooks.manage`, `compliance/audit.test.ts › refuses a key without audit.read`, `compliance/schema-enforcement.test.ts › refuses both doors to a key without config.manage`, `compliance/type-permissions.test.ts › a key without items.purge cannot purge`, `compliance/bulk.test.ts › purge is refused to a key holding no permissions`.
20. **An item the key cannot read answers exactly as a missing one, on every door that names an item by id in its path or body.** A write to an item in the bin that the key may read is refused the same way and says so in `details.trashed` (`errors/bin-trashed`). A row whose type the key's map does not reach, live or trashed, answers what an id no row holds answers there: `404 item_not_found` with the same message and the same headers, so the answer says nothing of whether the row exists or what type it is. That holds on `GET`, `PATCH` and `DELETE /items/{id}`, its `edges` and `backrefs`, the three `metadata` doors, `versions`, both `tags` doors, `restore`, `transition` and `purge`, on every extension door (21), on the source of `POST /edges`, `POST /edges/bulk` and a `PATCH /edges/{id}` moving the source (`edges/end-source-hidden` and `edges/end-source-hidden-move`), as `edges/end-target-hidden` holds a target, and on `GET`, `PATCH` and `DELETE /edges/{id}` for an edge whose source is such a row, which answer `404 edge_not_found` as for no edge (`edges/read-id-source`). A create naming as its `id` the id of such a row is refused `409 conflict`, which says the id is taken and nothing of the row (`items/create-id-unreadable`), and a `POST /items/bulk` entry under `upsert` naming one meets the same `conflict`, whether the row is live or trashed. A create naming as its edge `id` the id of an edge the key may not read is refused `409 id_reused` naming only `existing_id` (`edges/id-reused-unreadable`). `compliance/unreadable-items.test.ts › POST /items/bulk naming the id of an item it cannot read answers alike whether the item is live or trashed, and not with its type`, `› POST /edges and POST /edges/bulk naming the id of an edge it cannot read learn the id is taken, and nothing of the edge`. **A write to a type the key may read and not write is still refused `403 type_not_permitted`**: the key already knows the row is there, so the refusal says nothing it did not know. A key whose map reaches no type at all is refused `403 type_not_permitted` whatever the id names (1). A `backref` filter term anchored on such a row, on `GET /items`, `GET /search` and `POST /items/bulk-actions`, matches as one anchored on an id no row holds (`edges/filter-backref-anchor`). A write replayed under its `Idempotency-Key` replays the same `404`, which is recorded rather than released like a `403`, since releasing it would tell the two apart. `compliance/unreadable-items.test.ts › replays a hidden row's 404 under its Idempotency-Key, as it replays a missing id's`. **A limit, accepted:** `GET /items/{id}?include=neighbors` counts in `neighbors_omitted` the neighbours the key may not read, which reveals how many there are, never their ids or types. A caller diagnosing a narrow key reads the key's own permissions at `GET /keys/current` (35), which names its `type_permissions`, rather than reading them off a refusal; a signed-in app's token, which that door refuses, reads the scope list on its token response. `compliance/unreadable-items.test.ts › an item the key cannot read answers as a missing one`, `› a filter term anchored on an item it cannot read matches as one anchored on no item`, `› a write to a type the key reads and does not write is still refused 403`, `compliance/type-permissions.test.ts › a key without reach on the item's type is answered as if the item, its edges and its backrefs were not there`, `› read-only scoped key cannot DELETE items of that type`, `compliance/key-management.test.ts › a key holding no permission reads itself, and no other key`.
21. Extension namespaces are gated twice. First by the type map, on the item's type, as the item doors gate it (20): an item whose type the key may not read answers every extension door, the listing included, `404 item_not_found` as a missing item does, and with read and not write the replace and delete doors answer `403 type_not_permitted` while the read doors admit the key, whatever the extension map grants; a refused write moves nothing. A `system.folder` is refused like any other type, and its extensions take the write fence the item doors put on every `system.*` row (22): a key holding write on `system.folder`, which writes the folder through `/folders`, is refused a replace or a delete of the folder's extensions `403 type_not_permitted` and may read them. Then by the extension map: a key holding the type and not the namespace is refused every namespace door `403 forbidden`, naming the namespace and the level it lacks in `details.grant` (`errors/grant-extension`). **What a key is answered of an item's extensions is the namespaces its extension map reads, and its own label's, on every door that answers them, whatever the door did:** the replace and delete doors answer the namespaces the key may read and leave the rest out, as the listing does, and so do the metadata an item read and `POST /items/bulk-get` carry, an export in both formats (`search-and-filters.md` 16, 18) and the event stream's frames (`events.md` 7). A namespace left out of an answer is left alone on the item. `compliance/extensions.test.ts › answers a key only the namespaces its extension map reads, on the replace and delete doors as on the reads`, `compliance/export.test.ts › carries on each row only the extension namespaces the key may read, on both output formats`, `compliance/events-contract.test.ts › carries on a metadata.changed frame only the extension namespaces the subscriber may read`, `compliance/extensions.test.ts › answers every door on an item whose type the key does not hold as a missing item, as the item doors answer it`, `› refuses a replace and a delete to a key that may read the item's type and not write it`, `› refuses a folder's extensions to a key holding write on system.folder, as the item doors refuse the folder`, `› refuses a key without reach on the namespace`.
22. Writes to a `system.*` type through the item doors are refused for every key the API can mint, whatever its type map grants. A folder's `system.folder` is written through `/folders`, which takes write on `system.folder` in the key's type map (`items/folder-grant`); a mint takes that entry as it takes any other. `compliance/system-types.test.ts › rejects system.* writes from every key the API can mint`, `› refuses a system.folder write on every item door, from a key the folder door admits`, `compliance/folders.test.ts › admits a key minted with write on system.folder alone, and refuses one whose map does not grant it`.

## The OAuth provider

23. Authorization server metadata is served at `/.well-known/oauth-authorization-server/auth` without a credential, with `issuer` at the server's `/auth` path, the token, authorization and registration endpoints under it, `code` among `response_types_supported` and `S256` among `code_challenge_methods_supported`. `compliance/oauth.test.ts › serves the authorization server metadata under the issuer path`.
24. `POST /auth/oauth2/register` registers a client with no credential and answers `201` with a `client_id`, the registered metadata echoed back, and a non-empty `scope`: the scope the request named, each literal once, which is what the client is registered for, or every scope the instance allows when the request names none. `compliance/oauth.test.ts › registers a native client dynamically and issues a client_id`, `› registers a client naming a scope at that scope, once each`.
25. A registration is a `web` client unless `application_type` says `native`. A web client's redirect URI must be https and on a host that is not the loopback, so `http://127.0.0.1` and `https://127.0.0.1` alike are refused `400 invalid_redirect_uri`; a native client may use `http` on the loopback. `compliance/oauth.test.ts › registers a web client, whose redirect URI must be https and off the loopback`, `› registers a native client dynamically and issues a client_id`.
26. An unparseable redirect URI answers `400` with an RFC 7591 error object rather than the envelope, which the document declares as the shape this one door answers. `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`.
27. The token endpoint refuses a request with no proof of the client with `400 invalid_request`, and an unsupported grant type with `400 unsupported_grant_type`. `compliance/oauth.test.ts › refuses a token request with no proof of the client`, `› refuses a grant type it does not support`.
28. WHEN a client polls `POST /auth/oauth2/token` with a device code nobody has approved or denied, as the code's first poll or at least the code's interval after its previous one, and before the code expires, the server SHALL answer `400 authorization_pending`.

    Reason: a device holds no credential until the exchange, so the answer to its poll is all it has to act on, and a device told nothing of the person's choice cannot tell waiting from failure. A poll sooner than the interval, an expired code and a denied code have their own answers, `slow_down`, `expired_token` and `access_denied`, which no statement here holds. The approval is a signed-in owner's, which the run's shared server does not have, so the fixture boots a server of its own and creates the owner there (31).

    Tests: `compliance/device-grant.test.ts › answers authorization_pending to a poll of a code nobody has decided`; `compliance/signed-in-apps.test.ts › is issued a code for a published scope it is not registered for, and its registration is as it was`.

## The owner

29. **A fresh instance has no owner, and nobody can sign in.** `GET /owner` answers `404 owner_not_found` to the operator key, and `POST /auth/sign-in/email` answers `401` for any address: sign-up is disabled on every instance, and no account exists until the door below creates one. `compliance/owner.test.ts › does not exist on a fresh instance, and nobody can sign in`.
30. **The owner is the operator key's to read and to create.** Both doors refuse no credential `401 unauthorized` and a working key `403 forbidden` whatever its body (16), and a refusal creates nothing. The operator key is the gate rather than the bootstrap secret because it outlives the secret and is the instance's recovery root. `compliance/owner.test.ts › is the operator key's to read and to create`, `› refuses a working key 403 whatever its body`.
31. **`POST /owner` creates the one account and refuses a second.** The body carries `email` and `password`, and may carry a `name`; the answer is `201` with `id`, `email` (stored lowercased), `name` (the address's local part when none was given, which is the case asserted) and `created_at`, and `GET /owner` answers the same record from then on; the creation is on the audit log as `owner.created` against the owner's id. The account is real: it signs in at `POST /auth/sign-in/email` with its password and is refused `401` with another. Once an owner exists the door answers `409 owner_exists` to any body the schema accepts, the same address included. `compliance/owner.test.ts › is created once, signs in with its password, and refuses a second`.
32. **The password is judged by the sign-in surface's own length rule**, which the door does not restate: under its minimum or over its maximum, `400 validation_error` with `details.errors[].path` naming `password` and the message naming the bound, and nothing is created. `compliance/owner.test.ts › refuses a password outside the sign-in surface's rule, naming the bound`.

## The limit on the key doors

33. **Every door under `/keys` shares one cap per credential, and the instance chooses the number.** On an instance with the limiter on, `RATE_LIMIT_KEYS_REQUESTS` sets the cap and 200 requests per window is the default; an answer from these doors carries `X-RateLimit-Limit` naming the cap in force, and the request past it answers `429 rate_limited` with `Retry-After` in seconds. The cap is the key doors' own, so a credential that has just been refused at `/keys` is answered at a door outside them. It is not the whole of what bounds a credential: a second window keyed on the credential alone, with no path split, counts the requests the first one refused, so a caller that keeps asking after the refusal is eventually refused everywhere — and a refusal from that second window is not the one `X-RateLimit-Limit` describes. A request carrying no credential is keyed on its address instead. Asserted against a server booted for it, because the run's own server has the limiter switched off. `compliance/key-rate-limit.test.ts › refuses past the limit the instance set, and the key doors share one window`, `› closes the key doors while a data-plane read on the same credential is answered`, `› falls back to 200 when the instance names no number`.

## Claimed sources

34. **A key may claim sources besides its own, and a write may name one it claims** (`items/source-claimed`). `sources` is a list of at most 1,000 non-empty strings of at most 200 characters, each trimmed as a key's own `source` is, which `POST /keys` and `PATCH /keys/{id}` take and the mint, the listing and the update answer. A claim named twice is held once, on the mint and the update alike, in the order it was first named. It is reach, held to the rules the permission maps keep (3, 4, 5, 11): a mint naming no family (4) takes the creator's claims with its maps, one naming `sources` holds only the claims it names and no map or permission it did not name, and one naming a map or `permissions` and not `sources` holds no claim. A working key may grant only its own `source` and what it claims itself; anything else is refused `403 forbidden` with `details.source` naming the first source it may not grant, on a mint and on an update alike, and the operator key may grant any. The same refusal meets a mint naming as the new key's own `source` one another key claims, unless the caller could grant it, because a key writes under its own source as it does under a claim. A source under the reserved prefix `oauth:` is granted to no key by any caller: `400 validation_error`, as it is for a key's own `source`. That prefix is read whatever its case, but a key's own source is compared with another key's claims exactly, as a source a write names is with its key's: a mint naming as its own a source that differs from another key's claim only in case is not refused, and the key it mints may not write under the claim. A key an app made is never widened to a source it does not already claim, by any caller. A claim is not unique, because two keys claiming one source is what lets two separately enrolled devices share a natural key (`items/natural-key-upsert`), while a key's own `source` stays unique (7). Narrowing a key's claims takes effect at its next write: a create or a natural-key upsert naming a source the key no longer claims is refused `403 forbidden` with `details.source`, and nothing is written. A `PATCH /items/{id}` of a row already under that source is not refused, because it names no source and the row's never moves (`items/source-fixed`), so the claim is not asked of it. `compliance/claimed-sources.test.ts › answers a key's claims on the mint, the listing and the update`, `› holds a claim named twice once, on the mint and on the update`, `› refuses a mint or an update claiming a source its caller does not hold`, `› refuses a key whose own source another key claims, unless its caller could grant it`, `› compares a key's own source with another key's claim case included`, `› refuses a reserved prefix, even to the operator key`, `› grants a source under any other prefix, connector: included`, `› refuses a claim that is empty or longer than a source may be, and trims one`, `› refuses a mint or an update claiming more than 1,000 sources`, `› a mint naming nothing takes the creator's claims`, `› never widens a key an app made to a new source`, `› stops a narrowed key writing under a source it no longer claims, and leaves its rows there editable`.

## The calling key

35. **Any key reads itself at `GET /keys/current`**, whatever it holds: its `id`, `source`, `permissions`, its maps, its claimed `sources` and its tier, never its plaintext. A key holding no permission reads itself there while `GET /keys` refuses it `403`, so a process handed a key can check it holds what it should and no more. A request with no credential answers `401`; a signed-in app's token is not a key and is refused `403 forbidden`. `compliance/key-management.test.ts › a key holding no permission reads itself, and no other key`, `compliance/declared-refusals.test.ts › cannot register a connector`.

## The shape of a key

36. **Every key answer carries the key's `permissions`, its claimed `sources` and each of its permission maps, empty where the key holds nothing**, so an empty list is never left for a reader to tell from a missing one. That holds on the mint, the listing, `GET /keys/current` and the update, and the published `KeyResponse` and `ApiKey` declare each of them required. The listing, `GET /keys/current` and the update also carry `expires_at`, null on every key a door mints, which `ApiKey` declares required; the mint declares no expiry. `compliance/key-management.test.ts › every key answer carries its permissions and its maps, empty where it holds nothing`.

## A key's own levers

37. **A key may carry its own enforcement levers, and each one it carries replaces the instance's for that key** (`types/strict-mode`, `types/source-allowlist` and `types/source-filter`). `enforcement_override`, which `POST /keys` and `PATCH /keys/{id}` take, holds any of the instance's three levers in the shape `/config` gives them: `strict_mode` with its `types`, and `source_allowlist` and `source_filter` each with `types` and `sources`. A lever the key carries is used in place of the instance's, so it loosens as well as tightens: a key whose `strict_mode` names no type writes an undeclared property on a type the instance holds strict, and one naming a type the instance leaves loose is refused `400 invalid_properties` there. A lever the key does not carry stays the instance's. The levers are not reach and no ceiling holds them: any caller that reaches the mint or the update, a working key holding `keys.mint` or a signed-in app alike, may set them looser than the instance's. A mint that names none gives the key none, whatever its creator carries. An update naming `enforcement_override` replaces the levers whole, and `null` clears them. A lever lacking `types` or `sources` is refused `400 missing_required_field` on the mint and on the update alike, with `details.field` naming it in full, such as `enforcement_override.source_filter.types`, and nothing is stored. The mint, the listing, the update and `GET /keys/current` answer a key's levers under `enforcement_override`, and leave the field out on a key carrying none, so a key reading itself sees the levers it writes under. `compliance/schema-enforcement.test.ts › replaces the instance's lever for the key, loosening as well as tightening`, `› leaves a lever it does not set to the instance`, `› reads back on the mint, the listing, the key itself and the update, is replaced whole and cleared by null`, `› names the field a lever lacks, on the mint and on the update`, `› is not taken from the creator by a mint naming none`, `› an app sets a key's levers looser than the instance's`.

## Which keys a credential reaches

38. **Through `GET /keys`, `PATCH /keys/{id}` and `DELETE /keys/{id}`, a credential lists, updates and revokes only the keys it could have minted.** A key is within a caller's reach when it is not an operator key and holds nothing the caller does not: each permission in its `permissions` is one the caller holds, its type, edge, metadata and profile maps reach nothing the caller's own maps do not, an exact `none` entry in the caller's map denying the row its wildcard would reach, its extension map names no namespace the caller lacks at that level, and its claimed `sources` are ones the caller may grant (34). That is the ceiling a mint is held to (5, 34), with the existing key in the place of the request, so a key the same as the caller is within its reach. A signed-in app is measured against its grant the two ways its mint and update can write a map: a family is within its reach when the grant's scopes cover it or when the maps the grant projects do, so the key an app mints naming no family (4), which copies those maps and their `none` entries, is within the app's reach. No scope names an extension namespace, so a key holding any extension reach is beyond every app. **The one exception** is revoking an app's access with `DELETE /auth/grants/{id}?revoke_keys=1`, which takes `grants.manage` and revokes every key that app minted whatever the caller's reach: a key an app mints is held to the app's grant, so taking those keys with the grant reaches no further than revoking the grant does. A key always reaches itself, so a key holding `keys.mint` can revoke itself; no other credential reaches an operator key, though an operator key holds nothing; and the operator key reaches every key. A key beyond the caller's reach answers `PATCH` and `DELETE /keys/{id}` exactly as an id no key holds (12), `404 api_key_not_found` with the same message, so the answer says nothing of whether the key exists, as an item the key cannot read answers as a missing one (20). `GET /keys` lists only the keys within reach, the caller among them. A revoked key's reach cannot be measured, so a second revoke answers as an unknown id to every caller but the operator key, which is told the key was already revoked. `compliance/key-reach.test.ts › cannot revoke a key beyond its reach, and is answered as for no key`, `› cannot change a key beyond its reach, and is answered as for no key`, `› lists only the keys within its reach, itself included`, `› revokes and changes keys within its reach, a peer included, and revokes itself`, `› does not reach a key holding a permission it lacks`, `› does not reach a key claiming a source it could not grant`, `› does not reach a key holding an extension namespace it lacks`, `› no working key reaches an operator key, and the operator key reaches every key`, `› a signed-in app reaches the key it mints naming no reach, and no wider key`. When a key is past its `expires_at`, `GET /keys` MUST omit it. When `PATCH /keys/{id}` or `DELETE /keys/{id}` addresses that key, the server MUST answer `404 api_key_not_found` without changing it, including when the caller is the operator key.

    No door stamps an expiry on a key, so an HTTP fixture cannot create this condition. Test: the server suite stamps an expiry in its database (`packages/server/src/routes/keys-expired.test.ts`). The storage suite also crosses expiry while an update reads its row, for both a changed and an empty patch (`packages/server/src/storage/sqlite/key-update-expiry.test.ts`).

## The sign-in surface

39. **A browser door under `/auth` refuses a form post from an origin the instance does not trust.** `POST /auth/sign-in`, `POST /auth/device`, `POST /auth/device/consent` and `POST /auth/authorize/decision` answer `403 forbidden` to a post whose `Origin`, or `Referer` when it carries no `Origin`, is neither the issuer's origin nor one of the instance's CORS origins, before the door reads its form; `Origin: null` is such an origin. A post naming no origin at all is not refused by this rule. `compliance/sign-in-surface.test.ts › refuses a form post from an origin it does not trust, on every browser door`.
40. **A sign-in sends the browser only to a path on the instance.** The `return_to` the sign-in page carries and the sign-in form redirects to is resolved against the issuer as a browser would resolve it, and anything that lands on another origin, or on a path a browser reads as another host (one starting `//`, which a tab or newline the browser strips, or a dot segment resolving collapses, can produce), is replaced by `/`. One that lands on the instance is kept as its path, query and fragment. `compliance/sign-in-surface.test.ts › sends a signed-in browser only to a path on the instance`.
41. **Password sign-in takes ten attempts at an account from one address in fifteen minutes, and a hundred from every address together in an hour.** The attempt past either is answered `429` with `Retry-After` before the password is judged, at `POST /auth/sign-in/email` and through the sign-in form, whose redirect then names `error=too_many_attempts` rather than a wrong password. An attempt one address makes past its own limit does not count toward the account's, so one guessing address cannot stop another signing in; ten addresses, or one IPv6 /56, can fill the account's window and hold every address out until it ends. The address is the one the instance resolves for every door, behind the proxy trust it was configured with, and an IPv6 address counts as its /64. `compliance/sign-in-surface.test.ts › holds one address to ten attempts at an account, and leaves the owner signing in from another`.
42. **A device code is looked up ten times from one address, and a hundred times from every address together, in fifteen minutes**, whatever codes they are, counted across every door that looks one up: the entry form (`POST /auth/device`), the consent screen (`GET /auth/device/consent`) and its decision (`POST /auth/device/consent`). The lookup past either is answered with a redirect naming `error=too_many_attempts` before the code is looked up, and one an address makes past its own limit does not count toward the instance's. `compliance/sign-in-surface.test.ts › limits device code lookups per address, on the entry form and the consent screen alike`.

## Signed-in apps

43. **A client's registration widens only for a signed-in person.** An authorization request naming a scope the instance publishes to every client and the client is not registered for adds that scope to the registration, so the client is not refused a scope it was never told it lacked, but only when a person is signed in. A request from nobody signed in is sent to `/auth/sign-in` with the request, every scope it named included, as `return_to`, and the registration is unchanged: a request naming no scope is still the registration's own (24). Under `prompt=none` nobody can be sent anywhere, so such a request is judged against the registration as it stands. Device initiation, which is made before anybody can sign in, is held to the same rule by 73 to 75. `compliance/signed-in-apps.test.ts › is registered at the scope it asked for, which an authorize from nobody signed in leaves as it was`, `› is caught up to a published scope once a person is signed in, and the grant carries it`.
44. **A signed-in app is limited by its grant, not by its token.** Every request an app makes for one person counts against one window, whichever access token it carries, so refreshing a token does not start a fresh window: the request after a refresh is answered with one fewer remaining (`X-RateLimit-Remaining`) than the one before it. `compliance/signed-in-apps.test.ts › is limited by its grant, so a refreshed token shares the window of the one before it`.
45. **Revoking a token this server does not hold answers `200`**, as RFC 7009 has it: a token never issued, already revoked or already gone is answered as one just revoked, whatever `token_type_hint` says. A revocation naming no token is refused `400 invalid_request`, and a client that fails to authenticate is refused as the plugin refuses it. `compliance/oauth.test.ts › answers 200 to revoking a token it does not hold, and 400 to a revocation naming no token`.

## Browser sign-out

46. WHEN a session lookup or deletion fails during `POST /auth/sign-out`, the server MUST return an error without clearing the session cookies.

    Reason: a success response must not claim that a session has ended when the database operation failed to establish that outcome.

    Tests: `packages/server/src/auth/sign-out-failure.test.ts › refuses sign-out without clearing cookies when native session deletion fails, then retries successfully`, `› refuses sign-out when native lookup cannot determine whether to delete the session, then retries successfully`.

## Credential audit units

47. WHEN an owner account, key, bootstrap credential, OAuth registration, grant, consent, token, code, session, password, or profile mutation commits, the server MUST commit its audit record in the same database unit.

    Reason: a missing audit must not leave undisclosed authority or a projection that disagrees with provider state. Browser consent, device approval, grant withdrawal, retirement, and session termination include their related provider rows and local projections in that unit.

    Tests: `packages/server/src/auth/credential-audit.test.ts`, `packages/server/src/auth/oauth-client-revoke.test.ts`, `packages/server/src/routes/device-consent-row.test.ts`, `packages/server/src/routes/key-audit-atomicity.test.ts`, `packages/server/src/routes/bootstrap-audit-outcome.test.ts`, `packages/server/src/storage/credential-retention-audit.test.ts`.

48. IF a credential unit rolls back, the server MUST preserve its prior database authority and publish no event for that unit.

    Reason: a refused consent or withdrawal must not leave only part of its provider and projected state changed. Concurrent consent and revocation use the same pair lock before the database writer.

    Tests: `packages/server/src/auth/oauth-client-revoke.test.ts`, `packages/server/src/routes/auth-grant-revoke.test.ts`, `packages/server/src/routes/consent-announcement-failure.test.ts`, `packages/server/src/routes/auth-consent-skip.test.ts`.

49. WHILE a credential commit outcome is unknown, the server MUST withhold its success response, raw credential, authorization-code redirect, and cookie changes.

    Reason: an unavailable commit acknowledgement is not proof of rollback. A retained audit can establish a committed result without replaying the mutation; an unavailable witness leaves the result unknown.

    Tests: `packages/server/src/auth/credential-outcome.test.ts`, `packages/server/src/auth/oauth-client-revoke.test.ts`, `packages/server/src/routes/bootstrap-audit-outcome.test.ts`.

50. IF the audit record of a browser session's end cannot be committed, THEN the server MUST leave the session in place and answer an error.

    Reason: a session that ended with nothing to account for it must not take effect, and one the person was told had ended must have. The request is answered `500`, a retry after the fault clears ends the session, and the session answers as signed in meanwhile.

    Tests: `packages/server/src/auth/credential-audit.test.ts › keeps a cached session usable if provider sign-out audit fails, then invalidates it on commit`.

51. WHEN the server records a failed sign-in, reused grant, narrowed scope request, or refresh replay, it MUST make that observation durable before returning the corresponding protocol outcome.

    Reason: a protocol refusal can be the intended result of a successfully recorded security observation. It does not imply rollback of that observation or an intentional replay withdrawal.

    Tests: `packages/server/src/auth/credential-audit.test.ts`, `packages/server/src/auth/oauth-authorize-observability.test.ts`, `packages/server/src/auth/oauth-authorize-scope-narrowing.test.ts`, `packages/server/src/auth/oauth-client-revoke.test.ts`.

## What the sign-in pages say

52. WHEN the browser consent page or the device approval page names an app that registered itself, the server SHALL show a caution that Marfa has not verified the app.

    Reason: registration needs no credential, so any program can pick any name, and the device flow is where a code from a stranger is likeliest to be typed in. A caution on one page and not the other leaves the second as the way round the first.

    Tests: `packages/server/src/routes/auth-consent.test.ts › flags a public/DCR client as unverified on the consent screen`; `packages/server/src/routes/device-grant.test.ts › warns on the approval screen that Marfa has not verified an app that registered itself`.

53. WHEN the browser consent page or the device approval page names an app that authenticates with a secret, the server SHALL NOT show the caution of statement 52.

    Reason: a caution shown beside every app says nothing about any of them.

    Tests: `packages/server/src/routes/auth-consent.test.ts › does NOT flag a confidential client as unverified`; `packages/server/src/routes/device-grant.test.ts › does not warn about an app that authenticates with a secret`.

54. WHEN a sign-in with the form fails, the server SHALL redirect the browser to the sign-in page carrying the typed email.

    Reason: a person who mistyped one character of a password should not retype the address with it.

    Tests: `compliance/sign-in-surface.test.ts › returns the typed email after a wrong password, and never the password`.

55. WHEN the sign-in page is opened carrying an email, it SHALL show that email in the email field.

    Reason: the redirect of statement 54 is of no use to a person unless the form they land on holds what they typed.

    Tests: `compliance/sign-in-surface.test.ts › returns the typed email after a wrong password, and never the password`; `packages/server/src/routes/sign-in-page.test.ts › returns the email after a wrong password, and only the email`.

56. The server SHALL NOT carry the typed password in the redirect of statement 54 or show it on the sign-in page.

    Reason: a password in an address is kept in history and in logs.

    Tests: `compliance/sign-in-surface.test.ts › returns the typed email after a wrong password, and never the password`.

57. WHEN an authorization the instance signed, and whose window is open, sends a person to sign in, the sign-in page SHALL name the app.

    Reason: a person signing in for an app should be able to see which app it is.

    Tests: `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`.

58. The sign-in page SHALL name no app for a request that is not an authorization the instance signed whose window is open, a link edited after it was signed included.

    Reason: the name is whatever the app registered under, so one taken from a request nobody signed would put a stranger's words on a page the real instance serves.

    Tests: `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`; `packages/server/src/routes/sign-in-page.test.ts › names nothing when the request was never signed`.

59. WHEN the sign-in page names an app that registered itself, it SHALL show the caution of statement 52.

    Reason: the name is as unvetted on the page before the sign-in as on the page after it.

    Tests: `compliance/sign-in-surface.test.ts › names the app an authorization sent the person for, and no app for a link edited after signing`.

60. WHEN a person who holds a session opens `GET /auth/sign-in` and no authorization sent them, the server SHALL answer a page that says they are signed in and holds no sign-in form.

    Reason: a form that reads as though nobody were signed in leaves a person unsure whether they are.

    Tests: `compliance/sign-in-surface.test.ts › tells a person who is signed in so, and shows the form to one an authorization sent to sign in again`; `packages/server/src/routes/sign-in-page.test.ts › tells somebody already signed in so, on the sign-in page`.

61. WHEN a person who holds a session opens `GET /auth/sign-in` and an authorization sent them, the server SHALL answer the sign-in form.

    Reason: the provider sends a signed-in person to sign in again when an app asks for a fresh sign-in, and only a new session satisfies it, so a page with no form there would send them round the same loop.

    Tests: `compliance/sign-in-surface.test.ts › tells a person who is signed in so, and shows the form to one an authorization sent to sign in again`; `packages/server/src/routes/sign-in-page.test.ts › still shows the form to a signed-in person an authorization sent to sign in afresh`.

62. WHEN an authorization link carries a signature the instance did not make, or was edited after it was signed, the server SHALL refuse it with the page that says it could not be verified.

    Reason: such a link is one nobody signed, and an honest person told so knows to start again at the app.

    Tests: `compliance/sign-in-surface.test.ts › tells a link edited after it was signed that it is invalid, not that it has expired`; `packages/server/src/routes/auth-consent.test.ts › tells a signed link edited after signing that it is invalid, whether or not its window has closed`.

63. The server SHALL say that an authorization request has expired only of one the instance signed whose window has closed.

    Reason: the expiry is a signed field, so a link whose expiry was edited into the past would otherwise be told it had merely timed out, and an honest person would look for a clock fault.

    Tests: `packages/server/src/routes/auth-consent.test.ts › tells a link whose exp was edited into the past that it is invalid, not that it expired`, `› REGRESSION: refuses to render a genuinely signed query past its exp`.

64. WHEN a request names `text/html` in `Accept` before any `application/json` and asks `GET /auth/oauth2/end-session` with no session and no `id_token_hint`, the server SHALL answer `200` with an HTML page that says the person is signed out.

    Reason: the page a person follows a logout link to showed raw JSON.

    Tests: `compliance/sign-in-surface.test.ts › shows a browser at end-session with no session a page, and a program the provider's JSON`; `packages/server/src/routes/end-session.test.ts › shows a browser with no session a page, and never JSON`.

65. WHEN a request that does not name `text/html` before `application/json` asks `GET /auth/oauth2/end-session` with no session, the server SHALL answer the provider's JSON refusal.

    Reason: a program calling the logout door needs its refusal in a form it can read, and must never be handed a page.

    Tests: `compliance/sign-in-surface.test.ts › shows a browser at end-session with no session a page, and a program the provider's JSON`; `packages/server/src/routes/end-session.test.ts › shows a browser with no session a page, and never JSON`.

## How access is described

66. The server SHALL name what a grant reaches in the same words on the browser consent page and on the device approval page.

    Reason: a person approving access reads it once and should recognize it wherever else they meet it. Two pages that name one grant two ways leave them guessing whether the second is the same grant.

    Tests: `packages/server/src/routes/consent-operation.test.ts › gives every grant the same words on both screens`, `› says the same thing about one grant on the device screen`.

67. The server SHALL state what a grant permits, reading only or reading and writing, in the same words on the browser consent page and on the device approval page.

    Reason: the same as statement 66, and a grant that reads as read only on one page and as something else on the other is the disagreement a person is least able to notice.

    Tests: `packages/server/src/routes/consent-operation.test.ts › gives every grant the same words on both screens`, `› says the same thing about one grant on the device screen`.

68. WHEN the browser consent page and the device approval page offer a grant that reaches types not yet registered, each SHALL state how far it reaches in the same line, naming the types it covers today where the pattern can be enumerated.

    Reason: a grant that grows as types are added is a larger grant than it reads, and the fact must not depend on which page a person approved it on.

    Tests: `packages/server/src/routes/consent-operation.test.ts › states how far a grant reaches in the same line on both screens`, `› names the types an enumerable wildcard covers in the same line on both screens`; `packages/server/src/routes/device-grant.test.ts › names the types a wildcard covers today on the approval screen, as the authorize screen does`; `packages/server/src/routes/auth-consent.test.ts › enumerates the registered custom types under a requested user.* wildcard`.

69. WHEN the browser consent page and the device approval page offer a grant that reaches one type, neither SHALL state a reach beyond it.

    Reason: a reach stated on a grant that has none tells somebody granting one type that the grant grows.

    Tests: `packages/server/src/routes/consent-operation.test.ts › states how far a grant reaches in the same line on both screens`.

## Keys an app made

70. The server SHALL include `oauth_client_id`, naming the `client_id` the app registered, in the answer of `POST /keys`, `GET /keys`, `GET /keys/current` and `PATCH /keys/{id}` for a key minted with a signed-in app's access token, and SHALL omit the field, rather than answer `null`, from those answers for every other key, a key that an app-made key minted included.

    Reason: a client that must not run on an app's key tells one by this field, and a server that stopped sending it would make every app's key pass as an ordinary one. A key an app made mints keys with its own credential, not with the app's access token, so a key it mints is not an app's. `GET /keys/current` answers the key bearing the request, so it carries the field when an app-made key reads itself; an app's access token is not a key and is refused there (35).

    Tests: `compliance/key-oauth-client.test.ts › names the client an app minted the key through, on every door that answers a key`, `› is absent from a key no app minted, on every door that answers a key`.

## Polling with a device code

71. WHEN a client polls `POST /auth/oauth2/token` with a device code a person has approved, as the code's first poll or at least the code's interval after its previous one, before the code expires, and while the grant the approval made still stands, the server SHALL answer `200` with an access token for the scopes the person approved.

    Reason: the token is what the device was waiting for, and one for a scope the person did not select would widen the grant past what they approved. A grant withdrawn after the approval is refused `invalid_grant` instead, which no fixture here reaches.

    Tests: `compliance/device-grant.test.ts › answers the first poll after the approval, an interval after the last, with an access token for the approved scopes`.

72. WHEN a client polls `POST /auth/oauth2/token` with a device code that an earlier poll exchanged for an access token, the server SHALL answer `400 invalid_grant`.

    Reason: a code that minted a second token would let anyone who has seen the code mint again. The refusal comes whatever the time since the previous poll.

    Tests: `compliance/device-grant.test.ts › answers invalid_grant to a poll of a code a token was already issued for`.

## Asking for a device code

73. WHEN a device asks `POST /auth/device/code` for a scope the instance publishes to every client and the client is not registered for, the server SHALL issue the code.

    Reason: a client registered before the instance published a scope can still be approved for it. A scope the instance does not publish to every client is refused `400 invalid_scope`.

    Tests: `compliance/signed-in-apps.test.ts › is issued a code for a published scope it is not registered for, and its registration is as it was`.

74. WHEN a device asks `POST /auth/device/code` for a scope the instance publishes to every client and the client is not registered for, the server SHALL NOT change the client's registration.

    Reason: nobody is signed in when a device asks, and a client's public id is all the request needs, so a change here would let a stranger widen what the client's later approval screens offer.

    Tests: `compliance/signed-in-apps.test.ts › is issued a code for a published scope it is not registered for, and its registration is as it was`.

75. WHEN a signed-in person approves a device code, the server SHALL add to the client's registration the scopes the person approved that it does not hold, and no others, before the device's exchange.

    Reason: the registration is what a request naming no scope asks for (24) and what a request nobody can send to sign in is judged against (43), so what a person approves on a device reaches the client's later requests as an approval in the browser does. A scope the person unticks, or a code they deny, adds nothing.

    Tests: `compliance/signed-in-apps.test.ts › is registered only for what the person approved, which a narrower approval leaves out`, `› is registered for the published scope once the person approves it, and the token carries it`.

## Browser sessions and apps

76. WHEN a person's browser session ends, the server SHALL keep valid every access token an app holds for that person.

    Reason: an app is not the browser that approved it, so signing out of a browser must not cut off the notes app or web page the person connected, and an app with no refresh grant has no way back in. A session ends by browser sign-out, by ending one, the other or every session, by a password change that ends the other sessions, by the provider's end-session once the person confirms it, or by a lookup of an expired session. Only an explicit disconnect or a withdrawal of the grant ends an app's access.

    Tests: `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› through ending the other sessions leaves every app connected`, `› through ending every session leaves every app connected`, `› through the provider's end-session, once confirmed, leaves every app connected`, `› through a password change that ends the other sessions leaves every app connected`.

77. WHEN a person's browser session ends, the server SHALL answer a refresh token grant of a refresh token an app holds for that person with `200` and tokens that are valid.

    Reason: a refresh token that outlives its browser is the app's way to keep access past an access token's expiry, and the one a refresh issues has to outlive the browser as well.

    Tests: `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› through ending the other sessions leaves every app connected`, `› through ending every session leaves every app connected`, `› through the provider's end-session, once confirmed, leaves every app connected`, `› through a password change that ends the other sessions leaves every app connected`.

78. WHEN a person's browser session ends, the server SHALL keep the person's consent to every app, so an authorization request the consent covers is answered with a code and no consent screen.

    Reason: consent is the person's decision about the app and not about the browser they made it in, so a person who signed out is not asked again.

    Tests: `compliance/browser-sessions.test.ts › through browser sign-out leaves every app connected`, `› through ending one session leaves every app connected`, `› through ending the other sessions leaves every app connected`, `› through ending every session leaves every app connected`, `› through the provider's end-session, once confirmed, leaves every app connected`, `› through a password change that ends the other sessions leaves every app connected`.

79. WHEN the server restarts, the server SHALL keep valid every access token and refresh token an app holds for a person.

    Reason: tokens an app holds live in the instance's storage, so a restart of the process, with the same secret and address, must not make an app approve itself again.

    Tests: `compliance/browser-sessions.test.ts › leaves every app connected across a restart of the server`.

80. WHEN a browser session has ended, the server SHALL refuse the exchange of an authorization code that session approved with `400 invalid_request`.

    Reason: a code is the browser's own step in an approval, and a browser that has ended cannot finish one. A code whose browser lives is exchanged, which the fixture shows first so the refusal cannot be a malformed request.

    Tests: `compliance/browser-sessions.test.ts › refuses an authorization code once the browser that approved it has ended, and accepts one whose browser lives`.

81. The server MUST advertise `backchannel_logout_supported` and `backchannel_logout_session_supported` as `false` in its authorization-server and OpenID configuration documents.

    Reason: an app's tokens end with neither a browser session nor a notification of one, so no app is told a person's browser ended, and a document that said otherwise would promise a sign-out that never arrives.

    Tests: `compliance/browser-sessions.test.ts › advertises no back-channel logout, since no app is notified of a browser ending`.

82. WHEN an app registers naming a `backchannel_logout_uri` or `backchannel_logout_session_required`, the server MUST register it without either and MUST NOT include either in the registration answer.

    Reason: a client reads the answer as what the server registered, so echoing an address the server will never use would promise a notification that 81 says is not sent. The registration itself is accepted, so a client library that sends its defaults still registers.

    Tests: `compliance/browser-sessions.test.ts › registers an app without a back-channel logout address and does not echo one`.
