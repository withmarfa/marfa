# Items

An item is a typed row: an `id`, a `type`, `properties` the type validates, a `source` and `source_id`, a lifecycle `state`, a `tier`, an `occurred_at` and a `version`. Its tags and extensions live in its `metadata`.

## Every write

### `items/refusal-writes-nothing`

If the server refuses a write to an item, then the server MUST leave every item, tag, edge and extension as it was and announce nothing.

**Tests:** `compliance/claimed-sources.test.ts › refuses a source the key does not claim, naming it`, `correctness/dedup.test.ts › refuses a create naming an id that is not the row its natural key resolves`, `correctness/item-versioning.test.ts › refuses a retype into a type nothing registered, and moves nothing`, `compliance/links.test.ts › refuses a link on an update, in either mode and at a stale version`.

## Creating an item

### `items/create`

When `POST /items` names a `type` and `properties` the type accepts, the server MUST answer `201` with the new `item` and its `metadata`.

**Tests:** `correctness/persistence.test.ts › item is retrievable by ID after creation`.

### `items/create-defaults`

When `POST /items` creates an item and names no `id`, `state` or `tags`, the server MUST answer an `item` with a UUIDv7 `id` the server minted, `version` 1, `state` `active` and an ISO 8601 `created_at`, and `metadata` with empty `tags`.

**Tests:** `correctness/persistence.test.ts › item is retrievable by ID after creation`, `correctness/lifecycle-transitions.test.ts › note starts in active state`.

### `items/create-client-id`

When `POST /items` names a lowercase UUIDv7 `id` that no item holds, the server MUST create the item under that `id`, on the row and on its `item.created` event.

**Reason:** a client that works offline names its rows before the server sees them.

**Tests:** `sync/identity.test.ts › keeps the id a client mints for an item, on the row and on the event`.

### `items/create-id-format`

If `POST /items` names an `id` that is not a lowercase UUIDv7, then the server MUST answer `400 invalid_id`.

**Tests:** `compliance/validation.test.ts › refuses a client-minted id that is not a lowercase UUIDv7`.

### `items/create-repeat`

When `POST /items` names an `id` that an item of the same type, which the key may read, holds and names no natural key that resolves an item, the server MUST answer `200` with the stored item as it stands and `acknowledged: true`.

**Reason:** a client that lost the answer to its create sends it again, and must get the row it made without overwriting an edit made since.

**Tests:** `sync/acknowledged.test.ts › answers an item repeat with the stored row and announces nothing`, `correctness/dedup.test.ts › applies a create naming the id and the natural key of one row as an upsert onto it`.

### `items/create-repeat-silent`

When the server answers a create with `acknowledged: true`, the server MUST NOT announce an event for it.

**Tests:** `sync/acknowledged.test.ts › answers an item repeat with the stored row and announces nothing`.

### `items/create-id-other-type`

If `POST /items` names an `id` that an item of another type holds, and the key may read that type, then the server MUST answer `409 id_reused` with `details.differs` naming `type`.

**Tests:** `sync/acknowledged.test.ts › refuses an item repeat whose body names a different type`.

### `items/create-id-unreadable`

If `POST /items` names an `id` that an item of a type the key may not read holds, then the server MUST answer `409 conflict` naming neither that item's type nor any of its properties.

**Reason:** the key learns the id is taken, which it must to choose another, and nothing else about a row it may not read.

**Tests:** `compliance/unreadable-items.test.ts › POST /items naming the id of an item it cannot read learns the id is taken, and not the type`.

### `items/create-id-and-natural-key`

When `POST /items` names both the `id` and the natural key of one item, the server MUST apply it as a natural-key upsert onto that item, as `items/natural-key-upsert` states.

**Reason:** the natural key decides before the id, so a connector that sends each row under its own id and its vendor's key updates the row on every sync.

**Tests:** `correctness/dedup.test.ts › applies a create naming the id and the natural key of one row as an upsert onto it`.

### `items/create-undeclared-key`

When `POST /items` carries a body key the operation does not declare, the server MUST drop that key and create the item without it.

**Tests:** `compliance/field-enforcement.test.ts › device: no such field ships, and a body naming one stores nothing`.

### `items/no-device-field`

The server MUST NOT answer a `device` field on an item.

**Reason:** a column whose meaning each writer decides alone, which a caller could filter on though only that caller wrote it, is worse than none.

**Tests:** `compliance/field-enforcement.test.ts › device: no such field ships, and a body naming one stores nothing`.

### `items/no-device-filter`

If a filter names `device` as a field, then the server MUST answer `400 validation_error` naming it.

**Tests:** `compliance/field-enforcement.test.ts › device: the filter grammar does not know the name`.

## The source and the natural key

An item's natural key is its `source` and `source_id` together.

### `items/source-own`

When `POST /items` or a `POST /items/bulk` entry names no `source`, or the credential's own, the server MUST stamp the item with the credential's source.

**Tests:** `compliance/claimed-sources.test.ts › writes under a source the key claims, and the row carries it`, `compliance/field-enforcement.test.ts › source: a body naming a source the key does not claim is refused, naming it`.

### `items/source-claimed`

When `POST /items` or a `POST /items/bulk` entry names a source the credential's key claims (`keys-and-oauth.md` 34), the server MUST stamp the item with that source.

**Tests:** `compliance/claimed-sources.test.ts › writes under a source the key claims, and the row carries it`.

### `items/source-unclaimed`

If `POST /items` or a `POST /items/bulk` entry names a source that is neither the credential's own nor one its key claims, then the server MUST refuse it `403 forbidden` with `details.source` naming that source.

**Tests:** `compliance/field-enforcement.test.ts › source: a body naming a source the key does not claim is refused, naming it`, `compliance/claimed-sources.test.ts › refuses a source the key does not claim, naming it`, `› refuses a bulk entry naming a source its key does not claim, and rolls an atomic page back`.

### `items/source-allow-list`

When the server asks a type's source allow-list (`types/source-allowlist`) of a write to an item, the server MUST ask it of the source the write resolves to, on `POST /items` and on each `POST /items/bulk` entry.

**Reason:** a source a key claims carries no write past the allow-list.

**Tests:** `compliance/schema-enforcement.test.ts › asks it of every bulk entry, under the source the entry resolves to`.

### `items/source-fixed`

When `PATCH /items/{id}` names a `source`, the server MUST answer `400 validation_error`.

**Reason:** a row's source never moves after its create.

**Tests:** `compliance/claimed-sources.test.ts › keeps a row's source where its create put it`.

### `items/natural-key-upsert`

When `POST /items`, or a `POST /items/bulk` entry under `mode: upsert`, names a `source_id` that, under the source it resolves to, a live item of the declared type holds, the server MUST apply it as an update to that item, answered `200` at the item's next version, whichever credential sends it.

**Reason:** two keys that claim one source share its natural keys, so a connector's row is one row whichever of its keys writes it.

**Tests:** `correctness/dedup.test.ts › duplicate (source, source_id) upserts onto the existing item (natural-key upsert)`, `compliance/claimed-sources.test.ts › upserts onto one row from two keys claiming one source`, `› lands a bulk entry naming a claim on the claim's row, not on its own source's`.

### `items/natural-key-merge`

When a create is applied as a natural-key upsert, the server MUST lay its `properties` over the item's.

**Tests:** `correctness/dedup.test.ts › merges a natural-key upsert's properties over the row's, and keeps its tags unless it names them`.

### `items/natural-key-tags`

When a create applied as a natural-key upsert names no `tags`, the server MUST leave the item's tags as they stand.

**Tests:** `correctness/dedup.test.ts › merges a natural-key upsert's properties over the row's, and keeps its tags unless it names them`.

### `items/natural-key-concurrent`

When two `POST /items` naming one natural key that no item holds arrive together, the server MUST create one item and apply every other as the natural-key upsert onto it.

**Tests:** `correctness/dedup.test.ts › lands concurrent creates of one natural key on one row`.

### `items/natural-key-other-type`

If the natural key of `POST /items` resolves an item of a type other than the one the create declares, then the server MUST answer `409 type_mismatch`.

**Tests:** `correctness/dedup.test.ts › refuses an upsert whose natural key lands on a row of another type`.

### `items/natural-key-new`

When a create names a `source_id` no item holds under its source, or names neither a `source_id` nor an `id` an item holds, the server MUST create a new item.

**Tests:** `correctness/dedup.test.ts › same source but different source_id is not a duplicate`, `› items without source/source_id are never duplicates`.

### `items/natural-key-id-mismatch`

If `POST /items` names a natural key that resolves an item and an `id` that is not that item's, then the server MUST answer `400 validation_error` with `details.field` `id`, `details.requested_id`, `details.existing_id`, `details.source` and `details.source_id`.

**Reason:** the natural key and the id each name a row, and writing onto either would ignore the other.

**Tests:** `correctness/dedup.test.ts › refuses a create naming an id that is not the row its natural key resolves`.

### `items/natural-key-unreadable`

If the natural key of `POST /items`, or of a `POST /items/bulk` entry under `mode: upsert`, resolves an item of a type the key may not read, then the server MUST refuse it `type_not_permitted` naming nothing of that item, before any other answer about it.

**Reason:** a key that shares a source with another can reach a row of a type it holds nothing on, and learns only that its natural key is taken.

**Tests:** `compliance/claimed-sources.test.ts › tells a key its natural key is taken, and nothing of a row it may not read`, `› refuses a create naming another id than the row its natural key resolves, to a key that may not read the row, without naming it`.

### `items/natural-key-trashed`

When the natural key or the `id` of `POST /items` resolves an item in the bin, of the type the create declares, that the key may read, the server MUST answer `200` with that item, still in the bin, and `acknowledged: true`.

**Reason:** a connector re-syncing a row the person trashed must neither bring it back nor fail.

**Tests:** `compliance/cascade-marks.test.ts › marks a row a cascade trashed on the acknowledgement of a create naming its source and source id, and names the row trashed only to a key that may read its type`, `› marks a row a cascade trashed on the answer to a create repeated under its id, and names the row trashed only to a key that may read its type`.

## Own time, tier and initial state

### `items/occurred-at-utc`

When a write to an item names an `occurred_at`, on any operation that writes one, the server MUST store and answer it in UTC at millisecond precision, as `YYYY-MM-DDTHH:mm:ss.sssZ`.

**Tests:** `compliance/canonical-time.test.ts › stores own time in UTC and orders and bounds it by instant`, `› normalizes bulk upserts, queued time updates and restored own time`.

### `items/occurred-at-stale-compare`

When the server compares an `occurred_at` in a write at a stale version with the stored one, the server MUST compare the two as instants.

**Tests:** `compliance/canonical-time.test.ts › normalizes a patch before comparing stale changes`.

### `items/occurred-at-zoneless`

When a write names an `occurred_at` date-time with no zone, the server MUST read it as UTC.

**Tests:** `compliance/occurred-at.test.ts › reads a zone-less occurred_at as UTC`.

### `items/occurred-at-invalid`

If a write names an `occurred_at` that is not a timestamp, then the server MUST refuse it `validation_error` with `details.field` `occurred_at`.

**Tests:** `compliance/occurred-at.test.ts › refuses an occurred_at that is not a timestamp, naming the field`, `› names the field when a bulk page or a bulk action sends an occurred_at that is not a timestamp`.

### `items/occurred-at-range`

If a write names an `occurred_at` whose UTC year is outside 0000 to 9999, then the server MUST answer `400 validation_error`.

**Reason:** every stored instant then has the same width, so instants sort as text.

**Tests:** `compliance/canonical-time.test.ts › refuses a timestamp outside the four-digit UTC range`.

### `items/occurred-at-default`

When a create names no `occurred_at`, the server MUST set it to the item's `created_at`.

