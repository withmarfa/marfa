# Edges

An edge is a typed, directed relationship from a source item to a target item, with its own id, properties and version. An edge type says how edges of that type behave: how many an item holds, which item types they join and what a delete does to the other end. Ten edge types ship, and a key registers more.

## Creating an edge

Where one request meets more than one refusal below, `edges/create-order` says which answer it gets.

### `edges/create-order`

When `POST /edges` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: a missing field; a malformed id; a source no item holds, in the bin or that the key may not read; no write on the source's type; no write on the edge type; an `id` that an edge the key may read holds, acknowledged under `edges/id-repeat` or refused under `edges/id-reused`; an edge type nothing registered; a self-loop; invalid `properties`; a target no item holds, in the bin or that the key may not read; an endpoint type, a revoked folder or nesting, the source's type before the target's; a duplicate triple; cardinality; a cycle; an `id` that an edge the key may not read holds.

**Tests:** `compliance/edge-check-order.test.ts › refuses a malformed id before it looks for the source`, `› answers a source in the bin as missing before it asks for write on the source's type`, `› refuses write on the source's type before write on the edge type`, `› refuses write on the edge type before it recognizes a repeated edge id`, `› refuses a reused edge id before it looks up the edge type`, `› answers an unknown edge type before it judges a self-loop`, `› refuses a self-loop before it checks properties`, `› refuses bad properties before it looks for the target`, `› refuses bad properties before it checks the endpoint types`, `› answers a missing target before it checks the endpoint types`, `› answers a missing target as forbidden when the key lacks write on the edge type`, `› checks the source's type before the target's type`, `› refuses an endpoint type before it names a duplicate`, `› names a duplicate before cardinality`, `› refuses cardinality before a cycle`, `› answers a missing edge type as missing_required_field before it judges a malformed id`, `› acknowledges a repeated edge id and triple after the target went to the bin`, `› acknowledges a repeated edge id and triple after its edge type was force deleted`, `› answers an unknown edge type before it refuses an id an unreadable edge holds`, `› answers a self-loop before it refuses an id an unreadable edge holds`, `› answers a duplicate triple before it refuses an id an unreadable edge holds`.

### `edges/create`

When a key sends `POST /edges` naming a `source_id`, a `target_id` and an `edge_type`, and no rule of this chapter refuses the edge, the server MUST answer `201` with an `edge` carrying its `id`, `source_id`, `target_id`, `edge_type`, `properties`, `created_at`, `updated_at` and `version`.

**Tests:** `compliance/edge-types.test.ts › registered edge type is usable in POST /edges`, `sync/identity.test.ts › keeps the id a client mints for an edge`, `sync/acknowledged.test.ts › answers an edge repeat naming other properties with the stored row, unchanged and unannounced`.

### `edges/create-version`

When `POST /edges` creates an edge, the server MUST give it `version` 1.

**Tests:** `correctness/edges/edges-list.test.ts › reads an edge by id with its version`, `sync/acknowledged.test.ts › answers an edge repeat naming other properties with the stored row, unchanged and unannounced`.

### `edges/create-announced`

When `POST /edges` creates an edge, the server MUST announce `edge.created`.

**Tests:** `compliance/edge-events.test.ts › SSE delivers edge.created and edge.deleted`, `sync/identity.test.ts › keeps the id a client mints for an edge`.

### `edges/create-missing-field`

If `POST /edges` names no `source_id`, no `target_id` or no `edge_type`, then the server MUST answer `400 missing_required_field`.

**Tests:** `correctness/edges/edges-crud.test.ts › rejects POST /edges missing required fields`, `compliance/edge-gaps.test.ts › refuses a request with no edge type as missing_required_field`.

### `edges/create-invalid-id`

If `POST /edges` names a `source_id`, a `target_id` or an `id` that is not a lowercase UUIDv7, then the server MUST answer `400 invalid_id`.

**Tests:** `compliance/edge-refusals.test.ts › refuses a malformed source_id, target_id or edge id with invalid_id`.

### `edges/create-type-unknown`

If `POST /edges` names an `edge_type` nothing registered, and the key's edge map grants write on that name, then the server MUST answer `404 edge_type_not_found`.

**Reason:** a key whose edge map does not grant write on the name is refused `edges/write-edge-type` first, so the answer never says whether a name is registered to a key that may not write it.

**Tests:** `compliance/edge-refusals.test.ts › answers an edge type nothing registered with edge_type_not_found`.

### `edges/create-duplicate`

If `POST /edges` names a triple of `source_id`, `target_id` and `edge_type` that an edge already holds, and names no `id` that edge holds, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `duplicate` and the `edge_type`, `source_id` and `target_id`.

**Reason:** one triple is one edge, so a second edge naming it is a mistake. A caller that minted the id of the edge it repeats is answered by `edges/id-repeat` instead.

**Tests:** `compliance/edge-refusals.test.ts › refuses a second edge naming a triple one already holds as a duplicate`, `device/fidelity.test.ts › matches the refusal of a second placement of one item in one folder`.

### `edges/create-end-missing`

If `POST /edges` names a `source_id` or a `target_id` that no item holds, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/edge-permissions.test.ts › $name answers an unreadable target as a missing one, whatever its type`, `compliance/unreadable-items.test.ts › $name`.

### `edges/create-end-in-bin`

If `POST /edges` names a `source_id` or a `target_id` whose item is in the bin, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/edge-move.test.ts › refuses a move of an edge whose end that stays is in the bin, as its create is refused`, `compliance/edge-gaps.test.ts › answers a target in the bin as item_not_found`.

## Client-minted edge ids

### `edges/id-client`

When `POST /edges` names an `id` that is a lowercase UUIDv7 and that no edge holds, the server MUST create the edge under that `id`, on the answer and on its `edge.created` event.

**Reason:** a client that works offline names its rows before the server sees them.

**Tests:** `sync/identity.test.ts › keeps the id a client mints for an edge`.

### `edges/id-repeat`

When a key that may write the source's type and the edge type sends `POST /edges` whose source exists outside the bin, naming an `id` that an edge the key may read holds and the triple of that edge, the server MUST answer `200` with the stored `edge` and `acknowledged: true`.

**Reason:** a client that lost the answer to its create sends it again, and gets the edge it made.

**Tests:** `sync/acknowledged.test.ts › answers an edge repeat with the stored row and announces nothing`, `› answers an edge repeat naming other properties with the stored row, unchanged and unannounced`.

### `edges/id-repeat-unchanged`

When `POST /edges` answers `acknowledged: true`, the server MUST leave the edge as it was, whatever `properties` the repeat names.

**Tests:** `sync/acknowledged.test.ts › answers an edge repeat naming other properties with the stored row, unchanged and unannounced`.

### `edges/id-repeat-silent`

When `POST /edges` answers `acknowledged: true`, the server MUST NOT announce an event for it.

**Tests:** `sync/acknowledged.test.ts › answers an edge repeat with the stored row and announces nothing`, `› answers an edge repeat naming other properties with the stored row, unchanged and unannounced`.

### `edges/id-repeat-source-in-bin`

If `POST /edges` repeats the `id` and triple of an edge whose source is now in the bin, then the server MUST answer `404 item_not_found`.

**Reason:** the source is looked up before the `id`, and a source in the bin is answered as missing (`edges/create-end-in-bin`).

**Tests:** `compliance/edge-check-order.test.ts › answers a repeated edge id as missing when its source is now in the bin`.

### `edges/id-reused`

If a key that may write the source's type and the edge type sends `POST /edges` whose source exists outside the bin, naming an `id` that an edge the key may read holds and another triple, then the server MUST answer `409 id_reused`.

**Reason:** the same code `POST /items` answers for a reused item id, because it is the same mistake: a caller minted an id that names a row it is not describing (`items/create-id-other-type`).

**Tests:** `sync/acknowledged.test.ts › refuses an edge id that names a different triple`.

### `edges/id-reused-differs`

When the server refuses an edge id with `id_reused` for an edge the key may read, the server MUST name in `details.differs` each of `source_id`, `target_id` and `edge_type` in which the two triples differ.

**Tests:** `sync/acknowledged.test.ts › refuses an edge id that names a different triple`, `compliance/edges-bulk.test.ts › refuses a reused edge id here as the single door does, and says what differs`.

### `edges/id-reused-bulk`

If an entry of `POST /edges/bulk` names an `id` that an edge the key may read holds and names another triple, then the server MUST refuse the entry `id_reused`, as `error` on the entry under `atomic: false` and as `details.code` of a `409` rollback under `atomic: true`.

**Tests:** `compliance/edges-bulk.test.ts › refuses a reused edge id here as the single door does, and says what differs`.

### `edges/id-reused-unreadable`

If `POST /edges`, or an entry of `POST /edges/bulk` under `atomic: false`, names an `id` that an edge holds that the key may not read, then the server MUST refuse it `id_reused`, with `409` on `POST /edges`, and carry `existing_id` alone in its `details`.

**Reason:** the key learns the id is taken, which it must to choose another, and nothing else about an edge it may not read (`keys-and-oauth.md` 20).

**Tests:** `compliance/unreadable-items.test.ts › POST /edges and POST /edges/bulk naming the id of an edge it cannot read learn the id is taken, and nothing of the edge`.

## Reading an edge

### `edges/read`

When `GET /edges/{id}` names an edge the key may read, the server MUST answer `200` with the `edge`.

**Tests:** `correctness/edges/edges-list.test.ts › reads an edge by id with its version`.

### `edges/read-missing`

If `GET /edges/{id}`, `DELETE /edges/{id}`, or `PATCH /edges/{id}` naming a `version`, names an id no edge holds, whether or not it is a lowercase UUIDv7, then the server MUST answer `404 edge_not_found`.

**Tests:** `compliance/edge-refusals.test.ts › answers edge_not_found on read, update and delete, and touches no edge`, `correctness/edges/edges-list.test.ts › refuses an unknown query key and an unknown edge id`.

## Listing edges

### `edges/list-type-filter`

When `GET /edges`, `GET /items/{id}/edges` or `GET /items/{id}/backrefs` names `edge_type` as a comma-separated list of at most 10 edge types, the server MUST list only edges of those types.

**Tests:** `correctness/edges/edges-list.test.ts › lists edges by type, excluding other types`, `correctness/edges/edges-backrefs.test.ts › ?edge_type filter narrows to one type`, `compliance/edge-listings.test.ts › takes an edge_type filter of 10 types and refuses one of 11, on both listings`.

### `edges/list-type-filter-cap`

