# Search, filters, lookup, export and restore

The query grammar the listing operations share, the full-text search, the counts, the lookup by link, natural key or id, the pages every list answers, and the export and restore of an instance. How a recurring event unfolds and what a calendar window holds is `occurrences.md`.

## A query key an operation does not declare

Every operation declares the query keys it takes. The rules here hold for all of them, the item listing and the search among them.

### `search-and-filters/undeclared-key`

When a request carries a query key that its operation does not declare, the server MUST answer `400 validation_error` naming each such key in `details.unknown_parameters`.

**Reason:** the validator drops a key it does not declare, so a misspelled bound answers the whole set and cannot be told from a filter that matched every row. A rule that holds on some operations leaves the caller to find out which, by being wrong once.

**Tests:** `compliance/declared-refusals.test.ts › is refused 400 and named on every published door, the event stream included`, `› names a misspelled key on the event stream rather than opening it unfiltered`, `sync/time-filters.test.ts › honors the item listing's own-time bound and refuses a name it does not declare`, `correctness/edges/edges-list.test.ts › refuses an unknown query key and an unknown edge id`, `compliance/audit.test.ts › refuses an undeclared bound rather than answering the whole trail`, `compliance/connectors.test.ts › refuses a query key the runs listing does not declare`, `compliance/inbound-webhooks.test.ts › refuses a query key the listing does not declare, rather than answering unfiltered`, `compliance/item-stats.test.ts › refuses a query key it does not declare, naming it`, `compliance/envelope.test.ts › refuses an offset query key`.

### `search-and-filters/undeclared-key-401`

If a request to an operation that takes a credential carries an undeclared query key and no credential, then the server MUST answer `401`.

**Reason:** the refusal of the key comes after the credential check, so a bare request answers `401` whatever its query holds.

**Tests:** `compliance/declared-refusals.test.ts › is refused after the credential, so a bare request still answers 401`.

### `search-and-filters/undeclared-key-403`

If a credential that the operation's standing rule turns away sends an undeclared query key, then the server MUST answer the `403` it answers without the key.

**Reason:** the refusal of the key comes after the standing rule (`keys-and-oauth/permission-before-body`), so a credential that reaches no type learns nothing about the keys an operation declares.

**Tests:** `compliance/declared-refusals.test.ts › answers a copy stream request with a stray key 401, then 403 for a key that reads no type`.

### `search-and-filters/undeclared-key-first`

If a request carries an undeclared query key and a value that its operation also refuses, then the server MUST answer `400 validation_error` naming the undeclared key in `details.unknown_parameters`.

**Reason:** the key is named before the rest of the query is judged, so the caller learns which part of the request is wrong first.

**Tests:** `compliance/declared-refusals.test.ts › names an undeclared key before it looks at the rest of the query`.

### `search-and-filters/underscore-key`

The server MUST ignore a query key that starts with `_`.

**Reason:** such a key is the caller's own, so a client can tag a request without the server refusing it.

**Tests:** `compliance/declared-refusals.test.ts › ignores a key starting with an underscore on doors beyond the item listing, the event stream included`.

### `search-and-filters/shorthand-accepted`

The server MUST accept `edge[<edge type>]` and `backref[<edge type>]` for any edge type as query keys of `GET /items` and `GET /items/stats`.

**Reason:** the edge type is part of the key, so no list of declared keys can name it.

**Tests:** `compliance/declared-refusals.test.ts › accepts an edge shorthand on GET /items and GET /items/stats and on no other door`.

### `search-and-filters/shorthand-elsewhere`

If a request to any other operation carries an `edge[<edge type>]` or `backref[<edge type>]` key, then the server MUST answer `400 validation_error` naming it in `details.unknown_parameters`.

**Tests:** `compliance/declared-refusals.test.ts › accepts an edge shorthand on GET /items and GET /items/stats and on no other door`.

### `search-and-filters/undeclared-key-exempt`

The server MUST NOT refuse as undeclared a query key sent to `POST /inbound/{token}`, to a discovery document under `/.well-known/` or `/auth/.well-known/`, or to a browser page or an OAuth protocol endpoint under `/auth/`, `POST /auth/oauth2/register` excepted.

**Reason:** a sender's query string belongs to the sender, and a redirect reaches the browser pages carrying the OAuth flow's own parameters.

**Tests:** `compliance/declared-refusals.test.ts › takes a query on the doors that are not this server's to declare, and still refuses one on the client registration door`.

### `search-and-filters/undeclared-key-register`

If a request to `POST /auth/oauth2/register` carries an undeclared query key, then the server MUST answer `400 validation_error` naming it in `details.unknown_parameters`.

**Tests:** `compliance/declared-refusals.test.ts › takes a query on the doors that are not this server's to declare, and still refuses one on the client registration door`.

## A filter with nothing in it

### `search-and-filters/empty-narrowing`

If a credential that the operation admits sends `GET /items`, `GET /items/stats`, `GET /search`, `GET /occurrences`, `GET /export` or `GET /events` with a `type`, `source`, `tags` or `filter` key that the operation declares, holding no value, only blanks, or, for `type` and `tags`, a list of blank entries, then the server MUST answer `400 validation_error` naming each such key in `details.empty_parameters`.

**Reason:** a filter with no value narrows nothing and would answer everything the operation can read, so a client that built its query from a variable it never filled in would read everything while believing it had narrowed.

**Tests:** `compliance/validation.test.ts › refuses an empty type, source, tags or filter rather than reading everything`.

### `search-and-filters/empty-narrowing-first`

If a credential that the operation admits sends `GET /search` or `GET /occurrences` with an empty narrowing value and without a parameter the operation requires, then the server MUST answer the empty value's `400 validation_error`.

**Tests:** `compliance/validation.test.ts › refuses an empty narrowing value before a missing required one, and after an undeclared key`.

### `search-and-filters/empty-narrowing-bulk`

If the `filter` of `POST /items/bulk-actions` carries `type`, `source`, `tags` or `filter` with no value or with only blanks, or carries `tags` as an empty list or a list of blank entries, then the server MUST answer `400 validation_error` naming each such field as `filter.<field>` in `details.empty_parameters`.

**Reason:** a filter field with no value narrows nothing, so an action built from a variable that was never filled in would match every item the credential may write.

**Tests:** `compliance/validation.test.ts › refuses an empty or blank type, source, tags or filter in a bulk-action filter`.

### `search-and-filters/empty-narrowing-bulk-order`

If a credential that the operation admits sends `POST /items/bulk-actions`, other than a `purge` without `confirm: "PURGE"`, with an empty `filter` field and a body or `filter` key the operation does not declare, then the server MUST answer the undeclared key's `400 validation_error`, naming it in `details.unknown_body_fields`, a key of the filter as `filter.<key>`, and naming nothing in `details.empty_parameters`.

**Tests:** `compliance/validation.test.ts › refuses an empty narrowing value before a missing required one, and after an undeclared key`.

### `search-and-filters/empty-narrowing-bulk-before-action`

If a credential that the operation admits sends `POST /items/bulk-actions` with an empty `filter` field and an `update_tags` naming neither `add` nor `remove`, then the server MUST answer the empty field's `400 validation_error`.

**Tests:** `compliance/validation.test.ts › refuses an empty narrowing value before a missing required one, and after an undeclared key`.

## The type filter

A `type` names a type and every type under it, as `types/listing-subtree` says of a listing. A wildcard ends in `.*`.

### `search-and-filters/type-subtree`

When `GET /items/stats`, `GET /search`, `GET /export`, `GET /events` or `POST /items/bulk-actions` names a `type`, the server MUST apply it to that type and every type under it.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers the readable descendants on every door`, `› GET /items/stats counts the readable descendants of a type the key may not read`, `› GET /events streams the readable descendants of a type the key may not read and withholds the rest`, `correctness/persistence.test.ts › type-filtered search only returns matching types`.

### `search-and-filters/type-wildcard`

When a `type` filter of `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` or `GET /events` ends in `.*`, the server MUST select the items of the type named by the part before `.*`, of every type whose name starts with that part and a dot, and of every type declared under it.

**Tests:** `compliance/unreadable-type-filter.test.ts › GET /items, /export and /search leave out what the key may not read`, `› GET /items/stats counts only what the key may read`, `› GET /items/stats answers an object with no counts for a wildcard over types the key reads none of`, `› GET /occurrences reads a wildcard as a wildcard`, `› GET /events streams the readable types a wildcard matches and withholds the rest`, `compliance/types.test.ts › selects with a type the types declared under it, as with its own name`.

### `search-and-filters/type-grammar-refused`

If the `type` of `GET /items`, `GET /items/stats`, `GET /search`, `GET /export` or `GET /occurrences`, or the `filter.type` of `POST /items/bulk-actions`, holds a value that is neither a type identifier nor a wildcard ending in `.*` over one, then the server MUST answer `400 validation_error` naming the field in `details.errors`.

**Tests:** `compliance/question-mark-values.test.ts › is refused on every door that takes a type, naming it`.

### `search-and-filters/type-unknown`

If a credential that reaches some type sends a `type` filter naming a well-formed concrete type that nothing registers, then the server MUST answer `400 unknown_type` on `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` and each entry of the `type` list of `GET /events`.

**Reason:** an empty page is the one answer a client cannot tell from a quiet instance, so a mistyped name, a type registered under another handle and a type deleted since the client last read the registry would all read as nothing here. A wildcard is not refused, because what it names may be nothing (`search-and-filters/type-wildcard-none`).

**Tests:** `compliance/unreadable-type-filter.test.ts › $name answers 400 unknown_type, whatever the key reads`, `› GET /events holds each entry of a list to the rule`, `correctness/pagination.test.ts › a nonexistent type is refused rather than answered with an empty page`, `compliance/item-stats.test.ts › counts the rows a listing's filters match`.

### `search-and-filters/type-bulk-unregistered`

If the `filter.type` of `POST /items/bulk-actions` names a type that nothing registers, then the server MUST select the rows that carry that type name rather than refuse the request `400 unknown_type`.

**Reason:** the operation takes no wildcard, so the type's own name is the only way to select the rows that a type removed with `force` left behind, in order to purge them.

**Tests:** `compliance/unreadable-type-filter.test.ts › POST /items/bulk-actions does not refuse one, because it takes no wildcard to reach the rows a removed type kept`, `› POST /items/bulk-actions selects the rows a type removed with force left behind, by the type's own name`.

### `search-and-filters/type-unreadable`

If a `type` filter names a registered type that the credential may not read, and no type under it that the credential may read, then the server MUST answer `403 type_not_permitted` on `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences`, each entry of the `type` list of `GET /events` and the `filter.type` of `POST /items/bulk-actions`.

**Reason:** an empty page would say nothing here about a type that is registered, which tells a caller nothing it can act on, while a write of the same type by the same credential is already answered `403 type_not_permitted`. The refusal discloses nothing the registry does not (`types/registry-open`). An item named by id keeps answering as a missing one when its type is unreadable (`items/get-missing`), because there the caller named a row and not a type.

**Tests:** `compliance/unreadable-type-filter.test.ts › $name answers 403 type_not_permitted naming the type`, `› the same type is served to a key that reads it, on every door but the bulk action`, `› GET /events holds each entry of a list to the rule`, `› refuses the same type to a key that reads nothing under it`.

### `search-and-filters/type-unreadable-grant`

When the server refuses a `type` filter `403 type_not_permitted` for the type it names, the server MUST name that type and the level `read` in `details.grant`.

**Reason:** a filter reads, so a credential that writes the type is not offered a write grant it does not need.

**Tests:** `compliance/unreadable-type-filter.test.ts › names the level read in the grant of every refusal`, `› $name answers 403 type_not_permitted naming the type`.

### `search-and-filters/type-bulk-unreadable`

If the `filter.type` of `POST /items/bulk-actions` names a type that nothing registers, and the credential may read neither it nor any type under it, then the server MUST answer `403 type_not_permitted`.

**Reason:** the operation selects a type's subtree as the listings do, so the grant decides whether or not the type is registered.

**Tests:** `compliance/unreadable-type-filter.test.ts › POST /items/bulk-actions refuses an unregistered type the key holds nothing on`.

### `search-and-filters/type-bulk-read-only`

When the `filter.type` of `POST /items/bulk-actions` names a type that the credential may read and may not write, the server MUST narrow the match set to nothing rather than refuse the request.

**Reason:** the action is narrowed to what the credential may write, so a key that reads every type and writes none matches nothing whatever the filter names. The refusal in `search-and-filters/type-unreadable` is about reading a type, which is what a filter asks of one.

**Tests:** `compliance/unreadable-type-filter.test.ts › narrows a type the key reads and does not write to nothing, rather than refusing it`.

### `search-and-filters/type-descendant-readable`

When a concrete `type` filter names a type that the credential may not read, and the credential may read a type under it, the server MUST answer the items of the types under it that the credential may read rather than refuse the request.