**Tests:** `compliance/occurred-at.test.ts › create without occurred_at defaults to created_at`, `› create with occurred_at preserves the value`, `› occurred_at persists on fetch`, `compliance/field-enforcement.test.ts › occurred_at: a specific ISO date is preserved`, `› occurred_at: a far-future ISO date is preserved`, `› occurred_at: a far-past ISO date is preserved`.

### `items/capture-coordinates`

When a write names `capture_latitude` or `capture_longitude`, the server MUST store the number as sent, whatever its range.

**Tests:** `compliance/field-enforcement.test.ts › capture coordinates are preserved verbatim, including out-of-range values`.

### `items/tier-new`

When a write creates an item, the server MUST give it the `tier` the write names, else the credential's `default_tier`, else `library`.

**Tests:** `compliance/tier-axis.test.ts › default-when-omitted is library`, `› credential default_tier stamps tier when client omits`, `› client per-item tier overrides credential default_tier`, `› uses the credential default and explicit tier on new bulk rows ($mode, $defaultTier)`.

### `items/tier-upsert`

When a natural-key upsert names no `tier`, on `POST /items` or `POST /items/bulk`, the server MUST leave the item's tier as it stands.

**Reason:** a row a person moved to the feed stays there through the connector's next sync.

**Tests:** `compliance/tier-axis.test.ts › keeps a row's tier through a natural-key re-sync on both doors`.

### `items/initial-state`

When a create names a `state` the type's lifecycle can reach from `active`, the server MUST create the item in that state.

**Tests:** `correctness/lifecycle-transitions.test.ts › refuses an initial state the type's lifecycle cannot reach, and stores one it can`.

### `items/initial-state-refused`

If a create names a `state` the type's lifecycle cannot reach from `active`, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/lifecycle-transitions.test.ts › refuses an initial state the type's lifecycle cannot reach, and stores one it can`, `compliance/bulk.test.ts › leaves a state alone on an entry that resolves a row rather than creating one`.

### `items/initial-state-bulk-update`

When a `POST /items/bulk` entry resolves an existing item, the server MUST ignore the entry's `state`.

**Reason:** the update the entry describes does not read `state`, so refusing it would roll a page back over a field the write ignores.

**Tests:** `compliance/bulk.test.ts › leaves a state alone on an entry that resolves a row rather than creating one`.

## Property values

### `items/property-verbatim`

When a write stores a string property, the server MUST answer it back unchanged, emoji, ZWJ sequences, right-to-left text, zero-width characters and HTML included.

**Tests:** `compliance/adversarial.test.ts › stores emoji and ZWJ sequences unchanged`, `› stores mixed RTL and LTR text unchanged`, `› stores zero-width characters unchanged`, `› stores HTML and script text as plain data, unchanged`.

### `items/property-empty-string`

When a write names an empty string for a property, the server MUST store it as that property's value.

**Tests:** `compliance/validation.test.ts › accepts item with minimal valid properties`.

### `items/property-nul`

If a write names a string property containing U+0000, then the server MUST answer `400 invalid_properties` naming the field.

**Tests:** `compliance/validation.test.ts › refuses a NUL in a string property, naming the field`.

### `items/property-length-cap`

If a write names a string property longer than the field's `maxLength`, or than 100,000 where the field declares none, then the server MUST answer `400 invalid_properties` naming the field.

**Tests:** `compliance/validation.test.ts › stores a body at the field's length cap intact`, `compliance/validation.test.ts › refuses a string one unit over the default length cap, naming the field`, `compliance/adversarial.test.ts › refuses a body over the field's length cap with invalid_properties`.

### `items/property-length-units`

When the server measures a string property against a length cap, the server MUST count UTF-16 code units.

**Reason:** the server and a working copy give the same verdict for a character outside the Basic Multilingual Plane, which takes two units (`device/declared-checked`).

**Tests:** `device/property-validation-live.test.ts › matches a real server's field decisions and keeps queued writes across a catalog change`.

### `items/property-invalid`

If a write leaves out a property its type requires, or names one the type declares with a value of another shape, then the server MUST answer `400 invalid_properties` with `details.errors[].field` naming it.

**Tests:** `compliance/validation.test.ts › rejects core.note with no properties with invalid_properties naming body`, `compliance/core-message.test.ts › rejects a message missing body with invalid_properties naming it`, `compliance/entity-subtypes.test.ts › rejects entity without required name with invalid_properties naming it`, `compliance/highlight.test.ts › rejects a highlight missing the required text property`, `compliance/thumbnails.test.ts › refuses a thumbnail over the cap or not an image, naming the field`.

### `items/property-name-empty`

If a write names a property with no characters, other than an archive restore, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/odd-input.test.ts › refuses a property named with no characters`, `› refuses a tag or property name the item doors refuse`, `› accepts valid tags and property names and refuses invalid ones on each write`.

### `items/create-null-optional`

When a create that makes an item carries a null for a field its type declares and does not require, or for `attachments` or `links`, the server MUST make the item without that field.

**Reason:** a null on an optional field means the field is unset. A null on a property the type does not declare is held as the value it is.

**Tests:** `compliance/validation.test.ts › leaves out a create's null on a declared optional field, and keeps one on an undeclared property`.

### `items/property-order-create`

When a create makes an item, the server MUST answer its properties with the fields the type declares first, in the order a read of the type lists them, then every other property in the order the write sent it, on the write's answer, a read by id and a listing.

**Tests:** `compliance/validation.test.ts › orders properties by the type's fields, then by the order they were sent`, `› puts no property ahead of the type's own that a read of the type does not list`.

### `items/property-order-merge`

When a merge writes an item's properties, through `PATCH /items/{id}`, a natural-key upsert or a `replace` at a stale version, the server MUST keep the properties the item holds in their places and put each one it adds after them, in the order sent.

**Tests:** `compliance/validation.test.ts › keeps the order a merge finds and adds after it, and takes the order a whole edit sends`, `› keeps the order a whole edit behind the row finds, as a merge does`.

### `items/property-order-replace`

When `PATCH /items/{id}` under `properties_mode: replace` names the version the item holds, the server MUST answer the properties in the order the write sent them.

**Tests:** `compliance/validation.test.ts › keeps the order a merge finds and adds after it, and takes the order a whole edit sends`.

### `items/property-order-index`

The server MUST answer a property whose name is the canonical decimal of an integer from 0 to 4294967294 before every other property, in numeric order.

**Reason:** a JavaScript object orders such names so, whatever the server stores.

**Tests:** `compliance/validation.test.ts › puts a property named by an array index first, in numeric order`.

### `items/thumbnail-format`

If a write names a `thumbnail` that is not `data:image/png;base64,`, `data:image/jpeg;base64,` or `data:image/webp;base64,` followed by canonical base64 of at most 16 KiB decoded whose leading bytes carry that format's signature, then the server MUST refuse it `invalid_properties` naming the field.

**Tests:** `compliance/thumbnails.test.ts › refuses a thumbnail over the cap or not an image, naming the field`, `› refuses a thumbnail that is not an image on an update and inside a bulk page`.

### `items/thumbnail-inline`

The server MUST answer an item's `thumbnail` as a property on every operation and event that answers the item.

**Reason:** a device holds the thumbnail with the item and never fetches it (`device/thumbnail-from-row`).

**Tests:** `compliance/thumbnails.test.ts › travels inside its item on a get, a list, an event frame and an export`.

### `items/thumbnail-not-searched`

The server MUST NOT match an item's `thumbnail` in full-text search.

**Tests:** `compliance/thumbnails.test.ts › is not found by a search that finds the same token in a body`, `› is not found after an update writes it, where the same token in a body is`.

## Tags on a create

### `items/tags-empty`

When a create names an empty `tags` list, the server MUST store the item with `tags` `[]`.

**Tests:** `correctness/tags.test.ts › accepts empty tags array`, `compliance/validation.test.ts › accepts item with empty tags array`.

### `items/tags-count`

If a write names more than 100 tags, or would leave an item more than 100 tags and more than it held, on a create or any tag operation, then the server MUST refuse it `validation_error`.

**Tests:** `compliance/item-limits.test.ts › refuses a create carrying more than 100 tags, and takes one of 100`, `› refuses a tag write that would leave an item more than 100 tags, on each tag operation`, `compliance/bulk-limits.test.ts › refuses an update_tags action adding more than 100 tags`.

### `items/tag-text`

If a write other than an archive restore carries a tag that is empty, holds only whitespace or exceeds 128 UTF-16 code units, then the server MUST answer `400 validation_error`.

**Reason:** every tag the server holds stays nameable in the path that removes it.

**Tests:** `compliance/odd-input.test.ts › refuses an empty, blank or over-long tag, and takes one of 128 characters`, `› refuses a tag or property name the item doors refuse`, `› accepts valid tags and property names and refuses invalid ones on each write`.

## Refusals on create

### `items/create-no-type`

If `POST /items` names no `type`, then the server MUST answer `400 missing_required_field` with `details.field` `type`.

**Tests:** `compliance/error-codes.test.ts › rejects item without type`, `compliance/adversarial.test.ts › valid JSON with no type returns 400 missing_required_field`.

### `items/create-malformed-type`

If a write names a type identifier that the grammar refuses, then the server MUST answer `400 validation_error` with `details.errors[].path` naming the field.

**Tests:** `compliance/error-codes.test.ts › rejects item with malformed type identifier`.

### `items/create-unknown-type`

If a write names a well-formed type identifier that nothing registered, and the key may write it, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/type-registry.test.ts › rejects item with an unregistered type`.

### `items/create-type-not-permitted`

If a key writes an item of a type its type map does not grant write on, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/error-codes.test.ts › rejects creation of out-of-scope type`.

### `items/system-types`

If any key the API can mint writes a `system.*` type through an item operation, then the server MUST answer `403 type_not_permitted`, whatever the key's type map grants.

**Reason:** a `system.*` row is written only through its own operation, such as `items/folder-create`.

**Tests:** `compliance/system-types.test.ts › rejects system.* writes from every key the API can mint`, `› refuses a system.folder write on every item door, from a key the folder door admits`.

## Reading

### `items/get`

When a key sends `GET /items/{id}` for an item it may read that is not in the bin, the server MUST answer `200` with the `item` and its `metadata`, every field as the write that made it stored it.

**Tests:** `correctness/persistence.test.ts › item is retrievable by ID after creation`, `› all fields are preserved after round-trip`.

### `items/get-matches-list`

The server MUST answer an item's `type`, `state`, `properties` and `created_at` the same by id as in a listing.

**Tests:** `correctness/persistence.test.ts › item data is consistent across getItem and listItems`.

### `items/found-after-create`

When an item is created, the server MUST find it in a listing and in full-text search from the create's answer on.

**Tests:** `correctness/persistence.test.ts › item appears in listItems after creation`, `› item appears in search results after creation`.

### `items/get-malformed-id`

If an operation on an item or a folder names an id that is not a lowercase UUIDv7, then the server MUST answer `400 invalid_id`.

**Tests:** `compliance/error-codes.test.ts › rejects request with malformed ID`, `compliance/extensions.test.ts › answers 404 for an unknown item and 400 for a malformed id on every door`, `compliance/folders.test.ts › refuses a change naming no version or no setting, and one to an id that is not a folder`.

### `items/get-missing`

