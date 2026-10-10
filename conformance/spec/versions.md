# Versions

An item carries a `version` that starts at 1 and moves with each write to its fields. The server keeps a snapshot of the item as it stood at each version it left, so that a write based on an earlier version is merged over what arrived since, or refused with a `409`.

## The version of an item

### `versions/update-step`

When `PATCH /items/{id}` names the version the item holds and carries `properties`, `tier`, `occurred_at`, `source_id` or a move to another type, the server MUST answer `200` with the item at the next version.

**Tests:** `correctness/item-versioning.test.ts › version increments on update`, `› moves a row's tier on an update`.

### `versions/metadata-keeps-version`

When `POST /items/{id}/tags`, `PUT /items/{id}/metadata` or `PUT /items/{id}/extensions/{namespace}` writes an item, the server MUST NOT move its `version` or write a snapshot.

**Reason:** tags, metadata and extensions are not the item's content, so a writer of content is not told its base moved when they change.

**Tests:** `compliance/version-order.test.ts › leaves the item at its version and its history empty after a tag write, a metadata replacement and an extension write`.

### `versions/refused-keeps-history`

If the server refuses `PATCH /items/{id}`, then the server MUST NOT write a snapshot.

**Tests:** `compliance/version-order.test.ts › leaves it after an update refused invalid_properties at the row's version, and writes a snapshot for the same update once valid`, `› leaves it after a stale update refused version_conflict, and writes a snapshot for a stale update that merges`.

### `versions/create-version-one`

When `POST /items` or an entry of `POST /items/bulk` creates an item, the server MUST give it `version` 1.

**Tests:** `compliance/version-order.test.ts › creates each item at version 1`.

### `versions/create-no-conflict`

If `POST /items` names `conflict`, then the server MUST answer `400 validation_error` naming it in `details.unknown_parameters`.

**Reason:** a create has no base to collide with, so it offers no resolution.

**Tests:** `compliance/version-order.test.ts › refuses conflict=auto on POST /items as an undeclared parameter and writes nothing`.

### `versions/update-unchanged`

When `PATCH /items/{id}` names the version the item holds and carries `properties` that are empty or equal to the item's own, the server MUST write the item at the next version.

**Reason:** a write that carries `properties` is a write to the item, whatever those properties hold.

**Tests:** `correctness/item-versioning.test.ts › writes a version for an update whose properties are empty or equal to the row's`.

### `versions/update-edges-only`

When `PATCH /items/{id}` names the version the item holds and carries only `edges`, the server MUST NOT advance the item's version.

**Reason:** an edge is not one of the item's own fields, and a version counts writes to those.

**Tests:** `correctness/item-versioning.test.ts › leaves the version, the row and the history where they were on an update that carries only edges or names the row's own type`.

### `versions/update-version-missing`

If `PATCH /items/{id}` names no `version`, then the server MUST answer `400 missing_required_field`.

**Reason:** an update that names no version cannot be told from a blind overwrite of whatever arrived since, which `PATCH /items/{id}` does not offer.

**Tests:** `correctness/item-versioning.test.ts › an update naming no version is refused`.

### `versions/update-version-invalid`

If `PATCH /items/{id}` names a `version` that is not a whole number of at least 0, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/item-versioning.test.ts › refuses an update that names nothing to change, and one naming a version that is not a whole number of at least 0`.

### `versions/update-nothing`

If `PATCH /items/{id}` names none of `properties`, a non-empty `edges`, `tier`, `occurred_at`, `source_id` or `retype: true`, then the server MUST answer `400 validation_error`.

**Reason:** an empty `properties` is a write and an empty `edges` is not, so a body that names only a version and an empty `edges` asks for nothing.

**Tests:** `correctness/item-versioning.test.ts › refuses an update that names nothing to change, and one naming a version that is not a whole number of at least 0`.

### `versions/update-race`

When two `PATCH /items/{id}` writes that name one version, name no `conflict=auto` and carry a change to the same property arrive together, the server MUST write one and answer the other `409 version_conflict`.

**Reason:** each write is judged against the item as it stands when it lands (`items/write-race`).

**Tests:** `correctness/item-versioning.test.ts › answers two updates naming one version with one 200 and one 409`.

### `versions/update-order`

When `PATCH /items/{id}` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: a `conflict` other than `auto`, `manual` or `callback`; a missing `version`, or one that is not a whole number of at least 0; a body member the operation does not declare; a malformed id; an update naming nothing to change; an `occurred_at` that is not a time; an item no item holds, in the bin or of a type the credential may not read; no write on the item's type; a `type` other than the item's; a move to a type nothing registered; an item of a type nothing registered; a `version` other than the item's where nothing writes the row; a `version` no snapshot the credential may read covers; a collision without `conflict=auto`; properties the merged result lacks.

**Reason:** the answers about the item itself, such as `404 item_not_found` and `409 type_mismatch`, come after the check for nothing to change and before the version is looked at.

**Tests:** `sync/conflict.test.ts › writes no copy where the resolution is refused after it, and writes it where the same write is not`, `compliance/version-order.test.ts › asks for the version before an undeclared body key`, `› asks for the version before the id`, `› asks for the version before whether the update names anything to change`, `› asks whether the id is well formed before whether the update names anything to change`, `› asks whether the update names anything to change before it looks the item up`, `› asks whether occurred_at is a time before it looks the item up`, `› asks whether the update names anything to change before the version`, `› looks the item up before it asks the version`, `› asks whether the key may write the item's type before it asks the version`, `› asks whether the type named is the item's before it asks the version`, `› asks whether a type to move to is registered before it asks the version`, `› asks whether a snapshot exists before it looks for a collision`, `› asks whether a snapshot exists before it judges the properties`, `› asks for a collision before it judges the properties, without conflict=auto`, `compliance/version-order.test.ts › asks whether conflict is a mode before it asks for the version`, `› answers unknown_type for an item whose type a forced delete removed before it asks the version, stale or current`, `› answers a snapshot the key may not read as ancestor_unavailable before it looks for a collision`.

## Snapshots and the history

### `versions/snapshot-written`

When the server advances an item's version, the server MUST record the item as it stood at the version it left as a snapshot under that version.

**Reason:** a merge needs the item as the writer read it, which the current row no longer holds.

**Tests:** `correctness/item-versioning.test.ts › updating an item creates a version snapshot`, `› multiple updates create multiple versions`, `› merges a stale write that collides on nothing, writes a snapshot of the row it merged over, and leaves the history as it was on one that collides`, `sync/conflict.test.ts › records the row the resolution moved on from, and gives the copy a history of its own`, `sync/idempotency.test.ts › a create naming a stale version on an existing row merges where nothing collides`.

### `versions/snapshot-fields`

When a credential sends `GET /items/{id}/versions`, the server MUST name in each snapshot the `type`, `tier`, `occurred_at` and `source_id` the item held at that version.

**Tests:** `correctness/item-versioning.test.ts › records the tier, own time, natural key and type the row had at each version`, `compliance/version-reach.test.ts › names the type each snapshot was written under`.

### `versions/history-list`

When a credential sends `GET /items/{id}/versions` for an item it may read, the server MUST answer `200` with a page in which each snapshot in `data` carries its `id`, the item's `id` as `item_id`, `version`, `properties`, `type`, `tier`, `occurred_at`, `source_id`, `writer` and `created_at`.

**Tests:** `correctness/item-versioning.test.ts › updating an item creates a version snapshot`, `› versions have correct item_id reference`, `› records the tier, own time, natural key and type the row had at each version`.

### `versions/history-ascending`

When a credential sends `GET /items/{id}/versions`, the server MUST list the snapshots oldest first.

**Tests:** `correctness/item-versioning.test.ts › multiple updates create multiple versions`, `compliance/version-reach.test.ts › pages the history and fills a page past what the key may not read`.

### `versions/history-empty`

When a credential sends `GET /items/{id}/versions` for an item the server never advanced past version 1, the server MUST answer an empty `data`.

**Tests:** `correctness/item-versioning.test.ts › version history for item with no updates is empty`.

### `versions/history-missing`

If `GET /items/{id}/versions` names an id no item holds, an item in the bin or an item of a type the credential may not read, then the server MUST answer `404 item_not_found`.

**Reason:** the type is judged as it stands now, so a credential that read the snapshots of an item before it moved to a type the credential cannot read is refused after the move.

**Tests:** `correctness/item-versioning.test.ts › answers 404 for an unknown item's history and 400 for a malformed id`, `compliance/declared-refusals.test.ts › is refused on every metadata, tag and version door by what it holds on the type, and on an inline edge it does not hold`, `compliance/unreadable-items.test.ts › $name`, `compliance/version-reach.test.ts › answers 404 for the history of an item in the bin, and the history again once it is restored`, `› answers 404 for the history of an item of a type the key may not read`, `› answers 404 item_not_found for a row moved into a type the key cannot read, though it read the snapshots before`.