**Reason:** a concrete type selects its subtree, so refusing would withhold rows that the credential is entitled to. The refusal in `search-and-filters/type-unreadable` is for a filter that reaches nothing readable.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers the readable descendants on every door`, `› GET /items/stats counts the readable descendants of a type the key may not read`, `› GET /occurrences answers the readable subtype of an event type the key may not read`, `› GET /events streams the readable descendants of a type the key may not read and withholds the rest`.

### `search-and-filters/type-wildcard-readable`

When a credential that may read some type sends a wildcard `type` filter, the server MUST answer the items of the types it matches that the credential may read, whatever else it matches.

**Reason:** a wildcard names a set, so the readable part of it is a complete answer, and a refusal would turn a client that asks for `core.*` into one that has to know its own grant first.

**Tests:** `compliance/unreadable-type-filter.test.ts › GET /items, /export and /search leave out what the key may not read`, `› GET /items/stats counts only what the key may read`, `› GET /occurrences reads a wildcard as a wildcard`, `› GET /events streams the readable types a wildcard matches and withholds the rest`.

### `search-and-filters/type-wildcard-none`

When a wildcard `type` filter matches no type that a credential reaching some type may read, the server MUST answer as it answers a filter that matches no row: an empty page, a counts object with no count, or a stream with no frame of those types.

**Reason:** nothing is a correct answer to everything under this root, as it is for a root under which nothing is registered.

**Tests:** `compliance/unreadable-type-filter.test.ts › a wildcard over types the key reads none of is an empty page, not a refusal`, `› GET /items/stats answers an object with no counts for a wildcard over types the key reads none of`, `› GET /events carries no frame for a wildcard over types the key reads none of`.

### `search-and-filters/type-map-none`

If a credential whose type map reaches no type sends a request to an operation that takes a `type` filter, or to `POST /items/lookup`, then the server MUST answer `403 type_not_permitted`, whatever the filter names, a wildcard and a type that nothing registers included.

**Reason:** an empty answer would say that the instance holds nothing for the credential to read, rather than that it may read nothing (`keys-and-oauth/permissions-no-content`).

**Tests:** `compliance/unreadable-type-filter.test.ts › answers 403 type_not_permitted whatever the filter names, to a working key and to a management key`, `› a key whose map reaches no type is refused a wildcard too`.

### `search-and-filters/type-map-narrows`

When a credential's type map names the types it may read, the server MUST leave out of every listing and search the items of every other type.

**Reason:** a type the credential may not read is not shown to it in a set, as it is not shown by id. `keys-and-oauth/permissions-no-content` states what the map grants.

**Tests:** `compliance/type-scoped-access.test.ts › scoped key list filtering only returns permitted types`, `› search results filtered by scoped permissions`, `› unlisted types are implicitly denied (no wildcard)`, `› namespace wildcard grants access to all types in the namespace`, `compliance/type-permissions.test.ts › none permission hides the type from a listing, not only from a write`, `› wildcard pattern matches all types in namespace`.

## State, source, tags and tier

The listing leaves out what is not `active` when it names no `state`: `items/bin-hidden` and `items/archived-hidden` state it, and `items/bin-listed` states what `state=trashed` and `state=any` reach.

### `search-and-filters/state-named`

When `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` names a `state`, the server MUST select only the rows in that state.

**Tests:** `compliance/state-default.test.ts › a named state and the sentinel still reach every row`, `› a search that names no state answers the active state`, `compliance/export.test.ts › filters by state`, `correctness/lifecycle-transitions.test.ts › state filter works on listItems`, `compliance/item-stats.test.ts › counts the rows a listing's filters match`.

### `search-and-filters/state-search-default`

When `GET /search` names no `state`, the server MUST match only rows in the `active` state.

**Reason:** a search never answers a row that a listing hides, because that would be two answers to one question.

**Tests:** `compliance/state-default.test.ts › a search that names no state answers the active state`.

### `search-and-filters/state-search-any`

When `GET /search` names `state=any`, the server MUST match the rows of every lifecycle state but `trashed`.

**Tests:** `compliance/state-default.test.ts › a search reads across states under the sentinel, except the bin`.

### `search-and-filters/search-bin`

The server MUST NOT match a row in the bin on `GET /search`, whatever `state` the search names.

**Reason:** the index holds no row in the bin, so `state=trashed` and `state=any` alike leave it unmatched, however the row came to be there.

**Tests:** `compliance/state-default.test.ts › a search reads across states under the sentinel, except the bin`, `› a search does not reach a row born in the bin either`.

### `search-and-filters/state-invalid`

If `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` names a `state` that is neither a lifecycle state nor `any`, then the server MUST answer `400 validation_error`.

**Reason:** a typo in a filter must not be served as a successful selection.

**Tests:** `compliance/state-default.test.ts › refuses a state that is not a state, on every door that reads items`, `compliance/export.test.ts › refuses an unknown state filter`, `compliance/item-stats.test.ts › refuses what the listing refuses in a filter: a state outside the enum, a bound that is not an instant and a number no double holds`.

### `search-and-filters/source-narrows`

When `GET /items`, `GET /items/stats`, `GET /export` or `POST /items/bulk-actions` names a `source`, the server MUST select only the rows stamped with that source.

**Tests:** `compliance/source-narrowing.test.ts › GET /items answers only the rows stamped with the source named`, `› GET /items/stats counts only the rows stamped with the source named`, `› GET /export carries only the rows stamped with the source named`, `› POST /items/bulk-actions selects only the rows stamped with the source named`.

### `search-and-filters/source-not-in-search`

If `GET /search` carries `source`, then the server MUST answer `400 validation_error` naming `source` in `details.unknown_parameters`.

**Reason:** a search declares no `source`, so the key is refused rather than dropped, which would answer every source.

**Tests:** `compliance/source-narrowing.test.ts › GET /search refuses a source, which it does not declare, rather than answering every source`.

### `search-and-filters/tags-every`

When `GET /items`, `GET /items/stats`, `GET /search` or `POST /items/bulk-actions` names tags, the server MUST select only the rows that carry every tag named.

**Tests:** `correctness/tags.test.ts › narrows the listing, the stats, the search and the bulk action to the rows that carry every tag named`, `› filters items by tag in queries`, `› filtering by tags=[favorite] returns tagged items and excludes others`.

### `search-and-filters/tier-narrows`

When `GET /items`, `GET /items/stats` or `GET /search` names `tier=library` or `tier=feed`, the server MUST select only the rows in that tier.

**Tests:** `compliance/tier-axis.test.ts › tier=library returns library items only`, `› tier=feed returns feed items only`, `› narrows the stats and the search by tier as the listing does`.

### `search-and-filters/tier-both`

When `GET /items`, `GET /items/stats` or `GET /search` names `tier=all` or names no `tier`, the server MUST select the rows of both tiers.

**Tests:** `compliance/tier-axis.test.ts › default query omitting tier returns both library and feed items`, `› tier=all returns both library and feed items`, `› narrows the stats and the search by tier as the listing does`.

### `search-and-filters/tier-invalid`

If `GET /items`, `GET /items/stats` or `GET /search` names a `tier` that is not `library`, `feed` or `all`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/tier-axis.test.ts › refuses a tier that is not library, feed or all, on the listing, the stats and the search`.

## Time bounds

An item's own time is its `occurred_at`, or its `created_at` where it has none.

### `search-and-filters/own-time-bounds`

When `GET /items`, `GET /search` or `GET /export` names `occurred_after` or `occurred_before`, the server MUST bound the rows by their own time.

**Tests:** `compliance/occurred-at.test.ts › occurred_after filter uses COALESCE(occurred_at, created_at)`, `› occurred_before filter uses COALESCE(occurred_at, created_at)`, `› GET /search bounds a search by the item's own time and excludes an item sitting exactly on either bound`, `› GET /export bounds an export by the item's own time and excludes an item sitting exactly on either bound`, `compliance/canonical-time.test.ts › stores own time in UTC and orders and bounds it by instant`, `compliance/export.test.ts › filters by date range on the item's own time`.

### `search-and-filters/own-time-exclusive`

When `GET /items`, `GET /search` or `GET /export` names `occurred_after` or `occurred_before`, the server MUST leave out an item whose own time is exactly the bound.

**Reason:** the row sitting on a bound is the row that tells an exclusive bound from an inclusive one.

**Tests:** `compliance/occurred-at.test.ts › both bounds exclude an item sitting exactly on them`, `› GET /search bounds a search by the item's own time and excludes an item sitting exactly on either bound`, `› GET /export bounds an export by the item's own time and excludes an item sitting exactly on either bound`.

### `search-and-filters/own-time-sort`

When `GET /items` names `sort=occurred_at`, the server MUST order the items by their own time.

**Tests:** `compliance/occurred-at.test.ts › COALESCE ordering: sort=occurred_at uses occurred_at then created_at`, `compliance/canonical-time.test.ts › stores own time in UTC and orders and bounds it by instant`.

### `search-and-filters/own-time-created-sort`

The server MUST NOT let an item's `occurred_at` change the order of a `GET /items` listing sorted by `created_at`.

**Tests:** `compliance/occurred-at.test.ts › occurred_at does not affect created_at ordering`.

### `search-and-filters/bound-not-instant`

If `GET /items` or `GET /items/stats` names `occurred_after`, `occurred_before`, `updated_after` or `updated_before`, or `GET /export` names `occurred_after` or `occurred_before`, with a value that is not an instant, then the server MUST answer `400 validation_error`.

**Reason:** the export streams, so a bound refused after the response began would hand the caller an empty body under a success status.

**Tests:** `compliance/item-stats.test.ts › refuses what the listing refuses in a filter: a state outside the enum, a bound that is not an instant and a number no double holds`, `compliance/export.test.ts › refuses a bound that is not an instant, on both output formats`.

### `search-and-filters/updated-after`

When `GET /items` names `updated_after`, the server MUST list only the items whose `updated_at` is at or after it.

**Reason:** the bound is inclusive because `updated_at` ties across a bulk write, so a strict bound would drop every row sharing the instant of a resuming client's cursor. A tag moves `updated_at` as a property does (`items/tag-updated-at`).

**Tests:** `sync/time-filters.test.ts › keeps updated_after inclusive, which the catch-up depends on`, `sync/catchup.test.ts › sees a tag written after the boundary, not just a property change`.

### `search-and-filters/updated-after-order`

If `GET /items` names `updated_after` with a `sort` other than `updated_at` or a `direction` other than `asc`, then the server MUST answer `400 validation_error`.

**Reason:** the bound orders the listing by `updated_at` and then id, ascending, which is the only order a catch-up cursor can advance through, so honoring one half of a contradicting request would answer a page that cannot be resumed.

**Tests:** `sync/time-filters.test.ts › refuses updated_after beside a sort or direction it does not order by, and takes the order it implies`.

### `search-and-filters/updated-before`

When `GET /items` names `updated_before`, the server MUST list only the items whose `updated_at` is before it.

**Tests:** `sync/time-filters.test.ts › bounds an item listing by updated_before, exclusively`.

## What a listing adds and what it leaves out

### `search-and-filters/include-edges`

When `GET /items` names `include=edges`, the server MUST add to each item its outbound edges, keyed by edge type, each block a page of `data` and `next_cursor`.

**Reason:** `edges/hydrate` states the blocks of an item read, and `POST /items/lookup` hydrates its rows the same way.

**Tests:** `compliance/links.test.ts › hydrates edges on a lookup as the listing does`, `compliance/envelope.test.ts › carries each hydrated edge block as a page`.

### `search-and-filters/system-named-type`

When `GET /items` names a `type` in the `system.` namespace, the server MUST list the items of that type that the credential may read.

**Reason:** a caller that asks for `system.folder` has already said what it wants, so the default that leaves `system.*` items out of a listing does not apply to it.

**Tests:** `compliance/folders.test.ts › creates a folder as a system.folder, read back through the item doors`.

## The filter expression

`GET /items`, `GET /items/stats` and `GET /search` take a `filter` expression, and `POST /items/bulk-actions` takes one inside its filter. An edge term in an expression is `edges.md`'s (`edges/filter-edge`, `edges/filter-edge-full`).

### `search-and-filters/filter-question-mark`

When a value in a `filter` expression, a `tags` parameter or the value of a `backref[<edge type>]` parameter of `GET /items`, `GET /items/stats`, `GET /search` or `POST /items/bulk-actions` holds a `?`, the server MUST match the `?` as that character and as nothing else.

**Tests:** `compliance/question-mark-values.test.ts › matches as itself in a filter on GET /items`, `› matches as itself in a tags parameter on GET /items`, `› matches as itself in a tags parameter on GET /items/stats, GET /search and POST /items/bulk-actions`, `› matches as itself in a filter on GET /items/stats`, `› matches as itself in a filter on GET /search`, `› matches as itself in a filter on POST /items/bulk-actions`, `› matches as itself in the anchor of an edge term, on every door that takes one`.

### `search-and-filters/tag-count-question-mark`

When a tag holds a `?`, the server MUST count it under its own name on `GET /metadata/tags`.

**Tests:** `compliance/question-mark-values.test.ts › counts a tag holding a ? under its own name on GET /metadata/tags`.

### `search-and-filters/filter-max-length`

The server MUST take a `filter` of 2,048 characters on `GET /items` and `GET /search`.

**Tests:** `compliance/validation.test.ts › takes a filter of 2,048 characters and refuses one of 2,049, on the listing and the search`.

### `search-and-filters/filter-over-length`

If a `filter` on `GET /items` or `GET /search` is longer than 2,048 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/validation.test.ts › takes a filter of 2,048 characters and refuses one of 2,049, on the listing and the search`.

### `search-and-filters/filter-max-conditions`

The server MUST take a `filter` of 10 conditions joined by `AND`, or joined by `OR`, on `GET /items` and `GET /search`.

**Tests:** `compliance/validation.test.ts › takes a filter of 10 conditions and refuses one of 11, on the listing and the search`.

### `search-and-filters/filter-over-conditions`

If a `filter` on `GET /items` or `GET /search` holds more than 10 conditions, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/validation.test.ts › takes a filter of 10 conditions and refuses one of 11, on the listing and the search`.

### `search-and-filters/filter-mixed-logic`