If `GET /items/{id}` names an id no item holds, an item in the bin or an item of a type the key may not read, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/error-codes.test.ts › returns 404 for non-existent item`, `correctness/trash.test.ts › deleted item returns 404 on direct get`, `compliance/state-default.test.ts › a read by id answers an archived row and refuses one in the bin`.

### `items/bulk-get`

When a key sends `POST /items/bulk-get` with `ids`, the server MUST answer `200` with each item it may read that is not in the bin, once each, in the order the request named them.

**Tests:** `compliance/bulk-get.test.ts › returns the requested items by id`, `› omits ids that do not resolve rather than erroring`, `compliance/links.test.ts › looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`.

### `items/bulk-get-omits`

When `POST /items/bulk-get` names an id that no item holds, or that holds an item the key may not read, the server MUST leave it out of the answer rather than refuse the request.

**Tests:** `compliance/bulk-get.test.ts › omits an id whose type the key cannot read, and an id naming nothing`.

### `items/bulk-get-no-type`

If a key whose type map reaches no type sends `POST /items/bulk-get`, then the server MUST answer `403 type_not_permitted`.

**Reason:** an empty answer would say the ids named nothing, rather than that the key may see nothing.

**Tests:** `compliance/key-management.test.ts › management permissions do not grant content access`.

### `items/bulk-get-cap`

If `POST /items/bulk-get` names more than 100 ids, then the server MUST answer `400 validation_error` with `details.cap` 100.

**Tests:** `compliance/bulk-get.test.ts › rejects a request with more than 100 ids`.

### `items/bulk-get-not-list`

If `POST /items/bulk-get` names `ids` that is not a list, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/bulk-get.test.ts › refuses a body whose ids is not a list`.

### `items/bulk-get-metadata`

When `POST /items/bulk-get` names `metadata` in `include`, the server MUST answer a `metadata` list holding each answered item's metadata.

**Tests:** `compliance/bulk-get.test.ts › hydrates metadata when include carries metadata`.

## Updating an item

What a write at a stale version does is `versions.md`'s.

### `items/update-merge`

When `PATCH /items/{id}` names `properties` and no `properties_mode`, or `properties_mode: merge`, the server MUST lay them over the item's properties.

**Tests:** `compliance/validation.test.ts › clears nothing with a null under a merge, declared or not`, `correctness/item-versioning.test.ts › merges a stale write on an item field nobody else changed`.

### `items/update-replace`

When `PATCH /items/{id}` names `properties_mode: replace`, the server MUST take its `properties` as the item's whole properties, clearing each property it leaves out.

**Tests:** `correctness/item-versioning.test.ts › takes a replace at the current version as the item's whole properties, and refuses one that drops a required field`.

### `items/update-replace-required`

If `PATCH /items/{id}` under `properties_mode: replace` leaves out a property the type requires, then the server MUST answer `400 invalid_properties`.

**Tests:** `correctness/item-versioning.test.ts › takes a replace at the current version as the item's whole properties, and refuses one that drops a required field`.

### `items/update-null-merge`

When a merge names a null for a property the item's type declares optional, or does not declare, the server MUST leave that property as it stands.

**Reason:** a null under a merge means unset, and `properties_mode: replace` is how a property is cleared.

**Tests:** `compliance/validation.test.ts › clears nothing with a null under a merge, declared or not`, `correctness/item-versioning.test.ts › reads a null on a move by the type entered`.

### `items/update-null-required`

If a merge names a null for a property the item's type requires, then the server MUST answer `400 invalid_properties` naming it.

**Tests:** `compliance/validation.test.ts › refuses a null on a field the type requires under a merge`.

### `items/update-null-replace`

When `PATCH /items/{id}` under `properties_mode: replace` names a null for a property, the server MUST treat that property as left out.

**Tests:** `correctness/item-versioning.test.ts › reads a null on a move by the type entered`.

### `items/update-tier`

When `PATCH /items/{id}` names a `tier`, the server MUST move the item to that tier.

**Tests:** `correctness/item-versioning.test.ts › moves a row's tier on an update`.

### `items/update-source-id`

When `PATCH /items/{id}` names a `source_id` on an item under the credential's own source or one its key claims, the server MUST give the item that `source_id`.

**Tests:** `correctness/items-source-id-mutation.test.ts › mutates source_id, returns 200, and round-trips on subsequent GET`.

### `items/update-source-id-forbidden`

If a write gives a new `source_id` to an item under a source that is neither the credential's own nor one its key claims, then the server MUST answer `403 forbidden` with `details.source` naming the item's source.

**Reason:** a natural key belongs to its source, and moving it takes the row from the key that syncs it.

**Tests:** `compliance/claimed-sources.test.ts › refuses a key moving a natural key under a source it does not write under`.

### `items/update-source-id-taken`

If a write gives an item a `source_id` that another item holds under the same source, in any state, the bin included, then the server MUST answer `409 source_id_conflict`.

**Tests:** `correctness/items-source-id-mutation.test.ts › refuses a move onto a natural key another row already holds`, `› refuses a move onto the natural key of a row in the bin`.

### `items/update-type-mismatch`

If `PATCH /items/{id}` names a `type` other than the item's without `retype: true`, then the server MUST answer `409 type_mismatch`.

**Tests:** `correctness/dedup.test.ts › refuses an update declaring a type the item is not`.

### `items/update-undeclared-key`

If `PATCH /items/{id}` carries a body key the operation does not declare, then the server MUST answer `400 validation_error`.

**Reason:** a dropped key is a request half performed and answered `200`. Keys inside `properties` are the type's, not the operation's.

**Tests:** `correctness/item-versioning.test.ts › refuses a body key the update door does not declare`, `compliance/field-enforcement.test.ts › device: no such field ships, and a body naming one stores nothing`.

### `items/update-inline-edges`

When `PATCH /items/{id}` names `edges`, the server MUST replace the item's outbound edges of each edge type named with edges to the targets listed, and leave every other edge type as it stands.

**Tests:** `correctness/edges/edges-crud.test.ts › PATCH /items with edges replaces edges of specified types only`.

## Moving an item to another type

### `items/retype`

When a write names `retype: true` and a `type`, the server MUST move the item to that type, with or without `properties`.

**Tests:** `correctness/item-versioning.test.ts › moves the type with retype alone, holding the row to the type entered`, `› reads a null on a move by the type entered`.

### `items/retype-validated`

If the properties an item would hold after a move fall short of the type it enters, then the server MUST answer `400 invalid_properties`.

**Tests:** `correctness/item-versioning.test.ts › moves the type with retype alone, holding the row to the type entered`.

### `items/retype-unknown`

If a move names a type nothing registered, on `PATCH /items/{id}` or a `POST /items/bulk` entry, then the server MUST refuse it `unknown_type` with `details.type`.

**Tests:** `correctness/item-versioning.test.ts › refuses a retype into a type nothing registered, and moves nothing`, `compliance/bulk-limits.test.ts › answers unknown_type for a bulk entry retyped into a type nothing registered, and moves nothing`.

### `items/retype-destination-write`

If a move names a type the key may not write, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/type-permissions.test.ts › refuses a retype into a type the key may not write`.

### `items/retype-same-type`

When a move names the type the item already has at the version it holds, the server MUST answer the item as it is, at its version, with no snapshot written.

**Tests:** `correctness/item-versioning.test.ts › moves nothing when retype names the type the row already has`.

### `items/retype-same-type-stale`

If a move naming the type the item already has names a version the item no longer holds, then the server MUST answer `409 version_conflict`.

**Tests:** `correctness/item-versioning.test.ts › refuses a retype naming the row's own type at a stale version, as any stale write that changes nothing`.

### `items/retype-null`

When a merge moves an item, the server MUST read each null by the type the item enters.

**Tests:** `correctness/item-versioning.test.ts › reads a null on a move by the type entered`.

### `items/retype-search`

When a write moves an item, the server MUST index it for search under the type it enters.

**Tests:** `correctness/item-versioning.test.ts › indexes a row under the type it entered on a stale move`.

## Writes that race

### `items/write-race`

When two writes to one item race, the server MUST judge each against the item and its type as they stand when that write lands, so a write raced against a move, a type change or a trash is refused as one sent after it.

**Reason:** a check made before the write lands is made of a row another write may change first.

**Tests:** waiting on #1444.

## Idempotency keys

### `items/idempotency-operations`

The server MUST honor an `Idempotency-Key` on `POST /items`, `PATCH /items/{id}`, `DELETE /items/{id}`, `POST /items/{id}/purge`, `POST /items/{id}/transition`, `POST /items/{id}/restore`, `POST /edges`, `PATCH /edges/{id}`, `DELETE /edges/{id}`, `POST /folders`, `PATCH /folders/{id}`, `POST /folders/{id}/revoke` and `POST /items/bulk-actions`, and on no other operation.

**Tests:** `sync/idempotency-replay.test.ts › guards the replay on every idempotent write operation`, `› takes no Idempotency-Key on the operations that do not list it, and runs each repeat`, `compliance/edge-move.test.ts › answers a move repeated under one Idempotency-Key from its record`.

### `items/idempotency-replay`

When a credential repeats, under one `Idempotency-Key`, the request whose answer the server kept, the server MUST answer with the first answer's status and body and the header `Idempotency-Replayed: true`, which the first answer lacks.

**Tests:** `sync/idempotency.test.ts › answers a repeated create with the first result rather than a second row`, `› announces a replayed edge create`, `› announces a replayed delete, which would otherwise be a 404`, `compliance/bulk.test.ts › Idempotency-Key returns the same job id on replay`, `compliance/folders.test.ts › answers a folder create repeated under one Idempotency-Key once`.

### `items/idempotency-once`

When the server replays an answer, the server MUST NOT perform or announce the write again.

**Tests:** `sync/idempotency.test.ts › makes a repeated update one version step, not two`, `› answers a repeated create with the first result rather than a second row`.

### `items/idempotency-reused`

If a credential sends an `Idempotency-Key` it used with another request, differing in method, path, query as written or body text, then the server MUST answer `422 idempotency_key_reused`.

**Tests:** `sync/idempotency.test.ts › refuses a key that names a different request rather than serving it`, `compliance/declared-refusals.test.ts › is refused 422 on every idempotent write door when sent with another request`, `compliance/folders.test.ts › refuses 422 a key sent again with another request on each folder door`, `compliance/bulk.test.ts › refuses a different request under a key already used`.

### `items/idempotency-contract`

If a credential repeats a request under its `Idempotency-Key` after the server has moved to another contract version, then the server MUST answer `422 idempotency_key_reused`.

**Reason:** the kept answer is shaped for the contract it was made under.

**Tests:** waiting on #1444.

### `items/idempotency-credential`

When a credential sends an `Idempotency-Key` that another credential used, the server MUST answer that credential's own request.

**Tests:** `sync/idempotency.test.ts › holds a key to the credential that sent it`, `compliance/bulk.test.ts › runs another credential's own job under a key this one used, and never hands it this job`.

### `items/idempotency-signed-in`

When a signed-in app repeats a request under an `Idempotency-Key` with another access token for the same app and person, the server MUST treat it as the same credential's.

**Tests:** `compliance/idempotency-signed-in.test.ts › holds a key to the app and person across a token refresh`.

### `items/idempotency-key-length`