If `GET /edges`, `GET /items/{id}/edges` or `GET /items/{id}/backrefs` names `edge_type` as a list of more than 10 edge types, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/edge-listings.test.ts › takes an edge_type filter of 10 types and refuses one of 11, on both listings`, `compliance/edge-gaps.test.ts › takes 10 edge types and refuses 11`.

### `edges/list-updated-after`

When `GET /edges` names `updated_after`, the server MUST list only edges whose `updated_at` is at or after it.

**Reason:** the bound is inclusive because `updated_at` ties across a bulk write, and a strict bound would drop every edge sharing the instant of a catch-up cursor.

**Tests:** `correctness/edges/edges-list.test.ts › bounds a listing by updated_after with an excluded control`, `sync/time-filters.test.ts › narrows an edge listing by modification time`.

### `edges/list-updated-before`

When `GET /edges` names `updated_before`, the server MUST list only edges whose `updated_at` is before it.

**Tests:** `sync/time-filters.test.ts › bounds an edge listing by updated_before, exclusively`.

### `edges/list-order`

When `GET /items/{id}/edges` answers, or `GET /edges` names no `updated_after`, the server MUST list edges newest created first, whether or not an edge has been updated since.

**Tests:** `compliance/edge-listings.test.ts › lists edges newest created first, and an update does not move one`.

### `edges/list-paginate`

When a key pages `GET /edges`, `GET /items/{id}/edges` or `GET /items/{id}/backrefs` by `next_cursor`, the server MUST deliver every edge once.

**Tests:** `correctness/edges/edges-list.test.ts › paginates with a cursor and delivers every edge once`, `correctness/edges/edges-backrefs.test.ts › paginates via cursor across many inbound edges`, `correctness/edges/edges-response.test.ts › per-type hydration caps a block and carries a next_cursor when over the limit`.

### `edges/list-limit`

When `GET /edges`, `GET /items/{id}/edges` or `GET /items/{id}/backrefs` names a `limit` of 500 or less, the server MUST answer a page of at most that many edges.

**Tests:** `compliance/edge-listings.test.ts › takes a limit of 500 and refuses 501 and 0, on both listings`, `compliance/edge-gaps.test.ts › takes a limit of 500 and refuses 501 and 0`.

### `edges/list-limit-refused`

If `GET /edges`, `GET /items/{id}/edges` or `GET /items/{id}/backrefs` names a `limit` above 500 or below 1, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/edge-listings.test.ts › takes a limit of 500 and refuses 501 and 0, on both listings`, `compliance/edge-gaps.test.ts › takes a limit of 500 and refuses 501 and 0`.

### `edges/list-unknown-key`

If `GET /edges` carries a query key the operation does not declare, then the server MUST answer `400 validation_error` naming the key in `details.unknown_parameters`.

**Tests:** `correctness/edges/edges-list.test.ts › refuses an unknown query key and an unknown edge id`.

### `edges/list-no-credential`

If `GET /edges` carries no credential, then the server MUST answer `401`.

**Tests:** `correctness/edges/edges-list.test.ts › refuses a listing with no credential`.

### `edges/list-no-type`

If a credential whose type map reaches no type sends `GET /edges`, `GET /edges/{id}`, `GET /items/{id}/edges`, `GET /items/{id}/backrefs` or `POST /edges/bulk`, then the server MUST answer `403 type_not_permitted`, whether or not the id names an edge or an item, and on an empty page of `POST /edges/bulk` too.

**Reason:** a credential that reaches no type is not one with nothing to see, and an empty `200` would say the wrong one of the two (`keys-and-oauth.md` 1).

**Tests:** `compliance/key-management.test.ts › the operator key is refused the data plane, reading as well as writing`, `compliance/unreadable-items.test.ts › a key reaching no type is refused a single row, whatever the id names`.

### `edges/list-bin`

While an item is in the bin, the server MUST go on answering the edges it holds on `GET /edges/{id}`, `GET /edges`, `GET /items/{id}/edges` and `GET /items/{id}/backrefs`, whichever end the item is.

**Reason:** an edge has no lifecycle of its own, and a client reconciling its copy must see the edges of an item in the bin.

**Tests:** `compliance/edge-listings.test.ts › stay readable by id and listed, whichever end is in the bin`.

### `edges/target-named`

When a key may read an edge's edge type and its source's type, the server MUST answer the edge with its `target_id` whatever the target's type, on `GET /edges/{id}`, `GET /edges`, `GET /items/{id}/edges`, the `edges` an item read carries and the `edge.created` event.

**Reason:** a limit accepted: an edge is a statement its source makes about its target, so it names the target even where the key may not read the target.

**Tests:** `compliance/edge-hidden-limits.test.ts › names a hidden target's id on an edge the key may read`, `› names a hidden target's id on every read of an edge the key may read`.

## An item's edges

### `edges/item-outbound`

When `GET /items/{id}/edges` names an item the key may read, the server MUST list the outbound edges of that item.

**Tests:** `correctness/edges/edges-response.test.ts › per-type hydration caps a block and carries a next_cursor when over the limit`, `compliance/edge-listings.test.ts › takes an edge_type filter of 10 types and refuses one of 11, on both listings`.

### `edges/item-inbound`

When `GET /items/{id}/backrefs` names an item the key may read, the server MUST list the inbound edges of that item.

**Tests:** `correctness/edges/edges-backrefs.test.ts › GET /items/:id/backrefs returns inbound edges`.

### `edges/item-unknown`

If `GET /items/{id}/edges` or `GET /items/{id}/backrefs` names a lowercase UUIDv7 that no item the key may read holds, then the server MUST answer `404 item_not_found`.

**Tests:** `correctness/edges/edges-response.test.ts › answers 404 for an unknown item and 400 for a malformed id`, `correctness/edges/edges-backrefs.test.ts › answers 404 for an unknown item and 400 for a malformed id`.

### `edges/item-malformed`

If `GET /items/{id}/edges` or `GET /items/{id}/backrefs` names an id that is not a lowercase UUIDv7, then the server MUST answer `400 invalid_id`.

**Tests:** `correctness/edges/edges-response.test.ts › answers 404 for an unknown item and 400 for a malformed id`, `correctness/edges/edges-backrefs.test.ts › answers 404 for an unknown item and 400 for a malformed id`.

## The edges an item read carries

### `edges/hydrate`

When `GET /items/{id}` answers an item that holds outbound edges the key may read, the server MUST carry them in `item.edges`, keyed by edge type, each block a page of `data` and `next_cursor`.

**Tests:** `correctness/edges/edges-response.test.ts › GET /items/:id returns hydrated edges keyed by edge_type, each block a page`.

### `edges/hydrate-cap`

When `GET /items/{id}` carries a block of `item.edges`, the server MUST put at most 50 edges in its `data`.

**Tests:** `correctness/edges/edges-response.test.ts › per-type hydration caps a block and carries a next_cursor when over the limit`.

### `edges/hydrate-cursor`

When an edge type holds more outbound edges than the 50 a block of `item.edges` carries, and the server carries the block, the server MUST give the block a `next_cursor` that `GET /items/{id}/edges` continues under that `edge_type`, so that the block and the listing deliver every edge once.

**Tests:** `correctness/edges/edges-response.test.ts › per-type hydration caps a block and carries a next_cursor when over the limit`.

### `edges/hydrate-whole`

When a block of `item.edges` holds every edge of its type, the server MUST give it `next_cursor` `null`.

**Tests:** `correctness/edges/edges-response.test.ts › GET /items/:id returns hydrated edges keyed by edge_type, each block a page`.

### `edges/hydrate-backrefs`

When `GET /items/{id}` names `include=backrefs`, the server MUST carry the inbound edges of the item in `backrefs`, keyed by edge type, each block a page of `data` and `next_cursor`.

**Tests:** `correctness/edges/edges-response.test.ts › continues a hydrated inbound block at the backrefs listing`.

### `edges/hydrate-backrefs-cap`

When `GET /items/{id}` carries `backrefs`, the server MUST carry at most 50 edges in a block.

**Tests:** `correctness/edges/edges-response.test.ts › continues a hydrated inbound block at the backrefs listing`.

### `edges/hydrate-backrefs-cursor`

When an edge type holds more inbound edges than the 50 a block of `backrefs` carries, the server MUST give the block a `next_cursor` that `GET /items/{id}/backrefs` continues under that `edge_type`.

**Tests:** `correctness/edges/edges-response.test.ts › continues a hydrated inbound block at the backrefs listing`.

## Edge terms in a listing filter

### `edges/filter-edge`

When `GET /items` names `edge[<edge type>]=<id>`, the server MUST list only items that hold an outbound edge of that type to that id.

**Reason:** the query grammar every listing shares is `search-and-filters.md`.

**Tests:** `correctness/edges/edges-query.test.ts › edge[about]=<id> shorthand returns items with outbound about edge to id`.

### `edges/filter-edge-full`

When `GET /items` names `filter=edge[<edge type>] eq "<id>"`, the server MUST list exactly the items `edge[<edge type>]=<id>` lists.

**Tests:** `correctness/edges/edges-query.test.ts › answers the full edge filter with exactly the items the edges listing names, and not an item holding another edge type`.

### `edges/filter-edge-type`

When `GET /items` names an edge term and a `type`, the server MUST list only items of that type that the edge term lists.

**Tests:** `correctness/edges/edges-query.test.ts › combines edge filter with type to narrow results`.

## Updating an edge

Where one request meets more than one rule of this section or the next, `edges/update-order` says which answer it gets.

### `edges/update-order`

When `PATCH /edges/{id}` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: an edge the key may not read; no write on the source's type; no write on the edge type; a stale `version`; a malformed id; both ends moved; an edge type no longer registered; an end the edge type cannot move; a new source no item holds or the key may not read; no write on the new source's type; an end that stays no item holds, in the bin or that the key may not read; neither `properties` nor a moved end; then the order of `edges/create-order` from a self-loop on.

**Tests:** `compliance/edge-check-order.test.ts › answers an edge whose source's type the key cannot read as missing before it asks for write on that type`, `› refuses write on the source's type before write on the edge type`, `› refuses write on the edge type before it judges a stale version`, `› refuses a stale version before it judges a malformed id in a move`, `› refuses a stale version before it finds the update names nothing`, `› refuses a malformed id before it finds both ends moved`, `› refuses a move of both ends before it looks up the edge type`, `› refuses a move the edge type cannot make before it looks for the new source`, `› answers a new source the key cannot read as missing before it asks for write on it`, `› refuses a new source the key cannot write before it looks for the end that stays`, `› refuses write on the new source's type before it finds a source moved onto its own target`.

### `edges/move-invalid-id`

If `PATCH /edges/{id}` moves an end to an id that is not a lowercase UUIDv7, then the server MUST answer `400 invalid_id`.

**Tests:** `compliance/edge-check-order.test.ts › refuses a malformed id in a move as invalid_id on either end`.

### `edges/update-merge`

When `PATCH /edges/{id}` names `properties` and the edge's current `version`, the server MUST store each property named over the edge's own and leave every property it names none for as it was.

**Tests:** `correctness/edges/edges-crud.test.ts › updateEdge patches properties only`, `› updateEdge merges over the properties it was not given`.

### `edges/update-version`