If a `filter` on `GET /items` or `GET /search` joins conditions with both `AND` and `OR`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/validation.test.ts › refuses a filter that mixes AND with OR, on the listing and the search`.

### `search-and-filters/filter-or-shorthand`

If `GET /items` carries an `edge[<edge type>]` or `backref[<edge type>]` key and a `filter` that uses `OR`, then the server MUST answer `400 validation_error`.

**Reason:** the server joins a shorthand to the `filter` with `AND`, so the two cannot form one expression.

**Tests:** `compliance/validation.test.ts › refuses a filter that uses OR beside an edge shorthand, which joins it with AND`.

### `search-and-filters/shorthand-backslash`

If the value of an `edge[<edge type>]` or `backref[<edge type>]` key carries a backslash, then the server MUST answer `400 validation_error`.

**Reason:** the filter grammar reads `\"` as a quote and every other backslash literally, so a backslash cannot be quoted. One before the closing quote would run the value on into the next clause, where it would be read as filter syntax. An item id never carries one.

**Tests:** `compliance/validation.test.ts › refuses an edge shorthand value carrying a backslash, and still takes a quote`.

### `search-and-filters/shorthand-quote`

When the value of an `edge[<edge type>]` key carries a double quote, the server MUST take the quote as part of the value, which matches no item.

**Tests:** `compliance/validation.test.ts › refuses an edge shorthand value carrying a backslash, and still takes a quote`.

### `search-and-filters/filter-number-range`

If a `filter` on `GET /items`, `GET /items/stats` or `GET /search` compares with a number that no double holds, then the server MUST answer `400 validation_error`.

**Reason:** a number no double holds would be compared as infinity.

**Tests:** `compliance/validation.test.ts › refuses a filter number no double holds, on the listing and the search`, `compliance/item-stats.test.ts › refuses what the listing refuses in a filter: a state outside the enum, a bound that is not an instant and a number no double holds`.

### `search-and-filters/filter-numeric`

When a `filter` on `GET /items` or `GET /search` compares a numeric JSON property with a number using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare it as a finite double, with the value the API returns.

**Tests:** `compliance/numeric-property-filters.test.ts › witnesses every seeded row on both doors before filtering`, `› compares numeric properties as finite doubles on the listing and search`.

### `search-and-filters/filter-numeric-spellings`

When distinct spellings of an integer round to the same double, the server MUST compare them equal in a numeric `filter`, with `eq` agreeing with both inclusive range comparisons.

**Tests:** `compliance/numeric-property-filters.test.ts › compares numeric properties as finite doubles on the listing and search`.

### `search-and-filters/filter-numeric-only`

The server MUST NOT turn text, an array, an object, a missing property or `null` into a number when a numeric `filter` compares with `eq`.

**Tests:** `compliance/numeric-property-filters.test.ts › does not turn text, arrays, objects, missing or null properties into numeric equality matches`.

### `search-and-filters/filter-null-refused`

If a `filter` compares a field with a `null` literal after an operator that takes a value, then the server MUST answer `400 validation_error`.

**Reason:** a comparison with null is never true, so `eq null` would answer an empty page with no error, and a bulk action selecting by it would silently select nothing.

**Tests:** `compliance/null-filter.test.ts › is refused 400 on every operator, naming not_exists where a property can be absent`, `› is refused on a system field, an edge and tags, and still read as text when quoted`.

### `search-and-filters/filter-null-hint`

When the server refuses a comparison of a property with `null`, the server MUST name `not_exists` in the message as the way to ask for an absent value.

**Reason:** `not_exists` asks the question the caller means and answers the rows whose property is absent or null, and `exists` the rows that hold a value. A system field always exists, so a refusal about one names no presence test.

**Tests:** `compliance/null-filter.test.ts › is refused 400 on every operator, naming not_exists where a property can be absent`.

### `search-and-filters/filter-not-exists`

When a `filter` applies `not_exists` to a property, the server MUST select the rows whose property is absent or null, and `exists` the rows whose property holds a value.

**Tests:** `compliance/null-filter.test.ts › is not needed: not_exists asks for a property that is absent or null, and exists for one that has a value`.

### `search-and-filters/filter-null-quoted`

When a `filter` compares a field with `"null"` inside double quotes, the server MUST compare it as text.

**Tests:** `compliance/null-filter.test.ts › is refused on a system field, an edge and tags, and still read as text when quoted`.

### `search-and-filters/filter-time-instant`

When a `filter` on `GET /items` or `GET /search` compares `created_at`, `updated_at` or `occurred_at` with a timestamp literal using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare it as the instant it names, however it is spelled.

**Tests:** `compliance/canonical-time.test.ts › normalizes filter timestamps on listing and search`, `› compares filter timestamps with neq, gt, lt and lte as instants, on listing and search`.

### `search-and-filters/filter-time-refused`

If a `filter` on `GET /items` or `GET /search` compares `created_at`, `updated_at` or `occurred_at` with `eq`, `neq`, `gt`, `gte`, `lt` or `lte` against a literal that is not a timestamp or is not text, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/canonical-time.test.ts › refuses a time comparison with a literal that is not a timestamp, on every operator, naming validation_error`, `› refuses invalid time comparisons while retaining text operators`.

### `search-and-filters/filter-time-text`

When a `filter` on `GET /items` or `GET /search` compares `created_at`, `updated_at` or `occurred_at` with `contains` or `starts_with`, the server MUST match text fragments.

**Tests:** `compliance/canonical-time.test.ts › refuses invalid time comparisons while retaining text operators`.

## Sorting by a property

### `search-and-filters/sort-property`

When `GET /items` names `sort=properties.<field>`, the server MUST order the rows by the scalar value each stores in that property, whatever the row's type and whether the `type` filter is concrete, a wildcard or absent.

**Tests:** `correctness/property-sort-pagination.test.ts › walks numeric properties whatever the type filter`, `› walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-ascending`

When `GET /items` sorts by a property ascending, the server MUST put numbers and booleans first in numeric order, with `false` equal to `0` and `true` equal to `1`, followed by strings in binary lexical order, an empty string being a value and numeric text remaining text.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-descending`

When `GET /items` sorts by a property descending, the server MUST reverse the scalar order, including the order between numbers and strings.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-missing`

When `GET /items` sorts by a property, the server MUST put the rows whose property is missing, null, an object or an array after every scalar, in either direction.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-ties`

When `GET /items` sorts by a property, the server MUST order rows with equal values, numerically equal booleans and numbers and the whole null tail included, by item ID ascending in both directions.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-cursor`

When a client follows `next_cursor` through a `GET /items` listing sorted by a property, the server MUST deliver every matching row once, across type boundaries, scalar kinds and ties.

**Reason:** the cursor keeps the scalar kind of the value it stopped at.

**Tests:** `correctness/property-sort-pagination.test.ts › walks numeric properties whatever the type filter`, `› walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

## Pages and limits

The rows of one page and the key that continues them are in `search-and-filters/page-envelope`.

### `search-and-filters/limit-listing`

When `GET /items` names a `limit` from 1 to 200, the server MUST answer a page of at most that many items.

**Tests:** `correctness/pagination.test.ts › takes a limit of 200 and refuses 201 and 0, on the listing`, `› basic pagination: limit restricts result count and signals more`.

### `search-and-filters/limit-listing-refused`

If `GET /items` names a `limit` above 200 or below 1, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `correctness/pagination.test.ts › takes a limit of 200 and refuses 201 and 0, on the listing`.

### `search-and-filters/limit-search`

When `GET /search` names a `limit` from 1 to 100, the server MUST answer a page of at most that many hits.

**Tests:** `correctness/pagination.test.ts › takes a limit of 100 and refuses 101 and 0, on the search`, `› search respects limit parameter`.

### `search-and-filters/limit-search-refused`

If `GET /search` names a `limit` above 100 or below 1, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `correctness/pagination.test.ts › takes a limit of 100 and refuses 101 and 0, on the search`.

### `search-and-filters/cursor-continues`

When a client sends back the `next_cursor` of a page of `GET /items`, the server MUST answer the page that follows it, so that walking to the end delivers every row exactly once.

**Tests:** `correctness/pagination.test.ts › cursor continuation delivers every item exactly once`, `› cursor is opaque and enables next page retrieval`.

### `search-and-filters/cursor-last-page`

When a page of `GET /items` holds the last row, the server MUST answer `next_cursor` `null`.

**Tests:** `correctness/pagination.test.ts › the last page answers next_cursor: null`.

### `search-and-filters/cursor-other-listing`

If a `GET /items` request sends a `cursor` that another listing or another ordering issued, then the server MUST answer `400 validation_error`.

**Reason:** every ordering compares an ISO timestamp or a property value, so the wrong cursor would answer a page that is simply not the next page.

**Tests:** `correctness/pagination.test.ts › refuses a cursor issued by another listing or ordering`.

## Search

`GET /search?q=` matches full text. A device matches the same way, as the device chapter's section "Search, matched as the server matches" says.

### `search-and-filters/search-q-required`

If `GET /search` carries no `q`, then the server MUST answer `400 missing_required_field`.

**Tests:** `correctness/persistence.test.ts › refuses a search with no query`, `compliance/validation.test.ts › refuses an empty q and a q holding a NUL as validation_error, and names a q that is absent as missing`.

### `search-and-filters/search-q-empty`

If `GET /search` carries a `q` that is empty, then the server MUST answer `400 validation_error`.

**Reason:** only an absent `q` is a missing field, and a `q` of blanks is not empty: it matches nothing (`search-and-filters/search-no-word`). A `q` holding a NUL character is refused by `items/search-nul`.

**Tests:** `compliance/validation.test.ts › refuses an empty q and a q holding a NUL as validation_error, and names a q that is absent as missing`.

### `search-and-filters/search-q-punctuation`

The server MUST take a `q` that holds quotes, ampersands and parentheses.

**Tests:** `compliance/validation.test.ts › accepts quotes, ampersands and parentheses in a search query`.

### `search-and-filters/search-matches`

When `GET /search` carries a `q`, the server MUST answer the items whose searchable text or tags match it, and no other item.

**Tests:** `correctness/persistence.test.ts › search for distinctive text returns matching items`, `› search for nonexistent string returns empty results`.

### `search-and-filters/search-id-not-text`

The server MUST NOT match an item on its identifier alone.

**Reason:** an identifier is not searchable content, so it matches only where it also appears in an indexed field or a tag.

**Tests:** `compliance/fts-searchable.test.ts › matches searchable content and tags without matching an item identifier alone`.

### `search-and-filters/search-score`

The server MUST carry on each hit of `GET /search` a positive `relevance_score`, higher for a hit ranked better and equal for hits of equal rank.

**Reason:** the score is relative to the rows of the index it ranks in, so it compares hits only within one search.

**Tests:** `compliance/search-matching.test.ts › scores a hit by its rank and gives the better hit the higher score`.

### `search-and-filters/search-cursor`

When a client sends back the `next_cursor` of a page of `GET /search` with the same query, the server MUST continue the ranking, so that walking to `null` delivers every hit once.

**Tests:** `compliance/envelope.test.ts › walks to a null cursor, delivering every hit once`.

### `search-and-filters/search-cursor-refused`

If a `GET /search` request sends a `cursor` that another listing issued, that another search issued, or that does not parse, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/envelope.test.ts › refuses a cursor another listing issued, and one it cannot read`, `› refuses a cursor minted for another search`.

### `search-and-filters/search-depth`

When a page of `GET /search` holds the 10,000th row of the ranking, the server MUST answer `next_cursor` of `null`.

**Reason:** the server reads the ranking at most 10,000 rows deep, so a search is narrowed rather than paged past that depth.

**Tests:** `compliance/search-depth.test.ts › stops paging a search at its 10,000th row`.

### `search-and-filters/search-stem`

The server MUST reduce every word of the indexed text and of a query to its stem, so that `run` followed by another word matches `running` and `runs` and not `runner`.

**Reason:** a person searching with the word they remember expects its other forms.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-fold-case`

The server MUST match a word in the indexed text and in a query whatever its case.

**Tests:** `compliance/search-matching.test.ts › folds case in the text and in the query`.

### `search-and-filters/search-fold-diacritics`

The server MUST match a word in the indexed text and in a query whatever its diacritics.

**Tests:** `compliance/search-matching.test.ts › folds diacritics in the text and in the query`.

### `search-and-filters/search-split`

The server MUST split words of the indexed text and of a query at anything that is not a letter or a digit, and keep a digit inside its word.

**Tests:** `compliance/search-matching.test.ts › splits words at anything that is not a letter or a digit, and keeps a digit inside its word`.

### `search-and-filters/search-all-words`

When a query is not wholly inside double quotes, the server MUST match only the rows in which every whitespace-separated word of it matches, in any order and in any column.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-last-prefix`

When a query is not wholly inside double quotes, the server MUST match its last word as the start of a word.

**Reason:** the person is still typing the last word.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-earlier-whole`

When a query is not wholly inside double quotes, the server MUST match every word of it but the last as a whole stem.

**Reason:** a prefix on every word would match `marshland` for `marsh landscape`, and the person has finished the earlier words.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-phrase`

When a query begins and ends with a double quote and holds at least one character between them, the server MUST match the text between them as a phrase, with its words adjacent and in order.

**Reason:** a phrase is how a person asks for words that belong together.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-phrase-whole`

When a query begins and ends with a double quote and holds at least one character between them, the server MUST match the last word of the phrase as a whole stem and not as a prefix.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-quote-text`

When a double quote in a query is not the first and the last character of a phrase, the server MUST read it as text.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-trim`