If an `Idempotency-Key` is empty or longer than 255 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/declared-refusals.test.ts › refuses an empty key 400 rather than treating it as absent`, `sync/idempotency-replay.test.ts › refuses a key longer than 255 characters, and takes one of 255`.

### `items/idempotency-not-kept`

When the server answers a request under an `Idempotency-Key` with `401`, `403` or a `5xx` status, the server MUST NOT keep the answer.

**Reason:** the same key works once the credential or the grant is fixed.

**Tests:** `sync/idempotency-replay.test.ts › does not keep a 403 answer, so the key works once the grant is added`.

### `items/replay-reauthorized`

When the server replays an answer, the server MUST first hold the credential to every grant the first request needed and to read on everything the first answer disclosed, as they stand at the replay.

**Reason:** a credential narrowed since its first request must not read, through the kept answer, what it may no longer read.

**Tests:** `sync/idempotency.test.ts › reauthorizes a retained answer after its credential is narrowed`, `sync/idempotency-replay.test.ts › guards the replay on every idempotent write operation`.

### `items/replay-write-lost`

If a replay's credential may still read the item's type but no longer write it, then the server MUST answer `403 type_not_permitted`.

**Tests:** `sync/idempotency-replay.test.ts › refuses a replay 403 type_not_permitted to a key that now only reads the type, and replays once write returns`.

### `items/replay-read-lost`

If a replay's credential may no longer read the item's type, then the server MUST answer `404 item_not_found` without the kept answer's body.

**Tests:** `sync/idempotency.test.ts › reauthorizes a retained answer after its credential is narrowed`.

### `items/replay-grant-lost`

If a replay's credential no longer holds a grant the first request needed, such as `items.purge`, a source claim, write on an edge type or read on any type, then the server MUST refuse the replay as it would refuse the request sent fresh.

**Tests:** `sync/idempotency-replay.test.ts › refuses a purge replay once the key no longer holds items.purge`, `› refuses a replay once the key no longer claims the source the write named, naming the source`, `› refuses an edge replay once the key loses write on the edge type`, `› refuses a replay to a key that now reaches no type`.

### `items/replay-disclosure-lost`

If a kept answer discloses a conflict snapshot, an extension namespace, a hydrated edge, a cascade mark or a bulk-action match that the replay's credential may no longer read, then the server MUST refuse the replay.

**Tests:** `sync/idempotency-replay.test.ts › refuses the replay of a conflict envelope once the key cannot read the row it disclosed`, `› refuses a replay disclosing an extension namespace the key can no longer read`, `› refuses a replay disclosing hydrated edges the key can no longer read`, `› reauthorizes a retained cascade mark after the row it names is purged`, `› refuses a bulk-action replay once the key may no longer write the matched rows, naming none of them`.

### `items/replay-current-state`

When the server reauthorizes a replay about an item or edge that still exists, the server MUST judge it by the item's or edge's current type and source as well as those the first answer recorded.

**Tests:** `sync/idempotency-replay.test.ts › judges a replay by the row's current type after a retype`, `› judges an edge replay by the edge's current source`.

### `items/replay-removed-subject`

When the server reauthorizes a replay about an item or edge since purged, the server MUST judge it by the type and source the first answer recorded.

**Tests:** `sync/idempotency-replay.test.ts › judges a replay about a purged row by its original type and source`.

### `items/replay-blocking-edges`

When the server reauthorizes a kept `edge_constraint_violation`, the server MUST require read on both ends of each blocking edge the answer named.

**Tests:** `sync/idempotency-replay.test.ts › refuses a blocking-edge refusal's replay once the key cannot read both ends`.

### `items/replay-hidden-blocker`

When the server reauthorizes a kept `edge_constraint_violation`, the server MUST NOT require anything of a blocking edge the answer did not name.

**Tests:** `sync/idempotency-replay.test.ts › replays a blocking-edge refusal whose hidden blocker the first answer never named`.

### `items/replay-edge-target`

When the server reauthorizes a kept answer about an edge, the server MUST NOT require read on the edge's target.

**Reason:** an edge's ordinary answer names its target to whoever may read the edge (`edges/target-named`).

**Tests:** `sync/idempotency-replay.test.ts › replays an edge answer without read on its target`.

### `items/replay-refused-inert`

When the server refuses a replay, the server MUST write nothing and announce nothing.

**Tests:** `sync/idempotency-replay.test.ts › writes and announces nothing on a refused replay`.

### `items/replay-refused-kept`

When the server refuses a replay, the server MUST keep the first answer for a later replay.

**Tests:** `sync/idempotency-replay.test.ts › refuses a replay 403 type_not_permitted to a key that now only reads the type, and replays once write returns`.

### `items/replay-refused-names-nothing`

When the server refuses a replay, the server MUST NOT name an item, edge or source in the refusal that the request and the first answer did not name.

**Tests:** `sync/idempotency-replay.test.ts › refuses a bulk-action replay once the key may no longer write the matched rows, naming none of them`.

### `items/replay-source-withheld`

If a replay's credential may no longer read the item a kept answer disclosed a source for, then the server MUST answer the refusal without that source.

**Tests:** `sync/idempotency-replay.test.ts › withholds a disclosed source once the key cannot read the row`, `› keeps the source refusal's details for a source the key still reads`.

### `items/replay-restored`

When the grants a refused replay lacked are restored, the server MUST replay the first answer, without asking again any version or lifecycle condition the first write changed.

**Tests:** `sync/idempotency-replay.test.ts › refuses a replay 403 type_not_permitted to a key that now only reads the type, and replays once write returns`, `sync/idempotency.test.ts › makes a repeated update one version step, not two`, `› announces a replayed delete, which would otherwise be a 404`.

## Lifecycle

An item of a canonical or custom type is `active`, `archived` or `trashed`; one of a `system.*` type is `active` or `revoked`. The bin is the `trashed` state.

### `items/transition`

When `POST /items/{id}/transition` names `active`, `archived` or `trashed`, the server MUST move the item along the graph `active` to `archived` or `trashed`, `archived` to `active` or `trashed`, and `trashed` to `active`, for every type that is not `system.*`.

**Tests:** `correctness/lifecycle-transitions.test.ts › transitions note from active to archived`, `compliance/custom-type-lifecycle.test.ts › active -> archived -> active -> trashed -> (invalid) archived`, `compliance/core-message.test.ts › transitions active -> archived`.

### `items/transition-invalid`

If `POST /items/{id}/transition` names a move the graph does not hold, the state the item is in included, then the server MUST answer `400 invalid_transition`.

**Tests:** `compliance/custom-type-lifecycle.test.ts › active -> archived -> active -> trashed -> (invalid) archived`, `correctness/lifecycle-transitions.test.ts › refuses a move to the state the row is in`.

### `items/transition-unknown-state`

If `POST /items/{id}/transition` names a `state` other than `active`, `archived` or `trashed`, `revoked` included, then the server MUST answer `400 validation_error` naming `state`.

**Tests:** `correctness/lifecycle-transitions.test.ts › rejects a state outside the enum`, `› offers a canonical type three states, and not the fourth`.

### `items/system-lifecycle`

The server MUST hold a `system.*` item to the lifecycle `active` to `revoked`, where `revoked` is final.

**Tests:** `compliance/folders.test.ts › revokes a folder once, and a revoked folder does not change`.

### `items/delete`

When `DELETE /items/{id}` names an item not in the bin, the server MUST move it to the bin.

**Tests:** `correctness/trash.test.ts › deleted item is hidden from default queries`.

### `items/bin-hidden`

The server MUST leave an item in the bin out of a listing that names no `state`.

**Tests:** `compliance/state-default.test.ts › a listing that names no state answers the active state`, `correctness/trash.test.ts › deleted item is hidden from default queries`.

### `items/bin-listed`

When a listing names `state=trashed` or `state=any`, the server MUST list the items in the bin the key may read.

**Tests:** `compliance/state-default.test.ts › a named state and the sentinel still reach every row`, `sync/catchup.test.ts › reads across every lifecycle state in one pass`.

### `items/archived-hidden`

The server MUST leave an archived item out of a listing that names no `state`.

**Tests:** `compliance/state-default.test.ts › a listing that names no state answers the active state`.

### `items/archived-readable`

When `GET /items/{id}` names an archived item the key may read, the server MUST answer it.

**Tests:** `compliance/state-default.test.ts › a read by id answers an archived row and refuses one in the bin`.

### `items/write-in-bin`

If `PATCH /items/{id}`, `DELETE /items/{id}`, `PUT` or `PATCH /items/{id}/metadata`, `POST /items/{id}/tags`, `DELETE /items/{id}/tags/{tag}`, or `PUT` or `DELETE /items/{id}/extensions/{namespace}` names an item in the bin, then the server MUST answer `404 item_not_found`, with `details.trashed: true` only to a key that may read the item's type (`errors/bin-trashed`).

**Tests:** `correctness/trash.test.ts › deleted item is hidden from default queries`, `compliance/write-refusal-details.test.ts › answers 404 with details.trashed to a key that may read the type, and nothing to one that may not`.

### `items/delete-version`

When `DELETE /items/{id}` names a `version` the item no longer holds, the server MUST answer `409 version_conflict` with the item under `current` and no `ancestor`.

**Reason:** a queued delete cannot remove an edit it never saw.

**Tests:** `compliance/write-refusal-details.test.ts › refuses a stale one as a stale write carrying nothing to merge, and trashes nothing`.

### `items/delete-unconditional`

When `DELETE /items/{id}` names no `version`, the server MUST move the item to the bin as it stands.

**Tests:** `compliance/write-refusal-details.test.ts › deletes unconditionally where no version is named`.

### `items/version-parameter`

If `DELETE /items/{id}` or `POST /items/{id}/purge` names a `version` that is not a positive whole number, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/purge-preconditions.test.ts › refuses a delete or purge version that is not a positive whole number`.

### `items/trash-cascade`

When a delete or a transition into the bin moves an item, on its own operation or in a bulk action, the server MUST move into the bin every item a cascading edge (`edges/cascade-parent-of` and `edges/cascade-custom`) reaches from it, at every depth.

**Tests:** `correctness/edges/edges-cascade.test.ts › a transition into the bin takes what a delete takes, and a restore brings it back`, `› takes what a cascade reaches on a bulk transition into the bin, and brings it back on a restore`.

### `items/trash-cascade-announced`

When a cascade moves an item into the bin, the server MUST announce `item.deleted` for it.

**Tests:** `compliance/cascade-marks.test.ts › marks a row a cascade trashed with the row named, and no row trashed on its own`, `› announces item.deleted with its mark for each row a transition into the bin takes`.

### `items/trash-blocked`

If a delete or a transition into the bin would move an item that a `block` edge holds, as its source or its target, the item named or one the cascade reaches, then the server MUST answer `400 edge_constraint_violation`.

**Tests:** `correctness/edges/edges-cascade.test.ts › a block edge refuses a transition into the bin as it refuses a delete`, `› refuses a transition into the bin held by a block edge into the row, or on a row the cascade reaches`.

### `items/trash-blocked-names`

When the server refuses a move into the bin with `edge_constraint_violation`, the server MUST name in `details.blocking_edges` no edge the key may not read.

**Tests:** `compliance/edge-hidden-limits.test.ts › refuses a delete held by a blocking edge it cannot see, naming no hidden id`, `correctness/edges/edges-cascade.test.ts › a block edge refuses a transition into the bin as it refuses a delete`.

### `items/trash-blocked-bulk`

When a bulk-action `transition` into the bin meets a `block` edge, the server MUST report that item in the job's `errors` with `edge_constraint_violation`.

**Tests:** `correctness/edges/edges-cascade.test.ts › a block edge refuses a transition into the bin as it refuses a delete`.

### `items/trash-connection`

If a delete's cascade would take a live `system.connection`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/edge-hidden-limits.test.ts › names nothing of a grant the key cannot read`.

### `items/trash-connection-hidden`

When the server refuses a delete for a live `system.connection` the key may not read, the server MUST NOT name that connection's id or type.

**Tests:** `compliance/edge-hidden-limits.test.ts › names nothing of a grant the key cannot read`.

### `items/cascade-mark`

While an item a cascade moved into the bin stays there, the server MUST answer it with `trashed_by_cascade: true` on every operation and event that answers it.

**Reason:** a connector must know a trash was a cascade, or it carries to the vendor a trash the person never made.

**Tests:** `compliance/cascade-marks.test.ts › marks a row a cascade trashed with the row named, and no row trashed on its own`, `› answers the marks on POST /items/lookup, to each reader as it may be told`, `› marks a row a cascade trashed on the acknowledgement of a create naming its source and source id, and names the row trashed only to a key that may read its type`, `› marks a row a cascade trashed on the answer to a create repeated under its id, and names the row trashed only to a key that may read its type`, `› delivers the item.deleted of a row a cascade trashed with its mark, and the row trashed's own without one`, `› restores a row a cascade trashed as its own trash, which its parent's restore leaves in the bin`.

### `items/cascade-mark-names`

While an item a cascade moved into the bin stays there, the server MUST answer it with `trashed_with` naming the item the delete or transition named, to a key that may read that item's type, and to no other key.

**Tests:** `compliance/cascade-marks.test.ts › names the row trashed only to a key that may read its type, and says a cascade took the row to any key that reads it`.