### `versions/history-restored`

When a credential sends `GET /items/{id}/versions` for an item that was in the bin and has been restored, the server MUST answer its whole history.

**Reason:** a move to the bin and back writes no version (`versions/state-keeps-history`).

**Tests:** `compliance/version-reach.test.ts › answers 404 for the history of an item in the bin, and the history again once it is restored`.

### `versions/history-invalid-id`

If `GET /items/{id}/versions` names an id that is not a lowercase UUIDv7, then the server MUST answer `400 invalid_id`.

**Tests:** `correctness/item-versioning.test.ts › answers 404 for an unknown item's history and 400 for a malformed id`.

### `versions/history-no-type`

If a credential whose type map reaches no type sends `GET /items/{id}/versions`, then the server MUST answer `403 type_not_permitted`, whatever id it names.

**Reason:** an answer that depended on the id would say whether an item exists to a credential that may read nothing.

**Tests:** `compliance/version-reach.test.ts › answers 403 type_not_permitted to a key whose type map reaches no type, before it looks the item up`, `compliance/declared-refusals.test.ts › is refused on every metadata, tag and version door by what it holds on the type, and on an inline edge it does not hold`.

### `versions/history-refusal-order`

When `GET /items/{id}/versions` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: a credential whose type map reaches no type; a parameter the operation does not declare or a `limit` outside 1 to 200; a malformed id; an item no item holds, in the bin or of a type the credential may not read; a malformed `cursor`.

**Tests:** `compliance/version-reach.test.ts › answers 403 type_not_permitted to a key whose type map reaches no type, before it looks the item up`, `› refuses a parameter it does not declare 400 validation_error, and names it`, `› refuses a cursor that is malformed or that another listing issued, and takes one the door issued for another item`, `compliance/version-order.test.ts › asks whether the key reaches any type before it names an undeclared parameter`, `› asks whether limit is valid before whether the id is well formed`, `› asks whether the id is well formed before it looks the item up`.

### `versions/history-limit`

When `GET /items/{id}/versions` names a `limit` of 1 to 200, the server MUST answer a page of at most that many snapshots.

**Tests:** `compliance/version-reach.test.ts › holds a page to 1 to 200 snapshots and fills it to 50 where it names no limit`.

### `versions/history-default-limit`

When `GET /items/{id}/versions` names no `limit`, the server MUST answer a page of at most 50 snapshots.

**Tests:** `compliance/version-reach.test.ts › holds a page to 1 to 200 snapshots and fills it to 50 where it names no limit`.

### `versions/history-limit-refused`

If `GET /items/{id}/versions` names a `limit` that is not a whole number of 1 to 200, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/version-reach.test.ts › holds a page to 1 to 200 snapshots and fills it to 50 where it names no limit`.

### `versions/history-continues`

When `GET /items/{id}/versions` has snapshots beyond the page it answers, the server MUST carry a `next_cursor` that, sent as `cursor`, continues with the snapshot after the page's last.

**Tests:** `compliance/version-reach.test.ts › pages the history and fills a page past what the key may not read`, `› holds a page to 1 to 200 snapshots and fills it to 50 where it names no limit`.

### `versions/history-last-page`

When a page of `GET /items/{id}/versions` holds the last snapshot the credential may read, the server MUST answer `next_cursor` `null`.

**Tests:** `compliance/version-reach.test.ts › pages the history and fills a page past what the key may not read`, `› holds a page to 1 to 200 snapshots and fills it to 50 where it names no limit`, `compliance/version-order.test.ts › answers next_cursor null when the snapshots fill the page exactly, and a cursor one snapshot short`, `› answers next_cursor null when the page fills with the readable snapshots and only ones the key may not read follow`.

### `versions/history-cursor-refused`

If `GET /items/{id}/versions` names a `cursor` that is malformed or that another listing issued, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/version-reach.test.ts › refuses a cursor that is malformed or that another listing issued, and takes one the door issued for another item`.

### `versions/include-first-page`

When a credential sends `GET /items/{id}` with `include=versions`, the server MUST carry the first 50 snapshots of the item that the credential may read in `versions`, as a page with `data` and `next_cursor`.

**Tests:** `compliance/version-reach.test.ts › carries the first 50 snapshots on the item read and lets the listing continue from its next_cursor`, `compliance/envelope.test.ts › carries an item's hydrated history as a page`.

### `versions/include-continues`

When a credential sends the `next_cursor` of the `versions` that `GET /items/{id}` carried to `GET /items/{id}/versions` as `cursor`, the server MUST continue with the snapshot after the last one the read carried.

**Tests:** `compliance/version-reach.test.ts › carries the first 50 snapshots on the item read and lets the listing continue from its next_cursor`.

## What a key may read of a history

### `versions/reach-left-out`

When a credential sends `GET /items/{id}/versions` for an item it may read, the server MUST leave out each snapshot of a type the credential may not read, and answer the rest.

**Reason:** a snapshot holds the properties of the type the item had then, which the credential may not read. A credential that may read the item is not refused for it.

**Tests:** `compliance/version-reach.test.ts › leaves out of the history the snapshots of a type the key may not read`.

### `versions/reach-include`

When a credential sends `GET /items/{id}` with `include=versions`, the server MUST leave out of `versions` each snapshot of a type the credential may not read.

**Tests:** `compliance/version-reach.test.ts › leaves them out of the history the item read carries`.

### `versions/reach-page-filled`

When snapshots are left out of a page of `GET /items/{id}/versions`, the server MUST fill the page with the snapshots after them, up to the `limit`.