When a query has whitespace or byte-order marks around it, the server MUST ignore them.

**Reason:** a pasted query carries them, and they must not change whether it is a phrase or what it matches.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-syntax-text`

The server MUST read an operator word, a column name before a colon, a star, a leading minus and a double quote inside a word of a query as words to match, and never as search syntax.

**Reason:** a query is typed by a person, and one that a search engine read as syntax would be refused or would answer a different question.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-no-word`

When a query holds no word, the server MUST answer an empty page without an error.

**Tests:** `compliance/search-matching.test.ts › matches nothing, without an error, for a query with no word in it`, `› $name: $query`.

### `search-and-filters/index-fields`

While a row is not in the bin, the server MUST match a query against the row's `title`, `body`, `description` and `name` where each is a string, every other string property its type declares or inherits, and its tags.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/index-order`

When a query is a phrase, the server MUST match it against the string properties of a row beyond the four core ones joined in the order of their names, and against its tags joined in byte order.

**Reason:** two indexes that join the text in the same order answer the same phrase.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/index-undeclared`

The server MUST NOT match a property that the row's type does not declare.

**Reason:** a thumbnail's base64 or an undeclared property is not text a person wrote to be found.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/index-not-string`

The server MUST NOT match a value that is not a string.

**Tests:** `compliance/fts-searchable.test.ts › does not hold a value that is not a string, though the same text is found in a string`.

### `search-and-filters/index-unregistered`

When the type of a row is not registered, the server MUST match the row by its `title`, `body`, `description`, `name` and tags alone.

**Tests:** `compliance/fts-searchable.test.ts › keeps the four core properties and the tags of a row whose type was removed with force`.

### `search-and-filters/index-type-change`

When a type is registered, replaced, or deleted with `force`, the server MUST match each row not in the bin of that type and of each type that inherits from it by what the type then marks searchable.

**Reason:** what a row contributes to the index is decided when it is written, so without this a row would keep answering by the fields its type had until the row is next written, and a field marked `searchable: false` would stay matched.

**Tests:** `compliance/fts-searchable.test.ts › rows already stored follow a change to what their type marks searchable`, `› indexes the rows of a type that inherits again when its parent changes what it marks searchable`.

### `search-and-filters/rank-bm25`

The server MUST order hits by BM25 over the `title`, `body`, `description`, `name`, extra properties and tags at equal weight, best first.

**Reason:** a device ranks by the same measure (`device/rank-bm25`), so the two orders agree where they rank the same rows.

**Tests:** `compliance/search-matching.test.ts › $name: $query`, `› scores a hit by its rank and gives the better hit the higher score`.

### `search-and-filters/rank-ties`

The server MUST order hits of equal rank by item identifier, ascending.

**Reason:** an unordered tie is two answers to one query.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/excerpt-words`

When a hit's text matches the query, the server MUST carry in `snippet_html` an excerpt of at most 32 words.

**Tests:** `compliance/search-matching.test.ts › excerpts a match in a long text, marked and cut`.

### `search-and-filters/excerpt-column`

The server MUST draw the excerpt of a hit from the column that matches it best.

**Reason:** an excerpt drawn from the title alone shows a title with nothing marked for a match in the body, which is most matches, and is empty where the title is.

**Tests:** `compliance/search-matching.test.ts › marks the match in the column that holds it, not only in the title`.

### `search-and-filters/excerpt-mark`

The server MUST wrap each matched word of an excerpt in `<mark>` and `</mark>`.

**Tests:** `compliance/search-matching.test.ts › marks the match in the column that holds it, not only in the title`, `› excerpts a match in a long text, marked and cut`.

### `search-and-filters/excerpt-cut`

When an excerpt cuts the text, the server MUST write `...` where it is cut.

**Tests:** `compliance/search-matching.test.ts › excerpts a match in a long text, marked and cut`.

### `search-and-filters/excerpt-escaped`

The server MUST write an excerpt as HTML in which every `&`, `<`, `>`, `"` and `'` of the row's text is escaped as `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`.

**Reason:** an app shows the excerpt as HTML, and a row's text is what a person or a source wrote, never markup for that app to render.

**Tests:** `compliance/search-matching.test.ts › escapes the row's text in an excerpt and marks only the match`.

### `search-and-filters/excerpt-markup`

The server MUST NOT put markup in an excerpt other than pairs of `<mark>` and `</mark>`, each pair opened before it closes.

**Tests:** `compliance/search-matching.test.ts › escapes the row's text in an excerpt and marks only the match`.

## Owner browser reads

### `search-and-filters/owner-count-export`

When a request to `GET /items/stats` or `GET /export` carries a live browser session of the instance's owner and no Authorization header, the server MUST admit the request as the owner without requiring authentication within the last five minutes.

**Tests:** `compliance/owner-item-read.test.ts › admits the owner to filtered counts and both exports without creating a key`.

### `search-and-filters/owner-read-reach`

When an owner browser session reads counts or an export, the server MUST apply the operation's filters and instance source filtering with read access to every type, edge type, extension namespace, history snapshot and referenced blob.

**Reason:** The browser session is explicit owner authority, not a key with a projected permission map. The operation's existing state and system-item defaults still apply.

**Tests:** `compliance/owner-item-read.test.ts › admits the owner to filtered counts and both exports without creating a key`, `› refuses undeclared and invalid filters and accepts an empty selection`, `› keeps instance source filtering on owner counts and both exports`.

### `search-and-filters/owner-read-no-key`

When the owner reads counts or an export through their browser session, the server MUST create no API key for that read.

**Tests:** `compliance/owner-item-read.test.ts › admits the owner to filtered counts and both exports without creating a key`.

### `search-and-filters/owner-read-bearer`

When a request to counts or export carries an Authorization header alongside an owner browser cookie, the server MUST decide access using the presented credential alone.

**Tests:** `compliance/owner-item-read.test.ts › refuses an invalid bearer with an owner cookie and attributes owner exports`.

### `search-and-filters/owner-read-boundary`

When a request carries only owner browser authority to another item, edge, search, occurrence or tag content route, or only private local authority to counts or export, the server MUST retain that route's existing credential requirement.

**Reason:** Owner browser counts and exports admit no other content operation or transport.

**Tests:** `compliance/owner-item-read.test.ts › keeps other content doors and private socket reads closed with credential witnesses`.

### `search-and-filters/owner-read-ended`

When a request to counts or export carries only an ended or expired owner browser session, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/owner-item-read.test.ts › refuses the ended browser session on counts and exports`.

## Counting

`GET /items/stats` counts the rows a listing matches.

### `search-and-filters/stats-counts-listing`

When `GET /items/stats` names the filters of a `GET /items` listing, the server MUST count the rows that listing matches.

**Tests:** `compliance/item-stats.test.ts › counts the rows a listing's filters match`.

### `search-and-filters/stats-group`

The server MUST group the counts of `GET /items/stats` by lifecycle state, or by type when the request names `by=type`.

**Tests:** `compliance/item-stats.test.ts › counts the rows a listing's filters match`.

### `search-and-filters/stats-every-state`

When `GET /items/stats` names no `state`, the server MUST count the rows of every state, the bin included.

**Reason:** the default answer is the breakdown across the states, so the listing's own default of `active` does not apply.

**Tests:** `compliance/item-stats.test.ts › counts the rows a listing's filters match`, `› answers the listing's own count as the bucket of its state, and the sum of the buckets under state=any`, `compliance/state-default.test.ts › a named state and the sentinel still reach every row`.

### `search-and-filters/stats-equals-listing`

When `GET /items/stats` and `GET /items` name the same filters, the server MUST count as many rows in the bucket of the named state, or in the `active` bucket where none is named, as the listing lists, and under `state=any` as many as the sum of the buckets.

**Tests:** `compliance/item-stats.test.ts › answers the listing's own count as the bucket of its state, and the sum of the buckets under state=any`.

### `search-and-filters/stats-no-paging`

If `GET /items/stats` carries `limit`, `cursor`, `sort` or `direction`, then the server MUST answer `400 validation_error` naming each in `details.unknown_parameters`.

**Reason:** paging and ordering are not filters, and a count has no page.

**Tests:** `compliance/item-stats.test.ts › refuses a limit, a cursor, a sort and a direction as keys it does not declare, naming each`.

### `search-and-filters/stats-system`

When `GET /items/stats` names `include=system`, the server MUST count the `system.*` items that the credential may read.

**Tests:** `compliance/item-stats.test.ts › counts the system items under include=system and refuses any other include`.

### `search-and-filters/stats-system-default`

When `GET /items/stats` names neither `include=system` nor a `type` in the `system.` namespace, the server MUST leave the `system.*` items out of its counts.

**Tests:** `compliance/item-stats.test.ts › counts the system items under include=system and refuses any other include`.

### `search-and-filters/stats-include-other`

If `GET /items/stats` names an `include` other than `system`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/item-stats.test.ts › counts the system items under include=system and refuses any other include`.

## Lookup

`POST /items/lookup` finds rows by link, by natural key or by id.

### `search-and-filters/lookup-answer`

When the server takes a `POST /items/lookup` request, the server MUST answer `200` with `data` and `tombstones` and no other key.

**Tests:** `compliance/links.test.ts › looks rows up by link in every state, and refuses links for a type naming none`.

### `search-and-filters/lookup-by-link`

When `POST /items/lookup` names a `type` and `links`, the server MUST answer the rows of exactly that type that hold them.

**Reason:** a link is one row's within its type (`items/link-taken`), so a subtype's row holding the same value is not found.

**Tests:** `compliance/links.test.ts › answers by link only the rows of the type named`, `› looks rows up by link in every state, and refuses links for a type naming none`.

### `search-and-filters/lookup-by-key`

When `POST /items/lookup` names `source` and `source_ids`, the server MUST answer the rows holding those natural keys, whatever their type.

**Reason:** a row retyped since it was written is still found.

**Tests:** `compliance/links.test.ts › looks rows up by natural key whatever their type`.

### `search-and-filters/lookup-by-id`

When `POST /items/lookup` names `ids`, the server MUST answer the rows with those ids, whatever their type.

**Tests:** `compliance/links.test.ts › looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`.

### `search-and-filters/lookup-every-state`

When `POST /items/lookup` finds a row, the server MUST answer it in whatever state it holds, the bin included.

**Reason:** a lookup asks whether a key is held, and a row in the bin still holds it. `POST /items/bulk-get` leaves the bin out (`items/bulk-get`).

**Tests:** `compliance/links.test.ts › looks rows up by link in every state, and refuses links for a type naming none`, `› looks rows up by natural key whatever their type`, `› looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`.

### `search-and-filters/lookup-order`

The server MUST answer the rows of `POST /items/lookup` in the order the request named their keys, each row once.

**Tests:** `compliance/links.test.ts › looks rows up by link in every state, and refuses links for a type naming none`, `› looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`.

### `search-and-filters/lookup-system-left-out`

The server MUST leave out of the rows of `POST /items/lookup` a `system.*` row, whichever key names it.

**Tests:** `compliance/links.test.ts › looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`, `› leaves out a system row that holds a natural key a lookup names`.

### `search-and-filters/lookup-unreadable-left-out`

The server MUST leave out of the rows of `POST /items/lookup` a row whose type the credential's type map cannot read.

**Tests:** `compliance/links.test.ts › leaves out a row the key may not read, and refuses a key that may not read the type`.

### `search-and-filters/lookup-tombstones`

When `POST /items/lookup` names links or natural keys, the server MUST answer under `tombstones` what purges left under `type` for those keys, in the order named.

**Reason:** `items/tombstone` states what a purge leaves, and `items/tombstone-own-type` that a tombstone is answered only under the type it was recorded under.

**Tests:** `compliance/links.test.ts › leaves a tombstone for a purged row's link and natural key`, `› answers tombstones in the order named`, `› keeps each tombstone to its type, read and moved`.

### `search-and-filters/lookup-tombstones-subtype`

When `POST /items/lookup` answers a credential that may read a type under `type` and not `type` itself, the server MUST answer `tombstones` as an empty list.

**Reason:** the tombstones record what purges left under `type`, so they are answered only to a credential that may read `type` itself.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers no tombstones to a key that reads only a type under the one named`.

### `search-and-filters/lookup-source-filter`

When `POST /items/lookup` names `ids`, or `source` and `source_ids`, the server MUST answer a row that the `enforcement.source_filter` holding for the credential leaves out of `GET /items`.

**Reason:** a lookup names the rows it wants, as a read by id does (`types/source-filter-by-id`), so a row left out would read as a row that does not exist.

**Tests:** `compliance/schema-enforcement.test.ts › answers a row the instance's source filter leaves out of listings, as a read by key`.

### `search-and-filters/lookup-edges`

When `POST /items/lookup` names `include: ["edges"]`, the server MUST add to each row its outbound edges as `GET /items?include=edges` does.

**Tests:** `compliance/links.test.ts › hydrates edges on a lookup as the listing does`.

### `search-and-filters/lookup-type-unreadable`

If `POST /items/lookup` names a registered `type` and the credential may read neither it nor any type under it, then the server MUST answer `403 type_not_permitted`.

**Reason:** an empty page would say that the keys named nothing. A type under `type` that the credential may read is held to `search-and-filters/type-descendant-readable`.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers 403 where it used to answer an empty 200, and 400 for an unregistered type`, `compliance/links.test.ts › leaves out a row the key may not read, and refuses a key that may not read the type`.

### `search-and-filters/lookup-body-first`

If a `POST /items/lookup` body is one that the server refuses `400`, then the server MUST answer the `400` before it asks whether the credential may read `type`.

**Reason:** the order of checks is the body's shape, then the type's registration, then the credential's reach, so a refused body answers the same to every credential.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers 400 for a body it cannot read before it asks whether the key may read the type`.