When `PATCH /edges/{id}` writes an edge, the server MUST advance its `version` by one.

**Tests:** `compliance/edge-refusals.test.ts › refuses a version other than the current one, lower or higher, and writes nothing`, `correctness/edges/edges-move.test.ts › moves a child to a new parent in one write, keeping the edge's id and properties`.

### `edges/update-announced`

When `PATCH /edges/{id}` writes an edge, the server MUST announce `edge.updated`.

**Tests:** `compliance/events-contract.test.ts › announces edge.updated when an edge's properties change`.

### `edges/update-version-required`

If `PATCH /edges/{id}` names no `version`, then the server MUST answer `400 missing_required_field`.

**Tests:** `sync/edge-version.test.ts › refuses an update naming no version`.

### `edges/update-version-required-unchanged`

If `PATCH /edges/{id}` is refused for naming no `version`, then the server MUST leave the edge as it was.

**Tests:** `sync/edge-version.test.ts › refuses an update naming no version`.

### `edges/update-stale`

If `PATCH /edges/{id}` names a `version` other than the edge's current one, whether lower or higher, then the server MUST answer `409 version_conflict`.

**Tests:** `compliance/edge-refusals.test.ts › refuses a version other than the current one, lower or higher, and writes nothing`, `sync/edge-version.test.ts › refuses an update naming a stale version and accepts the current one`, `compliance/edge-move.test.ts › refuses a stale version before it judges the move`.

### `edges/update-stale-answer`

When `PATCH /edges/{id}` answers `409 version_conflict`, the server MUST carry the `error` and, beside it, `current` holding the edge as it stands.

**Reason:** the client re-applies its change over the edge returned, without a second read.

**Tests:** `correctness/edges/edges-crud.test.ts › refuses a stale edge update, under current and not under edge`, `compliance/edge-move.test.ts › refuses a stale version with the edge as it stands, and moves nothing`.

### `edges/update-stale-first`

When `PATCH /edges/{id}` names a stale `version`, the server MUST refuse it `409 version_conflict` before it judges anything else the body names.

**Reason:** a move onto an item that does not exist, a malformed id or a cardinality the move would break is refused at the current version, and a stale write is told it is stale first.

**Tests:** `compliance/edge-move.test.ts › refuses a stale version before it judges the move`.

### `edges/update-stale-writes-nothing`

If `PATCH /edges/{id}` is refused `409 version_conflict`, then the server MUST leave the edge as it was.

**Tests:** `compliance/edge-refusals.test.ts › refuses a version other than the current one, lower or higher, and writes nothing`, `compliance/edge-move.test.ts › refuses a stale version with the edge as it stands, and moves nothing`.

### `edges/update-empty`

If `PATCH /edges/{id}` moves no end and names no `properties`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/edge-move.test.ts › refuses an update that moves no end and names no properties`.

## Moving an end of an edge

A move changes the `source_id` or the `target_id` of an edge in place, so a child changes parent, a message its thread and a successor its predecessor in one write.

### `edges/move-target`

When `PATCH /edges/{id}` names a `target_id` for an edge whose type is `one-to-one` or `many-to-one`, the server MUST move the edge's target to it.

**Reason:** each source holds one edge of such a type, so the end that stays is the one the move leaves whole.

**Tests:** `correctness/edges/edges-move.test.ts › moves a message to another thread, and a successor onto another predecessor`.

### `edges/move-source`

When `PATCH /edges/{id}` names a `source_id` for an edge whose type is `one-to-one` or `one-to-many`, the server MUST move the edge's source to it.

**Reason:** each target holds one edge of such a type, so a child changes parent by moving the edge.

**Tests:** `correctness/edges/edges-move.test.ts › moves a child to a new parent in one write, keeping the edge's id and properties`.

### `edges/move-keeps`

When `PATCH /edges/{id}` moves an end, the server MUST keep the edge's `id` and the properties it holds.

**Tests:** `correctness/edges/edges-move.test.ts › moves a child to a new parent in one write, keeping the edge's id and properties`.

### `edges/move-properties`

When `PATCH /edges/{id}` moves an end and names `properties`, the server MUST merge them over the edge's own, as it does where no end moves.

**Tests:** `correctness/edges/edges-move.test.ts › moves a child to a new parent in one write, keeping the edge's id and properties`.

### `edges/move-announced`

When `PATCH /edges/{id}` moves an end, the server MUST announce one `edge.updated` carrying the edge as it now stands.

**Tests:** `compliance/edge-move.test.ts › announces a move as one edge.updated, with nothing between`.

### `edges/move-announced-only`

When `PATCH /edges/{id}` moves an end, the server MUST NOT announce `edge.deleted` or `edge.created`.

**Tests:** `compliance/edge-move.test.ts › announces a move as one edge.updated, with nothing between`.

### `edges/move-announced-no-old-end`

When `PATCH /edges/{id}` moves an end, the server MUST NOT name the end the edge left in the `edge.updated` it announces.

**Reason:** a consumer holds the edge by its id, and an old source named on the stream would be one a subscriber may not read.

**Tests:** `compliance/edge-move.test.ts › announces a move as one edge.updated, with nothing between`.

### `edges/move-no-gap`

While `PATCH /edges/{id}` moves an end, the server MUST NOT show a reader of a listing or of the stream the end that stays holding no edge of the type or two.

**Reason:** a delete and a create are two writes, between which the end holds none.

**Tests:** `correctness/edges/edges-move.test.ts › never shows a reader the end with no edge while the edge moves`, `compliance/edge-move.test.ts › announces a move as one edge.updated, with nothing between`.

### `edges/move-cardinality`

If `PATCH /edges/{id}` moves an end of a `one-to-one` edge onto an item that already holds an edge of the type at that end, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `cardinality`, the `edge_type` and that end's id.

**Tests:** `compliance/edge-move.test.ts › refuses a move onto an end that already holds its one edge, and moves nothing`, `correctness/edges/edges-cardinality.test.ts › refuses to move an end of a one-to-one edge onto one that already holds an edge of the type on PATCH /edges/{id}`.

### `edges/move-constraint`

If `PATCH /edges/{id}` moves the target onto an item whose type the edge type's `target_type_constraints` do not admit, then the server MUST answer `400 edge_constraint_violation` naming the `target_type`.

**Tests:** `compliance/edge-move.test.ts › refuses a move onto a target its type's constraint refuses, and answers one the key cannot read exactly as a missing one`.

### `edges/move-cycle`

If `PATCH /edges/{id}` moves an end of a `parent-of` or `supersedes` edge so that it closes a cycle through other edges of the type, then the server MUST answer `400 edge_cycle` naming the `edge_type`, `source_id` and `target_id` the move would give the edge.

**Tests:** `compliance/edge-move.test.ts › refuses a move that would close a cycle, and moves nothing`, `correctness/edges/edges-cycle.test.ts › refuses a PATCH /edges/{id} move that closes a cycle, and moves a free edge`.

### `edges/move-cycle-self`

If `PATCH /edges/{id}` moves an end that `edges/move-target` or `edges/move-source` lets it move onto the item at the edge's other end, then the server MUST answer `400 edge_cycle` with `details.edge_type`.

**Tests:** `compliance/edge-move.test.ts › refuses a move that would close a cycle, and moves nothing`.

### `edges/move-source-write`

If `PATCH /edges/{id}` moves the source onto an item whose type the key may read and not write, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/edge-move.test.ts › refuses a new source that does not exist, or whose type the key cannot write`.

### `edges/move-end-missing`

If `PATCH /edges/{id}` moves an end onto an item that does not exist, then the server MUST answer `404 item_not_found`.

**Tests:** `compliance/edge-move.test.ts › refuses a new source that does not exist, or whose type the key cannot write`, `› refuses a move onto a target its type's constraint refuses, and answers one the key cannot read exactly as a missing one`.

### `edges/move-end-in-bin`

If `PATCH /edges/{id}` moves an edge whose end that stays is in the bin, then the server MUST answer `404 item_not_found`, as a create of the edge is refused.

**Tests:** `compliance/edge-move.test.ts › refuses a move of an edge whose end that stays is in the bin, as its create is refused`.

### `edges/move-many`

If `PATCH /edges/{id}` moves an end of an edge whose type lets the end that stays hold more than one edge, then the server MUST answer `400 validation_error`.

**Reason:** there is no one edge to replace, and moving one of several would be a guess. `about` is such a type, and so is `parent-of` where its target moves.

**Tests:** `compliance/edge-move.test.ts › refuses to move an end of a type that holds many at the end that stays, or both ends at once`.

### `edges/move-both-ends`

If `PATCH /edges/{id}` names both a `source_id` and a `target_id` that differ from the edge's, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/edge-move.test.ts › refuses to move an end of a type that holds many at the end that stays, or both ends at once`.

### `edges/move-refusal-field`

If `PATCH /edges/{id}` refuses a move with `400 validation_error`, then the server MUST name the moved field in `details.errors[0].path`.

**Tests:** `device/fidelity.test.ts › matches the refusal of a second parent, a parent moved in one step, and each refusal of a move`.

### `edges/move-refused-unchanged`

If `PATCH /edges/{id}` refuses a move, then the server MUST leave the edge as it was.

**Tests:** `compliance/edge-move.test.ts › refuses a move onto an end that already holds its one edge, and moves nothing`, `› refuses a move that would close a cycle, and moves nothing`, `› refuses a move of an edge whose end that stays is in the bin, as its create is refused`, `› refuses a stale version with the edge as it stands, and moves nothing`.

## Deleting an edge

### `edges/delete`

When `DELETE /edges/{id}` names an edge the key may write, the server MUST answer `200` with `ok: true`.

**Tests:** `correctness/edges/edges-crud.test.ts › deleteEdge removes the edge; subsequent list excludes it`.

### `edges/delete-gone`

When `DELETE /edges/{id}` answers `200`, the server MUST NOT list the edge on any later listing.

**Tests:** `correctness/edges/edges-crud.test.ts › deleteEdge removes the edge; subsequent list excludes it`.

### `edges/delete-announced`

When `DELETE /edges/{id}` removes an edge, the server MUST announce `edge.deleted`.

**Tests:** `compliance/edge-events.test.ts › SSE delivers edge.created and edge.deleted`.

### `edges/delete-missing`

When `DELETE /edges/{id}` finds no edge the credential may read, including one another request deleted first, the server MUST answer `404 edge_not_found`.

**Reason:** a second `200` for one edge would report a delete that did not happen.

**Tests:** `compliance/edge-events.test.ts › answers deletes of one edge after the first 404, and announces it once`.

### `edges/delete-missing-silent`

When `DELETE /edges/{id}` answers `404 edge_not_found`, the server MUST NOT announce an event for it.

**Reason:** a second `edge.deleted` for one edge would tell a subscriber of a delete that did not happen.

**Tests:** `compliance/edge-events.test.ts › answers deletes of one edge after the first 404, and announces it once`.