**Tests:** `compliance/version-reach.test.ts › pages the history and fills a page past what the key may not read`.

## Who wrote a version

A version's writer is the sign-in whose request wrote it: the owner's browser session, an app, a key or the private local command. The server takes it from the request's credential when it writes the version and keeps it with the version.

### `versions/writer-recorded`

When the server writes an item at a version, the server MUST record as that version's writer the sign-in whose request wrote it: the owner's browser session, an app, a key or the private local command.

**Reason:** the credential is the one thing about a request that its sender cannot choose, so a person reading the history can trust where each change came from.

**Tests:** `compliance/version-writers.test.ts › names the key that wrote each version by its id and label`, `› names the app that wrote a version by the id and name the sign-in listing gives it`, `› names the owner's browser and the local command that changed an app's record`, `› names the sign-in whose write lost as the writer of the copy that keeps it`.

### `versions/writer-field`

When a credential sends `GET /items/{id}/versions`, or `GET /items/{id}` with `include=versions`, the server MUST carry in each snapshot a `writer` holding the `kind`, `id` and `name` of the sign-in that wrote that version, or `null` when no sign-in wrote it.

**Tests:** `compliance/version-writers.test.ts › names the key that wrote each version by its id and label`, `› names no writer for a version the enrichment sweep wrote`.

### `versions/writer-kind`

The server MUST give a writer the `kind` `browser` for the owner's browser session, `app` for an app, `key` for a key and `local` for the private local command.

**Tests:** `compliance/version-writers.test.ts › names the key that wrote each version by its id and label`, `› names the app that wrote a version by the id and name the sign-in listing gives it`, `› names the owner's browser and the local command that changed an app's record`.

### `versions/writer-id`

The server MUST give a browser, an app or a key that wrote a version the `id` that `GET /owner/sign-ins` lists it under, and the private local command the `id` `local`.

**Reason:** a reader can tell which listed sign-in wrote a version, and end it by that id.

**Tests:** `compliance/version-writers.test.ts › names the app that wrote a version by the id and name the sign-in listing gives it`, `› names the owner's browser and the local command that changed an app's record`.

### `versions/writer-name`

When the server records a version's writer, the server MUST give it the `name` that `GET /owner/sign-ins` gives that sign-in at that moment, and `Local command` for the private local command.

**Tests:** `compliance/version-writers.test.ts › names the key that wrote each version by its id and label`, `› names the app that wrote a version by the id and name the sign-in listing gives it`, `› names the owner's browser and the local command that changed an app's record`.

### `versions/writer-name-bounds`

The server MUST hold a writer's `name` to at most 200 characters, none of them a control character or a bidirectional formatting character.

**Reason:** a browser's `User-Agent`, an app's registered name and a key's label are text a client chose, which the listing replaces where it is unprintable or too long (`keys-and-oauth/sign-ins-unprintable-name`).

**Tests:** `compliance/version-writers.test.ts › names a key or an app whose chosen name is unprintable or too long as the listing does`.

### `versions/writer-kept`

When the sign-in that wrote a version has ended, whether a key revoked, an app ended or a browser session ended, the server MUST still name it in that version's `writer` with the `id` and `name` it had when it wrote.

**Reason:** ending a sign-in stops what it can do next and changes nothing it did, and its name is kept with the version rather than looked up.

**Tests:** `compliance/version-writers.test.ts › still names each writer once the key is revoked, the app ended and the browser session ended`.

### `versions/writer-not-settable`

If the body of a write to an item names a `writer`, then the server MUST record the sign-in that sent the write as the writer.

**Reason:** `POST /items` drops a body key it does not declare (`items/create-undeclared-key`) and `PATCH /items/{id}` refuses one (`items/update-undeclared-key`), so no body reaches the writer.

**Tests:** `compliance/version-writers.test.ts › takes the writer from the credential, drops one a create names and refuses one an update names`.

### `versions/writer-sender`

When a working copy sends a write it queued earlier, the server MUST record as the writer the sign-in that sends it.

**Reason:** the server knows only the credential of the request it answers, not who made the edit offline or which sign-in the device held when it was made.

**Tests:** `compliance/version-writers.test.ts › names the sign-in that sends a queued write, not the one that read the version it is based on`.

### `versions/writer-none`

When the server writes a version that no request asked for, such as an enrichment, the server MUST record `null` as the writer.

**Tests:** `compliance/version-writers.test.ts › names no writer for a version the enrichment sweep wrote`.

### `versions/writer-archive`

When `GET /export?format=archive` carries an item, the server MUST carry the `writer` of each snapshot and, as the line's `writer`, the writer of the item's current version.

**Tests:** `compliance/version-writers.test.ts › carries each writer through an archive, the current version's too, and keeps them on restore`.

### `versions/writer-restore`

When `POST /restore` writes an archived item, the server MUST keep as writers the ones the archive names for each snapshot and for the current version, and `null` where it names none.

**Reason:** a restore puts back a history that others wrote, so the sign-in that restores it wrote none of it. Only the owner or the local command restores (`search-and-filters/restore-operator`), and the server checks an archived writer's form, not that the sign-in it names wrote the version.

**Tests:** `compliance/version-writers.test.ts › carries each writer through an archive, the current version's too, and keeps them on restore`.

### `versions/writer-restore-invalid`

If an archive names a writer that is neither `null` nor an object holding a `kind` of `browser`, `app`, `key` or `local`, an `id` of 1 to 200 characters and a `name` of at least one character that `versions/writer-name-bounds` admits with no space at either end, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/version-writers.test.ts › refuses an archive that names a malformed writer`.

## A stale write that collides

A write is stale when it names a version the item no longer holds.

### `versions/stale-collision`

If `PATCH /items/{id}` names a version the item no longer holds, whose snapshot the credential may read, the write carries a change to a field that has changed since, and the request names no `conflict=auto`, then the server MUST answer `409 version_conflict`.

**Tests:** `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `compliance/error-codes.test.ts › rejects a stale write whose base version is retained`, `correctness/merge-policy.test.ts › keep-both and LWW arrive in one 409, and the resolution reads back`, `sync/conflict.test.ts › keeps both copies in one write where the type says to`.

### `versions/stale-envelope`

When `PATCH /items/{id}` answers `409 version_conflict` for a collision, the server MUST carry `current` and `ancestor`, each the item as it stood, with its `id`, `version`, `properties`, `type`, `tier`, `occurred_at` and `source_id`.

**Reason:** `current` is the item now and `ancestor` is the item at the version the writer named, so that the writer can merge the two itself.

**Tests:** `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `› refuses a stale write that collides on tier, occurred_at or source_id`, `› names the type each side of a conflict held`, `device/fidelity.test.ts › matches the version_conflict envelope, field for field`.

### `versions/stale-ancestor-version`

When `PATCH /items/{id}` answers `409 version_conflict` for a collision, the server MUST give `ancestor` the `version` the write named.

**Tests:** `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `compliance/error-codes.test.ts › rejects a stale write whose base version is retained`.

### `versions/stale-fields`

When `PATCH /items/{id}` answers `409 version_conflict` for a collision, the server MUST list each colliding field in `conflicting_fields`, in ascending order.