### `items/cascade-mark-none`

The server MUST NOT mark with `trashed_by_cascade` or `trashed_with` the item a delete named, an item trashed on its own, or a `system.*` item a cascade revokes.

**Tests:** `compliance/cascade-marks.test.ts › marks a row a cascade trashed with the row named, and no row trashed on its own`, `› marks no row a cascade revokes rather than trashes`.

### `items/cascade-mark-life`

The server MUST keep an item's cascade marks through a purge of the item they name.

**Tests:** `compliance/cascade-marks.test.ts › keeps the mark through a purge of the row named, and drops it when the row leaves the bin`.

### `items/cascade-mark-dropped`

When an item a cascade moved into the bin leaves it, by a restore or a transition, the server MUST drop its cascade marks.

**Tests:** `compliance/cascade-marks.test.ts › keeps the mark through a purge of the row named, and drops it when the row leaves the bin`.

### `items/restore`

When `POST /items/{id}/restore` names an item in the bin, the server MUST move it to `active`.

**Tests:** `correctness/trash.test.ts › deleted item can be restored`.

### `items/restore-announced`

When a restore or a transition out of the bin moves an item to `active`, the server MUST announce `item.restored` for it.

**Tests:** `compliance/events-contract.test.ts › announces item.restored when a trashed item comes back`, `› announces item.restored for a row a transition out of the bin brings back, at any depth`.

### `items/restore-live`

If `POST /items/{id}/restore` names an item not in the bin, then the server MUST answer `400 invalid_transition`.

**Tests:** `correctness/trash.test.ts › restoring a non-deleted item returns error`.

### `items/restore-cascade`

When a restore, or a transition out of the bin on its own operation or in a bulk action, moves an item, the server MUST bring back every item that item's trash took through a cascading edge at every depth, and no item already in the bin when that trash ran.

**Reason:** a person who trashed a project by mistake gets it back whole, and nothing they had trashed before comes back with it.

**Tests:** `correctness/edges/edges-cascade.test.ts › restoring a parent brings back what its trash took, at every depth, and nothing trashed on its own`, `› does not restore with a parent a child that left the bin and was trashed on its own since`, `› a transition out of the bin brings back what the trash took, as a restore does`, `compliance/events-contract.test.ts › announces item.restored for a row the restore of its parent brings back`, `› announces item.restored for a row a transition out of the bin brings back, at any depth`, `compliance/bulk.test.ts › restores a row and what its trash took in one transition, counting each row once`.

### `items/restore-counted-once`

When a bulk transition out of the bin brings back an item both because the filter matched it and because a matched item's trash took it, the server MUST count it once.

**Tests:** `compliance/bulk.test.ts › restores a row and what its trash took in one transition, counting each row once`.

### `items/restore-child`

When a restore moves an item that a trash above it took, the server MUST bring back what that trash took beneath the item, and none of the item's siblings.

**Tests:** `correctness/edges/edges-cascade.test.ts › restoring a row the trash above took brings back what that trash took beneath it, and not its siblings`, `› restoring a child alone brings back only that child`.

### `items/restore-after-purge`

When the item a trash was keyed to is purged, the server MUST keep each item that trash took restorable as its own trash, with what lay beneath it.

**Tests:** `correctness/edges/edges-cascade.test.ts › restoring a row brings back what lay beneath it after the parent whose trash took them is purged`, `› restores a parent whose trash took a child purged since`, `compliance/cascade-marks.test.ts › keeps the mark through a purge of the row named, and drops it when the row leaves the bin`.

### `items/restored-with`

When a restore or a transition out of the bin brings back an item it did not name, the server MUST carry `restored_with` on that item's `item.restored`, naming the item named, to a key that may read the named item's type and to no other key.

**Tests:** `compliance/cascade-marks.test.ts › names the row restored on each row its restore brings back, and not on the row itself`, `› names the row moved on each row a transition out of the bin brings back, only to a key that may read its type`, `› names the row moved on each row a bulk transition out of the bin brings back, only to a key that may read its type`, `› names the row restored only to a key that may read its type`.

### `items/restored-with-none`

The server MUST NOT carry `restored_with` on the `item.restored` of the item a restore or a transition named.

**Tests:** `compliance/cascade-marks.test.ts › names the row restored on each row its restore brings back, and not on the row itself`.

### `items/restore-archive-alone`

When an archive restore writes an item into the bin, the server MUST hold it as its own trash, with no cascade marks, whatever the archive recorded.

**Reason:** what a trash took is the instance's record, and an archive does not carry it.

**Tests:** `compliance/cascade-marks.test.ts › restores a row a cascade trashed as its own trash, which its parent's restore leaves in the bin`.

### `items/purge`

When `POST /items/{id}/purge` names an item in the bin, the server MUST delete it.

**Tests:** `correctness/trash.test.ts › purges a trashed item, after which every read answers 404`.

### `items/purge-announced`

When the server purges an item, the server MUST announce `item.purged` with the item as it stood, its cascade marks included.

**Tests:** `sync/deletions.test.ts › announces a purge, so a client offline across it learns the row is gone`, `compliance/cascade-marks.test.ts › names the row whose trash took it on the purge of a row a cascade trashed`, `compliance/cascade-marks.test.ts › names the row whose trash took it on each row a bulk purge purges, only to a key that may read its type`.

### `items/purge-edges`

When a purge deletes an item, the server MUST delete its edges and announce each `edge.deleted` with `purged_with` naming the item.

**Tests:** `compliance/cascade-marks.test.ts › names the purged item on each edge its purge took, and on no edge deleted by its own door`, `sync/deletions.test.ts › announces an edge removed by cascade, not only one removed by its own route`, `compliance/cascade-marks.test.ts › names the purged original on the edge.deleted of the link to its conflicted copy`, `compliance/cascade-marks.test.ts › names the purged item on each edge a bulk purge took`.

### `items/purge-gone`

When an item has been purged, the server MUST answer a read, a restore and a purge of its id `404 item_not_found`.

**Tests:** `correctness/trash.test.ts › purges a trashed item, after which every read answers 404`.

### `items/purge-live`

If `POST /items/{id}/purge` names an item not in the bin that the key may write, then the server MUST answer `400 invalid_transition`.

**Tests:** `correctness/trash.test.ts › refuses to purge an item that is not trashed`.

### `items/purge-permission`

If a key without `items.purge` sends `POST /items/{id}/purge`, then the server MUST answer `403 forbidden` with `details.required_scope` `items.purge`.

**Tests:** `compliance/type-permissions.test.ts › a key without items.purge cannot purge`.

### `items/purge-type-write`

If a key that may read an item's type but not write it sends `POST /items/{id}/purge` or `POST /items/{id}/restore` for that item, in any state, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/type-permissions.test.ts › a key that may only read a type cannot purge a trashed row of it`, `› refuses a read-only key a purge of a live row, 403 type_not_permitted`.

### `items/purge-unreadable`

If `POST /items/{id}/purge` names an item of a type the key may not read, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/type-permissions.test.ts › answers 404 item_not_found to a purge of a row whose type the key cannot read`.

### `items/purge-version`

If `POST /items/{id}/purge` names a `version` the item no longer holds, then the server MUST answer `409 version_conflict` with the item under `current`.

**Reason:** a move to the bin does not change an item's version, so the version read before the trash is the one to send.

**Tests:** `compliance/purge-preconditions.test.ts › refuses a stale version with version_conflict, and the row survives`, `› purges at the version read before the trash, which trashing does not move`.

### `items/purge-undeclared-query`

If `POST /items/{id}/purge` names a query parameter it does not declare, then the server MUST answer `400 validation_error`.

**Reason:** a misspelled precondition dropped in silence would be an unconditional purge.

**Tests:** `compliance/purge-preconditions.test.ts › refuses a query parameter the purge operation does not declare, and purges nothing`.

## Bulk writes

`POST /items/bulk` writes a page of entries. Under `atomic: true`, the default, a refused entry rolls the whole page back; under `atomic: false` each entry stands alone. A refused entry is an entry `errored` on a best-effort page and the page's rollback on an atomic one.

### `items/bulk-no-type`

If a key whose type map reaches no type sends `POST /items/bulk`, then the server MUST answer `403 type_not_permitted` before it reads the page, an empty page included.

**Tests:** `compliance/bulk-limits.test.ts › refuses a key that reaches no type before it reads the page, an empty page included`.

### `items/bulk-answer`

When the server accepts a `POST /items/bulk` page, the server MUST answer `200` with `counts` of `created`, `updated`, `skipped` and `errored` entries and one `results` entry for each entry sent, in the order sent.

**Tests:** `compliance/bulk.test.ts › round-trips export → bulk (create_only) with a new source_id`, `› atomic=false keeps the good entry and errors the unregistered type`.

### `items/bulk-entry-cap`

If a `POST /items/bulk` page holds more than 5,000 entries, then the server MUST answer `400 validation_error` with `details.cap` 5000.

**Tests:** `compliance/bulk-limits.test.ts › refuses a page of more than 5,000 entries, and takes one of 5,000`.

### `items/bulk-body-cap`

If a `POST /items/bulk` or `POST /items/bulk-actions` body is larger than 16 MiB, then the server MUST answer `413 request_too_large`.

**Tests:** `compliance/bulk-limits.test.ts › refuses a bulk body over 16 MiB with request_too_large, on both bulk item operations`.

### `items/bulk-upsert`

When a `POST /items/bulk` entry under `mode: upsert`, the default, names a natural key that resolves a live item, the server MUST update that item and report the entry `updated` with its `id`.

**Tests:** `compliance/bulk.test.ts › upsert mode updates an existing (source, source_id) row in place`.

### `items/bulk-skipped`

When the server reports a `POST /items/bulk` entry `skipped`, the server MUST NOT write it.

**Tests:** `compliance/bulk.test.ts › create_only skips a repeated (source, source_id) as duplicate_source`, `› create_only skips an entry naming a held id as duplicate_id, live or in the bin, and writes nothing`, `› reads a natural key over trashed rows, as the single create does`.

### `items/bulk-create-only`

When a `POST /items/bulk` entry under `mode: create_only` names a natural key that resolves an item, live or in the bin, the server MUST report it `skipped` with `reason: "duplicate_source"`.

**Tests:** `compliance/bulk.test.ts › create_only skips a repeated (source, source_id) as duplicate_source`, `› reads a natural key over trashed rows, as the single create does`.

### `items/bulk-create-only-id`

When a `POST /items/bulk` entry under `mode: create_only` names an `id` an item holds, live or in the bin, and a natural key that resolves no item, the server MUST report it `skipped` with `reason: "duplicate_id"` and that `id`.

**Reason:** an id the caller minted is its own, so a repeat is an acknowledgment, not a refusal that rolls back every page that re-syncs it.

**Tests:** `compliance/bulk.test.ts › create_only skips an entry naming a held id as duplicate_id, live or in the bin, and writes nothing`.

### `items/bulk-skipped-id`

When the server reports a `POST /items/bulk` entry `skipped` for an item of a type the key may not read, the server MUST NOT name the item's `id`.

**Tests:** `compliance/claimed-sources.test.ts › tells a key its natural key is taken, and nothing of a row it may not read`, `compliance/bulk.test.ts › create_only skips a repeated (source, source_id) as duplicate_source`.

### `items/bulk-trashed`

When a `POST /items/bulk` entry under `mode: upsert` names a natural key or an `id` that resolves an item in the bin, of a type the key may write and the entry declares, the server MUST report it `skipped` with `reason: "trashed"` and the item's `id`.

**Reason:** a connector re-syncing a page that holds a row the person trashed must neither revive it nor fail the page.

**Tests:** `compliance/bulk.test.ts › reads a natural key over trashed rows, as the single create does`, `› acknowledges an upsert entry naming the id of an item in the bin, and refuses one of another type`.

### `items/bulk-trashed-unwritable`

If a `POST /items/bulk` entry under `mode: upsert` names a natural key that resolves an item in the bin of a type the key may not write, then the server MUST refuse the entry `type_not_permitted` without the item's `id`.

**Tests:** `compliance/claimed-sources.test.ts › gates a bulk entry resolving a trashed row on the row's type, and names no id`.