### `edges/delete-missing-no-audit`

When `DELETE /edges/{id}` answers `404 edge_not_found`, the server MUST NOT write an audit record for it.

**Tests:** `compliance/edge-events.test.ts › answers a delete of an edge the key cannot read 404 edge_not_found and writes no audit record, where a delete it can read writes one`.

## Bulk writes

### `edges/bulk-answer`

When the server accepts a `POST /edges/bulk` page, the server MUST answer `200` with `counts` of `created`, `updated`, `skipped` and `errored` entries and one `results` entry for each entry sent, in the order sent, each with its `index` and its `outcome`.

**Tests:** `compliance/edges-bulk.test.ts › creates edges in bulk and returns per-edge outcomes`.

### `edges/bulk-result-id`

When the server reports a `POST /edges/bulk` entry `created`, `updated` or `skipped`, the server MUST give the `id` of the edge the entry wrote or matched.

**Tests:** `compliance/edges-bulk.test.ts › creates edges in bulk and returns per-edge outcomes`, `› matches an entry to the edge an earlier entry of the same request wrote`.

### `edges/bulk-entry-cap`

If a `POST /edges/bulk` page holds more than 5,000 entries, then the server MUST answer `400 validation_error` with `details.cap` 5000 and `details.provided`.

**Tests:** `compliance/edges-bulk.test.ts › takes a page of 5,000 entries and refuses one of 5,001`.

### `edges/bulk-empty`

When `POST /edges/bulk` names an empty `edges` list, the server MUST answer `200` with zero `counts` and no `results`.

**Tests:** `compliance/edges-bulk.test.ts › answers an empty edges list with 200 and no results`.

### `edges/bulk-atomic-default`

When `POST /edges/bulk` names no `atomic`, the server MUST judge the page as `atomic: true`.

**Tests:** `compliance/edges-bulk.test.ts › writes nothing from a page with one bad entry when atomic is left out`, `› refuses a reused edge id here as the single door does, and says what differs`.

### `edges/bulk-upsert`

When a `POST /edges/bulk` entry under `mode: upsert`, the default, names a triple an edge holds and no `version` or that edge's current one, the server MUST merge the entry's `properties` over that edge's.

**Tests:** `compliance/edges-bulk.test.ts › upsert mode merges properties in place on duplicate triples`, `› answers an entry repeating a held edge id and triple as updated, or skipped under create_only, and a skipped entry writes nothing`.

### `edges/bulk-upsert-updated`

When a `POST /edges/bulk` entry under `mode: upsert` merges into an edge, the server MUST report the entry `updated` with that edge's `id`.

**Tests:** `compliance/edges-bulk.test.ts › upsert mode merges properties in place on duplicate triples`, `› answers an entry repeating a held edge id and triple as updated, or skipped under create_only, and a skipped entry writes nothing`.

### `edges/bulk-version-stale`

If a `POST /edges/bulk` entry under `mode: upsert` names a triple an edge holds and a `version` other than that edge's current one, then the server MUST refuse the entry `version_conflict`, as `errored` on the entry under `atomic: false` and as `details.code` of a `409` rollback under `atomic: true`.

**Tests:** `compliance/edges-bulk-version.test.ts › reports a stale version as errored with version_conflict under atomic false`, `› rolls the page back with a 409 whose details.code is version_conflict under atomic true`, `› updates an entry that names the current version`.

### `edges/bulk-match-unregistered`

When a `POST /edges/bulk` entry under `mode: upsert` names a triple that an edge of an edge type no longer registered holds, the server MUST report the entry `updated`.

**Tests:** `compliance/edges-bulk-version.test.ts › answers updated for an entry whose triple an edge of a force-deleted type holds`.

### `edges/bulk-upsert-merge`

When a `POST /edges/bulk` entry merges `properties` over an edge, the server MUST give each key the entry names its value whole, a nested object included, and leave each key it names none for as it was.

**Tests:** `compliance/edges-bulk.test.ts › upsert mode merges properties in place on duplicate triples`.

### `edges/bulk-create-only`

When a `POST /edges/bulk` entry under `mode: create_only` names a triple an edge holds, the server MUST report the entry `skipped` with `reason: "duplicate_edge"` and the `id` of the edge held.

**Reason:** the closed list of `reason` values is `items/bulk-reason`.

**Tests:** `compliance/edges-bulk.test.ts › create_only surfaces duplicates as skipped with reason duplicate_edge`, `› matches an entry to the edge an earlier entry of the same request wrote`, `compliance/edges-bulk-version.test.ts › skips an entry naming a held triple as duplicate_edge under create_only, whatever version it names`.

### `edges/bulk-skipped-writes-nothing`

When the server reports a `POST /edges/bulk` entry `skipped`, the server MUST NOT write it.

**Tests:** `compliance/edges-bulk.test.ts › answers an entry repeating a held edge id and triple as updated, or skipped under create_only, and a skipped entry writes nothing`.

### `edges/bulk-repeat-id`

When a `POST /edges/bulk` entry names an `id` that an edge the key may read holds, the triple of that edge, and no `version` or that edge's current one, the server MUST judge the entry as it judges any entry naming that triple, reporting it `updated` under `upsert` and `skipped` under `create_only`.

**Reason:** `POST /edges` answers the same repeat with `acknowledged: true` and writes nothing (`edges/id-repeat`), and a bulk entry does not, because it is matched by its triple.

**Tests:** `compliance/edges-bulk.test.ts › answers an entry repeating a held edge id and triple as updated, or skipped under create_only, and a skipped entry writes nothing`.

### `edges/bulk-match-earlier`

When a `POST /edges/bulk` entry names a triple that an earlier entry of the same page wrote, the server MUST judge the entry as one naming a triple an edge holds.

**Tests:** `compliance/edges-bulk.test.ts › matches an entry to the edge an earlier entry of the same request wrote`.

### `edges/bulk-match-race`

When a `POST /edges/bulk` entry names a triple that another request wrote after the page began, the server MUST judge the entry as one naming a triple an edge holds.

**Reason:** one triple is one edge, so the answer for a repeated triple does not depend on whether the edge was written before the request began.

**Tests:** `compliance/edge-races.test.ts › stores one edge when two bulk pages carry the same triple`.

### `edges/bulk-atomic`

If an entry of a `POST /edges/bulk` page under `atomic: true` is refused, then the server MUST answer `bulk_atomic_rollback`.

**Tests:** `compliance/edges-bulk.test.ts › atomic=true rolls back the whole batch on validation error`, `› atomic=true rolls back a batch naming an item that does not exist`, `› gates bulk edges per type and edge permission, and on nothing else`.

### `edges/bulk-atomic-writes-nothing`

If an entry of a `POST /edges/bulk` page under `atomic: true` is refused, then the server MUST write no entry of the page.

**Tests:** `compliance/edges-bulk.test.ts › atomic=true rolls back the whole batch on validation error`, `› atomic=true rolls back a batch naming an item that does not exist`, `correctness/edges/edges-cycle.test.ts › refuses an atomic page that proposes an edge and its reverse together, and writes neither`.

### `edges/bulk-atomic-gates-first`

When a `POST /edges/bulk` page under `atomic: true` holds an entry with a malformed id, or one whose source type or edge type the key may not write, the server MUST answer the rollback for the first such entry before it judges any entry against the edges it holds.

**Reason:** the same as `items/bulk-atomic-gates-first`: a page the key may not write is refused whole, whatever else it holds.

**Tests:** `compliance/edges-bulk-version.test.ts › refuses an atomic page for an entry the key may not write before a stale entry ahead of it`.

### `edges/bulk-atomic-details`

When the server answers `bulk_atomic_rollback` to a `POST /edges/bulk` page, the server MUST name in `details.code` and `details.index` the code and the position of the entry it refused.

**Tests:** `correctness/edges/edges-cardinality.test.ts › refuses a second edge at a held end in a POST /edges/bulk entry, as an errored entry or a rollback`, `correctness/edges/edges-cycle.test.ts › refuses a POST /edges/bulk entry that closes a cycle, as an errored entry or a rollback`, `compliance/edge-types.test.ts › names the property an in-folder refusal rests on, on an edge update, a bulk entry and an inline edge`.

### `edges/bulk-atomic-status`

When the server answers `bulk_atomic_rollback` to a `POST /edges/bulk` page, the server MUST answer it with the status the refused entry's code carries on its own operation, such as `404` for an end that is not there and `409` for an id another edge holds.

**Reason:** the status tells the caller what to do next, as `items/bulk-atomic-status` states for items.

**Tests:** `compliance/edges-bulk.test.ts › atomic=true rolls back a batch naming an item that does not exist`, `› refuses a reused edge id here as the single door does, and says what differs`, `› gates bulk edges per type and edge permission, and on nothing else`, `› atomic=true rolls back the whole batch on validation error`.

### `edges/bulk-best-effort`

If an entry of a `POST /edges/bulk` page under `atomic: false` is refused, then the server MUST report it `errored` with its `error.code` and `error.details`.

**Tests:** `compliance/edges-bulk.test.ts › atomic=false collects errors and continues`, `correctness/edges/edges-cardinality.test.ts › refuses a second edge at a held end in a POST /edges/bulk entry, as an errored entry or a rollback`, `correctness/edges/edges-type-constraints.test.ts › refuses an end of the wrong type in a POST /edges/bulk entry, on the entry's error or inside the rollback`.

### `edges/bulk-best-effort-others`

When the server refuses an entry of a `POST /edges/bulk` page under `atomic: false`, the server MUST still write the page's other entries.

**Tests:** `compliance/edges-bulk.test.ts › atomic=false collects errors and continues`, `correctness/edges/edges-type-constraints.test.ts › refuses an end of the wrong type in a POST /edges/bulk entry, on the entry's error or inside the rollback`.

### `edges/bulk-errored-writes-nothing`

When the server reports a `POST /edges/bulk` entry `errored` without `error.details.write_outcome: "unknown"`, the server MUST NOT have written its edge.

**Tests:** `correctness/edges/edges-cycle.test.ts › refuses a POST /edges/bulk entry that closes a cycle, as an errored entry or a rollback`.

### `edges/bulk-unknown-type`

If an entry of a `POST /edges/bulk` page under `atomic: false` names an edge type nothing registered and a triple no edge holds, and the key's edge map grants write on that name, then the server MUST report the entry `errored` with `edge_type_not_found`.

**Tests:** `compliance/edges-bulk.test.ts › unknown edge_type lands as errored in non-atomic mode`.

### `edges/bulk-outcome-unknown`

If the server cannot confirm whether an entry of a `POST /edges/bulk` page under `atomic: false` committed, then the server MUST report that entry `errored` with `error.details.write_outcome: "unknown"`, counted under `errored` alone, in a `200` answer.

**Reason:** the caller reconciles that entry's stored state before retrying it, and does not replay the page (`items/bulk-outcome-unknown`).

