# Search, export, occurrences and the filter grammar

## The listing grammar

Every listing door shares one grammar. `GET /items` is the reference; `GET /edges`, `GET /export` and the bulk-action filter take the same keys where the rows have the same axes.

1. `type` narrows to a type and its subtree; a well-formed type nothing registered answers `400 unknown_type` rather than an empty page, on every door but the bulk-action filter (57). `compliance/entity-subtypes.test.ts › querying core.entity returns all entity subtypes`, `correctness/pagination.test.ts › a nonexistent type is refused rather than answered with an empty page`.
2. `state` narrows to one lifecycle state; the default is the active state, which the export door alone departs from (statement 16); `state=any` reads every state in one pass; a value outside the enum answers `400 validation_error`. Both are the same on the listing, the search and the export doors, which resolve the parameter through one rule — with one difference the index imposes rather than the grammar: a trashed row leaves the full-text index on the write that trashes it, so no state value reaches it through a search (statement 12). `correctness/lifecycle-transitions.test.ts › state filter works on listItems`, `sync/catchup.test.ts › reads across every lifecycle state in one pass`, `compliance/state-default.test.ts › a listing that names no state answers the active state`, `› a named state and the sentinel still reach every row`, `› refuses a state that is not a state, on every door that reads items`, `compliance/export.test.ts › refuses an unknown state filter`, `correctness/trash.test.ts › deleted item is hidden from default queries`.
3. `source` narrows to rows stamped with that source, and a source filter on the instance configuration narrows the same way. `correctness/tags.test.ts › filtering by tags=[favorite] returns tagged items and excludes others`, `compliance/schema-enforcement.test.ts › narrows reads to listed sources`, `compliance/admin-archive.test.ts › round-trips: archive export then restore accepts the same payload`.
4. `tags` narrows to rows carrying every named tag. `correctness/tags.test.ts › filters items by tag in queries`, `› filtering by tags=[favorite] returns tagged items and excludes others`.
5. `tier` is `library`, `feed` or `all`; omitted returns both. `compliance/tier-axis.test.ts › default query omitting tier returns both library and feed items`, `› tier=library returns library items only`, `› tier=feed returns feed items only`, `› tier=all returns both library and feed items`.
6. `occurred_after` and `occurred_before` bound the item's own time, `occurred_at` falling back to `created_at`, both bounds exclusive of an item sitting exactly on them; `sort=occurred_at` orders by the same expression and never affects `created_at` ordering. `compliance/occurred-at.test.ts › occurred_after filter uses COALESCE(occurred_at, created_at)`, `› occurred_before filter uses COALESCE(occurred_at, created_at)`, `› both bounds exclude an item sitting exactly on them`, `› COALESCE ordering: sort=occurred_at uses occurred_at then created_at`, `› occurred_at does not affect created_at ordering`, `compliance/export.test.ts › filters by date range on the item's own time`. Comparison literals for the system fields `created_at`, `updated_at` and `occurred_at` inside `filter=` use the same UTC normalization as query bounds, for `eq`, `neq`, `gt`, `gte`, `lt` and `lte`, on listing and search alike; a non-timestamp or non-string comparison literal is refused `400 validation_error`. Text operators `contains` and `starts_with` still match text fragments. `compliance/canonical-time.test.ts › normalizes filter timestamps on listing and search`, `› refuses invalid time comparisons while retaining text operators`.
7. `updated_after` bounds an item or edge listing by modification time, which moves on any write including a tag, and is **inclusive**: `updated_at` ties across a bulk write, so a strict comparison would drop every row sharing a resuming client's cursor. `updated_before` closes the same window at the top and is exclusive like every other bound. `sync/catchup.test.ts › sees a tag written after the boundary, not just a property change`, `sync/time-filters.test.ts › narrows an edge listing by modification time`, `› keeps updated_after inclusive, which the catch-up depends on`, `› bounds an item listing by updated_before, exclusively`, `› bounds an edge listing by updated_before, exclusively`.
8. A query key no door declares is refused `400 validation_error` naming it in `details.unknown_parameters`, and a bulk-action filter field likewise in `details.unknown_filter_fields`: a dropped bound is not a narrower answer but the whole corpus, and on the bulk-action door the whole match set. `sync/time-filters.test.ts › honors the item listing's own-time bound and refuses a name it does not declare`, `› refuses an undeclared bound inside a bulk-action filter, where a dropped bound is every row`, `compliance/bulk.test.ts › refuses a filter field it does not declare, naming it`, `correctness/edges/edges-list.test.ts › refuses an unknown query key and an unknown edge id`, `compliance/audit.test.ts › refuses an undeclared bound rather than answering the whole trail`, `compliance/connectors.test.ts › refuses a query key the runs listing does not declare`, `compliance/inbound-webhooks.test.ts › refuses a query key the listing does not declare, rather than answering unfiltered`, `compliance/item-stats.test.ts › refuses a query key it does not declare, naming it`.
9. `edge[<type>]=<id>` narrows to items with that outbound edge, as does the full form `filter=edge[<type>] eq "<id>"`. A number in a `filter` expression that no double holds is refused `400 validation_error`, on `GET /search` as on `GET /items`, rather than compared as infinity. With a numeric filter literal, numeric JSON properties compare as finite doubles for `eq`, `neq`, `gt`, `gte`, `lt` and `lte`, using the same values the API returns. Distinct integer spellings that round to the same double compare equal, and equality agrees with both inclusive range comparisons. Numeric equality does not convert text, arrays, objects, missing properties or null into numbers. This rule holds on the listing and search. `compliance/numeric-property-filters.test.ts › witnesses every seeded row on both doors before filtering`, `› compares numeric properties as finite doubles on the listing and search`, `› does not turn text, arrays, objects, missing or null properties into numeric equality matches`. `correctness/edges/edges-query.test.ts › edge[about]=<id> shorthand returns items with outbound about edge to id`, `› filter=edge[X] eq "Y" full form returns the same set`, `compliance/validation.test.ts › refuses a filter number no double holds, on the listing and the search`.
10. `limit` caps a page and `cursor` continues it: a page carries its rows under `data` and an opaque `next_cursor`; walking to the end delivers every row exactly once; the last page answers `next_cursor: null`. **A cursor continues the page it came from and nothing else**: replayed under another ordering of the same listing, or on another listing, it is refused `400 validation_error` rather than honored against a column that happens to compare, because every ordering compares an ISO timestamp or a property value and the wrong one answers a page that is simply not the next page. `correctness/pagination.test.ts › basic pagination: limit restricts result count and signals more`, `› cursor continuation delivers every item exactly once`, `› cursor is opaque and enables next page retrieval`, `› the last page answers next_cursor: null`, `› refuses a cursor issued by another listing or ordering`, `correctness/edges/edges-list.test.ts › paginates with a cursor and delivers every edge once`, `correctness/edges/edges-backrefs.test.ts › paginates via cursor across many inbound edges`.
11. A key's type permissions narrow every listing and search to the types it can read; `none` hides a type from a listing as well as from a write; an unlisted type is denied without a wildcard; `core.*` reaches the namespace. `compliance/type-scoped-access.test.ts › scoped key list filtering only returns permitted types`, `› unlisted types are implicitly denied (no wildcard)`, `› namespace wildcard grants access to all types in the namespace`, `compliance/type-permissions.test.ts › none permission hides the type from a listing, not only from a write`, `› wildcard pattern matches all types in namespace`.