### `items/bulk-trashed-other-type`

If a `POST /items/bulk` entry under `mode: upsert` and without `retype: true` names a natural key that resolves an item in the bin of another type than the entry declares, then the server MUST refuse the entry `type_mismatch` with `details.actual_type` naming the item's type.

**Tests:** `compliance/claimed-sources.test.ts › gates a bulk entry resolving a trashed row on the row's type, and names no id`.

### `items/bulk-id-other-type`

If a `POST /items/bulk` entry under `mode: upsert` and without `retype: true` names an `id` that an item of another type the key may read holds, live or in the bin, then the server MUST refuse the entry `id_reused`.

**Tests:** `compliance/bulk.test.ts › tells a reused id from a mistaken declaration, as the single-item doors do`, `› acknowledges an upsert entry naming the id of an item in the bin, and refuses one of another type`.

### `items/bulk-natural-key-other-type`

If a `POST /items/bulk` entry under `mode: upsert` and without `retype: true` names a natural key that resolves a live item of another type, then the server MUST refuse the entry `type_mismatch`.

**Tests:** `compliance/bulk.test.ts › tells a reused id from a mistaken declaration, as the single-item doors do`.

### `items/bulk-version`

If a `POST /items/bulk` entry under `mode: upsert` names a `version` that the item it resolves no longer holds, whose snapshot the key may read, and changes a field another writer changed since, then the server MUST refuse the entry `version_conflict`.

**Tests:** `sync/idempotency.test.ts › a bulk entry naming a stale version is refused, and rolls the page back or not as atomic says`, `compliance/bulk.test.ts › takes properties_mode on an entry as PATCH takes it, stale versions included`, `compliance/version-order.test.ts › merges an entry that collides on nothing, and refuses one that collides as errored with its code and message`, `› rolls the whole batch back under atomic true when one entry collides`.

### `items/bulk-source-id-move`

If a `POST /items/bulk` entry resolves an item by its `id` and names another `source_id` for an item under a source the key does not write under, then the server MUST refuse the entry `forbidden` with `details.source`.

**Tests:** `compliance/claimed-sources.test.ts › refuses a key moving a natural key under a source it does not write under`.

### `items/bulk-properties-mode`

When a `POST /items/bulk` entry resolves an item, the server MUST apply its `properties_mode` as `PATCH /items/{id}` does, a stale `replace` merged as `versions/merge-replace-clear` states.

**Tests:** `compliance/bulk.test.ts › takes properties_mode on an entry as PATCH takes it, stale versions included`.

### `items/bulk-atomic`

If an entry of a `POST /items/bulk` page under `atomic: true` is refused, then the server MUST write no entry of the page and answer `bulk_atomic_rollback` with the entry's code in `details.code` and its position in `details.index`.

**Tests:** `compliance/bulk.test.ts › atomic rollback on invalid type returns 400 and leaves no rows`, `› gates bulk writes per item type, and on nothing else`, `sync/idempotency.test.ts › a bulk entry naming a stale version is refused, and rolls the page back or not as atomic says`.

### `items/bulk-atomic-status`

When the server answers `bulk_atomic_rollback`, the server MUST answer it with the status the refused entry's code carries on its own operation.

**Reason:** the status tells the caller what to do next, and a row that moved is not fixed by re-reading the body.

**Tests:** `compliance/bulk.test.ts › answers a rollback at the status of the refusal inside it`, `compliance/links.test.ts › refuses a bulk entry a link another row holds, on both halves`.

### `items/bulk-atomic-gates-first`

When the server reads a `POST /items/bulk` page under `atomic: true`, the server MUST refuse an entry of a type the key may not write, or naming a source it does not claim, before it looks any entry up.

**Reason:** otherwise a stale entry ahead of it answers `409`, and the caller re-reads a row when the cause is a permission it lacks.

**Tests:** `compliance/claimed-sources.test.ts › refuses an atomic page for an entry's source or type before a stale entry ahead of it`.

### `items/bulk-best-effort`

If an entry of a `POST /items/bulk` page under `atomic: false` is refused, then the server MUST report it `errored` with its `error.code` and `error.details`.

**Tests:** `compliance/bulk.test.ts › atomic=false keeps the good entry and errors the unregistered type`, `compliance/claimed-sources.test.ts › refuses a bulk entry naming a source its key does not claim, and rolls an atomic page back`.

### `items/bulk-best-effort-others`

When the server refuses an entry of a `POST /items/bulk` page under `atomic: false`, the server MUST still write the page's other entries.

**Tests:** `compliance/bulk.test.ts › atomic=false keeps the good entry and errors the unregistered type`, `compliance/claimed-sources.test.ts › refuses a bulk entry naming a source its key does not claim, and rolls an atomic page back`.

### `items/bulk-errored-wrote-nothing`

When the server reports a `POST /items/bulk` entry `errored` without `error.details.write_outcome: "unknown"`, the server MUST have written none of its item, tags and inline edges.

**Tests:** `compliance/bulk.test.ts › writes nothing for a best-effort entry whose edge target is missing`.

### `items/bulk-outcome-unknown`

If the server cannot confirm whether an entry of a page under `atomic: false` committed, then the server MUST report that entry `errored` with `error.details.write_outcome: "unknown"`, counted under `errored` alone, in a `200` answer.

**Reason:** the caller reconciles that entry's stored state before retrying it, and does not replay the page.

**Tests:** waiting on #1444.

### `items/bulk-outcome-unknown-continues`

When the server reports a `POST /items/bulk` entry with `write_outcome: "unknown"`, the server MUST go on to the page's next entry.

**Tests:** waiting on #1444.

### `items/bulk-reason`

When the server reports a bulk entry `skipped`, the server MUST give its `reason` as `duplicate_source`, `duplicate_id` or `trashed` on `POST /items/bulk`, and as `duplicate_edge` on `POST /edges/bulk`.

**Reason:** `reason` is a closed list, so a generated client branches on it with every case known.

**Tests:** `compliance/bulk.test.ts › create_only skips a repeated (source, source_id) as duplicate_source`, `› create_only skips an entry naming a held id as duplicate_id, live or in the bin, and writes nothing`, `› reads a natural key over trashed rows, as the single create does`, `compliance/edges-bulk.test.ts › create_only surfaces duplicates as skipped with reason duplicate_edge`.

### `items/bulk-reason-none`

The server MUST NOT give a `reason` on a bulk entry it reports `created`, `updated` or `errored`.

**Reason:** a reason says why a write did not happen.

**Tests:** `compliance/bulk.test.ts › create_only skips an entry naming a held id as duplicate_id, live or in the bin, and writes nothing`, `compliance/edges-bulk.test.ts › create_only surfaces duplicates as skipped with reason duplicate_edge`.

### `items/bulk-event-log`

When a bulk operation writes an item or an edge, the server MUST write its event to the event log, whatever `enable_fanout` says.

**Reason:** a client rebuilding its state replays the log, and a write missing from it is one that client never learns of.

**Tests:** `sync/replay.test.ts › carries a bulk write, so a catch-up after an import is complete`.

### `items/bulk-fanout`

When `POST /items/bulk`, `POST /edges/bulk` or `POST /items/bulk-actions` names no `enable_fanout: true`, the server MUST NOT deliver its writes to outbound webhooks.

**Reason:** one call writes thousands of rows, and a delivery for each to each subscriber is not what the caller asked for.

**Tests:** `compliance/webhooks.test.ts › calls out for a bulk write only when the call asks for fan-out`, `› calls out for a bulk edge write only when the call asks for fan-out`, `› calls out for a bulk action only when the call asks for fan-out`.

### `items/single-write-fanout`

When a single-item operation writes an item, the server MUST deliver the write to the outbound webhooks it matches.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`.

### `items/restore-no-fanout`

The server MUST NOT deliver the writes of `POST /restore` to outbound webhooks.

**Tests:** `compliance/webhooks.test.ts › never calls out for an archive restore`.

## Bulk actions

`POST /items/bulk-actions` applies one action to every item a filter matches, as a job.

### `items/bulk-action`

When a key sends `POST /items/bulk-actions` naming an action and a filter and no `dry_run`, the server MUST answer `202` with a job in `queued` and its `matched` count.

**Tests:** `compliance/bulk.test.ts › POST returns 202 with a queued envelope; status terminates completed`.

### `items/bulk-action-applies`

When a bulk-action job runs, the server MUST apply its `transition`, `purge`, `update_tags`, `update_tier`, `update_properties` or `update_occurred_at` to each item the filter matched when the job was queued.

**Tests:** `compliance/bulk.test.ts › transition archives every match (async job path)`, `› purge deletes matching items (with confirm)`, `› update_tags adds and removes`, `› update_tier and update_properties both land`, `› update_occurred_at overrides the item's own time`.

### `items/bulk-action-dry-run`

When `POST /items/bulk-actions` names `dry_run: true`, the server MUST answer `200` with `matched` and the matched `ids`.

**Tests:** `compliance/bulk.test.ts › dry_run stays synchronous and returns matched ids without mutating`, `compliance/bulk-limits.test.ts › lists a live row in a purge dry run, which the purge then leaves`.

### `items/bulk-action-dry-run-inert`

When `POST /items/bulk-actions` names `dry_run: true`, the server MUST NOT change any item.

**Tests:** `compliance/bulk.test.ts › dry_run stays synchronous and returns matched ids without mutating`.

### `items/bulk-action-cap`

If a bulk action's filter matches more items than its `max_items`, which is 10,000 when the request names none and counts as 50,000 when it names more, then the server MUST answer `400 bulk_cap_exceeded` with `details.cap`.

**Tests:** `compliance/bulk-limits.test.ts › refuses a bulk action matching more than 10,000 items when it names no max_items`, `› counts a max_items above 50,000 as 50,000`, `compliance/purge-preconditions.test.ts › caps the rows the purge takes, not the filter's whole match`.

### `items/bulk-action-undeclared`

If a `POST /items/bulk-actions` body, or its filter, carries a key the operation does not declare, then the server MUST answer `400 validation_error` naming the key in `details.unknown_body_fields` or `details.unknown_filter_fields`.

**Reason:** a dropped filter field is not a narrower match set but every item the credential may write, so the operation refuses the field rather than strips it.

**Tests:** `compliance/bulk-limits.test.ts › refuses a body key the bulk-action operation does not declare, naming it`, `compliance/bulk.test.ts › refuses a filter field it does not declare, naming it`, `sync/time-filters.test.ts › refuses an undeclared bound inside a bulk-action filter, where a dropped bound is every row`.

### `items/bulk-action-own-time`

When a bulk action's filter names `occurred_after` or `occurred_before`, the server MUST match items whose own time is strictly after or strictly before it.

**Tests:** `compliance/bulk.test.ts › narrows a match set by the item's own time`, `compliance/bulk-limits.test.ts › matches own time strictly after occurred_after and strictly before occurred_before`.

### `items/bulk-purge-permission`