**Tests:** waiting on #1444.

### `edges/bulk-outcome-unknown-continues`

When the server reports a `POST /edges/bulk` entry with `write_outcome: "unknown"`, the server MUST go on to the page's next entry.

**Tests:** waiting on #1444.

## Edges written with an item

### `edges/inline-create`

When `POST /items` names `edges`, the server MUST create the item and, for each edge type named, an outbound edge from it to each target listed.

**Tests:** `correctness/edges/edges-crud.test.ts › POST /items with edges creates item + edges atomically`.

### `edges/inline-create-answer`

When `POST /items` creates edges it names in `edges`, the server MUST answer the item with those edges in `item.edges`.

**Tests:** `correctness/edges/edges-crud.test.ts › POST /items with edges creates item + edges atomically`.

### `edges/inline-refused-no-item`

If `POST /items` names an inline edge the server refuses, then the server MUST NOT create the item.

**Tests:** `correctness/edges/edges-cardinality.test.ts › refuses an inline edge to an end a one-to-one or one-to-many type holds, and one set naming two ends of a one-to-one type, on POST /items`.

### `edges/inline-empty-list`

When `PATCH /items/{id}` names an empty list for an edge type under `edges`, the server MUST delete every outbound edge of that type from the item.

**Reason:** replacing the edges of a type is `items/update-inline-edges`, and an empty list replaces them with none.

**Tests:** `correctness/edges/edges-crud.test.ts › PATCH /items with an edge list replaces that type's edges, an empty list removes them, and a type not named stays`.

## Endpoint types

An edge type's `source_type_constraints` and `target_type_constraints` each hold `*`, a type identifier or `role:<name>`.

### `edges/endpoint-source`

If `POST /edges` names a source whose type the edge type's `source_type_constraints` do not admit, then the server MUST answer `400 edge_constraint_violation` with `details` naming the `edge_type`, the `source_type` and the types `allowed`.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › refuses an end of the wrong type on POST /edges, naming the type and the types allowed`, `› non-matching source type rejected`.

### `edges/endpoint-target`

If `POST /edges` names a target whose type the edge type's `target_type_constraints` do not admit, then the server MUST answer `400 edge_constraint_violation` with `details` naming the `edge_type`, the `target_type` and the types `allowed`.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › refuses an end of the wrong type on POST /edges, naming the type and the types allowed`, `› non-matching target type rejected`.

### `edges/endpoint-bulk`

If an entry of `POST /edges/bulk` names an end of a type the edge type does not admit, then the server MUST refuse the entry `edge_constraint_violation` with the `details` `POST /edges` gives, as `error` on the entry under `atomic: false` and as `details.details` of the rollback under `atomic: true`.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › refuses an end of the wrong type in a POST /edges/bulk entry, on the entry's error or inside the rollback`.

### `edges/endpoint-inline`

If `POST /items` names an inline edge whose new item or target is of a type the edge type does not admit, then the server MUST answer `400 edge_constraint_violation` with the `details` `POST /edges` gives.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › refuses an inline edge whose new item or target is of the wrong type on POST /items`.

### `edges/endpoint-subtype`

When a constraint of an edge type names a type, the server MUST admit an item of any subtype of it.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › inheritance-aware: constraint accepts inheriting child type`, `› source / target type constraints: matching types accepted`.

## Cardinality

A cardinality says how many edges of one type an end holds: `one-to-one` lets each source and each target hold one, `one-to-many` each target one, `many-to-one` each source one, and `many-to-many` any number.

### `edges/card-target-held`

If `POST /edges` names a target that already holds an inbound edge of the edge type, and the type is `one-to-many` or `one-to-one`, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `cardinality` and the `edge_type` and `target_id`.

**Reason:** a child has one parent at any depth, and a successor has one predecessor.

**Tests:** `correctness/edges/edges-cardinality.test.ts › parent-of is one-parent-per-child: second parent rejected`, `› parent-of deep nesting respects the one-parent-per-child rule at depth`, `› supersedes is one-to-one: rejects second inbound to same target`, `› refuses a second edge at a one-to-one or one-to-many end on POST /edges, and a many-to-many type takes it`.

### `edges/card-source-held`

If `POST /edges` names a source that already holds an outbound edge of the edge type, and the type is `many-to-one` or `one-to-one`, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `cardinality` and the `edge_type` and `source_id`.

**Tests:** `correctness/edges/edges-cardinality.test.ts › in-thread is many-to-one: source can only join one thread`, `› supersedes is one-to-one: rejects second outbound from same source`, `› refuses a second edge at a one-to-one or one-to-many end on POST /edges, and a many-to-many type takes it`.

### `edges/card-many`

When `POST /edges` names an end that already holds edges of a `many-to-many` type, the server MUST take the edge.

**Tests:** `correctness/edges/edges-cardinality.test.ts › many-to-many edge types accept multiple edges`, `› refuses a second edge at a one-to-one or one-to-many end on POST /edges, and a many-to-many type takes it`.

### `edges/card-bulk`

If an entry of `POST /edges/bulk` names a triple no edge holds and an end that already holds an edge of a `one-to-one`, `one-to-many` or `many-to-one` type at that end, including one an earlier entry of the page wrote, then the server MUST refuse the entry `edge_constraint_violation` with `details.constraint` `cardinality`, as `error` on the entry under `atomic: false` and as `details.details` of the rollback under `atomic: true`.

**Tests:** `correctness/edges/edges-cardinality.test.ts › refuses a second edge at a held end in a POST /edges/bulk entry, as an errored entry or a rollback`.

### `edges/card-inline`

If `POST /items` names inline edges that give an end a second edge of a `one-to-one`, `one-to-many` or `many-to-one` type, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `cardinality`.

**Tests:** `correctness/edges/edges-cardinality.test.ts › refuses an inline edge to an end a one-to-one or one-to-many type holds, and one set naming two ends of a one-to-one type, on POST /items`.

### `edges/card-hidden`

If `POST /edges` names a target of a `one-to-many` or `one-to-one` type that already holds an inbound edge from a source the key may not read, then the server MUST refuse it `400 edge_constraint_violation` with `details` naming only the edge type, the target the key named and the constraint.

**Reason:** a limit accepted: every cardinality check counts the edges the key cannot see, so the one-parent rule stays whole. The refusal can reveal that something hidden exists, never its id or type.

**Tests:** `compliance/edge-hidden-limits.test.ts › refuses a second parent the key cannot see, naming only the child`, `› refuses a successor the key cannot see on a one-to-one type, naming only the target`.

## Cycles

### `edges/cycle`

If `POST /edges` names a `parent-of` or `supersedes` edge that would close a cycle, directly or through other edges of the type, then the server MUST answer `400 edge_cycle`.

**Tests:** `correctness/edges/edges-cycle.test.ts › parent-of direct cycle: A→B then B→A rejected`, `› parent-of deep cycle: A→B→C then C→A rejected`, `› supersedes direct cycle: A→B then B→A rejected`, `› supersedes deep cycle: A→B→C then C→A rejected`.

### `edges/cycle-self-loop`

If `POST /edges` names the same item as `source_id` and `target_id`, then the server MUST answer `400 edge_cycle`, on every edge type.

**Reason:** a self-loop is the shortest cycle, so one edge closes it and the type is not walked.

**Tests:** `correctness/edges/edges-cycle.test.ts › self-loop rejected: A→A on parent-of`, `› self-loop rejected: A→A on about`.

### `edges/cycle-bulk`

If an entry of `POST /edges/bulk` names a `parent-of` or `supersedes` edge that would close a cycle through other edges of the type, then the server MUST refuse the entry `edge_cycle` naming the `edge_type`, `source_id` and `target_id`, as `error` on the entry under `atomic: false` and as `details.details` of the rollback under `atomic: true`.

**Tests:** `correctness/edges/edges-cycle.test.ts › refuses a POST /edges/bulk entry that closes a cycle, as an errored entry or a rollback`.

### `edges/cycle-atomic-page`

If a `POST /edges/bulk` page under `atomic: true` proposes a `parent-of` or `supersedes` edge and its reverse together, then the server MUST answer `bulk_atomic_rollback` with `details.code` `edge_cycle`.

**Tests:** `correctness/edges/edges-cycle.test.ts › refuses an atomic page that proposes an edge and its reverse together, and writes neither`.

### `edges/cycle-hidden`

If `POST /edges` names a `parent-of` edge that closes a cycle only through an edge from a source the key may not read, then the server MUST refuse it `400 edge_cycle` with `details` naming only the edge type and the two ends the key named.

**Reason:** a limit accepted: the cycle check reads every edge, so an acyclic graph stays whole. The refusal can reveal that something hidden exists, never its id or type.

**Tests:** `compliance/edge-hidden-limits.test.ts › refuses an edge that closes a cycle only through an edge the key cannot see, naming only its own ends`.

## The folder and collection edge types

### `edges/types-in-folder`

When a credential sends `GET /edge-types`, the server MUST list `in-folder` as `many-to-many`, from any type to `system.folder`, with `cascade_on_delete` `orphan`, `written_at` `source`, no `reverse_name` and a `path` in its `property_schema`.

**Reason:** `in-folder` places an item in a folder, and its `path` is the file's path relative to the folder's root (`items/folder-create`, `folders.md` 11).

**Tests:** `compliance/edge-types.test.ts › ships in-folder from any item to a system.folder, carrying its path`.

### `edges/folder-target`

If `POST /edges` names an `in-folder` edge to an item that is not a `system.folder`, then the server MUST answer `400 edge_constraint_violation`.

**Tests:** `compliance/edge-types.test.ts › writes an in-folder edge from a key holding the source's type, the edge type and read on system.folder, and writing nothing of it`.

### `edges/folder-path`

If `POST /edges` names an `in-folder` edge with no `path`, or a `path` that is empty, over 1024 UTF-16 code units, absolute, drive-absolute, holds a backslash or a NUL, climbs out of the folder or names its root, then the server MUST answer `400 validation_error` with `details.errors[0].path` `properties.path`.

**Tests:** `compliance/edge-types.test.ts › refuses an in-folder path that is missing or leaves the folder, and any other property, on every door that writes one`.

### `edges/folder-other-property`

If `POST /edges` names an `in-folder` edge with a property other than `path`, then the server MUST answer `400 validation_error` with `details.errors[0].path` naming `properties.` and that property.

**Tests:** `compliance/edge-types.test.ts › refuses an in-folder path that is missing or leaves the folder, and any other property, on every door that writes one`.

### `edges/folder-path-climb-back`

When `POST /edges` names an `in-folder` edge whose `path` climbs out of a name and comes back inside the folder, the server MUST create the edge.

**Tests:** `compliance/edge-types.test.ts › refuses an in-folder path that is missing or leaves the folder, and any other property, on every door that writes one`.

### `edges/folder-update`