### A type filter and the credential's reach

50. WHEN a `type` filter names a registered concrete type and the credential may read neither it nor any type under it, the server MUST refuse the request `403 type_not_permitted`, with `details.grant` naming the type and the level asked, on `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` and each entry of `GET /events`'s `type` list.

    Reason: an empty page answers "nothing here" about a type that is registered, so it tells a caller nothing it can act on, while the write doors already answer the same credential and the same type `403 type_not_permitted`. The refusal discloses nothing the registry does not (`types.md` 48): an unregistered type is already told from a registered one (1). An item named by id keeps answering as a missing one when its type is unreadable, because there the caller named a row and not a type.

    Tests: `compliance/unreadable-type-filter.test.ts › $name answers 403 type_not_permitted naming the type`, `› the same type is served to a key that reads it, on every door but the bulk action`, `› GET /events holds each entry of a list to the rule`, `› refuses the same type to a key that reads nothing under it`.

51. WHEN a concrete `type` filter names a type the credential may not read and the credential may read a type under it, the server MUST answer the types under it that the credential may read, and MUST NOT refuse the request.

    Reason: a concrete type selects its subtree (1), so refusing would withhold rows the credential is entitled to; the refusal in 50 is for a filter that reaches nothing readable.

    Tests: `compliance/unreadable-type-filter.test.ts › answers the readable descendants on every door`.

52. WHEN a credential that reads some type sends a wildcard `type` filter, the server MUST answer the types the wildcard matches that the credential may read, and MUST NOT refuse it for the types it matches that the credential may not read.

    Reason: a wildcard names a set, so the readable part of it is a complete answer, and a refusal would turn a client that asks for `core.*` into one that has to know its own grant first. `GET /search` once refused a wildcard its credential read only part of, while `GET /items` answered it.

    Tests: `compliance/unreadable-type-filter.test.ts › GET /items, /export and /search leave out what the key may not read`, `› GET /items/stats counts only what the key may read`, `› GET /occurrences reads a wildcard as a wildcard`, `› GET /events streams the readable types a wildcard matches and withholds the rest`.

53. WHEN a wildcard `type` filter matches no type that a credential reading some type may read, the server MUST answer an empty page, a stats object with no counts or a stream with no frames of those types.

    Reason: nothing is a correct answer to "everything under this root", as it is for a root nothing is registered under (1).

    Tests: `compliance/unreadable-type-filter.test.ts › a wildcard over types the key reads none of is an empty page, not a refusal`.

54. WHEN a credential's type map reaches no type, the server MUST refuse every door that takes a `type` filter `403 type_not_permitted`, whatever the filter names, a wildcard included.

    Reason: an empty answer there would say the instance holds nothing for the credential to read rather than that it may read nothing (`keys-and-oauth.md` 1).

    Tests: `compliance/unreadable-type-filter.test.ts › a key whose map reaches no type is refused a wildcard too`.

55. WHEN the `filter.type` of `POST /items/bulk-actions` names a registered or unregistered type the credential may read neither nor any type under it, the server MUST refuse the request `403 type_not_permitted`.

    Reason: the door selects a type's subtree as the listings do (1), so it is held to the rule in 50 and 51, and the grant decides whether or not the type is registered.

    Tests: `compliance/unreadable-type-filter.test.ts › $name answers 403 type_not_permitted naming the type`, `› POST /items/bulk-actions refuses an unregistered type the key holds nothing on`, `› answers the readable descendants on every door`.

56. WHEN the `filter.type` of `POST /items/bulk-actions` names a type the credential may read and not write, the server MUST narrow the action to nothing and MUST NOT refuse it.

    Reason: the action is narrowed to what the credential may write, so a key that reads every type and writes none matches nothing whatever the filter names. The refusal in 55 is about reading a type, which is what a filter asks of one.

    Tests: `compliance/unreadable-type-filter.test.ts › narrows a type the key reads and does not write to nothing, rather than refusing it`.

57. The `filter.type` of `POST /items/bulk-actions` MUST NOT be refused `400 unknown_type` for naming a type nothing registers.

    Reason: the door takes no wildcard, so the type's own name is the only way to select the rows a type removed with `force` left behind, to purge them.

    Tests: `compliance/unreadable-type-filter.test.ts › POST /items/bulk-actions does not refuse one, because it takes no wildcard to reach the rows a removed type kept`.

58. WHEN `POST /items/lookup` names a registered `type` and the credential may read neither it nor any type under it, the server MUST refuse the request `403 type_not_permitted` and MUST NOT answer an empty page.

    Reason: an empty answer would say the keys named nothing (26). The descendant rule is the one in 51, so the door asks the same question as the listings.

    Tests: `compliance/unreadable-type-filter.test.ts › answers 403 where it used to answer an empty 200, and 400 for an unregistered type`.

59. WHEN `POST /items/lookup` answers a credential that may read a type under `type` and not `type` itself, the server MUST answer `tombstones` as an empty list.

    Reason: the tombstones record what purges left under `type`, so they are answered only to a credential that may read `type` itself.

    Tests: `compliance/unreadable-type-filter.test.ts › answers no tombstones to a key that reads only a type under the one named`.

## Search