**Tests:** `correctness/merge-policy.test.ts › keep-both and LWW arrive in one 409, and the resolution reads back`, `› keep-both for body, last-writer-wins for url and title`, `› status (most-conflicted task field) takes the latter writer; body keeps both`, `correctness/item-versioning.test.ts › names an item field beside a property in conflicting_fields in ascending order, and not a field the stale write does not carry`.

### `versions/stale-merge-policy`

When `PATCH /items/{id}` answers `409 version_conflict` for a collision, the server MUST carry in `merge_policy` the policy of the item's current type that `types/merge-policy` states.

**Tests:** `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `compliance/error-codes.test.ts › rejects a stale write whose base version is retained`, `correctness/merge-policy.test.ts › keep-both and LWW arrive in one 409, and the resolution reads back`.

### `versions/stale-code-header`

When `PATCH /items/{id}` answers `409` `version_conflict` or `ancestor_unavailable`, or `PATCH /edges/{id}` answers `409` `version_conflict`, the server MUST carry the code in the `X-Error-Code` header.

**Tests:** `correctness/item-versioning.test.ts › stamps the error code on the X-Error-Code header of a 409`, `compliance/edge-refusals.test.ts › answers a stale edge update with the edge as it stands and none of ancestor, conflicting_fields or merge_policy`.

### `versions/collision-item-field`

If a stale `PATCH /items/{id}` that names no `conflict=auto` carries a `tier`, `occurred_at` or `source_id` other than the one the item held at the version it names, and another writer changed that field since, then the server MUST answer `409 version_conflict` naming that field in `conflicting_fields`, beside any property that collides.

**Tests:** `correctness/item-versioning.test.ts › refuses a stale write that collides on tier, occurred_at or source_id`, `› names an item field beside a property in conflicting_fields in ascending order, and not a field the stale write does not carry`.

### `versions/collision-type`

If a stale `PATCH /items/{id}` moves the item to a type other than the one it holds and another writer moved it since the version the write names, then the server MUST answer `409 version_conflict` naming `type` in `conflicting_fields`, whatever else the write carries.

**Reason:** landing the move would undo a move the writer never saw. A stale write that does not move the item collides with nothing on `type`.

**Tests:** `correctness/item-versioning.test.ts › refuses a stale move onto a row another writer moved since, naming type`, `› names the type each side of a conflict held`.

### `versions/collision-omitted`

When a stale write does not carry a `tier`, `occurred_at` or `source_id`, or under `properties_mode: merge` a property, that another writer changed since the version it names, the server MUST NOT name that field in `conflicting_fields`.

**Tests:** `correctness/item-versioning.test.ts › names an item field beside a property in conflicting_fields in ascending order, and not a field the stale write does not carry`, `correctness/merge-policy.test.ts › non-conflicting writes from two clients both apply (different fields)`.

### `versions/collision-echo`

When a stale write carries a property, `tier`, `occurred_at` or `source_id` equal to the one the item held at the version it names, the server MUST NOT count it as a change that collides.

**Reason:** an echo is the value the writer read, not a change the writer made.

**Tests:** `correctness/item-versioning.test.ts › moves the type on a stale write as on a current one`, `sync/conflict.test.ts › resolves a colliding item field to the later writer, and leaves an echoed one alone`.

### `versions/collision-echo-kept`

When a stale write carries a property, `tier`, `occurred_at` or `source_id` equal to the one the item held at the version it names, the server MUST leave the current item's value where the other writer put it.

**Tests:** `correctness/item-versioning.test.ts › moves the type on a stale write as on a current one`, `sync/conflict.test.ts › resolves a colliding item field to the later writer, and leaves an echoed one alone`.

### `versions/collision-clear-both`

When a stale write under `properties_mode: replace` clears a property that another writer also cleared since the version it names, the server MUST NOT count it as a collision.

**Tests:** `correctness/item-versioning.test.ts › takes a clear both writers made as an echo`.

### `versions/collision-same-value`

If a stale `PATCH /items/{id}` that names no `conflict=auto` sets a property or the `tier` to the value another writer set it to since the version it names, then the server MUST answer `409 version_conflict` naming that field.

**Reason:** the two writers each changed the field, so the server cannot tell that they agree.

**Tests:** `correctness/item-versioning.test.ts › refuses a stale write that sets a property to the value another writer set since`, `› refuses a stale write that collides on tier, occurred_at or source_id`.

### `versions/collision-replace-clear`

If a stale `PATCH /items/{id}` that names no `conflict=auto`, under `properties_mode: replace`, leaves out a property that the item held at the version it names and that another writer has since set to a different value, then the server MUST answer `409 version_conflict` naming that property.

**Tests:** `correctness/item-versioning.test.ts › refuses a stale replace that leaves out a field the other writer changed since`.

### `versions/collision-prototype-key`

When a stale write carries or clears a property named like a member every object has, such as `constructor`, the server MUST judge it by what the item holds, as it judges any other property.

**Tests:** `correctness/item-versioning.test.ts › clears a field named like a prototype member as any other`.

## A stale write that merges

### `versions/merge-stale`

When `PATCH /items/{id}` names a version the item no longer holds, whose snapshot the credential may read, and the write carries no change to a field that has changed since, the server MUST apply the write's changes over the current item where the result meets its type and takes no link another item holds.

**Tests:** `correctness/merge-policy.test.ts › non-conflicting writes from two clients both apply (different fields)`, `correctness/item-versioning.test.ts › merges a stale write on an item field nobody else changed`, `› merges a stale write that collides on nothing, writes a snapshot of the row it merged over, and leaves the history as it was on one that collides`.

### `versions/merge-item-fields`

When a stale `PATCH /items/{id}` carries a `tier`, `occurred_at` or `source_id` that nobody else changed since the version it names, the server MUST apply it over the current item.

**Tests:** `correctness/item-versioning.test.ts › merges a stale write on an item field nobody else changed`, `› merges a stale write on occurred_at or source_id that nobody else changed`.

### `versions/merge-version`

When the server applies a stale write over the current item, by a merge or by a resolution under `conflict=auto`, the server MUST write the item at the version after the one it held when the write landed.

**Reason:** a merged write is told from a clean one by its version, which is more than one step past the version the writer named.

**Tests:** `correctness/item-versioning.test.ts › merges a stale write that collides on nothing, writes a snapshot of the row it merged over, and leaves the history as it was on one that collides`, `› clears a field a stale replace leaves out, where nobody changed it since`, `sync/conflict.test.ts › resolves a property both writers set to one value as a collision`.

### `versions/merge-replace-clear`

When a stale `PATCH /items/{id}` under `properties_mode: replace` leaves out a property that nobody changed since the version it names, the server MUST clear that property.

**Reason:** under `replace` the body is the whole of the writer's properties, so a property the writer read and left out is one the writer cleared.

**Tests:** `correctness/item-versioning.test.ts › clears a field a stale replace leaves out, where nobody changed it since`.

### `versions/merge-replace-keeps-added`

When a stale `PATCH /items/{id}` under `properties_mode: replace` leaves out a property that another writer added since the version it names, the server MUST keep that property on the item.

**Reason:** the writer never read the property, so leaving it out clears nothing. A type that came to require it is still met.

**Tests:** `correctness/item-versioning.test.ts › judges a stale write by its merged result, not by the body laid over the current row`.

### `versions/merge-retype`

When a stale `PATCH /items/{id}` names `retype: true` and another type and collides on nothing, the server MUST move the item to that type, with or without `properties`, where the result meets that type and takes no link another item holds.

**Tests:** `correctness/item-versioning.test.ts › moves the type on a stale write as on a current one`, `› moves the type with retype alone at a stale version`.

### `versions/merge-short`

If the properties a stale `PATCH /items/{id}` that carries `properties` or a move would merge lack a field required by the item's type, or by the type the write moves it to, then the server MUST answer `400 invalid_properties` naming the field.

**Reason:** the merged result is what the type judges, and the body alone is not.

**Tests:** `correctness/item-versioning.test.ts › refuses a stale move whose merged properties fall short of the type entered`, `› names the field a merged result lacks when a stale write leaves the row short of its type`.

### `versions/merge-type-lax`

When a stale `PATCH /items/{id}` carries only `tier`, `occurred_at` or `source_id`, the server MUST merge it without holding the item to the required fields of its type.

**Reason:** a type may gain a required field while items that lack it stand, and a write that touches no property does not bring them to it.

**Tests:** `correctness/item-versioning.test.ts › holds a stale write to the type only where it carries properties or a move`.

## A version no snapshot covers

### `versions/ancestor-none`

If `PATCH /items/{id}` carries `properties`, `tier`, `occurred_at`, `source_id` or a move to another type and names a version other than the one the item holds, which no snapshot covers, 0 and a version never issued included, then the server MUST answer `409 ancestor_unavailable`.

**Tests:** `correctness/item-versioning.test.ts › a version no client ever read answers ancestor_unavailable`, `compliance/error-codes.test.ts › rejects an update naming a version that never existed`.

### `versions/ancestor-thinned`

If `PATCH /items/{id}` carries `properties` and names a version whose snapshot the version thinner removed, then the server MUST answer `409 ancestor_unavailable`.

**Tests:** `compliance/version-policy.test.ts › answers a write naming a version the thinner removed ancestor_unavailable, and never merges it, whatever conflict asks`.

### `versions/ancestor-envelope`

When `PATCH /items/{id}` answers `409 ancestor_unavailable`, the server MUST carry `current`, with the item's `id`, and `requested_version`, and none of `ancestor`, `conflicting_fields` or `merge_policy`.

**Reason:** there is no ancestor to compare against, so offering any of the three would name a resolution that cannot be performed.

**Tests:** `correctness/item-versioning.test.ts › a version no client ever read answers ancestor_unavailable`, `compliance/error-codes.test.ts › rejects an update naming a version that never existed`, `device/fidelity.test.ts › matches the ancestor_unavailable envelope, including the ancestor it does not carry`, `compliance/version-policy.test.ts › answers a write naming a version the thinner removed ancestor_unavailable, and never merges it, whatever conflict asks`.

### `versions/ancestor-never-merged`

When `PATCH /items/{id}` names a version other than the one the item holds, which no snapshot covers, the server MUST NOT merge or resolve the write, whatever `conflict` it names.

**Tests:** `sync/conflict.test.ts › never resolves a write naming a version no snapshot covers, whatever conflict asks`, `compliance/version-policy.test.ts › answers a write naming a version the thinner removed ancestor_unavailable, and never merges it, whatever conflict asks`.

### `versions/ancestor-unreadable`

If `PATCH /items/{id}` carries `properties`, `tier`, `occurred_at`, `source_id` or a move to another type and names a version whose snapshot is of a type the credential may not read, then the server MUST answer `409 ancestor_unavailable`.

**Reason:** the snapshot would be answered as `ancestor`, and it holds the properties of a type the credential may not read. The write is refused and merged nowhere.

**Tests:** `compliance/version-reach.test.ts › answers a stale update naming an unreadable snapshot ancestor_unavailable`, `› does not merge a stale update against a snapshot the key may not read`.

### `versions/ancestor-unreadable-create`

If `POST /items` names a natural key that a live item holds and a version whose snapshot is of a type the credential may not read, then the server MUST answer `409 ancestor_unavailable`.

**Tests:** `compliance/version-reach.test.ts › answers a conditional create naming an unreadable snapshot ancestor_unavailable`, `› leaves the row as it was when a conditional create names a snapshot the key may not read, and merges for one that may`.

### `versions/ancestor-unreadable-bulk`

If an entry of `POST /items/bulk` under `mode: upsert` names a version whose snapshot is of a type the credential may not read, then the server MUST refuse the entry `ancestor_unavailable`.

**Tests:** `compliance/version-reach.test.ts › answers a bulk entry naming an unreadable snapshot ancestor_unavailable`, `› rolls a bulk page back when an entry names a snapshot the key may not read, as an atomic page does, and leaves the row as it was`, `› leaves the row as it was when a non-atomic bulk entry names a snapshot the key may not read`.

## A write that carries nothing to merge

### `versions/stale-bare`

If `PATCH /items/{id}` carries only `edges`, or only `retype: true` with the item's own type, and names a version other than the one the item holds, 0 and a version ahead of the item included, then the server MUST answer `409 version_conflict`.

**Reason:** the write carries no field to compare, so the server looks up no snapshot. A write that names a field and a version no snapshot covers is answered `ancestor_unavailable` (`versions/ancestor-none`).

**Tests:** `correctness/item-versioning.test.ts › answers an update that carries only edges or names the row's own type version_conflict with no ancestor, whichever version it names`, `› answers an edges-only stale write with the envelope minus its merge half`.