If `PATCH /edges/{id}` would leave an `in-folder` edge, judged on the properties as they would stand after the merge, with no valid `path` or with a property other than `path`, then the server MUST answer `400 validation_error` with `details.errors[0].path` naming the property.

**Tests:** `compliance/edge-types.test.ts › names the property an in-folder refusal rests on, on an edge update, a bulk entry and an inline edge`.

### `edges/folder-bulk`

If an entry of `POST /edges/bulk` would leave an `in-folder` edge, created or merged, with no valid `path` or with a property other than `path`, then the server MUST refuse the entry `validation_error` with `details.errors[0].path` naming the property, as `error` on the entry under `atomic: false` and as `details.details` of the rollback under `atomic: true`.

**Tests:** `compliance/edge-types.test.ts › names the property an in-folder refusal rests on, on an edge update, a bulk entry and an inline edge`.

### `edges/folder-inline`

If `POST /items` or `PATCH /items/{id}` names an inline `in-folder` edge, then the server MUST answer `400 validation_error` with `details.errors[0].path` `properties.path`.

**Reason:** an inline edge carries no properties, so the `path` an `in-folder` edge requires is what it lacks.

**Tests:** `compliance/edge-types.test.ts › names the property an in-folder refusal rests on, on an edge update, a bulk entry and an inline edge`.

### `edges/folder-revoked`

If `POST /edges` names an `in-folder` edge to a revoked folder, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `revoked`.

**Tests:** `compliance/edge-types.test.ts › refuses a new placement in a revoked folder with edge_constraint_violation, and keeps the ones it held`.

### `edges/folder-revoked-keeps`

While a folder is revoked, the server MUST keep the `in-folder` edges it held when it was revoked.

**Tests:** `compliance/edge-types.test.ts › refuses a new placement in a revoked folder with edge_constraint_violation, and keeps the ones it held`.

### `edges/folder-place`

When a key holding write on an item's type, write on `in-folder` and read on `system.folder` sends `POST /edges` for the item and a folder, the server MUST create the edge.

**Reason:** the folder row stays refused to every operation that would write it (`items/system-types`, `items/folder-grant`).

**Tests:** `compliance/edge-types.test.ts › writes an in-folder edge from a key holding the source's type, the edge type and read on system.folder, and writing nothing of it`.

### `edges/folder-blind`

If a key without read on `system.folder` sends `POST /edges` for an `in-folder` edge, then the server MUST answer `404 item_not_found` for the folder.

**Tests:** `compliance/edge-types.test.ts › writes an in-folder edge from a key holding the source's type, the edge type and read on system.folder, and writing nothing of it`.

### `edges/collection-target`

If `POST /edges` names an `in-collection` edge to a target whose type does not declare the `container` role, then the server MUST answer `400 edge_constraint_violation`.

**Reason:** `in-collection` constrains its target by role rather than by type, so a publisher's registered type that declares `container` is a target too; the shipped `core.media.album` and `core.media.series` declare it.

**Tests:** `compliance/edge-permissions.test.ts › $name answers an unreadable target as a missing one, whatever its type`.

### `edges/collection-no-nesting`

If `POST /edges` names an `in-collection` edge from a source whose type declares the `container` role, then the server MUST answer `400 edge_constraint_violation` with `details.constraint` `nesting`, naming the `source_id` and `source_type`.

**Reason:** a container holds items, never other containers, and `parent-of` is for hierarchy.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › in-collection refuses a source that is itself a container, as nesting`.

### `edges/collection-no-nesting-others`

If an entry of `POST /edges/bulk`, or `POST /items` with an inline edge, names an `in-collection` edge from a source whose type declares the `container` role, then the server MUST refuse it `edge_constraint_violation` with `details.constraint` `nesting`.

**Tests:** `correctness/edges/edges-type-constraints.test.ts › in-collection refuses a source that is itself a container, as nesting`.

## Deleting an item that holds edges

### `edges/cascade-parent-of`

When `DELETE /items/{id}` names an item that holds outbound `parent-of` edges, the server MUST move into the bin the targets of those edges.

**Reason:** the cascade across every depth and operation is `items/trash-cascade`, and what a restore brings back is `items/restore-cascade`.

**Tests:** `correctness/edges/edges-cascade.test.ts › deleting a parent-of parent cascades to children`.

### `edges/cascade-custom`

When `DELETE /items/{id}` names an item that holds outbound edges of a registered type whose `cascade_on_delete` is `cascade`, the server MUST move into the bin the targets of those edges.

**Tests:** `correctness/edges/edges-cascade.test.ts › custom edge-type with cascade_on_delete=cascade cascades on source delete`.

### `edges/orphan-shipped`

When `DELETE /items/{id}` names an item that holds an edge of a shipped type other than `parent-of`, the server MUST leave the other end of the edge active.

**Reason:** the shipped types other than `parent-of` declare `cascade_on_delete` `orphan`, and the edge row stays while its item is in the bin.

**Tests:** `correctness/edges/edges-cascade.test.ts › supersedes defaults to orphan: deleting head leaves predecessor intact`, `› about defaults to orphan: deleting source leaves target intact`, `› attached-to defaults to orphan: deleting the host leaves the attachment intact`, `› references defaults to orphan: deleting the referenced target leaves the source intact`.

### `edges/block-named`

If `DELETE /items/{id}` or a transition into the bin is refused `400 edge_constraint_violation` for `block` edges whose edge type and both ends the key may read, then the server MUST name each of them in `details.blocking_edges`, wherever in the cascade it stands.

**Reason:** which edge types block is the registration's `cascade_on_delete`, and the refusal itself is `items/trash-blocked`.

**Tests:** `correctness/edges/edges-cascade.test.ts › custom edge-type with cascade_on_delete=block refuses source delete while edges exist`, `› names every blocking edge in the cascade, not only the first it meets`, `› names every blocking edge in the cascade on a transition into the bin, as a delete does`, `compliance/edge-hidden-limits.test.ts › counts the edge without naming it, where a key that reads the type is told which`.

### `edges/block-hidden-left-out`

If a delete is refused by a `block` edge whose edge type or whose either end the key may not read, then the server MUST leave that edge out of `details.blocking_edges` and out of the count its message gives.

**Reason:** the refusal can reveal that something hidden holds the row, never its id or type. Which edges a refusal names is `items/trash-blocked-names`.

**Tests:** `compliance/edge-hidden-limits.test.ts › refuses a delete held by a blocking edge it cannot see, naming no hidden id`, `› counts the edge without naming it, where a key that reads the type is told which`.

### `edges/block-hidden-refuses`

If a `block` edge that the key may not read holds an item, then the server MUST still refuse the delete `400 edge_constraint_violation`.

**Tests:** `compliance/edge-hidden-limits.test.ts › refuses a delete held by a blocking edge it cannot see, naming no hidden id`, `› counts the edge without naming it, where a key that reads the type is told which`.

### `edges/block-no-count`

If a delete is refused by `block` edges the key may not read and by none it may, then the server MUST give a message that states no count.

**Tests:** `compliance/edge-hidden-limits.test.ts › refuses a delete held by a blocking edge it cannot see, naming no hidden id`, `› counts the edge without naming it, where a key that reads the type is told which`.

### `edges/purge-not-blocked`

The server MUST NOT refuse `POST /items/{id}/purge` for an item that a `block` edge holds.

**Reason:** a purge deletes the edges on both ends of the item, and a cascade does not reach it (`items/purge-edges`).

**Tests:** `correctness/edges/edges-cascade.test.ts › purges an item held by a block edge, taking its edges on both ends`.

### `edges/cascade-hidden-children`

When a key deletes an item it may write, the server MUST move into the bin the `parent-of` children of the item whose types the key may not read.

**Reason:** a limit accepted: a delete takes the children whatever their types.

**Tests:** `compliance/edge-hidden-limits.test.ts › trashes a hidden child with the parent the key deletes`.

### `edges/cascade-hidden-unnamed`

When a key deletes an item whose `parent-of` children include children whose types it may not read, the server MUST NOT name those children in its answer.

**Tests:** `compliance/edge-hidden-limits.test.ts › trashes a hidden child with the parent the key deletes`.

## Edge types

Where one registration meets more than one rule of this section, `edges/types-register-order` says which answer it gets.

### `edges/types-register-order`

When `POST /edge-types` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: a key without `metadata.edge_types:write`; a missing field; a shipped `id`; an `id` that is not an edge type identifier; an `id` or `reverse_name` the key's edge map does not grant; `extends`; an `id` a registered edge type holds.

**Tests:** `compliance/edge-types.test.ts › refuses a key without metadata.edge_types:write before it answers a shipped id`, `› answers a shipped id as a conflict before it refuses extends`, `› answers a shipped id as a conflict before it asks the key's edge map`, `› refuses an id that is not an edge type identifier before it asks the key's edge map`, `› refuses an id the key's edge map does not grant before it refuses extends`.

### `edges/types-shipped`

When a credential sends `GET /edge-types`, the server MUST list the ten shipped edge types `about`, `parent-of`, `in-thread`, `attached-to`, `authored-by`, `derived-from`, `supersedes`, `references`, `in-collection` and `in-folder`.

**Tests:** `compliance/edge-types.test.ts › lists the shipped edge types and a registered one`.

### `edges/types-shipped-cardinality`

When a credential sends `GET /edge-types`, the server MUST list `parent-of` as `one-to-many`, `in-thread` as `many-to-one`, `supersedes` as `one-to-one` and the other seven shipped types as `many-to-many`.

**Tests:** `device/fidelity.test.ts › matches the edge types a working copy holds and a folder reads its frontmatter lines by`, `compliance/edge-types.test.ts › core-first resolution: edge_type="about" always routes to core semantics`.

### `edges/types-shipped-cascade`

When a credential sends `GET /edge-types`, the server MUST list `parent-of` with `cascade_on_delete` `cascade` and the other nine shipped types with `orphan`.

**Tests:** `device/fidelity.test.ts › matches the edge types a working copy holds and a folder reads its frontmatter lines by`.

### `edges/types-in-collection`

When a credential sends `GET /edge-types`, the server MUST list `in-collection` with the target constraint `role:container`.

**Tests:** `device/fidelity.test.ts › matches the edge types a working copy holds and a folder reads its frontmatter lines by`.

### `edges/types-reverse-names`

When a credential sends `GET /edge-types`, the server MUST list `reverse_name` `child-of` on `parent-of` and `has-attachment` on `attached-to`, and none on `references`.

**Reason:** the name an edge goes by read from its target.

**Tests:** `compliance/edge-types.test.ts › lists the reverse names the shipped edge types declare`.

### `edges/types-written-at`

When a credential sends `GET /edge-types`, the server MUST list `written_at` `target` on `parent-of` and `source` on `attached-to` and `references`.

**Reason:** `written_at` is the end whose file writes the edge in a folder, and a child names its parent (`folders.md` 11).