If a key without `items.purge` sends a bulk `purge`, a dry run included, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/bulk.test.ts › purge is refused to a key holding no permissions`, `compliance/bulk-limits.test.ts › asks a purge dry run for items.purge and confirm, as it asks a purge`.

### `items/bulk-purge-confirm`

If a bulk `purge`, a dry run included, does not name `confirm: "PURGE"`, then the server MUST answer `400 bulk_confirmation_required`.

**Tests:** `compliance/bulk.test.ts › purge without confirm returns 400 bulk_confirmation_required`, `compliance/bulk-limits.test.ts › asks a purge dry run for items.purge and confirm, as it asks a purge`.

### `items/bulk-purge-bin-only`

When a bulk `purge` reaches an item that is not in the bin when the job runs, the server MUST leave it and report it in the job's `errors` with `invalid_transition`.

**Tests:** `compliance/bulk.test.ts › purge leaves a match that is not in the trash, and reports it invalid_transition`, `compliance/bulk-limits.test.ts › lists a live row in a purge dry run, which the purge then leaves`.

### `items/bulk-purge-expected-ids`

When a bulk `purge` or its dry run names `expected_ids`, the server MUST match only the items both listed and matched by the filter when the request is made.

**Reason:** a purge confirmed against a dry run takes no row the dry run did not show.

**Tests:** `compliance/purge-preconditions.test.ts › does not purge a row trashed after the dry run`, `› does not purge a listed id the filter no longer matches`.

### `items/bulk-purge-expected-ids-cap`

When a bulk `purge` names `expected_ids`, the server MUST hold its `max_items` to the items it matches, not to the filter's whole match.

**Tests:** `compliance/purge-preconditions.test.ts › caps the rows the purge takes, not the filter's whole match`.

### `items/bulk-purge-expected-ids-refused`

If `expected_ids` is empty, or named on an action other than `purge`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/purge-preconditions.test.ts › refuses an empty expected_ids, and purges nothing`, `› refuses expected_ids on an action other than purge`.

### `items/bulk-action-row-atomic`

When a bulk action reports an item in the job's `errors`, the server MUST have left that item, its edges and what its cascade reached as they were.

**Tests:** `compliance/bulk.test.ts › purge leaves a match that is not in the trash, and reports it invalid_transition`, `correctness/edges/edges-cascade.test.ts › a block edge refuses a transition into the bin as it refuses a delete`.

### `items/bulk-action-row-rules`

When a bulk action writes an item, the server MUST hold the write to the rules the single-item operation holds it to, reporting a refused item in the job's `errors` with the code that operation answers.

**Tests:** `compliance/links.test.ts › reports a link another row holds per row of a bulk update_properties`, `correctness/edges/edges-cascade.test.ts › a block edge refuses a transition into the bin as it refuses a delete`, `compliance/odd-input.test.ts › refuses a tag or property name the item doors refuse`.

### `items/bulk-action-selection-moved`

If the credential's source filter changes, or hides a matched item, while the server selects a bulk action's items, then the server MUST answer `403 forbidden` without a count or ids.

**Tests:** waiting on #1444.

### `items/job-read`

When the credential that queued a bulk-action job, a caller with `instance.read`, or direct owner or local authority sends `GET /items/bulk-actions/jobs/{id}`, the server MUST answer the job's `status`, `matched`, `processed`, `succeeded` and `errored`.

**Tests:** `compliance/bulk.test.ts › POST returns 202 with a queued envelope; status terminates completed`, `compliance/bulk-limits.test.ts › lets instance.read and instance.maintain read and cancel any job`.

### `items/job-result`

When a job ends `completed` or `failed`, the server MUST answer its `result`, naming the action and, for a purge, `blob_hashes_referenced`.

**Tests:** `compliance/bulk.test.ts › POST returns 202 with a queued envelope; status terminates completed`, `› purge deletes matching items (with confirm)`.

### `items/job-not-found`

If `GET /items/bulk-actions/jobs/{id}` or its cancel names a job that does not exist, then the server MUST answer `404 bulk_job_not_found`.

**Tests:** `compliance/bulk.test.ts › GET on an unknown id returns 404 bulk_job_not_found`, `› cancel on an unknown id returns 404 bulk_job_not_found`.

### `items/job-other-credential`

If a credential other than the one that queued a job reads it without `instance.read` or cancels it without `instance.maintain`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/bulk.test.ts › refuses another credential reading or canceling the job, 403 forbidden`.

### `items/job-signed-in`

When a signed-in app refreshes its access token, the server MUST let the new token read and cancel the jobs an earlier token of the same app and person queued.

**Tests:** `compliance/idempotency-signed-in.test.ts › lets a refreshed token read and cancel the jobs an earlier token queued`.

### `items/job-cancel-terminal`

When `POST /items/bulk-actions/jobs/{id}/cancel` names a job that has ended, the server MUST answer `200` with the job as it ended.

**Tests:** `compliance/bulk.test.ts › cancel on a terminal job answers 200 with its final state unchanged`.

### `items/job-cancel`

When `POST /items/bulk-actions/jobs/{id}/cancel` names a job that has not ended, the server MUST end it `canceled`.

**Tests:** waiting on #1444.

### `items/job-cancel-keeps`

When the server cancels a job, the server MUST keep every item the job already wrote.

**Tests:** waiting on #1444.

### `items/job-canceled-final`

While a job is `canceled`, the server MUST answer it `canceled`, whatever the work it had in hand when canceled does.

**Tests:** waiting on #1444.

### `items/job-credential-lost`

If the credential that queued a job stops authenticating, or a purge's credential loses `items.purge`, while the job runs, then the server MUST write nothing more and end the job `failed` with an `error` saying so.

**Tests:** waiting on #1444.

### `items/job-failed-result`

When the server ends a job `failed`, the server MUST answer the `result` the job had gathered, its `ids`, `errors` and counts.

**Tests:** waiting on #1444.

### `items/job-token-expiry`

While the grant behind a signed-in app stands, the server MUST go on running the app's job after the access token that queued it expires.

**Reason:** the app refreshes to a new token while the grant stands.

**Tests:** waiting on #1444.

### `items/job-source-hidden`

If the credential's source filter comes to hide a matched item while its job runs, then the server MUST report that item in the job's `errors` as `item_not_found`, naming no type.

**Tests:** waiting on #1444.

### `items/job-type-lost`

If the credential that queued a job loses write on a matched item's type while the job runs, then the server MUST report that item in the job's `errors`, `type_not_permitted` where it may still read the type and `item_not_found` where it may not.

**Tests:** waiting on #1444.

### `items/job-row-continues`

When a job reports an item in its `errors`, the server MUST go on to the job's next item.

**Tests:** `compliance/bulk.test.ts › reports a refused row in a job's errors and goes on to the next`.

### `items/job-chunk-fault`

If a fault ends a job's write partway through a chunk of items, then the server MUST report the chunk's unwritten items in the job's `errors` with the fault's own cause.

**Tests:** waiting on #1444.

### `items/job-chunk-continues`

When a fault ends a job's write partway through a chunk of items, the server MUST go on to the job's next chunk.

**Tests:** waiting on #1444.

### `items/job-resumes`

If the server stops while a job runs, then the server MUST finish the job on its return without writing or announcing an item twice.

**Tests:** waiting on #1444.

## Tags, metadata and extensions

### `items/tags-set`

The server MUST hold an item's tags as a set, keeping each tag once, in the order it was first written.

**Tests:** `compliance/metadata-routes.test.ts › keeps each tag once, whichever operation writes it`.

### `items/tags-add`

When a key sends tags on `PATCH /items/{id}/metadata` or `POST /items/{id}/tags`, the server MUST add them to the item's tags.

**Tests:** `correctness/tags.test.ts › updates tags via metadata PATCH`, `compliance/metadata-routes.test.ts › adds tags, reads them back, and replaces them wholesale`.

### `items/tags-replace`

When a key sends `PUT /items/{id}/metadata`, the server MUST make the tags it names the item's whole tag list.

**Tests:** `compliance/metadata-routes.test.ts › adds tags, reads them back, and replaces them wholesale`.

### `items/tags-remove`

When a key sends `DELETE /items/{id}/tags/{tag}`, the server MUST remove that tag and keep the item's other tags.

**Tests:** `correctness/tags.test.ts › favorite can be removed via DELETE /items/:id/tags/favorite`.

### `items/tags-read`

The server MUST answer an item's tags in its `metadata` on `GET /items/{id}` and `GET /items/{id}/metadata`, which also names the `item_id`.

**Tests:** `correctness/tags.test.ts › creates an item with tags and returns them correctly`, `compliance/metadata-routes.test.ts › adds tags, reads them back, and replaces them wholesale`.

### `items/tags-not-list`

If a tag write names `tags` that is not a list, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/tags.test.ts › refuses a metadata patch whose tags are not an array, and answers 404 for an unknown item`, `compliance/metadata-routes.test.ts › refuses a tags body that is not an array`.

### `items/metadata-missing`

If a metadata, tag or extension operation names an item that does not exist, then the server MUST answer `404 item_not_found`.

**Tests:** `correctness/tags.test.ts › refuses a metadata patch whose tags are not an array, and answers 404 for an unknown item`, `compliance/metadata-routes.test.ts › answers 404 for an unknown item on every metadata door`, `compliance/extensions.test.ts › answers 404 for an unknown item and 400 for a malformed id on every door`.

### `items/metadata-write-grant`

If a key that may read an item's type but not write it writes the item's tags or extensions, then the server MUST answer `403 type_not_permitted` with `details.grant` naming the type and the level it lacks (`errors/grant-type`).

**Tests:** `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`, `compliance/extensions.test.ts › refuses a replace and a delete to a key that may read the item's type and not write it`.

### `items/favorite-tag`

The server MUST hold `favorite` as an ordinary tag, with no field of its own.

**Tests:** `correctness/tags.test.ts › favorite is not a separate metadata field; it lives in tags`, `› favorite persists when added via metadata PATCH`.

### `items/tag-counts`

When a key sends `GET /metadata/tags`, the server MUST answer each tag on an active item the key may read with the number of such items carrying it, by count descending and then by tag ascending.

**Tests:** `compliance/metadata-routes.test.ts › counts distinct tags across the dataset`, `› keeps each tag once, whichever operation writes it`.

### `items/tag-updated-at`

When a tag operation writes an item's tags, the server MUST move the item's `updated_at`.

**Tests:** `sync/catchup.test.ts › moves when a tag is written, not only when a property is`, `› moves updated_at on every tag operation`.

### `items/tag-announced`

When a tag operation writes an item's tags, the server MUST announce `metadata.changed`.

**Tests:** `compliance/events-contract.test.ts › announces metadata.changed on a tag write`.

### `items/extension-replace`

When a key sends `PUT /items/{id}/extensions/{namespace}`, the server MUST replace that namespace's data whole and leave every other namespace as it stands.

**Tests:** `compliance/extensions.test.ts › writes extension data to a namespace`, `› overwrites extension on second PUT`, `› writes multiple namespaces independently`.

### `items/extension-answer`

When the server answers a write or delete of an extension namespace, the server MUST answer every namespace on the item the key may read, and no other.

**Tests:** `compliance/extensions.test.ts › answers a key only the namespaces its extension map reads, on the replace and delete doors as on the reads`.

### `items/extension-read`

When a key reads an item's extensions, the server MUST answer every namespace it may read (`keys-and-oauth.md` 21) on `GET /items/{id}/extensions` and in the item's metadata, and `{ namespace, data }` on `GET /items/{id}/extensions/{namespace}`.

**Tests:** `compliance/extensions.test.ts › reads all extensions`, `› reads a specific namespace`, `› extensions persist on the item's metadata read`.

### `items/extension-absent`

When a key reads an extension namespace an item does not hold, the server MUST answer `200` with `data: null`.

**Tests:** `compliance/extensions.test.ts › deletes a namespace, after which its read answers 200 with null data`.

### `items/extension-archive`

When an archive round trip restores an item, the server MUST restore its extensions.

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`.

### `items/extension-announced`

When a key writes or deletes an extension namespace, the server MUST announce `metadata.changed`.

**Tests:** `compliance/events-contract.test.ts › announces metadata.changed on an extension write under any namespace`.

## The folder operations

A folder's settings are a `system.folder` item, written only through `/folders`. What a folder does with them is `folders.md`'s.

### `items/folder-create`

When a key sends `POST /folders` with a `title` and settings, the server MUST answer `201` with an `item` of type `system.folder` at `version` 1, `active`, whose properties are the settings as sent.

**Tests:** `compliance/folders.test.ts › creates a folder as a system.folder, read back through the item doors`.

### `items/folder-announced`

When a key creates, changes or revokes a folder, the server MUST announce `item.created`, `item.updated` or `item.state_changed` for it.

**Tests:** `compliance/folders.test.ts › publishes a folder's create, change and revoke as item events`.