12. `GET /search?q=` matches full text over searchable fields and tags, read, matched and ranked as 42 to 49 state. An item identifier alone is not searchable content and does not affect relevance; it matches only if it also appears in an indexed field or tag. `compliance/fts-searchable.test.ts › matches searchable content and tags without matching an item identifier alone`. Search ranks results with `relevance_score`, filters by `type`, takes the listing grammar's state default so a search never answers a row a listing hides, takes its `state=any` sentinel so a caller can read across states here too, and honors `limit` exactly when more rows match. It pages by `cursor` like every list: `next_cursor` continues the ranking, the walk to `null` delivers every hit once, and a cursor another listing or another search issued, or one that does not parse, is refused `400 validation_error`. The ranking is read at most 10,000 rows deep. The sentinel reaches every state the index holds, which is every state but `trashed`: a trashed row is removed from the index rather than narrowed out of the query, so it is unmatched under `any` and under `state=trashed` alike. `correctness/persistence.test.ts › search for distinctive text returns matching items`, `› search for nonexistent string returns empty results`, `› type-filtered search only returns matching types`, `correctness/pagination.test.ts › search respects limit parameter`, `compliance/state-default.test.ts › a search that names no state answers the active state`, `› a search reads across states under the sentinel, except the bin`, `compliance/envelope.test.ts › walks to a null cursor, delivering every hit once`, `› refuses a cursor another listing issued, and one it cannot read`, `› refuses a cursor minted for another search`, `› refuses an offset query key`.
13. A field declared `searchable: false` is not matched. `compliance/fts-searchable.test.ts › field with searchable:false is excluded from full-text matches`.
14. Results are narrowed by the key's type permissions. `compliance/type-scoped-access.test.ts › search results filtered by scoped permissions`.
15. `q` is required: `400 missing_required_field`. A query with quotes, ampersands and parentheses is accepted. `correctness/persistence.test.ts › refuses a search with no query`, `compliance/validation.test.ts › accepts quotes, ampersands and parentheses in a search query`.

## Export

16. `GET /export` streams NDJSON, one line per item with its metadata and an edge line for each edge between exported items after the item lines, sending each line as it reads it rather than building the body first, under the listing grammar (`type`, `state`, `source`, `occurred_after`, `occurred_before`) and the key's type permissions, and each line's metadata carries only the extension namespaces the key may read (`keys-and-oauth.md` 21). It takes the grammar's keys but not its state default: a caller naming no state is answered every state except `trashed`, because the archive this door writes is what a restore reads back and a copy that dropped archived rows would lose them on the round trip. `compliance/export.test.ts › filters by type`, `› filters by date range on the item's own time`, `› filters by state`, `› respects type permissions on a scoped key`, `› carries an edge line behind the item lines it joins`, `› refuses a bound that is not an instant, on both output formats`, `compliance/state-default.test.ts › an export that names no state carries archived rows`, `compliance/export.test.ts › carries on each row only the extension namespaces the key may read, on both output formats`, `load/export-stream.test.ts › measures time-to-first-record separately from full drain`.
17. `format` is closed: `ndjson` (the default) and `archive`, with anything else refused `400 validation_error` rather than served as the default. `compliance/export.test.ts › refuses a format outside the two it offers`.
18. `GET /export?format=archive` answers a gzip archive (`Content-Type: application/gzip`) of the same selection, its rows' extensions narrowed as the NDJSON lines are, so an archive restores only the namespaces the key that wrote it may read. Its manifest comes first and carries the selection's counts and blob list, so the whole selection is read before the body is sent. The blobs it carries are those the blob doors would serve the credential exporting (`blobs.md` 21). `POST /admin/restore-archive` accepts the archive back with the operator key, answering counts `imported`, `duplicates`, `blobs_imported`, `edges_imported` and `edges_skipped`: items keep their ids, tags, extensions and the edges between them in both directions, and a `(source, source_id)` pair already present is reported as a duplicate, as is a row whose link another row of its type holds (`items.md` 55); a working key is refused `403`. The archive carries no tombstones (`items.md` 56), so an archive restored into a new instance starts without them. A type the archive registers is held to its `link_field` as `POST /types` holds one (`types.md` 28): where two rows a forced delete left under the identifier share a value there, the restore is refused `409 link_taken` and writes nothing (67). `compliance/admin-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `› requires the operator key`, `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`, `› reconstructs edges between restored items, in both directions`, `compliance/links.test.ts › counts an archived row whose link another row holds as a duplicate`, `› stops a restore registering a link the rows a forced delete left share`.
19. `POST /admin/restore-archive` takes an archive of any size: the body streams to the disk store's spool as an upload's does, outside the request cap every JSON body sits under (`compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large` is the cap), so an archive carrying a blob larger than the cap restores, and the blob answers byte for byte on `GET /blobs/{hash}` under the type the manifest names; an entry whose bytes do not hash to its name is left out and counted in `blobs_imported` no more than it is stored. `compliance/admin-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.
20. A row the archive records in a state its type's lifecycle cannot produce (`revoked` for a canonical type, `trashed` for a `system.*` type, or a value that is no state) refuses the whole archive `400 validation_error` naming the row, before anything is written, the rows ahead of it included; the same canonical rows in states the lifecycle contains restore, each in the state recorded. `compliance/admin-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

## Occurrences

21. `GET /occurrences?from&to` expands `core.event` items into the occurrences that overlap the window (`occurrences.md` 9), ordered by `starts_at` ascending regardless of write order, with the window echoed and a scan summary; both `from` and `to` are required and the window must be ordered (`400 missing_required_field`, `400 validation_error`); no credential answers `401`. `compliance/occurrences.test.ts › expands events inside the window and excludes those outside it`, `› orders the window by starts_at ascending, not by write order`, `› refuses a missing or inverted window`, `› refuses a request with no credential`.

22. A row the archive records with a `source` no credential can hold — one carrying the reserved prefix `oauth:` — refuses the whole archive `400 validation_error` naming the row, before anything is written, the rows ahead of it included. The restore is the one door that copies `source` verbatim, and the key doors refuse that prefix as a key's own source and as one it claims (`keys-and-oauth.md` 34), so without this the restore would be the way around that gate: a row planted through it would read ever after as written by an authority that never existed. The same rows under an ordinary source restore. **An archive that legitimately records one is unrestorable**, and deliberately: nothing in this build writes such a row, so an archive carrying one was either built by hand or exported from an instance running something this one is not, and neither is a thing to restore silently. `compliance/admin-archive.test.ts › refuses an archive recording a source no credential can hold, and writes nothing`.