**Tests:** `compliance/edge-types.test.ts › lists the end whose file writes each shipped edge type`.

### `edges/types-list`

When a credential sends `GET /edge-types`, the server MUST list every registered edge type with its `cardinality`, beside the shipped ones.

**Reason:** the registry is open to every credential (`types/registry-open`).

**Tests:** `compliance/edge-types.test.ts › lists the shipped edge types and a registered one`, `compliance/unreadable-type-filter.test.ts › lists every type and edge type to a key that reads two types`.

### `edges/types-list-whole`

When a credential sends `GET /edge-types`, the server MUST answer `data` with the whole list and `next_cursor` `null`.

**Tests:** `compliance/edge-types.test.ts › answers the edge type list as the whole list, with a null next_cursor`.

### `edges/types-shipped-flag`

When the server answers an edge type, on `GET /edge-types` and on the `201` of `POST /edge-types`, the server MUST give `shipped` `true` for a shipped type and `false` for a registered one.

**Reason:** a connector tells the two apart without a list of names.

**Tests:** `compliance/edge-types.test.ts › says whether Marfa ships each edge type, on the list and on registration`.

### `edges/types-register`

When a key sends `POST /edge-types` with an `id` and a `cardinality` it may register, the server MUST answer `201` with the `edge_type`.

**Tests:** `compliance/edge-types.test.ts › registers a custom edge type and answers 201`.

### `edges/types-usable`

When a key registers an edge type, the server MUST accept `POST /edges` naming it.

**Tests:** `compliance/edge-types.test.ts › registered edge type is usable in POST /edges`.

### `edges/types-register-permission`

If a key without `metadata.edge_types:write` sends `POST /edge-types`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/edge-types.test.ts › a key without metadata.edge_types:write cannot register an edge type`.

### `edges/types-register-map`

If `POST /edge-types` names an `id` or a `reverse_name` that the key's own edge map leaves short of `write`, then the server MUST answer `403 edge_permission_denied` with `details.edge_type` naming it.

**Reason:** a registration claims both names, and one key cannot take a name another key was meant to register.

**Tests:** `compliance/edge-types.test.ts › registers only the edge type ids the key's own edge map grants write on`.

### `edges/types-register-shipped`

If `POST /edge-types` names the `id` of a shipped edge type, then the server MUST answer `409 conflict`.

**Reason:** a shipped name always resolves to the shipped type.

**Tests:** `compliance/edge-types.test.ts › rejects a custom type whose id collides with a core edge type`.

### `edges/types-register-duplicate`

If `POST /edge-types` names the `id` of an edge type already registered, then the server MUST answer `409 conflict`.

**Tests:** `compliance/edge-types.test.ts › refuses an id a registered edge type already holds with 409 conflict, and keeps the first`.

### `edges/types-register-duplicate-kept`

When the server refuses `POST /edge-types` for an `id` already registered, the server MUST leave the first registration as it was.

**Tests:** `compliance/edge-types.test.ts › refuses an id a registered edge type already holds with 409 conflict, and keeps the first`.

### `edges/types-register-id`

If `POST /edge-types` names an `id` that is not an edge type identifier, then the server MUST answer `400 validation_error`.

**Reason:** an identifier is a lowercase kebab name such as `parent-of`, or a dotted type identifier.

**Tests:** `compliance/edge-types.test.ts › refuses an id that is not an edge type identifier with 400 validation_error, and registers one that is`.

### `edges/types-register-role`

If `POST /edge-types` names in a type constraint a `role:` that is not a known role, then the server MUST answer `400 validation_error`.

**Reason:** an unknown role matches no type, so the edge type would refuse every end while reading as if it admitted a family of them.

**Tests:** `compliance/edge-types.test.ts › refuses a type constraint naming an unknown role with 400 validation_error, and takes a known one`.

### `edges/types-register-thumbnail`

If `POST /edge-types` names a property whose `type`, `items_type` or `format` is `thumbnail`, then the server MUST answer `400 validation_error`.

**Reason:** an edge carries no thumbnail, and nothing reads one from an edge.

**Tests:** `compliance/edge-types.test.ts › refuses an edge property of type thumbnail, as its type, its items type or its format, with 400 validation_error`, `compliance/thumbnails.test.ts › refuses a title or a body naming the thumbnail, and an edge property that is one`.

### `edges/types-register-property-type`

If `POST /edge-types` names a property whose `type` is neither `thumbnail` nor a field type a type's `fields` take, then the server MUST answer `400 invalid_schema` with `details.errors` naming `property_schema.<name>.type`.

**Reason:** the code a type's field of an unknown type gets (`types/field-grammar`).

**Tests:** `compliance/edge-types.test.ts › refuses an edge property of an unknown type with the code a type's field gets`.

### `edges/types-register-extends`

If `POST /edge-types` names `extends`, then the server MUST answer `400 validation_error`.

**Reason:** an edge type inherits nothing; a custom edge type states its own constraints.

**Tests:** `compliance/edge-types.test.ts › rejects registration that attempts extends on a core edge type (custom edges do not inherit)`.

### `edges/types-reverse-listed`

When a key registers an edge type with a `reverse_name`, the server MUST list and answer the type with it.

**Tests:** `compliance/edge-types.test.ts › registers an edge type with a reverse name and lists it`.

### `edges/types-reverse-grammar`

If `POST /edge-types` names a `reverse_name` that is not an edge type identifier, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/edge-types.test.ts › refuses a reverse name that is not an edge type identifier`.

### `edges/types-name-held`

If `POST /edge-types` names an `id` that another edge type holds as its reverse name, a `reverse_name` that another edge type holds as its `id` or its reverse name, or a `reverse_name` equal to its own `id`, then the server MUST answer `409 conflict`.

**Reason:** a folder reads a frontmatter key as the edge type it names, so a name two types held would say two things at once.

**Tests:** `compliance/edge-types.test.ts › refuses a reverse name another edge type already uses as a name`.

### `edges/types-written-at-listed`

When a key registers an edge type, the server MUST list and answer it with the `written_at` the registration named, `source` where it named none.

**Tests:** `compliance/edge-types.test.ts › registers an edge type written at its target, and refuses one with no name to write it under`.

### `edges/types-written-at-target`

If `POST /edge-types` names `written_at` `target` and no `reverse_name`, then the server MUST answer `400 validation_error`.

**Reason:** the target's file has no other name to write the edge under.

**Tests:** `compliance/edge-types.test.ts › registers an edge type written at its target, and refuses one with no name to write it under`.

### `edges/types-delete`

When a key sends `DELETE /edge-types/{id}` for a registered edge type it may delete, the server MUST remove the registration and no longer list the type.

**Tests:** `compliance/edge-types.test.ts › deletes a registered edge type and answers 404 for it afterwards`.

### `edges/types-delete-missing`

If `DELETE /edge-types/{id}` names an id nothing registers, including one already deleted, then the server MUST answer `404 edge_type_not_found`, whatever the key's edge map.

**Tests:** `compliance/edge-types.test.ts › deletes a registered edge type and answers 404 for it afterwards`, `› answers 404 when deleting an edge type that does not exist`.

### `edges/types-delete-shipped`

If `DELETE /edge-types/{id}` names a shipped edge type, then the server MUST answer `400 validation_error`, `force` included.

**Tests:** `compliance/edge-types.test.ts › refuses to delete a shipped edge type with 400 validation_error, and lists it still`.

### `edges/types-delete-permission`

If a key without `schema.write` sends `DELETE /edge-types/{id}`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/edge-types.test.ts › refuses a delete to a key without schema.write, and declares the refusal`.

### `edges/types-delete-map`

If `DELETE /edge-types/{id}` comes from a key whose edge map leaves the `id` or a `reverse_name` of the type short of `write`, then the server MUST answer `403 edge_permission_denied` with `details.edge_type` naming it, `force=true` included.

**Tests:** `compliance/edge-types.test.ts › deletes only the edge types whose id and reverse name the key's own edge map grants write on`.

### `edges/types-delete-map-kept`

When the server refuses `DELETE /edge-types/{id}` for the key's edge map, the server MUST keep the type registered.

**Tests:** `compliance/edge-types.test.ts › deletes only the edge types whose id and reverse name the key's own edge map grants write on`.

### `edges/types-delete-in-use`

If `DELETE /edge-types/{id}` names a type of which any edge is stored and names no `force=true`, then the server MUST answer `409 edge_type_in_use` with `details.edge_type`.

**Reason:** the sibling `DELETE /types/{id}` consults the rows in the same way.

**Tests:** `compliance/edge-types.test.ts › refuses to delete an edge type while edges of it exist, and orphans them on force`.

### `edges/types-delete-force`

When `DELETE /edge-types/{id}` names `force=true`, the server MUST delete the registration whatever edges of the type are stored.

**Tests:** `compliance/edge-types.test.ts › refuses to delete an edge type while edges of it exist, and orphans them on force`.

### `edges/types-delete-force-keeps`

When `DELETE /edge-types/{id}` deletes a registration that stored edges name, the server MUST keep those edges, still naming the type.

**Reason:** forcing orphans rather than cascades, because deleting rows nobody asked to delete is the worse of the two surprises.

**Tests:** `compliance/edge-types.test.ts › refuses to delete an edge type while edges of it exist, and orphans them on force`.

### `edges/types-delete-unused`

When `DELETE /edge-types/{id}` names a registered type no edge names, the server MUST delete it without `force`.

**Tests:** `compliance/edge-types.test.ts › deletes an edge type no edge names, without force`.

### `edges/types-delete-race`

When `DELETE /edge-types/{id}` naming no `force=true` races an edge write of the type, the server MUST either refuse the delete `409 edge_type_in_use` where the edge landed first, or refuse the edge write `404 edge_type_not_found` where the delete did.

**Reason:** the delete counts the edges and removes the registration in one write, so no edge is left naming a type that was never counted.

**Tests:** `compliance/edge-races.test.ts › either keeps an edge type with its new edge or deletes it and refuses the edge`.

## What a key may read

### `edges/read-list-withheld`

When `GET /edges` meets an edge whose source item's type or whose edge type the credential may not read, the server MUST leave the edge out of the page.

**Reason:** a refusal would say the edge exists, so the listing drops it, as `GET /edges/{id}` answers it as missing.

**Tests:** `compliance/edge-permissions.test.ts › drops an edge whose source is a type the credential cannot read`, `› drops an edge of an edge type the credential cannot read`.

### `edges/read-list-short`

When `GET /edges` leaves edges out of a page, the server MUST take `next_cursor` from the whole listing, so that a page can be shorter than `limit`, or empty with a `next_cursor` still to follow.

**Reason:** a caller stops on `next_cursor` `null` and not on an empty page.

**Tests:** `compliance/edge-permissions.test.ts › pages to the end of the listing though whole pages are dropped`.

### `edges/read-source-trashed`

When the source item of an edge is in the bin, the server MUST judge the edge's readability by the type of that item as it does for an item that is not.

