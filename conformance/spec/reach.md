# Reach

A reach is the server's proof, for one credential, that an inventory, the direct reads and the event stream a working copy holds were all read under the same limits on what that credential may read. The server gives it in the markers of a copy stream, and a conditional read or a resumed copy stream presents it back. Ordinary reads and write receipts do not give it.

## The copy stream

A copy stream is `GET /events?edges=all&copy=1`. A working copy opens one without a cursor to hydrate, and with its last cursor and reach to resume.

### `reach/copy-bootstrap`

When a credential sends `GET /events?edges=all&copy=1` with neither `Last-Event-ID` nor `X-Marfa-Reach`, the server MUST open a copy stream.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/copy-resume`

When a credential sends `GET /events?edges=all&copy=1` with one `Last-Event-ID` and one `X-Marfa-Reach` that equals its current reach, the server MUST open a copy stream that resumes after that cursor.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`, `› keeps the reach across content, metadata and write-only authority changes`.

### `reach/copy-query-refused`

If `GET /events` names `copy` and a query key other than `edges` and `copy`, a `type` filter, a repeated `edges` or `copy`, no `edges` or an `edges` other than `all`, or a `copy` other than `1`, then the server MUST answer `400 validation_error` before a stream starts.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`.

### `reach/copy-resume-unpaired`

If a copy-stream request names `Last-Event-ID` without `X-Marfa-Reach`, or `X-Marfa-Reach` without `Last-Event-ID`, then the server MUST answer `400 validation_error` before a stream starts.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`.

### `reach/copy-cursor-refused`

If a copy-stream request names a `Last-Event-ID` that is empty, repeated, or not `0` or a decimal beginning with a nonzero digit and at most `9223372036854775807`, then the server MUST answer `400 validation_error` before a stream starts.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`.

### `reach/copy-reach-refused`

If a copy-stream request names an `X-Marfa-Reach` that is empty, repeated, or not exactly 64 lowercase hexadecimal characters, then the server MUST answer `400 validation_error` before a stream starts.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`.

### `reach/copy-reach-ordinary`

If a credential that reads some type sends `GET /events` naming `X-Marfa-Reach` and no `copy`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`.

### `reach/copy-no-type`

If a key whose type map reaches no type sends `GET /events` naming `copy` and a query the copy grammar refuses, then the server MUST answer `403 type_not_permitted` and not `400`.

**Reason:** a key that may read nothing is told so before it is told how to spell a request it could not use.

**Tests:** `compliance/declared-refusals.test.ts › answers a copy stream request with a stray key 401, then 403 for a key that reads no type`.

### `reach/copy-refusal-order`

When a copy-stream request meets more than one of the answers this chapter gives it, the server MUST give the first in this order: no valid credential, `401`; a request the copy grammar refuses, `403` where the credential's type map reaches no type and `400` otherwise; a reach that differs from the credential's current one, `409`; a credential whose type map reaches no type, `403`.

**Tests:** `compliance/declared-refusals.test.ts › answers a copy stream request with a stray key 401, then 403 for a key that reads no type`, `compliance/reach-order.test.ts › answers 401 to a request with no credential before it asks the reach`, `› answers 400 to a request that is not well formed before it asks the reach`, `› answers 409 to a stale reach before it asks whether the key reaches any type, and 403 to the same key without one`.

## What a copy stream sends

### `reach/stream-no-header`

When a copy stream starts, the server MUST NOT carry `X-Marfa-Reach` on the response.

**Reason:** the reach of a stream is in its markers, where a client reads it with the cursor it belongs to.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-first`

When a copy stream starts, the server MUST send `stream_cursor` as its first event frame.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-no-id`

The server MUST send `stream_cursor` and `stream_live` without an SSE `id`.

**Reason:** a marker is not an event of the log, so a client that resumes from the last `id` it saw never resumes from one.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-body`

The server MUST send the body of `stream_cursor` and of `stream_live` on a copy stream as an object of exactly the string members `event_type`, `cursor`, `instance_id` and `reach`.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-event-type`

The server MUST give `event_type` in the body of `stream_cursor` and of `stream_live` the name of the SSE event that carries it.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-cursor`