23. **`POST /admin/restore-archive` refuses a property no type declares wherever `POST /items` would**, which is where the strict-mode lever names the row's type: `400 invalid_properties` with `details.code` `unknown_property`. A refused row refuses the whole restore, which writes nothing (67): no type or edge-type registration, blob row, item, edge, event or audit record remains. Native `routes/restore-strictness.test.ts` and `housekeeping/external-audit.test.ts` exercise rolled-back preparation beside refused restored rows. The store validates loosely whatever the lever says, so a door that writes through it asks above it or not at all, and a property that lands reads back ever after undeclared and unmarked under the type's current version. With the lever off the door takes it, because the lever belongs to the type and not to the door. `compliance/schema-enforcement.test.ts › strict-on rejects the same unknown property arriving through the restore door`, `› default-off accepts through the restore door as it does through the create door`.

24. **The item write doors ask the lever, and ask it of the properties the caller sent.** `POST /items`, `POST /items/bulk` on both halves of an upsert, `PATCH /items/{id}`, `POST /admin/restore-archive` and `POST /items/bulk-actions` with `update_properties` reach one function, so a property no type declares is refused `400 invalid_properties` with `details.code` `unknown_property` wherever the lever names the row's type, and the row the refusal names is not written. The bulk door reports it as that entry's `errored` outcome carrying its index, so a page refuses the row rather than the page. The bulk-action job reports it as that row's entry in the job's `errors`, naming the row by its `id` where the bulk door carries the entry's `index`, with `code` `invalid_properties` and `details.code` `unknown_property`, and goes on to the next row, so a filter matching rows of several types writes the rows of the types the lever does not name. The job asks when it writes the row rather than when it was queued, as every other door asks when it writes, so a lever set while the job waits holds for it, and asks it for the credential that queued the job as that credential stands then: a job whose queuing credential is gone writes nothing more (`items.md` 34). The properties the caller sent rather than the merge they land in: the lever refuses a caller introducing an undeclared property, and measuring the merge would instead freeze every row that already carries one from before the lever was set. What is refused is an undeclared key and nothing else: a patch naming only declared properties is taken whatever the type requires elsewhere, because a missing required field is the store's refusal and carries the store's reason. With the lever off every door takes the property and serves it back. `compliance/schema-enforcement.test.ts › strict-on rejects the same unknown property through the bulk door, on both halves of an upsert`, `› strict-on rejects the same unknown property through the update door`, `› default-off accepts through the bulk and update doors as it does through the create door`, `› takes a patch naming only declared properties, whatever else the type requires`, `› strict-on refuses the same unknown property per row of a bulk update_properties job`.

25. **Every list and every search answers one envelope**: the rows under `data` and the cursor that continues them under `next_cursor`, `null` on the last page, and no other key, on all twenty-four published doors that answer a set, on each hydrated edge block of an item and on an item's hydrated history. `GET /auth/grants`, which the document does not publish, answers the same envelope. A door that takes no cursor answers its whole set, and answers `null`. Two doors carry a sibling about the answer rather than the page: `GET /blobs/stores` its `min_copies`, and `GET /occurrences` its `window`, its `scan` and, when there are any, its diagnostics. Five answers carry rows and stand outside the envelope because none pages a set: `POST /connectors/{id}/deliveries/handled` answers the deliveries it marked under `data` and no cursor, the ones the caller named; `POST /connectors/{id}/agreements/find` answers the agreements of the rows the caller named under `data` and no cursor; `POST /items/bulk-get` answers `items`, and `metadata` beside it when `include` carries `metadata`, and no cursor, fetching the ids the caller names with nothing left to continue, and each of its `metadata` entries names its item by `item_id`; `POST /items/lookup` answers `data` and `tombstones` beside it, and no cursor, for the same reason (26); an item's `neighbors` is a list of that one item's far ends rather than a page, capped across every edge type together rather than per block, so `neighbors_truncated` answers `true` when the far ends pass the cap even though every edge block is whole, with exactly the cap hydrated, and the blocks still name every far end the list left out; at or below the cap it answers `false`, with every far end hydrated. The cap is 100 far ends. A page can be short, or empty, with a cursor still to follow, so a walk stops on `null` and never on a short page. On every door that takes a cursor, the page that holds the last row answers `null` even when the rows fill it exactly, so a walk never ends on an empty page it was sent to. `compliance/envelope.test.ts › one envelope for every list and search`, `› names twenty-four doors, every one the document publishes as a page`, `› answers a null cursor from every door that takes none`, `› answers GET /auth/grants, which the document does not publish, in the same envelope`, `› carries each hydrated edge block as a page`, `› carries an item's hydrated history as a page`, `› hydrates the far ends as a list, flagging no truncation below the cap`, `› hydrates every far end at the cap, flagging no truncation`, `› flags neighbors_truncated one past the cap, hydrating exactly the cap`, `compliance/full-last-page.test.ts › a full last page answers a null cursor`, `› covers every door that takes a cursor`, `compliance/edge-permissions.test.ts › pages to the end of the listing though whole pages are dropped`, `compliance/inbound-webhooks.test.ts › keeps the first mark, and marks nothing when an id is not the connector's`, `compliance/connector-state.test.ts › writes and clears agreements, skipping an id it cannot hold`, `compliance/bulk-get.test.ts › returns the requested items by id`, `› hydrates metadata when include carries metadata`, `compliance/links.test.ts › looks rows up by link in every state, and refuses links for a type naming none`.

## Lookup