### `items/folder-settings`

The server MUST take as a folder's settings `title`, `search` with `types`, `tier`, `state`, `filter` and `beneath`, `defaults` with `type`, `tier`, `properties`, `tags` and `edges`, `include`, `ignore`, `first_placement` and `removal_threshold`, and no other key.

**Tests:** `compliance/folders.test.ts › creates a folder as a system.folder, read back through the item doors`, `› refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `items/folder-read`

The server MUST answer a folder through `GET /items/{id}` and a listing naming `system.folder` to a key with read on `system.folder`.

**Tests:** `compliance/folders.test.ts › creates a folder as a system.folder, read back through the item doors`, `› reads a folder through the item doors only with read on system.folder`.

### `items/folder-read-hidden`

If a key without read on `system.folder` sends `GET /items/{id}` for a folder, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folders.test.ts › reads a folder through the item doors only with read on system.folder`.

### `items/folder-grant`

If a key whose type map does not grant write on `system.folder` creates, changes or revokes a folder, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/folders.test.ts › admits a key minted with write on system.folder alone, and refuses one whose map does not grant it`.

### `items/folder-change`

When `PATCH /folders/{id}` names the `version` the folder holds and one or more settings, the server MUST replace each setting named whole and advance the version.

**Tests:** `compliance/folders.test.ts › changes a folder at its version, merges a stale change to another setting, and refuses one to the same, and refuses a conflict parameter as undeclared`.

### `items/folder-change-stale`

When `PATCH /folders/{id}` names a version the folder no longer holds and changes only settings nobody changed since, the server MUST apply it.

**Tests:** `compliance/folders.test.ts › changes a folder at its version, merges a stale change to another setting, and refuses one to the same, and refuses a conflict parameter as undeclared`.

### `items/folder-change-conflict`

If `PATCH /folders/{id}` names a version the folder no longer holds and changes a setting changed since, then the server MUST answer `409 version_conflict` with `conflicting_fields` naming each such setting.

**Tests:** `compliance/folders.test.ts › changes a folder at its version, merges a stale change to another setting, and refuses one to the same, and refuses a conflict parameter as undeclared`.

### `items/folder-change-refused`

If `PATCH /folders/{id}` names no `version`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/folders.test.ts › refuses a change naming no version or no setting, and one to an id that is not a folder`.

### `items/folder-change-empty`

If `PATCH /folders/{id}` names no setting, or names a `conflict` parameter, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folders.test.ts › refuses a change naming no version or no setting, and one to an id that is not a folder`, `› changes a folder at its version, merges a stale change to another setting, and refuses one to the same, and refuses a conflict parameter as undeclared`.

### `items/folder-not-found`

If `PATCH /folders/{id}` or `POST /folders/{id}/revoke` names an id that holds no `system.folder`, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/folders.test.ts › refuses a change naming no version or no setting, and one to an id that is not a folder`.

### `items/folder-revoke`

When `POST /folders/{id}/revoke` names an active folder, the server MUST move it to `revoked` with its `revoked_at` set.

**Tests:** `compliance/folders.test.ts › revokes a folder once, and a revoked folder does not change`.

### `items/folder-revoked`

If a change or a revoke names a revoked folder, then the server MUST answer `400 invalid_transition`.

**Tests:** `compliance/folders.test.ts › revokes a folder once, and a revoked folder does not change`.

### `items/folder-setting-checked`

If a folder setting is malformed, then the server MUST answer `400`, naming the setting in `details.errors[0].path`, before it writes anything.

**Tests:** `compliance/folders.test.ts › refuses a malformed setting %j with %s naming %s, on a create and on a change`, `› caps defaults.edges at 100 edge types and 100 targets for each`.

### `items/folder-setting-unknown-type`

If `search.types`, `defaults.type` or a `first_placement` key names a well-formed type identifier nothing registered, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/folders.test.ts › refuses a malformed setting %j with %s naming %s, on a create and on a change`.

### `items/folder-setting-invalid`

If a folder setting names a malformed or `system.*` type identifier, a `filter` the listing grammar refuses, a `beneath` or edge target that is not an item id, an edge type in `defaults.edges` nothing registered or `in-folder`, more than 100 edge types or 100 targets for one, an empty or non-string `include` or `ignore` pattern, a `first_placement` directory that is absolute or drive-absolute, carries a backslash or NUL or climbs out of the folder, a `removal_threshold` with negative `files` or a `fraction` outside 0 to 1, a `search.state` other than `active` or `archived`, or a key a setting does not declare, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/folders.test.ts › refuses a malformed setting %j with %s naming %s, on a create and on a change`, `› caps defaults.edges at 100 edge types and 100 targets for each`.

### `items/folder-placement-inside`

When a `first_placement` directory climbs and comes back inside the folder, the server MUST take it.

**Tests:** `compliance/folders.test.ts › takes a placement that climbs and comes back inside the folder, on a create and on a change`.

## Links and tombstones

A type that names a `link_field` (`types/link-field`) makes that field each item's link: a value one item of the type holds.

### `items/link-taken`

If a write would give an item a non-empty value in its type's `link_field` that another item of the type holds, in any state, then the server MUST refuse it `409 link_taken` with `details.existing_id`, `details.field` and `details.value`.

**Tests:** `compliance/links.test.ts › refuses a second row a link another holds, on a create and a natural-key upsert`, `› holds a trashed row's link against every other row`.

### `items/link-every-write`

The server MUST hold every write to an item's link to `items/link-taken`, on `POST /items` and its natural-key upsert, `PATCH /items/{id}` under `merge` or `replace` at any version, a move into the type, each `POST /items/bulk` entry and each item a bulk `update_properties` writes.

**Tests:** `compliance/links.test.ts › refuses a link on an update, in either mode and at a stale version`, `› holds a retype to the type's links and frees the link a row takes away`, `› holds a retype from a type naming no link, and frees the link of a row retyped into one`, `› refuses a bulk entry a link another row holds, on both halves`, `› reports a link another row holds per row of a bulk update_properties`.

### `items/link-empty`

The server MUST NOT hold an empty string, or no value, as a link.

**Tests:** `compliance/links.test.ts › refuses a second row a link another holds, on a create and a natural-key upsert`.

### `items/link-freed`

When an item's link is cleared or changed, or the item moves out of the type, the server MUST free the old value for another item of the type.

**Tests:** `compliance/links.test.ts › frees a link its row clears or changes`, `› holds a retype to the type's links and frees the link a row takes away`.

### `items/link-keep-both`

When the server writes a keep-both copy of an item (`versions/copy-written`), the server MUST give the copy neither the item's natural key nor its link.

**Tests:** `compliance/links.test.ts › leaves the link off a keep-both copy of a row`.

### `items/link-keep-both-required`

If a write under `?conflict=auto` would resolve into a keep-both copy of an item whose type requires its `link_field`, then the server MUST answer `409 version_conflict`.

**Tests:** `compliance/links.test.ts › does not resolve into a copy where the type requires its link`.

### `items/tombstone`

When the server purges an item through `POST /items/{id}/purge` or a bulk `purge`, the server MUST record under its type a tombstone of its link and of its natural key, each it held, with `purged_at` and `settled_at` both the purge time.

**Reason:** a connector must hold a purge against a vendor that still has the item, for as long as the vendor keeps it.

**Tests:** `compliance/links.test.ts › leaves a tombstone for a purged row's link and natural key`, `› leaves tombstones from the bulk purge action`.

### `items/tombstone-trash-purge`

When the `trash-purge` housekeeping job purges an item, the server MUST record its tombstones as `items/tombstone` states.

**Tests:** waiting on #1444.

### `items/tombstone-kept`

The server MUST NOT remove a tombstone in a housekeeping job.

**Reason:** a vendor can keep a purged item for as long as it likes, and each tombstone is one small row.

**Tests:** waiting on #1444.

### `items/tombstone-own-type`

The server MUST answer and move a tombstone only under the type it was recorded under.

**Tests:** `compliance/links.test.ts › keeps each tombstone to its type, read and moved`.

### `items/tombstone-cleared`

When an item comes to hold a link a tombstone records in its type, or a natural key a tombstone records in any type, the server MUST remove that tombstone.

**Tests:** `compliance/links.test.ts › removes a tombstone when a row holds its key again`, `› removes a natural key's tombstone when an update gives a row the key`.

### `items/tombstone-link-change`

When a type changes or withdraws its `link_field` (`types/link-gained` and `types/link-withdrawn`), the server MUST drop its link tombstones.

**Tests:** `compliance/links.test.ts › forgets the old link's tombstones when a type changes its link`.

### `items/tombstone-link-kept`

When a type changes and keeps its `link_field`, the server MUST keep its link tombstones.

**Tests:** `compliance/links.test.ts › keeps the link's tombstones through a type change that keeps the link`.

### `items/tombstone-type-registered`

When a type is registered, the server MUST hold no tombstone under its identifier.

**Tests:** `compliance/links.test.ts › starts a type deleted and registered again with none of its tombstones`, `› starts a type registered again with no tombstones, even those its orphaned rows left`.

### `items/tombstone-settle`

When a key sends `POST /items/tombstones` naming a `type`, either `links` or `source` with `source_ids`, and a `settled_at`, the server MUST move each named tombstone's `settled_at` to that time where it is later, and keep it otherwise.

**Reason:** a connector whose own carrying of a purge changed the vendor's copy, closing an issue it cannot delete, moves the time to that change, so its own close does not bring the row back.

**Tests:** `compliance/links.test.ts › moves settled_at later, never earlier`.

### `items/tombstone-settle-answer`

When the server answers `POST /items/tombstones`, the server MUST answer each named tombstone as it then stands, in the order named, in UTC, leaving out a key with none.

**Tests:** `compliance/links.test.ts › answers tombstones in the order named`, `› moves settled_at later, never earlier`.

### `items/tombstone-settle-grant`

If a key that may not write the `type` sends `POST /items/tombstones`, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/links.test.ts › refuses to move a tombstone to a key that may only read the type`.

### `items/tombstone-settle-source`

If `POST /items/tombstones` names a `source` that is neither the key's own nor one it claims, then the server MUST answer `403 forbidden` with `details.source` naming it.

**Tests:** `compliance/links.test.ts › refuses to move a natural key's tombstone under a source the key does not claim`.

### `items/tombstone-settle-refused`

If `POST /items/tombstones` names no `type` or no `settled_at`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/links.test.ts › refuses a malformed tombstone request`.

### `items/tombstone-settle-invalid`

If `POST /items/tombstones` names both `links` and `source` or neither, `source` without `source_ids`, an empty `source`, more than 500 values, `links` for a type with no `link_field`, a `settled_at` that is not a timestamp, or a key it does not declare, `ids` among them, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/links.test.ts › refuses a malformed tombstone request`.

### `items/tombstone-settle-unknown-type`

If `POST /items/tombstones` names a `type` nothing registered, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/links.test.ts › refuses a malformed tombstone request`.

## Odd input

### `items/json-depth`

If a JSON request body, other than one posted to an inbound webhook endpoint, nests more than 64 levels, counting each array or object inside another and no bracket inside a string, then the server MUST answer `400 validation_error`.

**Reason:** SQLite's JSON functions stop at 1,000 levels, so a deeper body would fail inside the database as `500`.

**Tests:** `compliance/odd-input.test.ts › accepts 64 levels and refuses deeper item, extension and bulk bodies`.

### `items/search-nul`

If a `GET /search` query contains a NUL character, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/odd-input.test.ts › refuses a search query holding a NUL, and answers one without`.