The server MUST give `cursor` in a marker as `0` or a decimal beginning with a nonzero digit, at most `9223372036854775807`.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-reach`

The server MUST give `reach` in a marker as exactly 64 lowercase hexadecimal characters.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-instance`

The server MUST give `instance_id` in a marker as the `instance_id` that `GET /` answers.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-same-reach`

When nothing changes between them, the server MUST give `stream_cursor` and `stream_live` of one copy stream the same `instance_id` and `reach`.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-live-bound`

The server MUST give the `cursor` of `stream_live` a value at least the `cursor` of `stream_cursor`, the resume cursor and the `id` of every event the stream sent.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/marker-live-after-replay`

When a copy stream has events to replay or hold, the server MUST send `stream_live` after it has sent them.

**Reason:** only a live marker that follows complete replay certifies that a working copy holds everything up to its cursor.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`.

### `reach/resume-same-reach`

When a copy stream resumes under a matching reach, the server MUST repeat the `instance_id` and `reach` the request named in `stream_cursor` and in `stream_live`.

**Tests:** `compliance/reach.test.ts › bootstraps and resumes with one instance, cursor and opaque reach`, `› keeps the reach across content, metadata and write-only authority changes`.

### `reach/resume-ahead`

If a copy stream resumes from a cursor past the head of the log, then the server MUST send `stream_cursor` and then a `cursor_ahead` frame without an `id`, carrying `requested` and `head`.

**Tests:** `compliance/reach.test.ts › ends a copy stream resumed past the head with cursor_ahead and no live marker`.

### `reach/resume-ahead-closes`

When a copy stream sends `cursor_ahead`, the server MUST close the stream and send no `stream_live`.

**Tests:** `compliance/reach.test.ts › ends a copy stream resumed past the head with cursor_ahead and no live marker`.

### `reach/resume-ahead-no-live`

If a copy stream resumes from a cursor past the head of the log, then the server MUST NOT send `stream_live`.

**Tests:** `compliance/reach.test.ts › ends a copy stream resumed past the head with cursor_ahead and no live marker`.

### `reach/opening-incomplete`

If the server cannot read the head of the log within the bound of a copy stream's opening, then the server MUST send neither `stream_cursor` nor `stream_live` and end the stream with `stream_incomplete`.

**Reason:** a marker invented without a head would certify a head the server did not read.

**Tests:** `compliance/stream-opening-faults.test.ts › ends a copy stream with stream_incomplete, and sends neither stream_cursor nor stream_live`.

## What a reach is bound to

### `reach/per-credential`

When two working keys, or the access tokens of two apps, that read the same things each open a copy stream, the server MUST give them different reaches.

**Tests:** `compliance/reach.test.ts › answers 409 to a reach minted for another credential, on every door and on resume`, `compliance/reach-order.test.ts › is the same for the access tokens an app holds before and after a refresh, and differs for another app`.

### `reach/per-app`

When two access tokens of one app that hold the same scopes open a copy stream, the server MUST give them one reach.

**Reason:** a refresh changes the token, not what the app may read.

**Tests:** `compliance/reach-order.test.ts › is the same for the access tokens an app holds before and after a refresh, and differs for another app`.

### `reach/moves-type-reach`

When a key's read reach over item types narrows, the server MUST give the key a different reach.

**Tests:** `compliance/reach.test.ts › refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`.

### `reach/moves-edge-reach`

When a key's read reach over edge types narrows or widens, the server MUST give the key a different reach.

**Tests:** `compliance/reach.test.ts › changes the reach when a key's edge reads narrow or widen, and keeps it when only edge writes change`.

### `reach/moves-metadata-reach`

When a key's read reach over metadata narrows or widens, the server MUST give the key a different reach.

**Tests:** `compliance/reach.test.ts › changes the reach when a key's metadata reads narrow or widen, and keeps it when only metadata writes change`.

### `reach/moves-extension-reach`

When a key's read reach over extensions narrows or widens, the server MUST give the key a different reach.

**Tests:** `compliance/reach.test.ts › changes the reach when a key's extension reads narrow or widen, and keeps it when only extension writes change`.