26. **`POST /items/lookup` finds rows by link, by natural key or by id, in every state.** The body names a `type`, exactly one of `links`, `source` with `source_ids`, or `ids`, at most 500 values, and may ask `include: ["edges"]`; the answer is `{ data, tombstones }`. By `links`, the rows of exactly `type` holding them (`items.md` 55), which `type` must name a `link_field` for or the lookup is refused `400 validation_error`; by `source` and `source_ids`, the rows holding those natural keys whatever their type, so a row retyped since it was written is found; by `ids`, the rows with those ids, whatever their type, trashed rows included where `POST /items/bulk-get` leaves them out (`items.md` 20). Every state is answered, the bin included, and rows come back in the order the request named their keys, each once. A `system.*` row is left out whatever the key holds, a folder's `system.folder` among them, and so is a row whose type the key's map cannot read, and a key whose map reaches no type is refused `403 type_not_permitted` rather than answered empty. `tombstones` answers what purges left under `type` for the links or natural keys named (`items.md` 56), in the order named, none by `ids`, and a key that may not read `type` is answered as 58 and 59 say. `include: ["edges"]` hydrates each row's outbound edges as `GET /items?include=edges` does, held to the same permissions. A body naming no `type` is refused `400 missing_required_field`; one naming no selector or two, `source` without `source_ids` or the reverse, more than 500 values, an empty value, `source` among them, a malformed `type`, or a key the door does not declare, `400 validation_error`; a malformed id `400 invalid_id`; an unregistered type `400 unknown_type`. `compliance/links.test.ts › looks rows up by link in every state, and refuses links for a type naming none`, `› answers by link only the rows of the type named`, `› looks rows up by natural key whatever their type`, `› looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`, `› hydrates edges on a lookup as the listing does`, `› leaves out a row the key may not read, and refuses a key that may not read the type`, `› refuses a lookup naming no selector, two, or more than 500 values`, `› answers tombstones in the order named`, `› keeps each tombstone to its type, read and moved`.

## An archive between builds

27. **Until the first public release, an archive is read only by the build that wrote it.** The archive format stays at version 0 (`instance.md`), and that number promises nothing between builds: what a restore into any other build does with an archive is outside the contract, whether it takes the archive or not. A manifest naming any version but 0 is refused whole `400 validation_error`, before anything is written, with a message saying the same. Nothing is stated about archives after the first public release. `compliance/admin-archive.test.ts › refuses an archive at another format version, saying it is read only by the build that wrote it`.

## Counting

28. **`GET /items/stats` counts the rows a listing matches.** It takes every filter `GET /items` takes (statements 1 to 9), with the same meaning and the same refusals, and answers the matching rows grouped by `by`: per lifecycle state by default, per type under `by=type`. Paging and ordering are not filters, so `limit`, `cursor`, `sort` and `direction` are refused as undeclared, and `include` takes `system` alone, which counts the `system.*` items left out by default, as the listing leaves them out. One default differs: naming no `state` counts every state, because the default answer is the breakdown across them. The listing's own count for the same filters is therefore the `active` bucket, the bucket of the state it names, or the sum under `state=any`. `compliance/item-stats.test.ts › counts the rows a listing's filters match`.

## Restore

29. The archive's `manifest.json` is held to the fields the restore reads: `version`, the number `0`, and `blobs`, an object whose every entry carries a string `mime_type` and a non-negative integer `size_bytes`. A manifest missing or mistyping any of them refuses the whole archive `400 validation_error`, the message naming each field and `details.errors` carrying each as a dotted `path`, before anything is written; the same archive under a well-formed manifest restores. A manifest naming another version is refused for its version (27) rather than its shape, since another version is free to lay its fields out differently. Fields the restore does not read, the writer's counts and provenance among them, are not asked about. `compliance/admin-archive.test.ts › refuses a manifest missing or mistyping a field the restore reads, naming the field, and writes nothing`.

## Edge shorthands

30. **An `edge[<type>]` or `backref[<type>]` shorthand value carrying a backslash is refused `400 validation_error`.** The filter grammar reads `\"` as a quote and every other backslash literally, so a backslash cannot be quoted: one before the closing quote would run the value on into the next clause, where it would be read as filter syntax. An item id never carries one. A double quote in the value is quoted and matches nothing. `compliance/validation.test.ts › refuses an edge shorthand value carrying a backslash, and still takes a quote`.

## Property ordering

31. **`GET /items?sort=properties.<field>` orders by each row's stored scalar value, independently of its type.** A concrete type filter, a wildcard and no type filter apply the same ordering. Ascending, numbers and booleans share numeric order (`false` equals `0`, `true` equals `1`), followed by strings in binary lexical order; an empty string is a value and numeric text remains text. Descending reverses the scalar order, including the order between numbers and strings. Missing fields, explicit nulls, objects and arrays all follow every scalar, in either direction. Equal values, including numerically equal booleans and numbers and the entire null tail, order by item id ascending in both directions. A cursor preserves the scalar kind, so a walk to `next_cursor: null` delivers every matching row once, including across type and kind boundaries and inside ties. `correctness/property-sort-pagination.test.ts › walks numeric properties whatever the type filter`, `› walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

## Archived row scalars

32. **An archived item or edge's present `version` is a positive safe integer, from 1 through 9007199254740991 inclusive, and a present item `tier` is `library` or `feed`.** A different value, including zero, a fractional or unsafe number, a string or null, refuses the whole archive `400 validation_error`, naming the offending row and field, before type registrations, blob placement, items, metadata, edges or events are written. A valid row ahead of the invalid one is not written either. These checks apply even when a row would otherwise be counted as a duplicate or an edge skipped. Omitted versions retain the restore's default of 1, and an omitted canonical item tier defaults to `library`; a valid recorded version or tier is preserved. Zero can be a write precondition but is never a stored version (`versions.md` 18). `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`, `› refuses invalid %s even when the row already exists`, `› refuses an invalid edge version even when its endpoint is missing`, `› restores $name without changing their meaning`.

## Complete archive restoration

33. When an operator restores an archive produced by the same server build, the server MUST accept its item, edge, type-registration and edge-type-registration counts without a separate restore count limit.

    Reason: an export that the same build cannot restore is not a usable backup. Resource protection is independent of the number of rows an export carries.

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › restores an actual export with $items items and $edges edges`; `packages/server/src/routes/archive-type-registrations.test.ts › restores more than 200 %s registered and exported through their routes`.

34. When an archive creates an item or edge, the server MUST preserve its recorded `created_at` and `updated_at` instants in canonical UTC millisecond form and its current `version` exactly.

    Reason: restored dates describe the original record, and canonical UTC values remain comparable with list filters and cursors. Resetting a version can make an old write precondition match unrelated content.

    Tests: `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`, `› reconstructs edges between restored items, in both directions`; `packages/server/src/routes/archive-complete-roundtrip.test.ts › preserves item and edge dates after metadata writes, with matching stored event frames`; `packages/server/src/routes/archive-restore-version.test.ts › brings items and edges back at the version they were archived at`; `packages/server/src/routes/archive-complete-roundtrip.test.ts › keeps restored %s discoverable by instant-based date filters`.

35. When exporting an archive, the server MUST include every stored snapshot below each selected item's recorded current version that the exporting credential can read under that snapshot's historical type permissions.

    Reason: a current type grant does not grant access to an item's earlier type, and one page of history is not complete history. A concurrent write may snapshot the selected current version after selection; that snapshot belongs to the next version and cannot be included beside the selected row.

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › preserves every snapshot across history pages and leaves duplicate live history untouched`, `› exports snapshots by their historical type permissions`, `› fences exported history below the selected row's version during a concurrent patch`.