### `versions/stale-bare-envelope`

When `PATCH /items/{id}` answers `409 version_conflict` to a write that carries nothing to merge, the server MUST carry `current`, with the item's `id` and the item as it stands, and none of `ancestor`, `conflicting_fields`, `merge_policy` or `requested_version`.

**Tests:** `correctness/item-versioning.test.ts › answers an edges-only stale write with the envelope minus its merge half`, `› answers an update that carries only edges or names the row's own type version_conflict with no ancestor, whichever version it names`.

## A create that names a version

`POST /items` resolves an item by its natural key or its `id` before it looks at a `version`, so `versions/create-order` says which answer a request gets.

### `versions/create-order`

When `POST /items` names a natural key or an `id` that an item holds, with a `version`, and meets more than one of the answers this chapter and `items/natural-key-id-mismatch` give it, the server MUST give the first in this order: an acknowledgment of a repeated `id` or of a natural key in the bin; a natural key that resolves an item the credential may not read; an `id` that is not the one the natural key resolves; a type other than the item's; a version no snapshot the credential may read covers; a collision.

**Reason:** a version is the precondition of a write, and a repeat that is acknowledged writes nothing, so it has no precondition to fail.

**Tests:** `sync/acknowledged.test.ts › acknowledges an item repeat whatever version it names, and writes nothing`, `› acknowledges a create naming the natural key of a row in the bin whatever version it names, and writes nothing`, `compliance/version-order.test.ts › asks whether the key may read the item its natural key resolves before whether the id is the item's`, `› asks whether the id is the one the natural key resolves before whether the type is the item's`, `› asks whether the type is the item's before it asks the version`, `› asks whether a snapshot exists before it looks for a collision`.