### `reach/moves-source-filter`

When the source filter that applies to a key changes, whether the instance's or the key's own, the server MUST give the key a different reach.

**Tests:** `compliance/reach.test.ts › classifies source-excluded direct items and neighbors without admitting them to a listed page`, `› changes the reach when a key's own source filter narrows, widens or clears`.

### `reach/keeps-write-reach`

When a key's write reach changes and its read reach does not, the server MUST leave the key's reach as it was.

**Tests:** `compliance/reach.test.ts › keeps the reach across content, metadata and write-only authority changes`, `› changes the reach when a key's edge reads narrow or widen, and keeps it when only edge writes change`, `› changes the reach when a key's metadata reads narrow or widen, and keeps it when only metadata writes change`, `› changes the reach when a key's extension reads narrow or widen, and keeps it when only extension writes change`.

### `reach/keeps-content`

When a write that moves no item to another type changes an item's properties or its metadata, the server MUST leave the reach as it was.

**Tests:** `compliance/reach.test.ts › keeps the reach across content, metadata and write-only authority changes`.

### `reach/keeps-lifecycle`

When a write that moves no item to another type changes an item's tier or state, or moves it to the bin or restores it, the server MUST leave the reach as it was.

**Tests:** `compliance/reach.test.ts › keeps the reach across a tier change, a state change, a trash and a restore`.

### `reach/moves-retype`

When `PATCH /items/{id}` or a `POST /items/bulk` entry moves an item to another type, the server MUST change the reach.

**Reason:** the item may leave or enter what a key reads, which no event the key reads announces.

**Tests:** `compliance/reach.test.ts › refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› ends an open copy stream with a no-id detail-free terminal after a structural change`, `› changes the reach when a bulk write retypes an item, and keeps it when the type is unchanged`, `compliance/reach-order.test.ts › changes the reach for a PATCH that moves the item to another type and writes properties, and keeps it for one that writes properties alone`.

### `reach/keeps-same-type`

When a write names the type the item already has, the server MUST leave the reach as it was.

**Tests:** `compliance/reach.test.ts › changes the reach when a bulk write retypes an item, and keeps it when the type is unchanged`.

### `reach/moves-edge-source`

When `PATCH /edges/{id}` moves the source of an edge, the server MUST change the reach.

**Reason:** the server makes the change on the move alone and never from the rows a copy holds, so a copy cannot tell a move that leaves its rows as they were from one that does, and a device expires its copy for every move it sends (`queue-and-verdicts/edge-source-move-expires`).

**Tests:** `compliance/reach.test.ts › changes the reach when an edge moves to another source, and keeps it when only the target moves`.

### `reach/keeps-edge-writes`

When a write that moves no item to another type creates or deletes an edge, or `PATCH /edges/{id}` moves only the target of an edge, the server MUST leave the reach as it was.

**Tests:** `compliance/reach.test.ts › changes the reach when an edge moves to another source, and keeps it when only the target moves`.

### `reach/moves-type-topology`

When a type is registered or deleted, or a replacement gives a type another `parent`, the server MUST change the reach.

**Tests:** `compliance/reach.test.ts › changes the reach when a custom type is created, re-parented or deleted, and keeps it when an update keeps the parent`.

### `reach/keeps-type-update`

When a replacement of a type keeps its `parent`, the server MUST leave the reach as it was.

**Tests:** `compliance/reach.test.ts › changes the reach when a custom type is created, re-parented or deleted, and keeps it when an update keeps the parent`.

### `reach/moves-edge-type`

When an edge type is registered or deleted, the server MUST change the reach.

**Tests:** `compliance/reach.test.ts › changes the reach when a custom edge type is created or deleted`.

### `reach/moves-purge-sweep`

When a retention sweep purges at least one item, the server MUST change the reach.

**Reason:** a sweep purges rows without a request, so no write answers the change.

**Tests:** `compliance/reach-sweep.test.ts › changes the reach, and a sweep that purges nothing does not`.

### `reach/change-before-answer`

When the server answers a write that changes the reach, the server MUST already refuse the earlier reach with `409 reach_changed`.

**Reason:** a working copy that read data after the write under the earlier reach would adopt data the reach no longer covers.