### `search-and-filters/lookup-no-type`

If a `POST /items/lookup` body names no `type`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`.

### `search-and-filters/lookup-no-selector`

If a `POST /items/lookup` body names no selector, names two, names `source` without `source_ids` or the reverse, or carries an empty value or a key the operation does not declare, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`.

### `search-and-filters/lookup-values-cap`

When a `POST /items/lookup` body names at most 500 values, the server MUST answer them.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`.

### `search-and-filters/lookup-over-cap`

If a `POST /items/lookup` body names more than 500 values, then the server MUST answer `400 validation_error` with `details.cap` of 500 and `details.provided` of the count named.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`.

### `search-and-filters/lookup-links-no-field`

If a `POST /items/lookup` body names `links` for a `type` that names no `link_field`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/links.test.ts › looks rows up by link in every state, and refuses links for a type naming none`, `› refuses a lookup naming no selector, two, or more than 500 values`.

### `search-and-filters/lookup-bad-id`

If a `POST /items/lookup` body names an id that is malformed, then the server MUST answer `400 invalid_id`.

**Tests:** `compliance/links.test.ts › looks rows up by id in every state, where bulk-get leaves the bin out, and leaves a system row out`, `compliance/unreadable-type-filter.test.ts › answers 400 for a body it cannot read before it asks whether the key may read the type`.

### `search-and-filters/lookup-bad-type`

If a `POST /items/lookup` body names a `type` that is malformed, a wildcard included, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`, `compliance/unreadable-type-filter.test.ts › refuses a wildcard type, which names no one type, to every key`.

### `search-and-filters/lookup-unknown-type`

If a `POST /items/lookup` body names a well-formed `type` that nothing registers, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`, `compliance/unreadable-type-filter.test.ts › answers 403 where it used to answer an empty 200, and 400 for an unregistered type`.

## Pages

Every list and every search answers the same envelope. A hydrated block of edges is a page of the same shape (`edges/hydrate`), and so is an item's history (`versions/include-first-page`).

### `search-and-filters/page-envelope`

When a list or a search answers, the server MUST carry the rows under `data` and the cursor that continues them under `next_cursor`, `null` on the last page, and no other key but a sibling that the operation's own rule names.

**Reason:** a client reads every page from one shape, and the siblings are `occurrences/answer-keys` and the `min_copies` of `GET /blobs/stores`.

**Tests:** `compliance/envelope.test.ts › GET %s answers data and next_cursor`, `› names twenty-six doors, every one the document publishes as a page`.

### `search-and-filters/page-whole-set`

When a list takes no `cursor`, the server MUST answer its whole set with `next_cursor` `null`.

**Tests:** `compliance/envelope.test.ts › answers a null cursor from every door that takes none`.

### `search-and-filters/page-grants`

The server MUST answer `GET /auth/grants` in the envelope of a list, though the API document does not publish it.

**Tests:** `compliance/envelope.test.ts › answers GET /auth/grants, which the document does not publish, in the same envelope`.

### `search-and-filters/page-full-last`

When the rows of a page fill it exactly and it holds the last row, the server MUST answer `next_cursor` `null` on every operation that takes a cursor.

**Reason:** a walk then never ends on an empty page it was sent to. A page can still be short or empty with a cursor to follow, so a walk stops on `null` and never on a short page (`edges/read-list-short`).

**Tests:** `compliance/full-last-page.test.ts › %s answers null when the rows fill the page exactly`, `› covers every door that takes a cursor`.

## Export

`GET /export` admits the owner browser session or a credential and answers the items that caller may read and the edges between them, as NDJSON or as an archive that `POST /restore` reads. Management permissions alone grant no content access (`blobs/export-operator-refused`).

### `search-and-filters/export-lines`

When `GET /export` names no `format`, the server MUST answer NDJSON with one line per item, carrying the item and its metadata.

**Tests:** `compliance/export.test.ts › filters by type`, `› filters by state`, `› carries on each row only the extension namespaces the key may read, on both output formats`.

### `search-and-filters/export-edge-lines`

When `GET /export` answers items, the server MUST follow the item lines with a line for each edge between the exported items.

**Reason:** `edges/read-export` and `edges/read-export-ends` state which edges are left out.

**Tests:** `compliance/export.test.ts › carries an edge line behind the item lines it joins`.

### `search-and-filters/export-type-map`

When a credential requests an export, the server MUST leave out the items of every type that its type map may not read.

**Tests:** `compliance/export.test.ts › respects type permissions on a scoped key`.

### `search-and-filters/export-extensions`

When `GET /export` answers a credential with a row, the server MUST carry on it only the extension namespaces that credential may read, in both formats.

**Reason:** an archive written by a credential restores only the namespaces that credential may read. `keys-and-oauth/extension-map-only` states what a credential may read of an extension.

**Tests:** `compliance/export.test.ts › carries on each row only the extension namespaces the key may read, on both output formats`.

### `search-and-filters/export-format`

If `GET /export` names a `format` other than `ndjson` or `archive`, then the server MUST answer `400 validation_error`.

**Reason:** a format that the server does not offer must not be served as the default.

**Tests:** `compliance/export.test.ts › refuses a format outside the two it offers`.

### `search-and-filters/export-state-default`

When `GET /export` names no `state`, the server MUST carry the rows of every state but `trashed`.

**Reason:** the archive this operation writes is what a restore reads back, so a default that dropped archived rows would lose them on the round trip. The bin is the one thing a copy leaves behind.

**Tests:** `compliance/state-default.test.ts › an export that names no state carries archived rows`, `compliance/export.test.ts › carries archived rows and leaves out the bin when an archive names no state`.

### `search-and-filters/export-state-any`

When `GET /export` names `state=any`, the server MUST carry every row it holds, the bin included, in both formats.

**Tests:** `compliance/export.test.ts › carries every row it holds, the bin included, when it names state=any, on both formats`.

### `search-and-filters/export-state-trashed`

When `GET /export` names `state=trashed`, the server MUST carry only the rows in the bin, in both formats.

**Tests:** `compliance/export.test.ts › carries only the rows in the bin when it names state=trashed, on both formats`.

### `search-and-filters/archive-media-type`

When `GET /export` names `format=archive`, the server MUST answer a gzip archive with `Content-Type: application/gzip`.

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`.

### `search-and-filters/archive-same-selection`

When `GET /export?format=archive` names the filters of an NDJSON export, the server MUST select the rows that export selects.

**Tests:** `compliance/export.test.ts › carries every row it holds, the bin included, when it names state=any, on both formats`, `› carries only the rows in the bin when it names state=trashed, on both formats`, `› refuses a bound that is not an instant, on both output formats`.

### `search-and-filters/archive-entries`

The server MUST open an archive with its `manifest.json`, then `items.ndjson`, `edges.ndjson` and `types.ndjson`, and then a `blobs/<hash>` entry for each blob its manifest lists in `blobs`.

**Reason:** the manifest comes first, so a reader knows what the archive holds before it reads the rest.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `search-and-filters/archive-manifest`

The server MUST write into the manifest of an archive its `version`, its `format` of `marfa-archive-v0`, a `created_at` instant, and the counts of the items, edges, blobs, types and edge types the archive holds.

**Reason:** `instance/archive-version` and `instance/id-in-archive` state the version and the instance's name in the manifest.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `search-and-filters/archive-manifest-blobs`

The server MUST list in the manifest of an archive each blob it carries, with its MIME type and its size in bytes.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `search-and-filters/archive-missing-blobs`

When an archive would carry a blob of which no attached store holds a copy that the location log records, at the blob's whole size, the server MUST name the blob in the manifest's `missing_blobs` with its MIME type and its size in bytes.

**Reason:** one lost file costs the backup that file and not the rest of the instance, and the manifest, which a reader reads first, says which file the archive lacks. The bytes a struck or dropped copy leaves in its store are not the blob's (`stores/no-bytes-not-found`).

**Tests:** `compliance/export-missing-blob.test.ts › names a blob whose file has left the disk under missing_blobs, and carries the rest`, `› names a blob whose struck copy is the only one under missing_blobs, and answers a whole archive`.

### `search-and-filters/archive-missing-unrecorded`

When an item that `GET /export?format=archive` carries is of `core.file` or a type that inherits from it, in its current version or a snapshot the archive carries, and its `blob_ref` is a whole `sha256:` hash that the instance holds no blob of and that the caller may read, the server MUST name the hash in the manifest's `missing_blobs` with a `mime_type` and a `size_bytes` of `null`.

**Reason:** a blob that a restore answered missing keeps being named by every later backup, with no record of it standing in for bytes the instance does not hold. Its type and size are not known, so they are not given.

**Tests:** `compliance/export-missing-blob.test.ts › names in a later archive's missing_blobs a file's blob that a restore answered missing`.

### `search-and-filters/archive-missing-only-blobs`

The server MUST NOT name in the manifest's `missing_blobs` a hash that the instance holds no blob of and that no carried file's `blob_ref` names.

**Reason:** a run of hex in a row's text, or in any other property, may be anything, such as a checksum someone noted down. Only the instance's own record, or a file's `blob_ref`, makes it a blob.

**Tests:** `compliance/export-missing-blob.test.ts › names in a later archive's missing_blobs a file's blob that a restore answered missing`.

### `search-and-filters/archive-missing-not-carried`

When the manifest of an archive names a blob in `missing_blobs`, the server MUST NOT list the blob in `blobs`, count it in `blob_count` or carry a `blobs/<hash>` entry for it.

**Tests:** `compliance/export-missing-blob.test.ts › names a blob whose file has left the disk under missing_blobs, and carries the rest`.

### `search-and-filters/archive-blob-any-store`

When one attached store's recorded copy of a blob that an archive carries is missing or not as long as the blob, and another attached store holds a recorded copy whole, the server MUST carry the blob's bytes from that other store.

**Tests:** `compliance/export-missing-blob.test.ts › carries a blob whose disk file is gone from the object store's copy`.

### `search-and-filters/archive-bytes-verified`

If the bytes `GET /export?format=archive` reads for a blob do not hash to the blob's name, then the server MUST end the response with an error and not with a clean end.

**Reason:** the manifest that lists the blob has already been sent, so the archive is cut short rather than carrying other bytes under the blob's name. The bytes are checked as they are sent rather than before, because checking first would read every blob twice on every export.

**Tests:** `compliance/export-missing-blob.test.ts › ends the response with an error when a copy's bytes do not hash to the blob's name, and strikes the copy`.

### `search-and-filters/archive-bytes-struck`

If the bytes `GET /export?format=archive` reads from a store's copy of a blob are as long as the blob and do not hash to its name, and the copy still does not hash to the name when it is read again under the blob's upload lock, then the server MUST strike that copy from the location log.

**Reason:** the next export then reads the blob from another store that holds it, or names it in `missing_blobs`, as it does once `blob-integrity` has struck the copy. The first read is made without the lock, so the copy is read again before it is struck, in case it was put right in between.

**Tests:** `compliance/export-missing-blob.test.ts › ends the response with an error when a copy's bytes do not hash to the blob's name, and strikes the copy`.

### `search-and-filters/archive-read-fault-kept`

If a read of a blob's copy by `GET /export?format=archive` fails or ends before the blob's size, then the server MUST NOT strike the copy for it.

**Reason:** a read that goes wrong says nothing of the bytes the store holds.

**Tests:** `compliance/export-missing-blob.test.ts › strikes no copy when a read of a blob's bytes fails`, `› strikes no copy when a read of a blob's bytes ends short`.

### `search-and-filters/archive-blob-gone`

If a blob that the manifest of `GET /export?format=archive` lists in `blobs` has no record, or no recorded copy that a store holds whole, when its entry is due, then the server MUST end the response with an error and not with a clean end.

**Reason:** the manifest that lists the blob has already been sent, so an archive that left the entry out would claim a file it does not hold.

**Tests:** `compliance/export-missing-blob.test.ts › ends the response with an error when a listed blob's file goes before its entry is written`.

### `search-and-filters/archive-store-unavailable`

If a store fails, or does not answer within 15 seconds, while the server checks a copy of a blob that `GET /export?format=archive` would carry, and no other attached store holds a recorded copy of the blob whole, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** a store that cannot answer is no evidence that the copy is gone, so the blob is not named in `missing_blobs`. A copy that another store holds whole is carried from there. The checks are made before the response begins, so the refusal is an ordinary answer and not a stream cut short.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`.

### `search-and-filters/archive-only`

The server MUST hold nothing in an archive but `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` and the `blobs/` entries.

**Reason:** an archive carries no keys, no webhooks, no configuration and no tombstones, though an instance holds them.

**Tests:** `compliance/export.test.ts › holds nothing in an archive but its manifest, items, edges, types and blobs`.

### `search-and-filters/archive-types`

The server MUST carry in the types of an archive every type and edge type registered on the instance beside the ones the build ships, whatever the selection and whatever the credential may read.

**Reason:** the registrations are the instance's own and not the selected rows', so a restore into a new instance gets the types its rows need.

**Tests:** `compliance/export.test.ts › carries every registered type and edge type in an archive, whatever its selection and credential reach`.

### `search-and-filters/archive-history`

When `GET /export?format=archive` carries an item, the server MUST carry with it every stored snapshot below the item's current version that `search-and-filters/archive-history-reach` admits, however many pages of history they fill.

**Reason:** one page of history is not complete history.

**Tests:** `compliance/archive-history.test.ts › carries every stored snapshot below an item's version, across more than one page of history`.