### `versions/create-stale-collides`

If `POST /items` names a natural key that a live item holds, a version the item no longer holds and a change to a field that has changed since, then the server MUST answer `409 version_conflict` with the `current` and `ancestor` of `versions/stale-envelope`.

**Reason:** a create that resolves a live item is an update, and a version on it is the precondition `PATCH /items/{id}` takes.

**Tests:** `sync/idempotency.test.ts › a create naming a stale version on an existing row is refused`.

### `versions/create-stale-merges`

When `POST /items` names a natural key that a live item holds and a version the item no longer holds, and the create carries no change to a field that has changed since, the server MUST apply it over the current item where the result meets its type and takes no link another item holds.

**Tests:** `sync/idempotency.test.ts › a create naming a stale version on an existing row merges where nothing collides`.

### `versions/create-ancestor-none`

If `POST /items` names a natural key that a live item holds and a version other than the one the item holds, which no snapshot covers, 0 included, then the server MUST answer `409 ancestor_unavailable`.

**Tests:** `sync/idempotency.test.ts › takes a create's version of zero as the claim that there is no row`.

### `versions/create-names-row`

When `POST /items` answers `409 version_conflict` or `409 ancestor_unavailable` for a natural key, the server MUST name the item the key resolved in `current.id`.

**Reason:** the request names a key and not an id, so the answer is the one way the writer learns which item refused it, and a device needs that to hold the item rather than a second copy of it.

**Tests:** `sync/idempotency.test.ts › a create naming a stale version on an existing row is refused`, `› takes a create's version of zero as the claim that there is no row`.

### `versions/create-claim-none`

When `POST /items` names a `version` of 0, a natural key no item holds and no `id` an item holds, the server MUST create the item at version 1.

**Reason:** the server never gives an item version 0, so 0 is the claim that the writer read no item under the key.

**Tests:** `sync/idempotency.test.ts › takes a create's version of zero as the claim that there is no row`.

### `versions/create-repeat-version`

When the server acknowledges `POST /items` under `items/create-repeat`, the server MUST do so whatever `version` it names.

**Tests:** `sync/acknowledged.test.ts › acknowledges an item repeat whatever version it names, and writes nothing`.

### `versions/create-trashed-version`

When the server acknowledges `POST /items` under `items/natural-key-trashed`, the server MUST do so whatever `version` it names.

**Tests:** `sync/acknowledged.test.ts › acknowledges a create naming the natural key of a row in the bin whatever version it names, and writes nothing`.

### `versions/bulk-claim-none`

When a `POST /items/bulk` entry names a `version`, a natural key no item holds and no `id` an item holds, the server MUST create the item at version 1, under `mode: upsert` and under `mode: create_only`.

**Tests:** `sync/idempotency.test.ts › takes a bulk entry's version of zero as the claim that there is no row, in both modes`.

### `versions/bulk-ancestor-none`

If a `POST /items/bulk` entry under `mode: upsert` names a natural key that a live item holds and a version other than the one the item holds, which no snapshot covers, 0 included, then the server MUST refuse the entry `ancestor_unavailable`.

**Tests:** `sync/idempotency.test.ts › takes a bulk entry's version of zero as the claim that there is no row, in both modes`.

### `versions/bulk-merge`

When a `POST /items/bulk` entry under `mode: upsert` names a stale `version` whose snapshot the credential may read and changes no field another writer changed since, the server MUST merge it and report it `updated`, on a page under `atomic: false`, where the result meets its type and takes no link another item holds.

**Tests:** `compliance/version-order.test.ts › merges an entry that collides on nothing, and refuses one that collides as errored with its code and message`.

### `versions/bulk-collision-error`

When the server refuses a `POST /items/bulk` entry `version_conflict` under `atomic: false`, the server MUST carry `code` and `message` alone in the entry's `error`.

**Tests:** `compliance/version-order.test.ts › merges an entry that collides on nothing, and refuses one that collides as errored with its code and message`.

### `versions/bulk-create-only-version`

When a `POST /items/bulk` entry under `mode: create_only` names a natural key that a live item holds, the server MUST report it `skipped`, whatever `version` it names.

**Tests:** `sync/idempotency.test.ts › takes a bulk entry's version of zero as the claim that there is no row, in both modes`.

## Resolving a collision

The rules below are written for `PATCH /items/{id}`, the one operation that takes a `conflict` mode.

### `versions/conflict-manual`

When `PATCH /items/{id}` names `conflict=manual` or `conflict=callback`, the server MUST answer as it does where the request names no `conflict`.

**Tests:** `sync/conflict.test.ts › takes conflict=manual and conflict=callback as absent, and refuses any other value`.

### `versions/conflict-invalid`

If `PATCH /items/{id}` names a `conflict` other than `auto`, `manual` or `callback`, then the server MUST answer `400 validation_error`.

**Tests:** `sync/conflict.test.ts › takes conflict=manual and conflict=callback as absent, and refuses any other value`.

### `versions/auto-resolved`

When the server answers `200` to a stale `PATCH /items/{id}?conflict=auto` that collided on a property, the `tier`, `occurred_at` or `source_id`, the server MUST answer the item with the collision resolved field by field.

**Reason:** the same write without `conflict=auto` is refused `409 version_conflict` (`versions/stale-collision`).

**Tests:** `sync/conflict.test.ts › keeps both copies in one write where the type says to`, `› resolves a colliding tier or source_id to the later writer`, `› resolves a property both writers set to one value as a collision`.

### `versions/auto-last-writer`

When a colliding field resolves under `last_writer_wins`, the server MUST give the item the later writer's value.

**Tests:** `sync/conflict.test.ts › keeps both copies in one write where the type says to`, `› resolves a colliding tier or source_id to the later writer`.

### `versions/auto-keep-both`

When a colliding property resolves under `keep_both_copies`, the server MUST leave the value the item holds on the item.

**Tests:** `sync/conflict.test.ts › keeps both copies in one write where the type says to`.

### `versions/auto-item-fields`

When a colliding `tier`, `occurred_at` or `source_id` resolves under `conflict=auto`, the server MUST report `last_writer_wins` for it in `conflict_resolution.strategy`.

**Reason:** these are the item's own fields and not properties, so the type declares no strategy for one, and a copy has nothing to keep of a field it does not carry.

**Tests:** `sync/conflict.test.ts › resolves a colliding item field to the later writer, and leaves an echoed one alone`, `› resolves a colliding tier or source_id to the later writer`.

### `versions/auto-clear-last-writer`

When a stale `PATCH /items/{id}?conflict=auto` under `properties_mode: replace` clears a property that collides and resolves under `last_writer_wins`, the server MUST clear it.

**Tests:** `sync/conflict.test.ts › resolves a field a stale replace cleared by the policy: cleared under last-writer-wins, kept and left off the copy under keep-both`.

### `versions/auto-clear-keep-both`

When a stale `PATCH /items/{id}?conflict=auto` under `properties_mode: replace` clears a property that collides and resolves under `keep_both_copies`, the server MUST keep the value the item holds.

**Tests:** `sync/conflict.test.ts › resolves a field a stale replace cleared by the policy: cleared under last-writer-wins, kept and left off the copy under keep-both`.