**Tests:** `compliance/reach.test.ts › refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`.

### `reach/keeps-on-rollback`

If `PATCH /items/{id}` moving an item to another type is refused `409 link_taken`, then the server MUST leave the reach as it was.

**Tests:** `compliance/reach-order.test.ts › answers link_taken to a move onto a link another item holds and leaves the reach as it was, and changes it for a move onto a free link`.

## Conditional reads

A conditional read is one of `GET /items`, `GET /items/{id}`, `GET /items/{id}/edges`, `GET /edges`, `GET /edges/{id}`, `GET /types`, `GET /edge-types`, `GET /keys/current` and `POST /items/bulk-get` that carries one `X-Marfa-Reach` header. A path is one of those of the conditional reads when it has the shape of one with any value in place of `{id}`, so `GET /items/stats` has the path of `GET /items/{id}` and is not a conditional read.

### `reach/conditional-certified`

When a credential sends a conditional read whose header equals its current reach and the read answers `2xx`, the server MUST carry `X-Marfa-Reach` on the answer with that value.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`, `› refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`.

### `reach/conditional-no-store`

When a conditional read carries `X-Marfa-Reach` on its answer, the server MUST carry `Cache-Control: no-store` with it.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`, `› certifies matching resource absence without certifying generic validation or authentication failures`, `› certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`.

### `reach/conditional-no-body-reach`

When a conditional read answers, the server MUST NOT carry a reach in the body.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`, `› certifies matching resource absence without certifying generic validation or authentication failures`, `› certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`.

### `reach/conditional-ordinary`

When a credential sends `GET /items?include=metadata`, `GET /items/{id}` or `POST /items/bulk-get` without `X-Marfa-Reach`, the server MUST answer it as an ordinary read, without `X-Marfa-Reach`.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`, `› certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`, `› answers a system row to a bulk read under a reach only when include names system`.

### `reach/conditional-item-page`

If `GET /items` names `X-Marfa-Reach` and no `include` that holds `metadata`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/reach.test.ts › rejects unsupported conditional doors, malformed proofs and metadata-free item pages`, `compliance/reach-order.test.ts › is refused as one whose include lacks metadata is, under a reach that matches`.

### `reach/conditional-door-refused`

If a `GET` other than `GET /events` names `X-Marfa-Reach` on an operation that is not a conditional read, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/reach.test.ts › rejects unsupported conditional doors, malformed proofs and metadata-free item pages`, `› answers 400 outside the supported doors before asking who is calling, and 401 first on an unsupported door inside them`, `compliance/version-reach.test.ts › answers 400 validation_error to the X-Marfa-Reach header on a history`.

### `reach/write-header-ignored`

When a write names `X-Marfa-Reach`, the server MUST answer it as it answers the same write without the header.

**Reason:** a reach certifies reads; a write is held to its `version`, not to what the writer could read.

**Tests:** `compliance/reach-order.test.ts › answers a write carrying a stale, a malformed or a matching reach as it answers one without the header`.

### `reach/write-header-replay`

When a write repeats an `Idempotency-Key` and its body under another `X-Marfa-Reach`, the server MUST replay the first answer.

**Tests:** `compliance/reach-order.test.ts › replays a write under one Idempotency-Key whatever reach header it carries, and still refuses the key for another body`.

### `reach/conditional-reach-refused`