36. When restoring an item's archived history, the server MUST preserve each snapshot's `id`, `item_id`, `version`, `properties`, `type`, `tier`, `occurred_at`, `source_id` and `created_at` exactly, without validating historical properties against the current type schema.

    Reason: changing a type schema does not rewrite the past.

    Tests: `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`; `packages/server/src/routes/archive-complete-roundtrip.test.ts › keeps historical properties after the current type changes their shape`; `packages/server/src/storage/archive-history-storage.test.ts › stores every historical field exactly without requiring the historical type's current schema`.

37. When a readable archived snapshot references a blob, the archive MUST include its bytes if and only if the exporting credential could read that blob through the blob doors.

    Reason: a historical reference keeps bytes from orphan collection but does not grant read permission (`blobs.md` 21).

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › carries readable bytes referenced only by selected history without widening blob access`.

38. When an archived item is counted as a duplicate, the restore MUST leave the existing item's row, metadata and history unchanged.

    Reason: replaying a backup must not overwrite work made since the backup.

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › leaves an existing item and its live history unchanged on repeated restores`; `packages/server/src/routes/export-roundtrip.test.ts › re-restoring the same archive changes nothing and counts duplicates`.

39. If an archive contains an invalid present item or edge date, or malformed history, the restore MUST refuse the whole archive with `400 validation_error` before writing rows, including when a row would otherwise be duplicated or skipped.

    History shape: each snapshot is an object with a valid unique snapshot ID across the archive, the enclosing item's ID, a positive safe integer version below the current item version and unique within that item's history, object properties, a type identifier, a `library` or `feed` tier, valid `created_at` and `occurred_at` instants, and a string or null `source_id`. History, when present, is an array. Present row dates are valid instants. Validation uses the ordinary instant rules. Current row dates use canonical UTC millisecond form; historical snapshot dates retain their archived spelling.

    Reason: a malformed later row must not leave a partially restored archive.

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › refuses malformed item %s before any row writes`, `› refuses malformed edge %s even when its endpoints are missing`, `› refuses history with $name before writing valid rows ahead of it`, `› refuses duplicate history %s values before row writes`.

40. If a snapshot being restored has an ID already held by existing history, the restore MUST refuse the row transaction with `409 conflict` without changing the existing history.

    Reason: a history collision is not a duplicate current item and cannot overwrite another item's past.

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › refuses a snapshot ID already held by unrelated history without treating it as a duplicate item`.

41. If a row write fails during archive restoration, the server MUST roll back every item, metadata, history, edge and event write the restore made.

    Reason: snapshot restoration is part of restoring the item that owns it. The registrations and blob rows roll back with them (67).

    Tests: `packages/server/src/routes/archive-complete-roundtrip.test.ts › rolls back items, metadata, history and events when a later edge insert fails`, `› rolls back earlier snapshots and row writes when a native history insert fails`.

Archive scope: keys, webhooks, configuration and tombstones are not carried. Trashed items are carried only when selected explicitly, such as with `state=any` (16). An archive remains format 0 and is supported only by the build that wrote it (27).

## How a query matches

The server and a device index the same text and read a query the same way, so a query finds a row a device holds offline exactly when it finds that row online, and orders the hits the same where both rank the same rows. The server's rules are the reference and the device's follow them.

42. The server and a device MUST each reduce every word of the indexed text and of a query to its stem, folding case and diacritics and splitting words at anything that is not a letter or a digit, so that "run" followed by another word matches "running" and "runs" and not "runner".

    Reason: a person searching with the word they remember expects its other forms, and a device that matched whole words only would lose a row the server finds.

    Tests: `compliance/search-matching.test.ts › $name: $query`, `› excerpts a match in a long text, marked and cut`; `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

43. WHEN a query is not wholly inside double quotes, the server and a device MUST require every whitespace-separated word of it to match, in any order and in any column, MUST match the last word as the start of a word, and MUST match every other word as a whole stem.

    Reason: the person is still typing the last word and has finished the earlier ones. A prefix on every word would match "marshland" for "marsh landscape", which the server does not.

    Tests: `compliance/search-matching.test.ts › $name: $query`; `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

44. WHEN a query begins and ends with a double quote and holds at least one character between them, the server and a device MUST match the text between them as a phrase: its words adjacent and in order, the last one as a whole stem and not as a prefix. Any other double quote in a query MUST be text.

    Reason: a phrase is how a person asks for words that belong together.

    Tests: `compliance/search-matching.test.ts › $name: $query`; `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

45. The server and a device MUST read every character of a query as text to match: an operator word, a column name before a colon, a star, a leading minus and a double quote inside a word are words, never search syntax. A query with no word in it MUST match nothing.

    Reason: a query is typed by a person, and one that a search engine read as syntax would be refused or would answer a different question.

    Tests: `compliance/search-matching.test.ts › $name: $query`; `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

46. For each row not in the bin, the index MUST hold its `title`, `body`, `description` and `name` where each is a string, every other string field its type declares or inherits, and its tags, each field's text in its own column, the extra fields joined by a space in field-name order and the tags in byte order. It MUST NOT hold a field its type declares as a string with `searchable: false`, a property its type does not declare, or a value that is not a string. Where a type redeclares an inherited field, the nearest declaration decides. A row whose type is not registered MUST be indexed by its four core properties and its tags alone.

    Reason: the fields a person marked private stay unmatched, and a thumbnail's base64 or an undeclared property is not text a person wrote to be found.

    Tests: `compliance/search-matching.test.ts › $name: $query`; `compliance/fts-searchable.test.ts › field with searchable:false is excluded from full-text matches`; `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`; `packages/server/src/storage/search-indexing.test.ts › what a change to a type does to rows already stored`.