### `search-and-filters/archive-history-reach`

When an archive requested by a credential carries a snapshot, the server MUST carry it only if that credential may read the type that snapshot had.

**Reason:** a current grant on a type does not grant access to an item's earlier type.

**Tests:** `compliance/archive-history.test.ts › carries only the snapshots the exporting key may read under the type each had`.

### `search-and-filters/archive-history-bytes`

When a snapshot in an archive requested by a credential names a blob, the server MUST carry the blob's bytes if and only if that credential could read the blob through the blob operations.

**Reason:** a historical reference keeps bytes from orphan collection but does not grant read permission (`blobs/lend-earlier-version`).

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and no others`.

### `search-and-filters/archive-selection-read`

The server MUST count in the manifest of an archive exactly the items and edges its line files hold, whatever is written after the response headers arrive.

**Reason:** the selection is read before the headers are sent, because a tar header carries each entry's size, so a write after them can change neither the line files nor the counts.

**Tests:** `compliance/export.test.ts › counts every row the archive holds in its manifest when the headers arrive`.

### `search-and-filters/archive-row-as-read`

When a row is written after the headers of `GET /export?format=archive` have arrived, the server MUST carry the row as it stood before that write.

**Reason:** the archive's selection is fixed before its headers arrive.

**Tests:** `compliance/export.test.ts › carries a row as it stood when the export read it, whatever is written to it after the headers`.

### `search-and-filters/archive-no-later-item`

When an item is created after the headers of `GET /export?format=archive` have arrived, the server MUST NOT carry it.

**Tests:** `compliance/export.test.ts › does not carry an item created after the headers arrived`.

### `search-and-filters/archive-edge-before`

When an edge between two carried items exists before `GET /export?format=archive` begins and remains present throughout its selection read, the server MUST carry the edge.

**Tests:** `compliance/export.test.ts › carries an edge created before the export began, and not one created after its headers arrived`.

### `search-and-filters/archive-no-later-edge`

When an edge is created after the headers of `GET /export?format=archive` have arrived, the server MUST NOT carry it.

**Tests:** `compliance/export.test.ts › carries an edge created before the export began, and not one created after its headers arrived`.

### `search-and-filters/archive-restorable`

When `GET /export?format=archive` returns a complete archive, the server MUST ensure that the archive passes `POST /restore` validation into an empty store running the same build with the exporting instance's `MARFA_MAX_BULK_REQUEST_BYTES`, without skipping any carried item or edge.

**Reason:** pages can observe different committed states, and `schema.write` permits replacements that leave an earlier row that a restore refuses, such as a type that becomes an event while a row holds a rule no calendar read can unfold (`types/evolve-schema-write`). The setting is the exporting instance's because the archive is that instance's backup, restored into it under the same setting: a judgment against the default would refuse a row that the instance's write operations accepted, or pass a row that its restore refuses. The guarantee excludes destination conflicts and other settings of the destination; missing blobs retain their declared missing status.

**Tests:** `compliance/export-write-order.test.ts › restores an archive after writes land between its item pages`, `› restores a custom type retyped away and deleted between archive pages`.

### `search-and-filters/archive-rows-shape-free`

When `GET /export?format=archive` selects an item that is not of a `core` or `system` type that this build ships, the server MUST NOT refuse the export because the item lacks a field its type requires, holds a value its type's field does not accept, or is of a type that is not registered.

**Reason:** the export checks the selection with the restore's checks (`search-and-filters/archive-restorable`), and a restore takes such an item (`search-and-filters/restore-rows-shape-free`, `search-and-filters/restore-rows-orphan`). A type gains a required field while its rows stand (`types/field-gained`), and a forced delete leaves the rows of a type (`types/delete-force`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-rows-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`, `› restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`, `› restores an item of a platform type that this build no longer ships as an orphan`.

### `search-and-filters/archive-validation-retry`

If an archive selection fails restore validation, then the server MUST restart `GET /export?format=archive` from the beginning once before sending archive bytes.

**Reason:** a write between pages can make their combined state invalid even when each page was valid when read.

**Tests:** `compliance/export-write-order.test.ts › retries an incompatible selection from the beginning and restores every item after repair`.

### `search-and-filters/archive-validation-refused`

If both archive selections fail restore validation and the second selection refuses a different row than the first, or refuses the same row after that row, or the registration of its type, changed between the two reads, then the server MUST answer `503 export_unrestorable` without sending archive bytes.

**Reason:** a row that changed between the reads, or a different row refused, shows that writes were landing on what failed, and a later retry can read it after the writes have finished. Returning an invalid archive would claim a backup the restore cannot read.

**Tests:** `compliance/export-write-order.test.ts › refuses with export_unrestorable when the refused row's type is registered again between the reads`.

### `search-and-filters/archive-rows-refused`

If both archive selections fail restore validation on the same row, with the same `kind`, `id`, `type`, `field` and `code`, and that row's own archived line and the registration of its type are the same in both reads, then the server MUST answer `409 export_rows_unrestorable` without sending archive bytes, with `details.row` naming that row's `kind`, `id`, `type` and `field` and the `code` that restore refuses it with or the reason restore skips it for.

**Reason:** writes to other rows between the reads do not change the answer, because the failure is in the instance's own data, such as a row that a type's replacement schema no longer accepts, so a retry reads the same row and fails again. On an instance that is written to all the time, a test that also required every other row to be unchanged would turn a lasting bad row into a retry that never ends and never names the row. Only a change to the row or its registration lets the export pass, and the owner needs the row named to make it.

**Tests:** `compliance/export-rows-refused.test.ts › answers 409 naming the row, and exports once the row is corrected`.

### `search-and-filters/archive-spool-ended`

When a `GET /export?format=archive` response ends, whether the archive was read whole or the client left, the server MUST leave nothing of the export on disk.

**Reason:** the export keeps what it has read in the `tmp` folder of the disk store, and a copy of the instance's content that nobody will read must not stay there.

**Tests:** `compliance/export-spool.test.ts › leaves nothing in the spool once the whole archive has been read`, `› leaves nothing in the spool once the client has left`.

### `search-and-filters/archive-spool-fault`

If selection, validation or streaming fails during `GET /export?format=archive`, then the server MUST leave nothing of the export on disk.

**Tests:** `compliance/export-faults.test.ts › is answered with an error, not an archive, and leaves nothing of the export on disk`, `compliance/export-write-order.test.ts › refuses with export_unrestorable when the refused row's type is registered again between the reads`.

### `search-and-filters/archive-spool-start`

When the process starts, the server MUST remove whatever an export that a stopped process was writing left on disk.

**Reason:** a process that is stopped during an export cannot remove its own copy.

**Tests:** `compliance/export-spool.test.ts › keeps the spool of an export a stopped process was writing until the next start, and then clears it`.

### `search-and-filters/archive-failed-read`

If a read fails after the body of `GET /export?format=archive` has begun, then the server MUST end the response with an error and not with a clean end.

**Reason:** the status and headers are sent before the first byte, so the failure shows only as a connection cut short and a gzip stream with no end, which is an archive that nobody mistakes for a complete one.

**Tests:** `compliance/export-faults.test.ts › ends the response with an error, so the archive is cut short and cannot be taken for a whole one, and leaves nothing on disk`.

### `search-and-filters/export-credential-ended`

When the key or signed-in app that a `GET /export` request was admitted on is revoked, passes its expiry or is disconnected while the response is open, the server MUST end the response with an error and not with a clean end, in both formats and while an archive sends a blob.

**Reason:** what a key holds open ends with it (`keys-and-oauth/revoke-immediate`), and a response that ended cleanly after its credential ended would read as a whole copy.

**Tests:** `compliance/export-credential.test.ts › ends with an error when its key is revoked`, `› ends with an error when its key passes its expiry`, `› ends with an error when the app that opened it is disconnected`, `› ends with an error when its key is revoked while a blob is being sent`.

### `search-and-filters/export-credential-narrowed`

If the credential that a `GET /export` request was admitted on is narrowed while the response is open, so that it no longer reads something the export has still to send, then the server MUST end the response with an error and not with a clean end, in both formats.

**Reason:** an export that left out what the credential can no longer read would be a copy that is incomplete without saying so, and an archive has already promised its rows and blobs in its manifest.

**Tests:** `compliance/export-credential.test.ts › ends with an error when its key is narrowed to types the export does not carry`.

### `search-and-filters/export-narrowed-reaches`

When the credential that a `GET /export` request was admitted on is narrowed while the response is open, and it still reads everything the export has still to send, the server MUST send the rest of the export, in both formats.

**Reason:** a narrowing that takes away nothing the export has still to send changes nothing the export has promised.

**Tests:** `compliance/export-credential.test.ts › arrives whole when its credential stands, which is the witness for the cases below`, `› arrives whole when its key is narrowed to what the export still carries`.

### `search-and-filters/archive-selection-key`

If the key that a `GET /export?format=archive` request was admitted on is revoked before the response begins, then the server MUST answer `401 unauthorized` without sending archive bytes.

**Reason:** the export reads and checks the whole selection before its first byte, and the answer is the one the next request on the key gets.

**Tests:** `compliance/export-credential.test.ts › is refused 401 when its key is revoked while the selection is read`.

## Restore

`POST /restore` takes an archive that `GET /export?format=archive` wrote, with direct owner or local authority, and answers counts of what it wrote and skipped.

### `search-and-filters/restore-operator`

If a working key sends `POST /restore`, then the server MUST answer `403 forbidden`.

**Reason:** full restoration can write server-managed records, so ordinary app and key permissions cannot authorize it.

**Tests:** `compliance/restore-archive.test.ts › requires direct owner authority`.

### `search-and-filters/restore-roundtrip`

When direct owner or local authority sends `POST /restore` with an archive that `GET /export?format=archive` wrote, the server MUST answer `200` with the counts of what it restored.

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`.

### `search-and-filters/restore-counts`

When `POST /restore` succeeds, the server MUST carry the counts `imported`, `duplicates`, `edges_imported`, `edges_skipped`, `edges_skipped_reasons`, `blobs_imported`, `types_registered`, `types_skipped`, `edge_types_registered` and `edge_types_skipped`, each for the kind of thing it counts.

**Tests:** `compliance/restore-archive.test.ts › answers ten counts, each for the kind of thing it counts, on the first restore and on a repeat`.

### `search-and-filters/restore-blobs-missing`

When `POST /restore` succeeds, the server MUST answer in `blobs_missing` the hash of each blob that the archive's manifest names in `blobs` or `missing_blobs`, that no entry of the archive carries bytes hashing to, and that no attached store of the instance holds a recorded copy of whole.

**Reason:** an archive that lacks a file says so on the restore rather than restoring as though it were complete. Uploading the bytes again through `POST /blobs` restores the file.

**Tests:** `compliance/export-missing-blob.test.ts › answers in blobs_missing a blob the archive names and lacks, and none the instance holds`, `› answers in blobs_missing a blob the manifest lists that the archive carries no bytes for`.

### `search-and-filters/restore-store-unavailable`

If a store fails, or does not answer within 15 seconds, while `POST /restore` checks whether the instance holds a blob that the archive names and does not carry, and no other attached store holds a recorded copy of the blob whole, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** a store that cannot answer is no evidence that the instance lacks the blob, so the restore does not answer it in `blobs_missing`.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`, `› restores an archive lacking a blob that the object store holds whole while the disk cannot be read for it`.

### `search-and-filters/restore-store-unavailable-unwritten`

When `POST /restore` answers `503 blob_store_unavailable`, the server MUST NOT write any item, type registration or blob of the archive.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`.

### `search-and-filters/cli-export-lacking`

When `marfa export --format archive` has received an archive whose manifest names blobs in `missing_blobs`, the CLI MUST exit 1 with `blobs_missing`, naming up to ten of the blobs and counting the rest.

**Reason:** the exit says the archive is not a whole backup.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps the archive where it is, and still names the blobs, when the incomplete name cannot be taken`.

### `search-and-filters/cli-export-lacking-kept`

When `marfa export --format archive --output <path>` has received an archive whose manifest names blobs in `missing_blobs`, if `<path>.incomplete` can be replaced, then the CLI MUST keep the whole archive at `<path>.incomplete`, replacing only an earlier file of that name.

**Reason:** the archive holds everything else, and may hold the only copy of a file the server has since lost, so it is kept where the person can get it back and is named as incomplete.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `search-and-filters/cli-export-lacking-refused`

When `marfa export --format archive --output <path>` has received an archive whose manifest names blobs in `missing_blobs`, if `<path>.incomplete` cannot be replaced, then the CLI MUST keep the whole archive in a hidden partial file beside `<path>`.

**Reason:** the bytes are kept where the person can get them back, and the exit, the `blobs_missing` code and the hashes of `search-and-filters/cli-export-lacking` still reach the person.

**Tests:** `cli/archive-blobs.test.ts › keeps the archive where it is, and still names the blobs, when the incomplete name cannot be taken`.

### `search-and-filters/cli-export-refused-named`

When `marfa export --format archive --output <path>` has kept an archive that lacks blobs in a hidden partial file because `<path>.incomplete` cannot be replaced, the CLI MUST name that file and the reason in its message.

**Reason:** the person learns from the message alone where the archive is and why it is not at the incomplete name.

**Tests:** `cli/archive-blobs.test.ts › keeps the archive where it is, and still names the blobs, when the incomplete name cannot be taken`.