If a conditional read names an `X-Marfa-Reach` that is empty, repeated, or not exactly 64 lowercase hexadecimal characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/reach.test.ts › rejects unsupported conditional doors, malformed proofs and metadata-free item pages`, `compliance/reach-order.test.ts › answers 401, then 400 to a malformed reach, then 409 to a stale one before it checks the ids or asks whether the key reaches any type`.

### `reach/conditional-query-ordinary`

If a conditional read whose header equals the credential's current reach names a query the ordinary read refuses, then the server MUST answer the ordinary `400 validation_error`.

**Tests:** `compliance/reach.test.ts › answers 409 before a validation 400 and before a resource 403 under a stale reach`.

### `reach/conditional-order`

When a `GET` other than `GET /events`, or a `POST /items/bulk-get` whose body is within its operation's cap, nested at most 64 levels and holds only well-formed UTF-16, names `X-Marfa-Reach` and meets more than one of the answers this chapter gives it, the server MUST give the first in this order: a path outside those of the conditional reads, `400`; no valid credential, `401`; an operation that is not a conditional read, `400`; a header that is not one 64-character lowercase hexadecimal value, `400`; an item page without `metadata`, `400`; a reach that differs from the credential's current one, `409`; then the answers of the ordinary read.

**Reason:** a stale reach is refused before the query, the credential's reach or the resource is judged, so that the refusal says nothing about them.

**Tests:** `compliance/reach.test.ts › answers 400 outside the supported doors before asking who is calling, and 401 first on an unsupported door inside them`, `› answers 409 before a validation 400 and before a resource 403 under a stale reach`, `› refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `compliance/reach-order.test.ts › answers 400 to a malformed copy of a stale reach, and 409 to the stale reach itself`, `› answers 400 to an item page that asks for no metadata, though its reach is stale`, `› answers 401, then 400 to a malformed reach, then 409 to a stale one before it checks the ids or asks whether the key reaches any type`.

### `reach/conditional-coherent`

While a write that changes the reach lands, the server MUST NOT answer a conditional read with a body that mixes what the item set held before the write and after it.

**Tests:** `compliance/reach-coherent.test.ts › answers 409, or an answer that is wholly before the write or wholly after it`.

## What a conditional read certifies

### `reach/certified-absent`

When a conditional read whose header equals the credential's current reach answers `404 item_not_found` or `404 edge_not_found`, the server MUST carry `X-Marfa-Reach` and `Cache-Control: no-store` on the answer.

**Tests:** `compliance/reach.test.ts › certifies matching resource absence without certifying generic validation or authentication failures`, `› certifies type not permitted, edge permission denied and a hidden-type absence under the matching reach`.

### `reach/certified-type-refused`

When a conditional read whose header equals the credential's current reach answers `403 type_not_permitted`, the server MUST carry `X-Marfa-Reach` and `Cache-Control: no-store` on the answer.

**Tests:** `compliance/reach.test.ts › certifies type not permitted, edge permission denied and a hidden-type absence under the matching reach`, `› answers 409 before a validation 400 and before a resource 403 under a stale reach`.

### `reach/certified-edge-refused`

When a conditional read whose header equals the credential's current reach answers `403 edge_permission_denied`, the server MUST carry `X-Marfa-Reach` and `Cache-Control: no-store` on the answer.

**Tests:** `compliance/reach.test.ts › certifies type not permitted, edge permission denied and a hidden-type absence under the matching reach`, `› answers 409 before a validation 400 and before a resource 403 under a stale reach`.

### `reach/certified-keys-current`

When an app's access token sends `GET /keys/current` with a header that equals its current reach, the server MUST answer `403 forbidden` with `X-Marfa-Reach` and `Cache-Control: no-store`.

**Reason:** an app can read the content of a working copy and is refused this operation by its kind of credential, which the matching reach lets it tell from a refusal of what it may read.

**Tests:** `compliance/reach.test.ts › certifies an approved app's current-key refusal under its matching reach`, `› answers 409 before a validation 400 and before a resource 403 under a stale reach`.

### `reach/uncertified-failures`

When the server answers a request that names `X-Marfa-Reach` with other than a `2xx`, `404 item_not_found`, `404 edge_not_found`, `403 type_not_permitted`, `403 edge_permission_denied`, or `403 forbidden` on `GET /keys/current`, the server MUST NOT carry `X-Marfa-Reach` on the answer.

**Tests:** `compliance/reach.test.ts › certifies matching resource absence without certifying generic validation or authentication failures`, `› rejects unsupported conditional doors, malformed proofs and metadata-free item pages`, `› answers 409 before a validation 400 and before a resource 403 under a stale reach`, `compliance/reach-order.test.ts › carries none on a 400 or a 409 to a conditional read, and carries one on the same door when the read succeeds`, `› answers 401, then 400 to a malformed reach, then 409 to a stale one before it checks the ids or asks whether the key reaches any type`.