### `versions/auto-clear-keep-both-copy`

When a stale `PATCH /items/{id}?conflict=auto` under `properties_mode: replace` clears a property that collides and resolves under `keep_both_copies`, the server MUST leave the property off the conflicted copy.

**Tests:** `sync/conflict.test.ts › resolves a field a stale replace cleared by the policy: cleared under last-writer-wins, kept and left off the copy under keep-both`.

### `versions/auto-no-collision`

When a stale `PATCH /items/{id}?conflict=auto` collides on nothing, the server MUST merge it as it does without `conflict`.

**Tests:** `sync/conflict.test.ts › applies a clear nobody collided with under conflict=auto, and resolves nothing`.

### `versions/auto-no-collision-report`

When a stale `PATCH /items/{id}?conflict=auto` collides on nothing, the server MUST NOT carry `conflict_resolution`.

**Tests:** `sync/conflict.test.ts › applies a clear nobody collided with under conflict=auto, and resolves nothing`.

### `versions/auto-report`

When a stale `PATCH /items/{id}?conflict=auto` resolves a collision, the server MUST carry `conflict_resolution` beside the item, with `fields` naming each colliding field and `strategy` naming the strategy applied to each.

**Tests:** `sync/conflict.test.ts › keeps both copies in one write where the type says to`, `› resolves a colliding tier or source_id to the later writer`, `› resolves a property both writers set to one value as a collision`, `device/fidelity.test.ts › matches a resolution that names a sibling and one that does not`.

### `versions/auto-report-copy`

When a stale `PATCH /items/{id}?conflict=auto` writes a conflicted copy, the server MUST name the copy in `conflict_resolution.conflicted_copy_id`.

**Reason:** the copy's id appears nowhere else in the answer, so a client that caused the copy has no other way to reach it.

**Tests:** `sync/conflict.test.ts › keeps both copies in one write where the type says to`, `device/fidelity.test.ts › matches a resolution that names a sibling and one that does not`.

### `versions/auto-report-no-copy`

When a stale `PATCH /items/{id}?conflict=auto` resolves a collision on no `keep_both_copies` property, the server MUST NOT carry `conflicted_copy_id`.

**Tests:** `sync/conflict.test.ts › resolves a colliding tier or source_id to the later writer`, `device/fidelity.test.ts › matches a resolution that names a sibling and one that does not`.

### `versions/auto-type-move`

If a stale `PATCH /items/{id}?conflict=auto` collides and also moves the item to another type, then the server MUST answer `409 version_conflict`.

**Reason:** the policy that applies is the type being left, and a copy the resolution wrote would belong to neither type.

**Tests:** `sync/conflict.test.ts › refuses to resolve a colliding write that also moves the type`.

### `versions/auto-type-moved`

If a stale `PATCH /items/{id}?conflict=auto` moves the item to a type other than the one it holds and another writer moved it since the version the write names, then the server MUST answer `409 version_conflict` naming `type` in `conflicting_fields`.

**Tests:** `sync/conflict.test.ts › refuses to resolve a stale move onto a row another writer moved since`.

### `versions/auto-refused-no-copy`

If a stale `PATCH /items/{id}?conflict=auto` is refused after its collision was resolved, then the server MUST write no conflicted copy.

**Reason:** a copy of a write that did not land would show the person a conflict that never took place.

**Tests:** `sync/conflict.test.ts › writes no copy where the resolution is refused after it, and writes it where the same write is not`.

### `versions/auto-race`

When two stale `PATCH /items/{id}?conflict=auto` writes that name one version, move the item to no other type and collide on a `keep_both_copies` property arrive together, and the server answers both `200`, the server MUST have written a conflicted copy for each.

**Tests:** `sync/conflict.test.ts › resolves two stale writes arriving together, each into a copy of its own`.

## A conflicted copy

A rule in this section and the next holds for every conflicted copy the server writes, which only a resolution under `conflict=auto` does, where a `keep_both_copies` property collides.

### `versions/copy-written`

When the server answers `200` to a stale `PATCH /items/{id}?conflict=auto` that collided on a `keep_both_copies` property, the server MUST have written the losing value to a new item of the item's type, tagged `conflicted-copy`.

**Tests:** `sync/conflict.test.ts › keeps both copies in one write where the type says to`.

### `versions/copy-version`

When the server writes a conflicted copy, the server MUST write it at version 1, with no history.

**Tests:** `sync/conflict.test.ts › records the row the resolution moved on from, and gives the copy a history of its own`.

### `versions/copy-source`

When the server writes a conflicted copy, the server MUST write it under the original's `source`, not the writer's.

**Reason:** the copy is a copy of the item and not a record of who lost, and the write names no source of its own.

**Tests:** `sync/conflict.test.ts › writes the conflicted copy under the original's source and without its natural key`.

### `versions/copy-tags`

When the server writes a conflicted copy, the server MUST give it the original's tags beside `conflicted-copy`.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy the original's tags and every edge a second copy may hold`.

### `versions/copy-edges-own`

When the server writes a conflicted copy, the server MUST give it a copy of each outbound edge of the original whose type is written at its source and each inbound edge whose type is written at its target, that no other rule of this section withholds.

**Reason:** a track names its album, so the copy takes the album's place under its parent and what the album is about, and is not made the album of the tracks. A copy with no edges and no tags sits outside every project, tag and view the original was in, which is where nobody looks for it.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy the original's tags and every edge a second copy may hold`, `› gives the conflicted copy only the edges the original's own file writes, none that cascade or block`.

### `versions/copy-edges-cardinality`

When the server writes a conflicted copy, the server MUST NOT give it an edge that the cardinality of its type would not let its other end hold beside the original's, such as an edge to a child of the original or a `supersedes` edge.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy the original's tags and every edge a second copy may hold`.

### `versions/copy-edges-grants`

When the server writes a conflicted copy, the server MUST NOT give it an edge the writer could not have made with `POST /edges`, which asks write on the source's type, write on the edge type and read on the target's type.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy no edge its writer could not have made, and none to a row in the bin`.

### `versions/copy-edges-bin`

When the server writes a conflicted copy, the server MUST NOT give it an edge whose other end is in the bin.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy no edge its writer could not have made, and none to a row in the bin`, `› gives the conflicted copy only the edges the original's own file writes, none that cascade or block`.

### `versions/copy-edges-no-cascade`

When the server writes a conflicted copy, the server MUST NOT give it an outbound edge of a type that cascades on delete.

**Reason:** discarding the copy, which is what a person does with one, would otherwise move to the bin what the original points at.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy only the edges the original's own file writes, none that cascade or block`.

### `versions/copy-edges-no-block`

When the server writes a conflicted copy, the server MUST NOT give it an edge of a type that blocks a delete.

**Reason:** discarding the copy would otherwise be refused for an edge the copy was only given.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy only the edges the original's own file writes, none that cascade or block`.

### `versions/copy-edges-announced`

When the server writes a conflicted copy, the server MUST announce `edge.created` for each edge the copy is given, the link of `versions/copy-link` among them, after the copy's `item.created` and before the original's `item.updated`.

**Reason:** a subscriber applies the copy before an edge that names it, and meets the copy and its edges before the original's update, so it never holds the original past the losing edit with nothing that leads to that edit.