**Reason:** a source read away is a source with no type to refuse, so trashing it would turn a refusal into a disclosure.

**Tests:** `compliance/edge-permissions.test.ts › drops it still when the source is trashed, which is when a null source would read as no source at all`.

### `edges/read-item-withheld`

When `GET /items/{id}/edges` or `GET /items/{id}/backrefs` meets an edge whose source item's type or whose edge type the credential may not read, the server MUST leave the edge out of the page.

**Tests:** `compliance/edge-permissions.test.ts › leaves an edge of an unreadable kind out of GET /items/{id}/edges`, `› leaves an edge with an unreadable source out of GET /items/{id}/backrefs`, `› pages a per-item door to the end though whole pages are dropped`.

### `edges/read-hydrated-withheld`

When an item read, an item listing or `POST /items/bulk-get` carries edges, the server MUST leave out each edge whose source item's type or whose edge type the credential may not read.

**Tests:** `compliance/edge-permissions.test.ts › narrows the edges carried on an item read and on a bulk read`.

### `edges/read-hydrated-block`

When every edge of a block an item read carries is one the credential may not read, the server MUST remove the block.

**Reason:** the key of a block is an edge type, so an empty block would say the item holds edges of that type the credential cannot see.

**Tests:** `compliance/edge-permissions.test.ts › narrows the edges carried on an item read and on a bulk read`.

### `edges/read-export`

When `GET /export` carries edge lines, the server MUST leave out each edge whose edge type the credential may not read.

**Tests:** `compliance/export.test.ts › carries only the kinds of relationship the credential may read`.

### `edges/read-export-ends`

When `GET /export` carries edge lines, the server MUST leave out each edge whose source or target the export does not carry.

**Tests:** `compliance/edge-hidden-limits.test.ts › leaves an edge out of an export when the key cannot read its target`.

### `edges/read-id-kind`

If `GET /edges/{id}`, `PATCH /edges/{id}` or `DELETE /edges/{id}` names an edge whose edge type the key may not read, then the server MUST answer `404 edge_not_found` with the message an id no edge holds gets.

**Tests:** `compliance/unreadable-items.test.ts › an edge of a type it cannot read answers as a missing edge on every door naming it`.

### `edges/read-id-source`

If `GET /edges/{id}`, `PATCH /edges/{id}` or `DELETE /edges/{id}` names an edge whose source item is of a type the key may not read, in the bin or not, then the server MUST answer `404 edge_not_found` with the message an id no edge holds gets.

**Tests:** `compliance/unreadable-items.test.ts › $name`, `compliance/edge-permissions.test.ts › trashed source: PATCH/DELETE edge still gated on source type`, `› drops it still when the source is trashed, which is when a null source would read as no source at all`.

### `edges/filter-term-hidden`

If a filter term of `GET /items`, `GET /search` or `POST /items/bulk-actions` names an edge type the credential may not read, then the server MUST answer `403 edge_permission_denied`.

**Reason:** a dropped term would answer a different question under the same status, which is the unfiltered page an unknown parameter is refused to prevent. This holds for `edge[<type>]=`, `backref[<type>]=` and the full `filter=` form, and `POST /items/bulk-actions` refuses it before it matches a row.

**Tests:** `compliance/edge-permissions.test.ts › refuses a filter term naming a relationship the credential may not read`.

### `edges/filter-backref`

When a `backref` filter term of `GET /items`, `GET /search` or `POST /items/bulk-actions` is counted, the server MUST count only edges whose source the credential may read.

**Tests:** `compliance/unreadable-items.test.ts › a filter term anchored on an item it cannot read matches as one anchored on no item`.

### `edges/filter-backref-anchor`

When a `backref` filter term names an item the credential may not read, in the bin or not, the server MUST match exactly as it matches a term naming an id no item holds.

**Tests:** `compliance/unreadable-items.test.ts › a filter term anchored on an item it cannot read matches as one anchored on no item`.

### `edges/filter-edge-target`

When an `edge` filter term names an item the credential may not read, the server MUST match every edge to it that the credential may read.

**Reason:** a device that holds those edges answers the same.

**Tests:** `compliance/unreadable-items.test.ts › an outbound term naming an item it cannot read matches the readable edges to it`, `device/fidelity.test.ts › answers an edge term naming a target the key cannot read as the server does`.

## What a key may write

### `edges/write-source-type`

If a key that may read an edge's source type but not write it sends `POST /edges`, `PATCH /edges/{id}` or `DELETE /edges/{id}` for the edge, then the server MUST answer `403 type_not_permitted`.

**Reason:** writing an edge needs write on its source item's type and on its edge type, and the source type is asked first.

**Tests:** `compliance/edge-permissions.test.ts › dual-gate: source-type write + edge-type write required`, `› trashed source: PATCH/DELETE edge still gated on source type`.

### `edges/write-edge-type`

If a key that may read an edge type but not write it sends `POST /edges`, `PATCH /edges/{id}` or `DELETE /edges/{id}` for an edge of the type, then the server MUST answer `403 edge_permission_denied` with `details.edge_type`, `details.required` and `details.grant`.

**Tests:** `compliance/edge-permissions.test.ts › dual-gate: source-type write + edge-type write required`, `› narrow scope: key with edge.about:write cannot create parent-of edges`, `› edge read scope: key with edge.about:read can list but not write`, `compliance/edge-refusals.test.ts › refuses an update and a delete from a key that reads the edge but may not write its type`, `device/fidelity.test.ts › matches the refusal of a second parent, a parent moved in one step, and each refusal of a move`.

### `edges/write-grant`

When the server refuses `POST /edges` for a grant the key lacks, the server MUST name the grant in `details.grant`.

**Reason:** the refusal says which grant to ask for (`errors.md` 11).

**Tests:** `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`.

### `edges/write-wildcard`

When a key holds `edge.*:write`, the server MUST accept `POST /edges` for any edge type the key's other grants allow.

**Tests:** `compliance/edge-permissions.test.ts › wildcard edge_permissions: edge.*:write creates any edge type`, `› a key holding every edge type creates any edge`.

### `edges/write-bulk`

If a key sends `POST /edges/bulk` with an entry whose source it may read and whose source type or edge type it may not write, then the server MUST refuse the entry with `type_not_permitted` or `edge_permission_denied`, naming the grant in `details.grant`, as `error` on the entry under `atomic: false` and as `details.details` of a `403` rollback under `atomic: true`.

**Tests:** `compliance/edges-bulk.test.ts › gates bulk edges per type and edge permission, and on nothing else`, `compliance/write-refusal-details.test.ts › names the grant on a bulk page, inside the rollback or on the entry`.

## Ends the key may not read

### `edges/end-target-hidden`

If `POST /edges`, an entry of `POST /edges/bulk` from a key that may write its edge type, or an inline `edges` of `POST /items`, `PATCH /items/{id}` or an entry of `POST /items/bulk` names a target whose type the key may not read, then the server MUST answer exactly as for a target no item holds, `item_not_found` with the message `Edge target item not found: <id>`, on a bulk page as `error` on the entry under `atomic: false` and as `details.code` of the rollback under `atomic: true`.

**Reason:** the answer discloses neither the row's existence nor its type.

**Tests:** `compliance/edge-permissions.test.ts › $name answers an unreadable target as a missing one, whatever its type`, `compliance/edge-check-order.test.ts › answers an entry's end the key cannot read as a refused edge type when the key cannot write it, and as missing when it can`.

### `edges/end-target-hidden-first`

When an edge write names a target whose type the key may not read, the server MUST answer as `edges/end-target-hidden` does before it applies an endpoint constraint to the target, so a target a constraint would refuse answers the same.

**Tests:** `compliance/edge-permissions.test.ts › $name answers an unreadable target as a missing one, whatever its type`.

### `edges/end-target-hidden-matched`

When an entry of `POST /edges/bulk` names a target whose type the key may not read and a triple an edge already holds, the server MUST answer as `edges/end-target-hidden` does, and not report the entry `updated` or `skipped` with the edge's `id`.

**Tests:** `compliance/edge-permissions.test.ts › answers an unreadable target as a missing one on the bulk door, where an edge to it already exists`.

### `edges/end-target-hidden-stale`

When `PATCH /items/{id}` names a stale `version` and an inline edge to a target whose type the key may not read, the server MUST answer as `edges/end-target-hidden` does, and not `409`.

**Tests:** `compliance/edge-permissions.test.ts › answers an unreadable target as a missing one on a stale PATCH, before the version is read`.

### `edges/end-target-hidden-move`

If `PATCH /edges/{id}` moves the target onto an item whose type the key may not read, then the server MUST answer exactly as for a target no item holds, `404 item_not_found`.

**Tests:** `compliance/edge-move.test.ts › refuses a move onto a target its type's constraint refuses, and answers one the key cannot read exactly as a missing one`.

### `edges/end-source-hidden`

If `POST /edges`, or an entry of `POST /edges/bulk` from a key that may write its edge type, names a source whose type the key may not read, then the server MUST answer exactly as for a source no item holds, `404 item_not_found` with the message `Edge source item not found: <id>`.

**Reason:** an entry is judged as a create even where an edge from the source already matches it, so the answer discloses neither the source nor its edges (`keys-and-oauth.md` 20).

**Tests:** `compliance/unreadable-items.test.ts › $name`, `compliance/edge-check-order.test.ts › answers an entry's end the key cannot read as a refused edge type when the key cannot write it, and as missing when it can`.

### `edges/end-source-hidden-move`

If `PATCH /edges/{id}` moves the source onto an item whose type the key may not read, then the server MUST answer exactly as for a source no item holds, `404 item_not_found`, before it asks the key's write on that type.

**Tests:** `compliance/unreadable-items.test.ts › PATCH /edges/{id} moving the source onto an item it cannot read`.

## Concurrent writes

### `edges/race-parent`

When concurrent requests each create a `parent-of` edge giving one child a different parent, the server MUST write exactly one of them.

**Reason:** each request judges the cardinality against the edges as they stand when its write lands, so no child ends with two parents.

**Tests:** `compliance/edge-races.test.ts › lands one of two parents named for the same child`.

### `edges/race-duplicate`

When concurrent requests create the same triple, the server MUST write one edge and refuse the others as `edges/create-duplicate` does.

**Tests:** `compliance/edge-races.test.ts › lands one of two creates of the same triple`.

### `edges/race-retype`

If an edge write lands after its source item was retyped into a type the key may not write, then the server MUST refuse the write `403 type_not_permitted`.

**Reason:** the permission is judged against the source's type as it stands when the write lands.

**Tests:** waiting on #1444.

### `edges/race-event`

When an operation announces an event for an edge it wrote or removed, the server MUST carry the edge as the write left it.

**Reason:** an event naming ends the edge did not have when it was written or removed tells a subscriber of something that did not happen.

**Tests:** waiting on #1444.