## Which items a reach lists

### `reach/page-next-cursor`

When a credential sends `GET /items` with a matching `X-Marfa-Reach` and `include=metadata`, the server MUST carry `next_cursor` on every page, a string until the last page and `null` on it.

**Reason:** a walk of the pages ends only at an explicit `null`.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`.

### `reach/page-rows`

When a credential sends `GET /items` with a matching `X-Marfa-Reach` and `include=metadata`, the server MUST answer each row with `item`, `metadata` and `listed` `true`.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`.

### `reach/page-excludes`

When the source filter that applies to a credential excludes an item, the server MUST leave the item out of a conditional metadata page of `GET /items`.

**Tests:** `compliance/reach.test.ts › classifies source-excluded direct items and neighbors without admitting them to a listed page`.

### `reach/listed-direct`

When a credential sends `GET /items/{id}` with a matching `X-Marfa-Reach` for an item it may read, the server MUST carry a boolean `listed` beside the `item`.

**Tests:** `compliance/reach.test.ts › classifies source-excluded direct items and neighbors without admitting them to a listed page`, `› delivers source-excluded update, metadata, delete and restore carriers with listed false`, `› changes the reach when a key's own source filter narrows, widens or clears`.

### `reach/listed-neighbor`

When a credential sends `GET /items/{id}` with a matching `X-Marfa-Reach` and `include=neighbors`, the server MUST carry a boolean `listed` on each neighbor.

**Tests:** `compliance/reach.test.ts › classifies source-excluded direct items and neighbors without admitting them to a listed page`.

### `reach/listed-definition`

When the server answers `listed`, the server MUST answer `false` for an item whose type the source filter that applies to the credential names and whose source it does not name, and `true` for any other item.

**Reason:** `listed` says whether the item belongs to the working copy's inventory, before the device slices it by type or tier.

**Tests:** `compliance/reach.test.ts › classifies source-excluded direct items and neighbors without admitting them to a listed page`, `› changes the reach when a key's own source filter narrows, widens or clears`, `› certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`.

### `reach/listed-by-id`

When a credential sends `GET /items/{id}` with a matching `X-Marfa-Reach` for an item it may read that the source filter excludes, the server MUST answer `200` with `listed` `false`.

**Reason:** a read by id is not narrowed by the source filter (`types/source-filter-by-id`), so a device that holds the item can still refresh it.

**Tests:** `compliance/reach.test.ts › classifies source-excluded direct items and neighbors without admitting them to a listed page`.

### `reach/listed-bulk-get`

When a credential sends `POST /items/bulk-get` with a matching `X-Marfa-Reach`, the server MUST answer a `listed` list holding a boolean for each answered item, in the order of `items`.

**Reason:** the source filter does not narrow a read by id (`types/source-filter-by-id`), so `listed` is how a device that reads many items by id at once learns which of them belong to its inventory.

**Tests:** `compliance/reach.test.ts › certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`, `› answers a system row to a bulk read under a reach only when include names system`.

### `reach/listed-not-on-edges`

When a conditional read answers an edge, the server MUST NOT carry `listed` on it.

**Tests:** `compliance/reach.test.ts › walks conditional metadata pages to explicit null and certifies every supported read door`.

## Write receipts

### `reach/receipt-uncertified`

When `POST /items`, `POST /edges` or `POST /folders` creates a row, the server MUST answer it without `X-Marfa-Reach` and without a reach in the body.

**Reason:** a receipt says what the write did, and not what a key's reach covers, so a device reads under its reach again before it adopts what the write left.

**Tests:** `compliance/reach.test.ts › returns item, edge and folder write receipts without a reach certificate`.

## A reach that changed

### `reach/changed-conditional`

If a conditional read names an `X-Marfa-Reach` of the right form that differs from the credential's current reach, then the server MUST answer `409 reach_changed`.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`, `› classifies source-excluded direct items and neighbors without admitting them to a listed page`, `› refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› answers 409 to a reach minted for another credential, on every door and on resume`, `› certifies a bulk read by id and answers listed for each item it returns, in order, false for a source-excluded one`.

### `reach/changed-resume`