**Tests:** `compliance/events-contract.test.ts › announces each edge a conflicted copy is given after the copy's create and before the original's update`, `› announces a conflicted copy's link to its original between the copy's create and the original's update`, `› announces edge.created for an edge a conflicted copy is given`.

## A conflicted copy and its original

### `versions/copy-link`

When the server writes a conflicted copy, the server MUST write one `derived-from` edge from the copy to the original, with no properties and at version 1.

**Reason:** nothing else joins the two rows. Without the edge an app that reads the copy later, on this device after a restart or on another, cannot show it beside its original, and an app that reads the original cannot find the copies made from it. `derived-from` is the shipped edge type for a row made from another, many to many, written at its source.

**Tests:** `sync/conflict.test.ts › links the conflicted copy to its original with one derived-from edge, whatever edge grants the writer holds`, `› links the conflicted copy to its original for a writer holding the edge grants, and gives it the edges those grants allow`.

### `versions/copy-link-any-grants`

When the server writes a conflicted copy, the server MUST write its link to the original whatever edge grants the writer holds.

**Reason:** the link is part of the server's own resolution, as a cascade is part of a delete, and a link that came and went with the writer's grants would leave some copies unlinked for good. It discloses nothing the writer cannot read, because the answer names only the copy.

**Tests:** `sync/conflict.test.ts › links the conflicted copy to its original with one derived-from edge, whatever edge grants the writer holds`.

### `versions/copy-link-own`

When the server writes a conflicted copy, the server MUST NOT give it an outbound `derived-from` edge of the original.

**Reason:** the original keeps its own provenance, so a reader follows the copy's one `derived-from` edge to its original without telling it from the original's own.

**Tests:** `sync/conflict.test.ts › gives the conflicted copy none of the original's own derived-from edges, though its writer could have made them`.

### `versions/copy-once`

When a client repeats a write that wrote a conflicted copy under the same `Idempotency-Key`, the server MUST NOT write a second copy of the original.

**Reason:** a retry is the same edit, and a second copy would show the person a conflict they had once as two.

**Tests:** `sync/conflict.test.ts › links the conflicted copy to its original with one derived-from edge, whatever edge grants the writer holds`.

### `versions/copy-once-executed`

When the server executes again, under the same `Idempotency-Key`, a write that wrote a conflicted copy, the server MUST NOT write a second copy of the original or a second edge to it.

**Reason:** the record that answers a repeat can be gone when the repeat arrives, and the repeat is then executed rather than answered.

**Tests:** waiting on #1444.

### `versions/copy-link-trash`

When the original of a conflicted copy is moved to the bin, the server MUST keep the copy's link to it.

**Reason:** a move to the bin keeps every edge of the row, so a restore brings the original back beside its copy.

**Tests:** `sync/conflict.test.ts › keeps the link while the original is in the bin, and a purge of the original takes the link and leaves the copy`, `› leaves the conflicted copy as it was when its original is purged, and when it is restored beside it`.

### `versions/copy-purge`

When the original of a conflicted copy is purged, the server MUST leave the copy as it was, its tags and its other edges included.

**Reason:** the copy holds the text the person lost, which a purge of the original does not decide about. The link goes with the original under `items/purge-edges`, and `derived-from` orphans the other end of a deleted row (`edges/orphan-shipped`).

**Tests:** `sync/conflict.test.ts › keeps the link while the original is in the bin, and a purge of the original takes the link and leaves the copy`, `› leaves the conflicted copy as it was when its original is purged, and when it is restored beside it`.

## A change of state

### `versions/state-keeps-version`

When `POST /items/{id}/transition`, `DELETE /items/{id}`, `POST /items/{id}/restore` or a `transition` run by `POST /items/bulk-actions` moves an item, the server MUST leave the item at the version it held.

**Reason:** the version counts writes to the item's own fields and `state` is not one. A version that moved on a state change would make an edit queued against the content it read stale for no change to that content.

**Tests:** `correctness/item-versioning.test.ts › moves neither the version nor its history on a transition, a delete or a restore`.

### `versions/state-keeps-history`

When `POST /items/{id}/transition`, `DELETE /items/{id}`, `POST /items/{id}/restore` or a `transition` run by `POST /items/bulk-actions` moves an item, the server MUST NOT add a snapshot to its history.

**Reason:** a snapshot recorded at a version that does not move would be a second row under a number the next update records again.

**Tests:** `correctness/item-versioning.test.ts › moves neither the version nor its history on a transition, a delete or a restore`.

### `versions/state-moves-updated-at`

When `POST /items/{id}/transition`, `DELETE /items/{id}`, `POST /items/{id}/restore` or a `transition` run by `POST /items/bulk-actions` moves an item, the server MUST move the item's `updated_at`.

**Reason:** a client that watches for change watches `updated_at` and `state` beside the version.

**Tests:** `correctness/item-versioning.test.ts › moves updated_at on a transition, a delete and a restore, where it leaves the version`.

### `versions/cascade-keeps-version`

When a cascade moves an item to the bin or a restore brings it back, the server MUST leave the item's version and history as they were.

**Tests:** `correctness/item-versioning.test.ts › leaves the version and the history of a row a cascade trashed and restored as they were`.

### `versions/folder-revoke-version`

When `POST /folders/{id}/revoke` revokes an active folder, the server MUST advance the folder's version by one.

**Reason:** the revoke writes `revoked_at` as a property beside the state, and a write to a property is a write to the item's fields.

**Tests:** `compliance/folders.test.ts › moves the folder's version by one on a revoke, which writes revoked_at beside the state`.

## Edges

### `versions/edge-create-version`

When `POST /edges/bulk`, an `edges` list on `POST /items`, on `PATCH /items/{id}` or on a `POST /items/bulk` entry creates an edge, the server MUST give it version 1.

**Reason:** `edges/create-version` states the same for `POST /edges`.

**Tests:** `correctness/edges/edges-crud.test.ts › creates an edge at version 1 through a bulk page, an inline edge list and a folder`.

### `versions/edge-version-first`

If `PATCH /edges/{id}` names no `version`, then the server MUST answer `400 missing_required_field` with `details.field` `version`, before it looks for the edge.

**Reason:** a request that names no version is refused whether or not an edge holds the id, so the answer says nothing about the edge.

**Tests:** `compliance/edge-refusals.test.ts › names version in details.field where an update names none, and asks for it before it looks for the edge`.

### `versions/edge-stale-bare`

When `PATCH /edges/{id}` answers `409 version_conflict`, the server MUST carry `current`, holding the edge as it stands, and none of `ancestor`, `conflicting_fields` or `merge_policy`.

**Reason:** an edge has no history of snapshots to compare against, so offering any of the three would name a resolution that cannot be performed.

**Tests:** `compliance/edge-refusals.test.ts › answers a stale edge update with the edge as it stands and none of ancestor, conflicting_fields or merge_policy`.

### `versions/edge-update-race`

When two `PATCH /edges/{id}` writes that name one version arrive together, the server MUST write one and answer the other `409 version_conflict` with the edge as the first left it.

**Tests:** `compliance/edge-races.test.ts › lands one of two updates naming the same version`.