### `search-and-filters/cli-export-lacking-path`

When `marfa export --format archive --output <path>` has received an archive whose manifest names blobs in `missing_blobs`, the CLI MUST NOT write to `<path>`.

**Reason:** a file at the path is the last complete backup when the command is run on a schedule, and a script that reads the path must never get an archive that lacks files. An earlier file stays byte for byte, and where none was, none is made.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `search-and-filters/cli-export-lacking-named`

When `marfa export --format archive --output <path>` has kept an archive that lacks blobs at `<path>.incomplete`, the CLI MUST name `<path>` and `<path>.incomplete` in its message.

**Reason:** the person learns from the message alone where the incomplete archive is.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `search-and-filters/cli-export-lacking-path-state`

When `marfa export --format archive --output <path>` has received an archive whose manifest names blobs in `missing_blobs`, the CLI MUST say in its message whether `<path>` still holds an earlier file or was not written.

**Reason:** the person learns that the path was left alone, and whether a backup is still there.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `search-and-filters/cli-export-whole`

When `marfa export --output <path>` receives an export that ends whole and, for an archive, has a readable manifest that names no blobs in `missing_blobs`, the CLI MUST replace `<path>` with it.

**Reason:** the earlier backup is replaced only by one that is at least as complete.

**Tests:** `cli/archive-blobs.test.ts › replaces the path with a whole archive and leaves no other file`.

### `search-and-filters/cli-export-whole-clean`

When `marfa export --output <path>` replaces `<path>`, the CLI MUST leave no partial file beside it.

**Reason:** a file left behind would be mistaken by a later run, or a person, for a backup. An older `<path>.incomplete` is not a partial file of this run, and is left as it was.

**Tests:** `cli/archive-blobs.test.ts › replaces the path with a whole archive and leaves no other file`.

### `search-and-filters/cli-restore-lacking`

When `POST /restore` answers `marfa restore` with hashes in `blobs_missing`, the CLI MUST print the answer and exit 1 with `blobs_missing`, naming up to ten of the blobs and counting the rest.

**Tests:** `cli/archive-blobs.test.ts › prints the answer of a restore of it and exits 1 with blobs_missing`.

### `search-and-filters/cli-export-cut`

If the stream of `marfa export --output <path>` ends early, then the CLI MUST leave the path as it was before the command and exit 3.

**Reason:** a file cut short at the path would pass for a backup until a restore needed it.

**Tests:** `cli/archive-blobs.test.ts › leaves the path as it was when the export is cut short, and the next export names the struck blob`.

### `search-and-filters/cli-export-cut-clean`

If the stream of `marfa export --output <path>` ends early, then the CLI MUST leave no partial file beside the path.

**Reason:** a file cut short, kept anywhere the person looks for backups, would pass for one. Only a process killed outright leaves its partial file, which no code can prevent.

**Tests:** `cli/archive-blobs.test.ts › leaves the path as it was when the export is cut short, and the next export names the struck blob`.

### `search-and-filters/restore-edge-skips`

When `POST /restore` skips an edge, the server MUST count it in `edges_skipped_reasons` under exactly one of these reasons: `already_present` when the instance already holds the edge, `endpoint_missing` when, once the archive's items are written, the instance holds no item under an endpoint's id, in the bin or out of it, `malformed` when the line does not give both endpoints and the edge type as strings, and otherwise the error code that `POST /edges` would answer for the edge.

**Reason:** a restore judges each edge as `POST /edges` does, except where `search-and-filters/restore-edges-bin` and `edges/properties-restore-kept` say otherwise and for an `in-folder` edge to a revoked folder, which it keeps as the folder kept it (`edges/folder-revoked-keeps`). It skips an edge it refuses rather than refusing the archive.

**Tests:** `compliance/restore-archive.test.ts › answers ten counts, each for the kind of thing it counts, on the first restore and on a repeat`, `› counts an edge that POST /edges would refuse under the code of its refusal`, `compliance/archive-scalars.test.ts › refuses an invalid edge version even when its endpoint is missing`.

### `search-and-filters/restore-items-kept`

When `POST /restore` writes an item, the server MUST keep its id, its tags and its extensions.

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`.

### `search-and-filters/restore-edges-kept`

When `POST /restore` writes the edges between restored items, the server MUST keep them in both directions.

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs edges between restored items, in both directions`.

### `search-and-filters/restore-edges-bin`

When `POST /restore` reads an edge whose endpoint is an item in the bin, the server MUST NOT skip the edge for that endpoint.

**Reason:** an export that names `state=any` carries the bin (`search-and-filters/export-state-any`), and an edge stays while its item is in the bin (`edges/list-bin`), and for someone moving to a new instance the archive is the only copy of that edge. `POST /edges` still refuses a new edge to an item in the bin (`edges/create-end-in-bin`).

**Tests:** `compliance/export-roundtrip.test.ts › reconstructs the edges of an item in the bin, in both directions`.

### `search-and-filters/restore-duplicate`

When an archived item holds an id or a natural key that a row on the instance already holds, or a link that a row of its type already holds, the server MUST count it in `duplicates`.

**Reason:** a link is one row's within its type (`items/link-taken`).

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `› answers ten counts, each for the kind of thing it counts, on the first restore and on a repeat`, `compliance/links.test.ts › counts an archived row whose link another row holds as a duplicate`.

### `search-and-filters/restore-duplicate-kept`

When `POST /restore` counts an archived item as a duplicate, the server MUST leave the existing item's row, tags, extensions and history as they are.

**Reason:** replaying a backup must not overwrite work made since the backup.

**Tests:** `compliance/archive-history.test.ts › leaves an existing row, its tags, its extensions and its history alone when the archive's copy is a duplicate`.

### `search-and-filters/restore-link-held`

If an archive registers a type with a `link_field` in which two rows that a forced delete left share a value, then the server MUST answer `409 link_taken`.

**Reason:** a type that an archive registers is held to its `link_field` as `POST /types` holds one (`types/link-gained`).

**Tests:** `compliance/links.test.ts › stops a restore registering a link the rows a forced delete left share`.

### `search-and-filters/restore-compatible-types`

When an otherwise valid archive carries a set of registrations accepted through the server's registration and replacement routes, the server MUST restore those registrations into an empty store regardless of their order in the archive.

**Reason:** an exported backup remains restorable when its registrations refer to each other, including mutual compatibility declarations and display hints, links, and merge policies that name inherited fields.

**Tests:** `compliance/restore-compatible-types.test.ts › round-trips accepted registrations into an empty store (reversed: %s)`, `› refuses a target change that breaks a reader and restores the accepted registry`.

### `search-and-filters/restore-type-conflict`

If an archive registers a type or an edge type that the instance holds differently, then the server MUST answer `409 conflict` naming each in `details.conflicting_ids`.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that registers a type or an edge type this instance holds differently, naming each, and writes nothing`.

### `search-and-filters/restore-core-edge-type`

If an archive carries a core edge type, then the server MUST answer `409 conflict`.

**Tests:** `compliance/declared-refusals.test.ts › cannot be deleted, and cannot be redefined by an archive`.

### `search-and-filters/restore-type-unknown-key`

If an archive registers a type with a key `types/unknown-key` refuses, or an edge type with a key `edges/types-register-unknown-key` refuses, then the server MUST answer `400 invalid_schema` with `details.errors` naming the path of each such key.

**Reason:** an archive is held to what the registration doors take, so a registration they would refuse cannot come in by restore.

**Tests:** `compliance/restore-archive.test.ts › refuses a type and an edge type that carry one, naming its path, and restores the same archive without it`.

### `search-and-filters/restore-nothing`

When `POST /restore` takes an archive that carries no row, the server MUST answer `200` with `imported` of 0.

**Reason:** an archive of nothing is not an empty body, and its members are present and empty, which `search-and-filters/restore-members` tells from missing.

**Tests:** `compliance/restore-archive.test.ts › refuses an empty body, and takes an archive of nothing`.

### `search-and-filters/restore-empty-body`

If the body of `POST /restore` is empty, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/restore-archive.test.ts › refuses an empty body, and takes an archive of nothing`.

### `search-and-filters/restore-members`

If an archive lacks `manifest.json`, `items.ndjson`, `edges.ndjson` or `types.ndjson`, then the server MUST answer `400 validation_error` naming each missing entry in the message and in `details.entries`.

**Reason:** an export writes all four even when it holds no row (`search-and-filters/archive-entries`), so a missing entry is a damaged archive or a file that is no archive, and an archive of nothing is told from it by its entries being empty (`search-and-filters/restore-nothing`). Without the check a restore answers `200` with counts of zero for a file it never read.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive without %s, naming it, and writes nothing`, `› refuses a gzip-compressed tar that is no archive, naming every member it lacks`.

### `search-and-filters/restore-not-archive`

If the body of `POST /restore` is not a gzip-compressed tar, or its compressed stream breaks partway, then the server MUST answer `400 validation_error`.

**Reason:** a damaged backup is an ordinary input and not a fault in the server.

**Tests:** `compliance/restore-archive.test.ts › refuses a body that is not a gzip-compressed tar, or whose compressed stream breaks partway, and goes on serving`.

### `search-and-filters/restore-keeps-serving`

When the server refuses a body of `POST /restore` that it cannot read, the server MUST go on answering other requests.

**Reason:** the process is every client's server, and a file that one operator sends must not stop it.

**Tests:** `compliance/restore-archive.test.ts › refuses a body that is not a gzip-compressed tar, or whose compressed stream breaks partway, and goes on serving`.

### `search-and-filters/restore-version`

If the `manifest.json` of an archive names a `version` other than 0, then the server MUST answer `400 validation_error` with a message saying that the archive is read only by the build that wrote it.

**Reason:** a version of 0 promises nothing between builds, so what a restore into another build does with an archive is outside the contract. Nothing is stated about archives after the first public release.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive at another format version, saying it is read only by the build that wrote it`.

### `search-and-filters/restore-manifest`

If the `manifest.json` of an archive is missing `version`, or `blobs`, or mistypes them, `missing_blobs`, an entry of `blobs`, which holds a string `mime_type` and a non-negative integer `size_bytes`, or an entry of `missing_blobs`, which holds the same or `null` for either, then the server MUST answer `400 validation_error` naming each field in the message and in `details.errors` as a dotted `path`.

**Reason:** another version is free to lay its fields out differently, so a manifest naming one is refused for its version and not its shape.

**Tests:** `compliance/restore-archive.test.ts › refuses a manifest missing or mistyping a field the restore reads, naming the field, and writes nothing`.

### `search-and-filters/restore-state`

If an archive records a row in a state that its type's lifecycle cannot produce, such as `revoked` for a canonical type, `trashed` for a `system.*` type or a value that is no state, then the server MUST answer `400 validation_error` naming the row.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

### `search-and-filters/restore-state-kept`

When `POST /restore` takes a canonical row in a state that its lifecycle contains, the server MUST write the row in the state recorded.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

### `search-and-filters/restore-source`

When restoring an item whose `source`, after trimming whitespace and ignoring case, starts with `oauth:`, the server MUST store `restored:` followed by the exact archived source.

**Reason:** An archive carries history but no app credentials. A restored source cannot belong to a credential (`keys-and-oauth/claims-reserved`), so a later app sign-in cannot overwrite the archived item's natural key.

**Tests:** `compliance/restore-archive.test.ts › rewrites app sources exactly and accepts previously restored sources`, `compliance/version-writers.test.ts › restores app-written items twice with their writers and separate natural keys`.

### `search-and-filters/restore-source-again`

When restoring an item whose `source` starts with `restored:`, the server MUST preserve that source unchanged.

**Tests:** `compliance/restore-archive.test.ts › rewrites app sources exactly and accepts previously restored sources`, `compliance/version-writers.test.ts › restores app-written items twice with their writers and separate natural keys`.

### `search-and-filters/restore-app-connection`

When restoring a `system.connection` item whose `kind` property is `app`, the server MUST set its current `status` property to `revoked`.

**Reason:** A restored app connection records past access, not a live grant. Its other fields and archived version writers remain part of that history (`versions/writer-restore`).

**Tests:** `compliance/version-writers.test.ts › marks restored app connections inactive without changing their recorded fields`.

### `search-and-filters/restore-scalars`

If an archive records a `version` of an item or an edge that is not a positive safe integer, or a `tier` of an item that is not `library` or `feed`, then the server MUST answer `400 validation_error` naming the row and the field.

**Tests:** `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`.

### `search-and-filters/restore-text`

If the `manifest.json` of an archive, or a line the restore reads as an item, an edge or a registration in its `items.ndjson`, `edges.ndjson` or `types.ndjson`, holds a string or an object key that is not well-formed UTF-16, then the server MUST answer `400 validation_error` naming the entry or the row and the JSON pointer of the text, and write nothing.

**Reason:** a restore is not a way to plant text the write doors refuse (`items/json-text-well-formed`).

**Tests:** `compliance/well-formed-text.test.ts › refuses a %s that is not well-formed UTF-16, naming the row and where, and takes a pair there`.

### `search-and-filters/restore-scalars-held`

When an archive records an invalid `version` or `tier` for a row that the instance already holds, or for an edge whose endpoint is missing, the server MUST still refuse the archive.

**Tests:** `compliance/archive-scalars.test.ts › refuses invalid %s even when the row already exists`, `› refuses an invalid edge version even when its endpoint is missing`.

### `search-and-filters/restore-scalars-kept`

When `POST /restore` writes an item or an edge, the server MUST keep the `version` and the item's `tier` that the archive records, and write `1` and `library` where it records none.