If a copy-stream request resumes under an `X-Marfa-Reach` of the right form that differs from the credential's current reach, then the server MUST answer `409 reach_changed` as an HTTP answer and not as a stream.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`, `› refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› answers 409 to a reach minted for another credential, on every door and on resume`.

### `reach/changed-body`

When the server answers `409 reach_changed`, the server MUST send exactly the body `{"error":{"code":"reach_changed","message":"The reach changed. Rebuild the working copy."}}`.

**Reason:** the body names no policy and no resource, so a key learns nothing about what it may no longer read.

**Tests:** `compliance/reach.test.ts › rejects every alternate copy grammar before starting a stream`, `› refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› answers 409 to a reach minted for another credential, on every door and on resume`.

### `reach/changed-uncertified`

When the server answers `409 reach_changed`, the server MUST NOT carry `X-Marfa-Reach` on the answer.

**Tests:** `compliance/reach.test.ts › refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› answers 409 to a reach minted for another credential, on every door and on resume`.

### `reach/terminal-frame`

When the reach of a copy stream changes after the stream has started, the server MUST send one frame with `event: reach_changed`, no `id` and the data `{"event_type":"reach_changed"}`.

**Reason:** the data holds no cursor, certificate, instance or resource, so a stream that may no longer read what it carried is told nothing more.

**Tests:** `compliance/reach.test.ts › ends an open copy stream with a no-id detail-free terminal after a structural change`.

### `reach/terminal-closes`

When the server has sent `reach_changed` on a copy stream, the server MUST close the stream without sending another frame, `stream_live` included.

**Tests:** `compliance/reach.test.ts › ends an open copy stream with a no-id detail-free terminal after a structural change`.

### `reach/terminal-withholds`

When the reach of a copy stream changes after the stream has started, the server MUST NOT send the frame that announced the change.

**Tests:** `compliance/reach.test.ts › ends an open copy stream with a no-id detail-free terminal after a structural change`.

### `reach/terminal-races`

While a copy stream replays, holds a frame, or is about to announce `stream_live`, if the reach changes, then the server MUST end the stream with `reach_changed`.

**Tests:** `compliance/copy-stream-races.test.ts › ends with reach_changed and sends no replayed frame and no stream_live`, `› ends with reach_changed and sends neither the held frame nor stream_live`, `› ends with reach_changed and does not announce stream_live`.

### `reach/terminal-races-silent`

While a copy stream replays, holds a frame, or is about to announce `stream_live`, if the reach changes, then the server MUST send neither `stream_live` nor a frame of the changed data.

**Tests:** `compliance/copy-stream-races.test.ts › ends with reach_changed and sends no replayed frame and no stream_live`, `› ends with reach_changed and sends neither the held frame nor stream_live`, `› ends with reach_changed and does not announce stream_live`.

## What a copy stream says about each item

### `reach/frame-listed`

When a copy stream sends `item.created`, `item.updated`, `item.state_changed`, `item.deleted`, `item.restored`, `item.purged` or `metadata.changed`, the server MUST carry a boolean `listed` in the frame, on a live stream and on a replayed one.

**Tests:** `compliance/reach.test.ts › sends listed on created, state changed and purged frames, live and replayed`, `› delivers source-excluded update, metadata, delete and restore carriers with listed false`, `› ends an open copy stream with a no-id detail-free terminal after a structural change`.

### `reach/frame-excluded`

When the source filter that applies to a credential excludes an item the credential may read, the server MUST still send the item's frames on a copy stream, each with `listed` `false` and an `id`.

**Reason:** a device that already holds the item has to process what happens to it.

**Tests:** `compliance/reach.test.ts › delivers source-excluded update, metadata, delete and restore carriers with listed false`, `› sends listed on created, state changed and purged frames, live and replayed`.

### `reach/frame-edge-shape`

When a copy stream sends `edge.created`, `edge.updated` or `edge.deleted`, the server MUST send the frame with `event_type`, `edge` and `source_type` and without `listed`, on a live stream and on a replayed one.

**Tests:** `compliance/reach.test.ts › sends edge frames on a copy stream in their ordinary shape, live and replayed`.