47. WHEN a type is registered, replaced or deleted with `force`, the server MUST index again, in the same transaction, every row not in the bin of that type and of each type that inherits from it, and a device MUST index again every row it holds when it takes a changed catalog.

    Reason: what a row contributes to the index is decided when it is written, so without this a row keeps answering by the fields its type had until the row is next written, and a field marked `searchable: false` stays matched.

    Tests: `compliance/fts-searchable.test.ts › rows already stored follow a change to what their type marks searchable`; `device/search-live.test.ts › holds a changed type's searchable fields against rows it already holds`; `packages/server/src/storage/search-indexing.test.ts › what a change to a type does to rows already stored`.

48. The server and a device MUST order hits by BM25 over the title, body, description, name, extra and tags columns at equal weight, best first, and MUST order hits of equal rank by item identifier, ascending. `relevance_score` MUST be the absolute value of the BM25 score.

    Reason: two indexes that hold the same rows then rank them alike. Weighting the title above the body would be a ranking the server does not have, and an unordered tie is two answers to one query. BM25 is relative to the rows of the index it ranks in, so a device that holds a slice of the instance scores, and so can order, by that slice: its scores and its order equal the server's only where the rows they hold are the same, and which of the rows it holds it finds is the same either way.

    Tests: `compliance/search-matching.test.ts › $name: $query`, `› scores a hit by its rank and gives the better hit the higher score`; `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

49. Each hit MUST carry an excerpt of at most 32 words from the column that matches it best, with each matched word wrapped in `<mark>` and `</mark>` and `...` where the text is cut.

    Reason: an excerpt drawn from the title alone shows a title with nothing marked for a match in the body, which is most matches, and is empty where the title is.

    Tests: `compliance/search-matching.test.ts › excerpts a match in a long text, marked and cut`, `› marks the match in the column that holds it, not only in the title`; `device/search-live.test.ts › excerpts a match as the server does, from the column that holds it`.

## Restore bounds

60. When an archive carries an entry under a name the restore does not read, the server MUST step past the entry without holding it in memory.

    Reason: an archive is a file anyone can hand an operator, and a small compressed entry can expand to more memory than the server has.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › steps past a 600 MB entry it does not read without holding it`; `compliance/admin-archive.test.ts › steps past an entry it does not read`.

61. If an archive's `manifest.json` or `types.ndjson`, or one line of its `items.ndjson` or `edges.ndjson`, is larger than 67,108,864 bytes (64 MiB), the server MUST refuse the whole archive with `400 validation_error`, naming the entry, before writing anything.

    Reason: the restore parses each of these whole, so this limit and the one row it holds at a time (71) bound the memory a restore takes, beside the ids of the items and snapshots it has written, which it keeps so that edges resolve and snapshot ids stay unique. The line files are otherwise read a line at a time, so an archive of any number of rows restores (33).

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › refuses a line longer than the most it reads at once, and writes nothing`; `compliance/admin-archive.test.ts › refuses a line longer than 64 MiB, and writes nothing`.

62. If an archive carries `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` or a `blobs/` entry more than once, the server MUST refuse the whole archive with `400 validation_error`, naming the entry, before writing anything.

    Reason: a repeated entry has no single meaning, and reading both would let a later copy add rows the first one never listed.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › refuses an archive carrying a name it reads twice, and writes nothing`; `compliance/admin-archive.test.ts › refuses an archive carrying an entry twice, and writes nothing`.

63. If an archive body is not a gzip-compressed tar, or its compressed stream breaks partway, the server MUST refuse it with `400 validation_error` before writing anything.

    Reason: a damaged backup is an ordinary input, not a fault in the server.

    Tests: `packages/server/src/routes/admin-archive.test.ts › refuses a body the gzip reader cannot parse and stays up`; `packages/server/src/routes/archive-restore-bounds.test.ts › refuses a body whose gzip stream breaks partway, leaving no spool`.

64. When an archive restore commits, the server MUST commit its type and edge-type registrations, blob rows, items, metadata, history, edges, events and audit records together.

    Reason: an owner who gives up on a restore must not hold types or rows they did not ask for, which only one commit for all of them can promise (67).

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › leaves no registration, row or event when it fails after registering the archive's types`; `packages/server/src/housekeeping/external-audit.test.ts › rolls back archive preparation with restored items and events`.

65. While an archive restore writes, the server MUST give other requests a turn of the event loop after at most 100 lines or 4 MiB of the archive's line files, whichever comes first, counting lines it skips or counts as duplicates as well as lines it writes.

    Reason: a restore of a large archive takes long enough that a server answering nothing in the meantime fails its health checks, and a few large rows take as long as many small ones.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › gives the event loop a turn between batches inside its transaction`, `› gives the event loop a turn over lines it skips as well as rows it writes`, `› holds no restored row's content in memory, before or after it commits, and gives a large row a turn of its own`.

66. When the server refuses an archive whose body it cannot read, it MUST keep serving other requests.

    Reason: the process is every client's server, and a file one operator sends must not stop it.

    Tests: `packages/server/src/routes/admin-archive.test.ts › refuses a body the gzip reader cannot parse and stays up`.

67. If an archive restore is refused, fails or is interrupted, the server MUST leave none of the registrations, rows, events or audit records it wrote, in the database or in the types other requests read.

    Reason: the owner can run the same restore again, and a half-restored instance holds types and rows nobody asked for.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › leaves no registration, row or event when it fails after registering the archive's types`, `› leaves no type, row, event or audit record behind, and its blob bytes to the copy cleanup`; `packages/server/src/routes/restore-strictness.test.ts › rolls back blob registration with the restored rows, and takes back the bytes it placed`.

68. If an archive restore does not commit, the server MUST remove the blob bytes it placed that no row names: at once when the restore fails or is refused, and through its copy cleanup when the process stopped before the restore ended. The copy cleanup removes a batch on each run of `blob-replicate`, by default up to 100 each minute (`MARFA_BLOB_REPLICATE_BATCH`, `MARFA_BLOB_REPLICATE_INTERVAL_MS`), and of `blob-integrity`, by default up to 500 each hour.

    Reason: the bytes are written before the transaction opens, which nothing can roll back, so a record committed before them names them for removal, and the restore's own transaction clears it.

    Tests: `packages/server/src/routes/restore-strictness.test.ts › rolls back blob registration with the restored rows, and takes back the bytes it placed`; `packages/server/src/routes/archive-restore-bounds.test.ts › leaves no type, row, event or audit record behind, and its blob bytes to the copy cleanup`.