**Reason:** zero can be a write precondition but is never a stored version (`versions/create-claim-none`), and resetting a version can make an old write precondition match unrelated content.

**Tests:** `compliance/archive-scalars.test.ts › restores $name without changing their meaning`.

### `search-and-filters/restore-dates`

If an archive records a `created_at` or `updated_at` of an item or an edge that is not an instant, then the server MUST answer `400 validation_error` naming the row and the field.

**Tests:** `compliance/archive-history.test.ts › refuses a row whose %s is malformed, and writes the row ahead of it nowhere`, `› refuses an edge whose date is malformed even when an endpoint is missing`.

### `search-and-filters/restore-dates-utc`

When `POST /restore` writes a row, the server MUST write its `created_at` and `updated_at` as the instants they name, in UTC to the millisecond.

**Reason:** canonical UTC values remain comparable with the filters and cursors of a listing.

**Tests:** `compliance/archive-history.test.ts › writes a row's dates in UTC to the millisecond and keeps a snapshot's dates as the archive spelled them`.

### `search-and-filters/restore-history-shape`

If an archive records history that is not an array of snapshots, each an object with a valid snapshot ID, the item's own ID, object properties, a type identifier, a `library` or `feed` tier, `created_at` and `occurred_at` instants, and a `source_id` that is a string or null, then the server MUST answer `400 validation_error` naming the row and the field.

**Tests:** `compliance/archive-history.test.ts › refuses a row whose %s is malformed, and writes the row ahead of it nowhere`.

### `search-and-filters/restore-history-version`

If an archive records a snapshot whose `version` is not a positive safe integer below the item's version, or repeats one of the same item's history, then the server MUST answer `400 validation_error` naming the row and the field.

**Tests:** `compliance/archive-history.test.ts › refuses a row whose %s is malformed, and writes the row ahead of it nowhere`.

### `search-and-filters/restore-history-id`

If an archive records a snapshot ID that repeats another snapshot's of the archive, the same item's or another's, then the server MUST answer `400 validation_error` naming the row and the field.

**Tests:** `compliance/archive-history.test.ts › refuses a row whose %s is malformed, and writes the row ahead of it nowhere`.

### `search-and-filters/restore-malformed-held`

When an archive records a malformed date or history for a row that the instance already holds, the server MUST still refuse the archive.

**Tests:** `compliance/archive-history.test.ts › refuses a malformed date or history even when the row is one the instance already holds`.

### `search-and-filters/restore-history-exact`

When `POST /restore` writes an item's history, the server MUST keep each snapshot's `id`, `item_id`, `version`, `properties`, `type`, `tier`, `occurred_at`, `source_id` and `created_at` exactly, and its dates as the archive spelled them.

**Tests:** `compliance/archive-history.test.ts › restores each snapshot field for field into an instance that has never seen the item`, `› writes a row's dates in UTC to the millisecond and keeps a snapshot's dates as the archive spelled them`.

### `search-and-filters/restore-history-shape-free`

The server MUST NOT hold a restored snapshot's properties to the current shape of its type.

**Reason:** changing a type's schema does not rewrite the past.

**Tests:** `compliance/archive-history.test.ts › restores a snapshot the type's current shape would refuse, as it was`.

### `search-and-filters/restore-rows-shape-free`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships, the server MUST NOT refuse it because its properties lack a field its type requires or hold a value its type's field does not accept.

**Reason:** a type gains a required field while its rows stand (`types/field-gained`), so an archive that an export wrote can hold a row that its type no longer accepts, and an export that the same build cannot restore is not a usable backup (`search-and-filters/restore-no-count-limit`). The current rows are held to the shape they had as a snapshot's properties are (`search-and-filters/restore-history-shape-free`). A `core` or `system` type that this build ships is read by the server's own code and cannot be deleted or replaced, so its rows keep to it. An instance can also hold items of a platform type this build no longer ships (`GET /platform-types/drift`); a restore takes those as archived, as it takes an item of any type that is not one the build ships, whether or not the instance still carries the type's row (`search-and-filters/restore-rows-orphan`). A property that no type declares is still refused where strict mode names the type (`search-and-filters/restore-strict`), and an event's schedule is still judged (`occurrences/schedule-unreadable`).

**Tests:** `compliance/restore-rows-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `search-and-filters/restore-rows-properties-kept`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships, the server MUST store its properties as the archive holds them.

**Reason:** the properties are the person's own, and a restore that rewrote them to a shape the type has now would change the backup it restores.

**Tests:** `compliance/restore-rows-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`, `› restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `search-and-filters/restore-schema-version-kept`

When `POST /restore` writes an item, the server MUST store the `schema_version` that the archive records for it.

**Reason:** `schema_version` is the `version` the item's type had when the item was created, and Marfa never changes it. Stamping the type's present version on a row written under an earlier one would say the row has a field it lacks.

**Tests:** `compliance/restore-rows-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `search-and-filters/restore-rows-orphan`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships and whose type is not registered once the archive's own types are, the server MUST store the item under that type.

**Reason:** a forced delete removes a type and keeps its items (`types/delete-force`), and an export carries them without the type. The item is restored as such a row stands: its properties, tier, time and natural key refuse a write until a type is registered (`types/orphan-write`), and it is read, listed and searched (`types/orphan-read`) and has its tags, extensions and lifecycle state written (`types/orphan-kept-writable`) as it was. A type registered again holds its later writes (`types/orphan-reregistered`).

**Tests:** `compliance/restore-rows-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`, `› restores an item of a platform type that this build no longer ships as an orphan`.

### `search-and-filters/restore-item-type`

If an archived item's `type` is missing or is not a type identifier, then the server MUST answer `400 validation_error` naming the item's ID in the message.

**Reason:** a forced delete leaves an item under an identifier a type was registered with (`search-and-filters/restore-rows-orphan`), so an identifier that none could have been is an archive that no instance wrote.

**Tests:** `compliance/restore-archive.test.ts › refuses an item whose type is no identifier or whose properties are no object, and writes nothing`.

### `search-and-filters/restore-item-properties`

If an archived item's `properties` are present and are not an object, then the server MUST answer `400 invalid_properties` naming the item's ID in the message.

**Reason:** a restore that took them would store a row whose properties no read can return as an object.

**Tests:** `compliance/restore-archive.test.ts › refuses an item whose type is no identifier or whose properties are no object, and writes nothing`.

### `search-and-filters/restore-snapshot-held`

If an archive records a snapshot ID that existing history already holds, then the server MUST answer `409 conflict`.

**Reason:** a history collision is not a duplicate current item and cannot overwrite another item's past.

**Tests:** `compliance/archive-history.test.ts › refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was`.

### `search-and-filters/restore-strict`

Where `enforcement.strict_mode` names the type of an archived row, if the row sets a property that no type declares, then the server MUST answer `400 invalid_properties`.

**Reason:** a restore is not a way to plant a row that `POST /items` would refuse. `types/strict-mode` states the lever and `types/strict-mode-code` the code it carries.

**Tests:** `compliance/schema-enforcement.test.ts › strict-on rejects the same unknown property arriving through the restore door`.

### `search-and-filters/restore-strict-off`

Where `enforcement.strict_mode` does not name the type of an archived row, the server MUST take a property that no type declares and serve it back.

**Tests:** `compliance/schema-enforcement.test.ts › default-off accepts through the restore door as it does through the create door`.

### `search-and-filters/restore-blob-size`

Where the volume has room for an archive beside the instance's reserve (`blobs/restore-reserve`), the server MUST restore it even when it is larger than the request cap that every JSON body sits under.

**Reason:** the body streams to disk as an upload's does, so an archive that carries a blob larger than the cap restores.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`, `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`.

### `search-and-filters/restore-blob-bytes`

When `POST /restore` takes a blob that the archive carries, the server MUST answer its bytes on `GET /blobs/{hash}` byte for byte, under the type that the manifest names.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.

### `search-and-filters/restore-blob-hash`

When an entry of an archive holds bytes that do not hash to its name, the server MUST leave the entry out and not count it in `blobs_imported`.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.

### `search-and-filters/restore-unread-entry`

When an archive carries an entry under a name that the restore does not read, the server MUST restore the rest of the archive and leave the entry unread.

**Reason:** an archive is a file that anyone can hand an operator, and a small compressed entry can expand to more memory than the server has.

**Tests:** `compliance/restore-archive.test.ts › steps past an entry it does not read`.

### `search-and-filters/restore-text-cap`

If the `manifest.json`, the `types.ndjson`, or a line of the `items.ndjson` or `edges.ndjson` of an archive is larger than 64 MiB, then the server MUST answer `400 validation_error` naming the entry.

**Reason:** the restore parses each of these whole, so this limit bounds the memory a restore takes. The line files are otherwise read a line at a time, so an archive of any number of rows restores.

**Tests:** `compliance/restore-archive.test.ts › refuses a line longer than 64 MiB, and writes nothing`.

### `search-and-filters/restore-entry-twice`

If an archive carries `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` or a `blobs/` entry more than once, then the server MUST answer `400 validation_error` naming the entry.

**Reason:** a repeated entry has no single meaning, and reading both would let a later copy add rows that the first never listed.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive carrying an entry twice, and writes nothing`.

### `search-and-filters/restore-no-count-limit`

When direct owner or local authority restores an archive that the same build wrote, the server MUST take its counts of items, edges, types and edge types without a limit of its own.

**Reason:** an export that the same build cannot restore is not a usable backup.

**Tests:** `compliance/archive-limits.test.ts › restores an archive of more than 5,000 items, 20,000 edges, 200 types and 200 edge types, as one the same build wrote`.

### `search-and-filters/restore-row-at-cap`

When an archived item's properties, those of one of its earlier versions, or an archived edge's properties are exactly as large as the largest body the bulk write operations take, the server MUST restore the row.

**Tests:** `compliance/archive-limits.test.ts › takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the row and the field, and writes nothing`.

### `search-and-filters/restore-row-over-cap`

If an archived item's properties, those of one of its earlier versions, or an archived edge's properties are larger than the largest body the bulk write operations take, then the server MUST answer `413 request_too_large` naming the row and the field in `details`.

**Reason:** a restore is not a way to plant a row that the write operations would refuse, and the cap is `MARFA_MAX_BULK_REQUEST_BYTES` (`items/bulk-body-cap`).

**Tests:** `compliance/archive-limits.test.ts › takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the row and the field, and writes nothing`.

### `search-and-filters/restore-refused-nothing`

If the server refuses an archive, then the server MUST leave no row, history, type, edge type, blob, event or audit record that the restore wrote.

**Reason:** the registrations, the blob bytes and the rows commit together or not at all, so an owner who gives up on a restore does not hold types or rows they did not ask for and can run the same restore again.

**Tests:** `compliance/restore-archive.test.ts › leaves no row, type, edge type, blob, event or audit record behind when a later row is refused`, `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`, `compliance/archive-history.test.ts › refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was`.

### `search-and-filters/restore-failed-nothing`

If a write fails while the server restores an archive, then the server MUST leave no row, type, edge type, blob, event or audit record that the restore wrote.

**Tests:** `compliance/restore-faults.test.ts › leaves no row, type, edge type, blob, event or audit record when a write fails ($fault), and restores whole when it is tried again`.

### `search-and-filters/restore-stopped-nothing`

If the process stops while the server restores an archive, then the server MUST leave no row, type, edge type, event or audit record that the restore wrote, and remove the blob bytes it placed that no row names.

**Reason:** the bytes are written before the transaction opens, which nothing can roll back, so the copy cleanup of `blob-replicate` and `blob-integrity` removes them.

**Tests:** `compliance/restore-faults.test.ts › leaves no row, type, edge type, event or audit record when the process stops while it writes, and the next copy cleanup removes the bytes it placed`.

### `search-and-filters/restore-announced`

When a restore commits, the server MUST announce the items it wrote on the event stream.

**Tests:** `compliance/restore-archive.test.ts › leaves no row, type, edge type, blob, event or audit record behind when a later row is refused`.

### `search-and-filters/restore-announced-order`

When a restore commits, the server MUST tell subscribers about its events in event-log order, ahead of the events of any write committed after it.

**Reason:** a subscriber that received a later event first would move its cursor past events it never saw (`events/live-no-repeat`).

**Tests:** `compliance/restore-concurrent.test.ts › tells subscribers about its events in log order, ahead of the events of any write committed after it`.

### `search-and-filters/restore-hidden`

While a restore writes, the server MUST NOT show its rows, registrations or events to other requests.

**Reason:** a reader that saw part of a restore would see rows that a failed restore then takes away.

**Tests:** `compliance/restore-faults.test.ts › shows other requests none of its rows, registrations, blobs or events until it commits`.

### `search-and-filters/restore-writers-wait`

While a restore writes, if another request has to write and waits for the restore longer than the instance's busy budget, then the server MUST answer that request `503 write_contention`.

**Reason:** the restore holds the write lock until it commits, and a caller retries a `503` (`errors/contention`), whose `details.budget_ms` names the budget (`errors/contention-budget`).

**Tests:** `compliance/restore-concurrent.test.ts › is answered 201, or 503 write_contention carrying the busy budget, and nothing else`.

### `search-and-filters/restore-bytes-kept`

When the server removes the blob bytes of a restore that did not commit, the server MUST NOT remove bytes that a committed row names.

**Reason:** content addressing means that another request can be told the same bytes are stored while the restore runs.

**Tests:** `compliance/restore-faults.test.ts › keeps the bytes a committed row names, and removes those no row names`, `› keeps the bytes of an upload requested while the failed restore ran`.