69. While an archive restore writes, the server MUST NOT show its rows, registrations or events to other requests.

    Reason: a reader that saw part of a restore would see rows a failed restore then takes away.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › holds other writers in the queue and keeps its rows and types from readers until it commits`.

70. While an archive restore writes, if another request has to write and waits for the restore longer than the write budget, the server MUST refuse that request with `503 write_contention`.

    Reason: the restore holds the write lock until it commits, and a caller retries a `503` (`errors.md` 10).

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › holds other writers in the queue and keeps its rows and types from readers until it commits`.

71. While an archive restore writes or tells subscribers about its events, the server MUST hold no more of the archive's content in memory than the line it is reading, the edges it has written since its last turn (at most 100 lines or 4 MiB of them, 65), and, once it has committed, one page of its events: the events that start within 8 MiB of the page's first byte, so at most 8 MiB and one more event.

    Reason: an archive's rows together can be larger than the memory the server has. Each row is itself no larger than a write door takes (74).

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › holds no restored row's content in memory, before or after it commits, and gives a large row a turn of its own`.

72. When an archive restore commits, the server MUST tell subscribers about its events in event-log order, ahead of the events of any write committed after it.

    Reason: a subscriber that receives a later event first moves its cursor past events it never saw.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › tells live subscribers every restored event once it commits, in id order and ahead of the next write`.

73. When the server cleans up after an archive restore that did not commit, it MUST NOT remove blob bytes a committed row names.

    Reason: content addressing means another request can be told the same bytes are stored while the restore runs, and the cleanup and that request take the same per-hash lock.

    Tests: `packages/server/src/routes/admin-archive.test.ts › never takes back bytes an upload was told are stored meanwhile`, `› leaves the purge record naming the bytes it found on disk, for the sweep to finish`.

74. If an archived item's properties, the properties of any of its earlier versions, or an archived edge's properties are larger than the largest request body the bulk write doors take (`MARFA_MAX_BULK_REQUEST_BYTES`, 16 MiB by default), the server MUST refuse the whole archive with `413 request_too_large`, naming the row and the field, before writing anything.

    Reason: a restore is not a way to plant a row the write doors would refuse, and the rest of the server sizes its work on rows the write doors took. A line may still be larger than one row, since it carries the item's history, so the line limit (61) stays.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › refuses a row whose properties are larger than any write door takes, as the write door does, and writes nothing`.

75. While an archive restore's events are told to subscribers after its commit, the server MUST give the event loop a turn between pages of events it reads back.

    Reason: the database driver reads synchronously, so a long read-back would otherwise hold every other request.

    Tests: `packages/server/src/routes/archive-restore-bounds.test.ts › gives the event loop a turn between the pages it reads back after the commit`.

## Archive export bounds

76. WHEN `GET /export?format=archive` is requested, the server MUST read the whole selection into the disk store's spool before it sends the first byte of the archive.

    Reason: a tar header carries each entry's size, so the line files and the manifest are complete before their first byte, and the manifest comes first so the whole selection is read before the body is sent (18).

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › writes the manifest first, then the line files, then the blobs, each as long as it said`, `› carries more blobs than a page, each once, in the manifest and the tar`, `› restores an archive of nothing`.

77. While `GET /export?format=archive` reads and writes, the server MUST NOT hold in memory more than one page of rows and the chunk of a blob it is sending.

    Reason: kept in memory, the selection grew with the instance, and 20,000 items took several hundred megabytes. The ids of the exported items and the digests of the blobs they name are kept in the spool too, so that the edges and the manifest need no set that grows with the instance.

    Tests: `packages/server/src/routes/export-spool.test.ts › keeps sets of strings, answers which it holds and walks them in order`, `› holds more strings than one statement binds`; `packages/server/src/routes/export-archive-stream.test.ts › carries more blobs than a page, each once, in the manifest and the tar`.

78. While `GET /export?format=archive` reads its selection, the server MUST give other requests a turn between pages of at most 200 rows.

    Reason: the pages are read from a driver that runs each statement synchronously, so an export that reads them in one go stops the server for as long as the selection is large (`instance.md` 19).

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › between pages of items and between pages of edges`; `packages/server/src/routes/long-jobs-health.test.ts › answers within the bound during an archive export of 20,000 items`.

79. WHEN a `GET /export?format=archive` response ends, whether the archive is complete, the client has left or a read has failed, the server MUST remove everything the export kept in the spool.

    Reason: the spool holds the instance's content, and a copy nobody will read is left behind otherwise. A server that is stopped during an export cannot remove it; it stays until the next start, which clears the spool.

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › holds the spool while it writes and removes it when the body ends`, `› with the spool removed when the client leaves while the tar is being written`, `› with the spool removed when the client leaves while the selection is read`, `› with an error and the spool removed when reading the selection fails`.

80. WHEN the client of `GET /export?format=archive` leaves before the body begins, the server MUST stop reading the selection.

    Reason: the selection is read before the first byte, which on a large instance takes long enough for a client to give up, and nobody is left to read what is read after.

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › with the spool removed when the client leaves while the selection is read`.

81. IF a read fails after the body of `GET /export?format=archive` has begun, the server MUST end the response with an error and not with a clean end.

    Reason: the status and headers are sent before the first byte, so the failure can only show as a connection cut short and a gzip stream with no end, which is an archive no one mistakes for a complete one.

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › cut short, never complete-looking, when a blob cannot be read once the body has begun`.

82. WHILE `GET /export?format=archive` reads, a write that lands between two of its pages MUST NOT make the archive unrestorable.

    Reason: the export no longer holds the server for the whole selection, so a write can land between pages. Each page of items is read together with its metadata, digests and history; the history of an item is the snapshots strictly below the version the export selected (35); and an edge is written only if both its endpoints are items the archive carries.

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › restores an archive of an instance written to between its pages`; `packages/server/src/routes/archive-complete-roundtrip.test.ts › fences exported history below the selected row's version during a concurrent patch`.

83. A row that is written while `GET /export?format=archive` reads MUST be carried as it stood when the export read its page, and a row created after the export began MUST NOT be carried.

    Reason: the archive is a copy of the instance as it moved and not at one instant. A row created after the export began is dated after every page, and the export reads the newest rows first, so it never reaches it.

    Tests: `packages/server/src/routes/export-archive-stream.test.ts › restores an archive of an instance written to between its pages`.
