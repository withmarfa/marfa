# Search, filters, lookup, export and restore

The query grammar the listing operations share, the full-text search, the counts, the lookup by link, natural key or id, the pages every list answers, and the export and restore of an instance. How a recurring event unfolds and what a calendar window holds is `occurrences.md`.

## A query key an operation does not declare

Every operation declares the query keys it takes. The rules here hold for all of them, the item listing and the search among them.

### `search-and-filters/undeclared-key`

When a request carries a query key that its operation does not declare, the server MUST answer `400 validation_error` naming each such key in `details.unknown_parameters`.

**Reason:** the validator drops a key it does not declare, so a misspelled bound answers the whole set and cannot be told from a filter that matched every item. A rule that holds on some operations leaves the caller to find out which, by being wrong once.

**Tests:** `compliance/declared-refusals.test.ts › is refused 400 and named on every published door, the event stream included`, `› names a misspelled key on the event stream rather than opening it unfiltered`, `sync/time-filters.test.ts › honors the item listing's own-time bound and refuses a name it does not declare`, `correctness/edges/edges-list.test.ts › refuses an unknown query key and an unknown edge id`, `compliance/audit.test.ts › refuses an undeclared bound rather than answering the whole trail`, `compliance/connectors.test.ts › refuses a query key the runs listing does not declare`, `compliance/inbound-webhooks.test.ts › refuses a query key the listing does not declare, rather than answering unfiltered`, `compliance/item-stats.test.ts › refuses a query key it does not declare, naming it`, `compliance/envelope.test.ts › refuses an offset query key`.

### `search-and-filters/undeclared-key-401`

If a request to an operation that takes a credential carries an undeclared query key and no credential, then the server MUST answer `401`.

**Reason:** the refusal of the key comes after the credential check, so a bare request answers `401` whatever its query holds.

**Tests:** `compliance/declared-refusals.test.ts › is refused after the credential, so a bare request still answers 401`.

### `search-and-filters/undeclared-key-403`

If a credential that the operation's standing rule turns away sends an undeclared query key, then the server MUST answer the `403` it answers without the key.

**Reason:** the refusal of the key comes after the standing rule (`keys-and-oauth/permission-before-body`), so a credential that reaches no type learns nothing about the keys an operation declares.

**Tests:** `compliance/declared-refusals.test.ts › answers a copy stream request with a stray key 401, then 403 for a key that reads no type`, `compliance/auth-grants.test.ts › refuses a caller without grants.manage 403 whatever query it sends, at both doors`.

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

A `type` names a type and every type under it, as `types/listing-subtree` says of a listing. A wildcard ends in `.*`. On `GET /items`, `GET /items/stats`, `GET /search`, `GET /export` and `GET /events`, a `type` is one entry or a comma-separated list of entries, and each rule below holds for every entry.

### `search-and-filters/type-subtree`

When `GET /items/stats`, `GET /search`, `GET /export`, `GET /events` or `POST /items/bulk-actions` names a `type`, the server MUST apply it to that type and every type under it.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers the readable descendants on every door`, `› GET /items/stats counts the readable descendants of a type the key may not read`, `› GET /events streams the readable descendants of a type the key may not read and withholds the rest`, `correctness/persistence.test.ts › type-filtered search only returns matching types`.

### `search-and-filters/type-wildcard`

When a `type` filter of `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` or `GET /events` ends in `.*`, the server MUST select the items of the type named by the part before `.*`, of every type whose name starts with that part and a dot, and of every type declared under it.

**Tests:** `compliance/unreadable-type-filter.test.ts › GET /items, /export and /search leave out what the key may not read`, `› GET /items/stats counts only what the key may read`, `› GET /items/stats answers an object with no counts for a wildcard over types the key reads none of`, `› GET /occurrences reads a wildcard as a wildcard`, `› GET /events streams the readable types a wildcard matches and withholds the rest`, `compliance/types.test.ts › selects with a type the types declared under it, as with its own name`.

### `search-and-filters/type-list`

When the `type` of `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` is a comma-separated list, the server MUST select the items that any entry of the list selects.

**Reason:** a client that shows several types at once asks for them in one read, so a page and its limit count the items of all of them together.

**Tests:** `compliance/filter-lists.test.ts › answers the items of any type it names, on every door`, `› combines with a type list`.

### `search-and-filters/type-list-max`

If the `type` of `GET /items`, `GET /items/stats`, `GET /search`, `GET /export` or `GET /events` is a list of more than 10 distinct entries that are not blank, then the server MUST answer `400 validation_error`.

**Reason:** one bound on every door that takes the list, so a client learns it once. A blank entry, as a trailing comma leaves, names nothing, and a repeat names nothing new, so neither counts toward the bound or narrows the answer.

**Tests:** `compliance/filter-lists.test.ts › refuses more than ten entries`, `› drops blank entries and repeats before it counts the list`.

### `search-and-filters/type-grammar-refused`

If the `type` of `GET /items`, `GET /items/stats`, `GET /search`, `GET /export` or `GET /occurrences`, or the `filter.type` of `POST /items/bulk-actions`, holds a value that is neither a type identifier nor a wildcard ending in `.*` over one, then the server MUST answer `400 validation_error` naming the field in `details.errors`.

**Tests:** `compliance/question-mark-values.test.ts › is refused on every door that takes a type, naming it`.

### `search-and-filters/type-unknown`

If a credential that reaches some type sends a `type` filter with an entry naming a well-formed concrete type that nothing registers, then the server MUST answer `400 unknown_type` on `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` and `GET /events`.

**Reason:** an empty page is the one answer a client cannot tell from a quiet instance, so a mistyped name, a type registered under another handle and a type deleted since the client last read the registry would all read as nothing here. A wildcard is not refused, because what it names may be nothing (`search-and-filters/type-wildcard-none`).

**Tests:** `compliance/unreadable-type-filter.test.ts › $name answers 400 unknown_type, whatever the key reads`, `› GET /events holds each entry of a list to the rule`, `correctness/pagination.test.ts › a nonexistent type is refused rather than answered with an empty page`, `compliance/item-stats.test.ts › counts the items a listing's filters match`, `compliance/filter-lists.test.ts › refuses the list for an entry it would refuse alone`.

### `search-and-filters/type-bulk-unregistered`

If the `filter.type` of `POST /items/bulk-actions` names a type that nothing registers, then the server MUST select the items that carry that type name rather than refuse the request `400 unknown_type`.

**Reason:** the operation takes no wildcard, so the type's own name is the only way to select the items that a type removed with `force` left behind, in order to purge them.

**Tests:** `compliance/unreadable-type-filter.test.ts › POST /items/bulk-actions does not refuse one, because it takes no wildcard to reach the items a removed type kept`, `› POST /items/bulk-actions selects the items a type removed with force left behind, by the type's own name`.

### `search-and-filters/type-unreadable`

If a `type` filter names a registered type that the credential may not read, and no type under it that the credential may read, then the server MUST answer `403 type_not_permitted` on `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences`, each entry of the `type` list of `GET /events` and the `filter.type` of `POST /items/bulk-actions`.

**Reason:** an empty page would say nothing here about a type that is registered, which tells a caller nothing it can act on, while a write of the same type by the same credential is already answered `403 type_not_permitted`. The refusal discloses nothing the registry does not (`types/registry-open`). An item named by id keeps answering as a missing one when its type is unreadable (`items/get-missing`), because there the caller named an item and not a type.

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

**Reason:** a concrete type selects its subtree, so refusing would withhold items that the credential is entitled to. The refusal in `search-and-filters/type-unreadable` is for a filter that reaches nothing readable.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers the readable descendants on every door`, `› GET /items/stats counts the readable descendants of a type the key may not read`, `› GET /occurrences answers the readable subtype of an event type the key may not read`, `› GET /events streams the readable descendants of a type the key may not read and withholds the rest`.

### `search-and-filters/type-wildcard-readable`

When a credential that may read some type sends a wildcard `type` filter, the server MUST answer the items of the types it matches that the credential may read, whatever else it matches.

**Reason:** a wildcard names a set, so the readable part of it is a complete answer, and a refusal would turn a client that asks for `core.*` into one that has to know its own grant first.

**Tests:** `compliance/unreadable-type-filter.test.ts › GET /items, /export and /search leave out what the key may not read`, `› GET /items/stats counts only what the key may read`, `› GET /occurrences reads a wildcard as a wildcard`, `› GET /events streams the readable types a wildcard matches and withholds the rest`.

### `search-and-filters/type-wildcard-none`

When a wildcard `type` filter matches no type that a credential reaching some type may read, the server MUST answer as it answers a filter that matches no item: an empty page, a counts object with no count, or a stream with no frame of those types.

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

When `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` names a `state`, the server MUST select only the items in that state.

**Tests:** `compliance/state-default.test.ts › a named state and the sentinel still reach every item`, `› a search that names no state answers the active state`, `compliance/export.test.ts › filters by state`, `correctness/lifecycle-transitions.test.ts › state filter works on listItems`, `compliance/item-stats.test.ts › counts the items a listing's filters match`.

### `search-and-filters/state-list`

When the `state` of `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` is a comma-separated list of lifecycle states, the server MUST select the items in any state the list names.

**Reason:** a client that shows live and filed items together, such as `active,archived`, reads them in one page rather than merging two.

**Tests:** `compliance/filter-lists.test.ts › answers the items in any state it names, on every door`, `› combines with a type list`.

### `search-and-filters/state-any-alone`

If the `state` of `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` is a list that holds `any` and another entry, then the server MUST answer `400 validation_error`.

**Reason:** `any` already reaches every state the door reaches, so a list beside it says two things at once.

**Tests:** `compliance/filter-lists.test.ts › refuses any beside another state, and a list with no state in it`.

### `search-and-filters/state-empty`

If `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` names a `state` holding no value, only blanks, or a list of blank entries, then the server MUST answer `400 validation_error`.

**Reason:** a caller who sends the key means to narrow, so reading a state that names nothing as the default would serve a selection the caller did not make.

**Tests:** `compliance/filter-lists.test.ts › refuses any beside another state, and a list with no state in it`.

### `search-and-filters/state-search-default`

When `GET /search` names no `state`, the server MUST match only items in the `active` state.

**Reason:** a search never answers an item that a listing hides, because that would be two answers to one question.

**Tests:** `compliance/state-default.test.ts › a search that names no state answers the active state`.

### `search-and-filters/state-search-any`

When `GET /search` names `state=any`, the server MUST match the items of every lifecycle state but `trashed`.

**Tests:** `compliance/state-default.test.ts › a search reads across states under the sentinel, except the bin`.

### `search-and-filters/search-bin`

The server MUST NOT match an item in the bin on `GET /search`, whatever `state` the search names.

**Reason:** the index holds no entry for an item in the bin, so `state=trashed` and `state=any` alike leave it unmatched, however the item came to be there.

**Tests:** `compliance/state-default.test.ts › a search reads across states under the sentinel, except the bin`, `› a search does not reach an item born in the bin either`, `compliance/enrichment-search.test.ts › leaves a file in the bin unmatched, and matches it again once restored`, `compliance/filter-lists.test.ts › never matches the bin on the search door, even when the list names it`.

### `search-and-filters/state-invalid`

If `GET /items`, `GET /items/stats`, `GET /search` or `GET /export` names a `state` with an entry that is neither a lifecycle state nor `any`, then the server MUST answer `400 validation_error`.

**Reason:** a typo in a filter must not be served as a successful selection.

**Tests:** `compliance/state-default.test.ts › refuses a state that is not a state, on every door that reads items`, `compliance/export.test.ts › refuses an unknown state filter`, `compliance/item-stats.test.ts › refuses what the listing refuses in a filter: a state outside the enum, a bound that is not an instant and a number no double holds`, `compliance/filter-lists.test.ts › refuses a list holding a value that is not a state`.

### `search-and-filters/source-narrows`

When `GET /items`, `GET /items/stats`, `GET /search`, `GET /export` or `POST /items/bulk-actions` names a `source`, the server MUST select only the items stamped with that source.

**Tests:** `compliance/source-narrowing.test.ts › GET /items answers only the items stamped with the source named`, `› GET /items/stats counts only the items stamped with the source named`, `› GET /search answers only the items stamped with the source named`, `› GET /export carries only the items stamped with the source named`, `› POST /items/bulk-actions selects only the items stamped with the source named`.

### `search-and-filters/tags-every`

When `GET /items`, `GET /items/stats`, `GET /search` or `POST /items/bulk-actions` names tags, the server MUST select only the items that carry every tag named.

**Tests:** `correctness/tags.test.ts › narrows the listing, the stats, the search and the bulk action to the items that carry every tag named`, `› filters items by tag in queries`, `› filtering by tags=[favorite] returns tagged items and excludes others`.

### `search-and-filters/tags-blank-search`

When `GET /search` names a `tags` list that holds a blank entry beside a tag, the server MUST ignore the blank entry.

**Reason:** a client that builds the list by joining values can leave a trailing comma, and an empty page would read as no item carrying the tag.

**Tests:** `correctness/tags.test.ts › ignores a blank entry of a tags list on the search`.

### `search-and-filters/tier-narrows`

When `GET /items`, `GET /items/stats` or `GET /search` names `tier=library` or `tier=feed`, the server MUST select only the items in that tier.

**Tests:** `compliance/tier-axis.test.ts › tier=library returns library items only`, `› tier=feed returns feed items only`, `› narrows the stats and the search by tier as the listing does`.

### `search-and-filters/tier-both`

When `GET /items`, `GET /items/stats` or `GET /search` names `tier=all` or names no `tier`, the server MUST select the items of both tiers.

**Tests:** `compliance/tier-axis.test.ts › default query omitting tier returns both library and feed items`, `› tier=all returns both library and feed items`, `› narrows the stats and the search by tier as the listing does`.

### `search-and-filters/tier-invalid`

If `GET /items`, `GET /items/stats` or `GET /search` names a `tier` that is not `library`, `feed` or `all`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/tier-axis.test.ts › refuses a tier that is not library, feed or all, on the listing, the stats and the search`.

## Beneath an item

`beneath` names an item. It takes that item and every item under it by `parent-of` at any depth, as a view's `query.beneath` does (`views/items-beneath`), but in the states the request names rather than only active ones.

### `search-and-filters/beneath-listing`

When `GET /items` names `beneath`, the server MUST list only that item and the items under it by `parent-of` at any depth.

**Reason:** a folder's copy holds one subtree, and without this its hydration reads every item of its types to keep a few.

**Tests:** `compliance/items-beneath.test.ts › lists and counts the item beneath and everything under it by parent-of, at any depth, in the states the listing names`, `› lists and counts nothing beneath an id that is no item`.

### `search-and-filters/beneath-stats`

When `GET /items/stats` names `beneath`, the server MUST count only the items `GET /items` lists with the same `beneath`.

**Reason:** the device sizes a hydration by these counts, so a count of more items than the listing gives reads as a hydration that never finishes.

**Tests:** `compliance/items-beneath.test.ts › lists and counts the item beneath and everything under it by parent-of, at any depth, in the states the listing names`, `› lists and counts nothing beneath an id that is no item`.

### `search-and-filters/beneath-readable`

When `GET /items` or `GET /items/stats` names `beneath`, the server MUST NOT reach an item through one the key cannot read.

**Reason:** an item under an unreadable one would show that the unreadable one has children.

**Tests:** `compliance/items-beneath.test.ts › walks beneath only through items the key can read`.

### `search-and-filters/beneath-edge-read`

If `GET /items` or `GET /items/stats` names `beneath` and the key cannot read `parent-of` edges, then the server MUST answer `403 edge_permission_denied`.

**Tests:** `compliance/items-beneath.test.ts › refuses beneath to a key that cannot read parent-of edges`.

### `search-and-filters/beneath-invalid`

If `GET /items` or `GET /items/stats` names a `beneath` that is not an item ID, then the server MUST answer `400 validation_error` naming `beneath`.

**Tests:** `compliance/items-beneath.test.ts › refuses a beneath that is not an item ID, naming it`.

## Time bounds

An item's own time is its `occurred_at`, or its `created_at` where it has none.

### `search-and-filters/own-time-bounds`

When `GET /items`, `GET /search` or `GET /export` names `occurred_after` or `occurred_before`, the server MUST bound the items by their own time.

**Tests:** `compliance/occurred-at.test.ts › occurred_after filter uses COALESCE(occurred_at, created_at)`, `› occurred_before filter uses COALESCE(occurred_at, created_at)`, `› GET /search bounds a search by the item's own time and excludes an item sitting exactly on either bound`, `› GET /export bounds an export by the item's own time and excludes an item sitting exactly on either bound`, `compliance/canonical-time.test.ts › stores own time in UTC and orders and bounds it by instant`, `compliance/export.test.ts › filters by date range on the item's own time`.

### `search-and-filters/own-time-exclusive`

When `GET /items`, `GET /search` or `GET /export` names `occurred_after` or `occurred_before`, the server MUST leave out an item whose own time is exactly the bound.

**Reason:** the item sitting on a bound is the item that tells an exclusive bound from an inclusive one.

**Tests:** `compliance/occurred-at.test.ts › both bounds exclude an item sitting exactly on them`, `› GET /search bounds a search by the item's own time and excludes an item sitting exactly on either bound`, `› GET /export bounds an export by the item's own time and excludes an item sitting exactly on either bound`.

### `search-and-filters/own-time-sort`

When `GET /items` names `sort=occurred_at`, the server MUST order the items by their own time.

**Tests:** `compliance/occurred-at.test.ts › COALESCE ordering: sort=occurred_at uses occurred_at then created_at`, `compliance/canonical-time.test.ts › stores own time in UTC and orders and bounds it by instant`.

### `search-and-filters/own-time-created-sort`

The server MUST NOT let an item's `occurred_at` change the order of a `GET /items` listing sorted by `created_at`.

**Tests:** `compliance/occurred-at.test.ts › occurred_at does not affect created_at ordering`.

### `search-and-filters/bound-not-instant`

If `GET /items`, `GET /items/stats` or `GET /search` names `occurred_after`, `occurred_before`, `updated_after` or `updated_before`, or `GET /export` names `occurred_after` or `occurred_before`, with a value that is neither an RFC 3339 date-time (`items/occurred-at-form`) nor a date alone as `YYYY-MM-DD`, which names its midnight in UTC, then the server MUST answer `400 validation_error`.

**Reason:** the export streams, so a bound refused after the response began would hand the caller an empty body under a success status.

**Tests:** `compliance/item-stats.test.ts › refuses what the listing refuses in a filter: a state outside the enum, a bound that is not an instant and a number no double holds`, `compliance/export.test.ts › refuses a bound that is not an instant, on both output formats`, `compliance/search-ordering.test.ts › refuses an update bound that is not an instant`.

### `search-and-filters/updated-after`

When `GET /items` or `GET /search` names `updated_after`, the server MUST select only the items whose `updated_at` is at or after it.

**Reason:** the bound is inclusive because `updated_at` ties across a bulk write, so a strict bound would drop every item sharing the instant of a resuming client's cursor. A tag moves `updated_at` as a property does (`items/tag-updated-at`).

**Tests:** `sync/time-filters.test.ts › keeps updated_after inclusive, which the catch-up depends on`, `sync/catchup.test.ts › sees a tag written after the boundary, not just a property change`, `compliance/search-ordering.test.ts › bounds a search by updated_at, inclusive below and exclusive above`.

### `search-and-filters/updated-after-order`

If `GET /items` names `updated_after` with a `sort` other than `updated_at` or a `direction` other than `asc`, then the server MUST answer `400 validation_error`.

**Reason:** the bound orders the listing by `updated_at` and then id, ascending, which is the only order a catch-up cursor can advance through, so honoring one half of a contradicting request would answer a page that cannot be resumed.

**Tests:** `sync/time-filters.test.ts › refuses updated_after beside a sort or direction it does not order by, and takes the order it implies`.

### `search-and-filters/updated-before`

When `GET /items` or `GET /search` names `updated_before`, the server MUST select only the items whose `updated_at` is before it.

**Tests:** `sync/time-filters.test.ts › bounds an item listing by updated_before, exclusively`, `compliance/search-ordering.test.ts › bounds a search by updated_at, inclusive below and exclusive above`.

### `search-and-filters/search-updated-instant`

When `GET /search` names `updated_after` or `updated_before`, the server MUST bound the items by the instant the value names, whatever offset it is spelled in.

**Tests:** `compliance/search-ordering.test.ts › reads an update bound as the instant it names, in any offset`.

### `search-and-filters/search-updated-after-order`

When `GET /search` names `updated_after`, the server MUST order the hits as it would without it, by `sort` and `direction`.

**Reason:** the listing orders a catch-up by `updated_at` because its cursor can advance through no other order (`search-and-filters/updated-after-order`). A search pages by offset into its ranking, so the bound implies no order.

**Tests:** `compliance/search-ordering.test.ts › leaves the order to sort and direction when updated_after is named`.

## What a listing adds and what it leaves out

### `search-and-filters/include-edges`

When `GET /items` names `include=edges`, the server MUST add to each item its outbound edges, keyed by edge type, each block a page of `data` and `next_cursor`.

**Reason:** `edges/hydrate` states the blocks of an item read, and `POST /items/lookup` hydrates its items the same way.

**Tests:** `compliance/links.test.ts › hydrates edges on a lookup as the listing does`, `compliance/envelope.test.ts › carries each hydrated edge block as a page`.

### `search-and-filters/system-named-type`

When `GET /items` names a `type` in the `system.` namespace, the server MUST list the items of that type that the credential may read.

**Reason:** a caller that asks for `system.folder` has already said what it wants, so the default that leaves `system.*` items out of a listing does not apply to it.

**Tests:** `compliance/folders.test.ts › creates a folder as a system.folder, read back through the item doors`, `compliance/views.test.ts › creates a view as a system.view with its query, sort and group, read back through the item doors`.

## Filter grammar

`GET /items`, `GET /items/stats` and `GET /search` take a `filter` expression, `POST /items/bulk-actions` takes one inside its filter, and a view and a folder take one as `query.filter`. An expression is one or more conditions, `<field> <operator> <value>`, with no value after `exists` and `not_exists` (`search-and-filters/filter-malformed`). Numbers on properties are `search-and-filters/filter-numeric`, times are `search-and-filters/filter-time-instant`, and the escapes in a string are `search-and-filters/filter-string-escapes`. An edge term is also `edges.md`'s (`edges/filter-edge-full`, `edges/filter-term-hidden`).

### `search-and-filters/filter-doors`

The server MUST hold the `filter` of `GET /items`, `GET /items/stats` and `GET /search`, the `filter` inside the filter of `POST /items/bulk-actions`, and a view's and a folder's `query.filter` to one grammar, except that a folder's `query.filter` refuses every `backref` condition (`items/folder-setting-followable`).

**Reason:** an expression a client learned at one door then selects the same items, or draws the same refusal, at every other.

**Tests:** `compliance/filter-grammar.test.ts › selects the same items by one expression at each door`, `› refuses %s at each door with validation_error`, `› answers an edge term the same on the doors beyond the listing`, `› takes a backref term in a view and refuses it in a folder`.

### `search-and-filters/filter-unknown-field`

If a `filter` names a field the server does not define, such as `author` where `properties.author` is meant, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-unknown-operator`

If a `filter` names an operator other than `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `exists` and `not_exists`, each in lower case, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-malformed`

If a `filter` holds a field with no operator, an operator that takes a value with none, a value after `exists` or `not_exists`, a value in a form `search-and-filters/filter-value-forms` does not name, a string with no closing quote, two conditions with no join, a join other than upper-case `AND` or `OR`, a join with no condition after it, a parenthesis outside a string, or a line break outside a string, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-blank-query`

If a view's or a folder's `query.filter` holds no value or only blanks, then the server MUST answer `400 validation_error`, naming `query.filter` in `details.errors[0].path`.

**Reason:** `search-and-filters/empty-narrowing` and `search-and-filters/empty-narrowing-bulk` say the same of the other doors.

**Tests:** `compliance/filter-grammar.test.ts › refuses a filter of only blanks, naming it at each door`.

### `search-and-filters/filter-value-forms`

When the value of a condition in a `filter` is a double-quoted string, `true`, `false`, or a number written as digits with an optional leading `-` and an optional `.` that may have no digits after it, the server MUST read it as that string, boolean or number.

**Reason:** this says how a value may be written and leaves to each field whether it takes that kind of value, so `5.` reads as `5`. `1e5`, `.5` and `+5` are not numbers here, and a bare word is not a string (`search-and-filters/filter-malformed`).

**Tests:** `compliance/filter-grammar.test.ts › takes a quoted string, a number and a boolean`, `› refuses %s at each door with validation_error`.

### `search-and-filters/filter-join-and`

When a `filter` joins conditions with `AND`, the server MUST select the items every condition selects.

**Tests:** `compliance/filter-grammar.test.ts › selects by AND the items every condition selects, and by OR the items any selects`.

### `search-and-filters/filter-join-or`

When a `filter` joins conditions with `OR`, the server MUST select the items at least one condition selects.

**Tests:** `compliance/filter-grammar.test.ts › selects by AND the items every condition selects, and by OR the items any selects`.

### `search-and-filters/filter-or-narrows`

When `GET /items`, `GET /items/stats` or `GET /search` names a `filter` joined with `OR` beside another key that narrows, other than an `edge[<edge type>]` or `backref[<edge type>]` key (`search-and-filters/filter-or-shorthand`), the server MUST select only the items both the key and the `filter` select.

**Tests:** `compliance/filter-grammar.test.ts › narrows by the request's other keys what OR selects, on the listing, the stats and the search`.

### `search-and-filters/filter-text-compare`

When a `filter` compares a property holding text, `id`, `type`, `state`, `source` or `source_id` with a double-quoted string using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare the whole value by code point, with regard to case.

**Reason:** `type eq "core.entity"` therefore selects that identifier alone, where the `type` key takes the types under it too (`types/listing-subtree`).

**Tests:** `compliance/filter-grammar.test.ts › compares the whole value, with regard to case, in code point order`, `› compares a system field's whole value, with regard to case`, `› compares a type term with the identifier alone, not the types under it`.

### `search-and-filters/filter-version-compare`

When a `filter` compares `version` with a number using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare them as numbers.

**Tests:** `compliance/filter-grammar.test.ts › compares version as a number`.

### `search-and-filters/filter-absent-unselected`

When a `filter` compares a property using an operator that takes a value, the server MUST NOT select an item whose property is absent or null.

**Reason:** `neq` on a property therefore passes by an item without the property, where `neq` on an edge term selects an item without the edge (`search-and-filters/filter-edge-neq`). `not_exists` finds such an item (`search-and-filters/filter-not-exists`).

**Tests:** `compliance/filter-grammar.test.ts › selects no item whose property is absent or null, with any operator that takes a value`.

### `search-and-filters/filter-contains`

When a `filter` compares a property holding text, `id`, `type`, `state`, `source` or `source_id` using `contains`, the server MUST select the items whose value holds the text.

**Tests:** `compliance/filter-grammar.test.ts › selects a value that holds the text, and one that begins with it`, `› selects by id, state and source_id as it does by a property`.

### `search-and-filters/filter-starts-with`

When a `filter` compares a property holding text, `id`, `type`, `state`, `source` or `source_id` using `starts_with`, the server MUST select the items whose value begins with the text.

**Tests:** `compliance/filter-grammar.test.ts › selects a value that holds the text, and one that begins with it`, `› selects by id, state and source_id as it does by a property`.

### `search-and-filters/filter-text-case`

When a `filter` compares text using `contains` or `starts_with`, the server MUST match an ASCII letter in either case and every other character exactly.

**Reason:** a device folds case the same way (`device/filter-case-ascii`).

**Tests:** `compliance/filter-grammar.test.ts › folds ASCII case and no other`.

### `search-and-filters/filter-text-literal`

When the value of a `contains` or `starts_with` condition holds `%`, `_` or `\`, the server MUST match each as that character.

**Reason:** a `filter` has no wildcard, so a value such as `web_gallery` finds what it spells. A `\` in the value is written as `search-and-filters/filter-string-escapes` says.

**Tests:** `compliance/filter-grammar.test.ts › matches a percent sign, an underscore and a backslash as themselves`.

### `search-and-filters/filter-property-name`

If a `filter` names `properties.<name>` where `<name>` is empty, does not start with an ASCII letter or `_`, or holds anything but ASCII letters, digits and `_`, then the server MUST answer `400 validation_error`.

**Reason:** a name reaches one level into `properties`, and a second name after a `.` is a member of a list's entries (`search-and-filters/filter-entry-member`).

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-system-presence`

If a `filter` applies `exists` or `not_exists` to `id`, `type`, `state`, `source`, `source_id`, `version`, `created_at`, `updated_at` or `occurred_at`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-tags-contains`

When a `filter` holds `tags contains "<tag>"`, the server MUST select the items that carry a tag equal to the whole of the value, with regard to case.

**Reason:** unlike `contains` on a property, this names one tag rather than a fragment.

**Tests:** `compliance/filter-grammar.test.ts › takes a whole tag, with regard to case`.

### `search-and-filters/filter-tags-exists`

When a `filter` applies `exists` to `tags`, the server MUST select the items that carry at least one tag.

**Tests:** `compliance/filter-grammar.test.ts › selects by exists the items with a tag, and by not_exists the items with none`.

### `search-and-filters/filter-tags-not-exists`

When a `filter` applies `not_exists` to `tags`, the server MUST select the items that carry no tag.

**Tests:** `compliance/filter-grammar.test.ts › selects by exists the items with a tag, and by not_exists the items with none`.

### `search-and-filters/filter-tags-refused`

If a `filter` applies to `tags` an operator other than `contains`, `exists` and `not_exists`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-edge-neq`

When a `filter` holds `edge[<edge type>] neq "<id>"`, the server MUST select every item that holds no outbound edge of that type to that id, an item with no edge of that type included.

**Tests:** `compliance/filter-grammar.test.ts › selects by edge neq every item without that edge, an item with no edge of the type among them`.

### `search-and-filters/filter-edge-exists`

When a `filter` applies `exists` to `edge[<edge type>]`, the server MUST select the items that hold at least one outbound edge of that type.

**Tests:** `compliance/filter-grammar.test.ts › selects by edge exists the items with an outbound edge of the type, and by not_exists the items with none`.

### `search-and-filters/filter-edge-not-exists`

When a `filter` applies `not_exists` to `edge[<edge type>]`, the server MUST select the items that hold no outbound edge of that type.

**Tests:** `compliance/filter-grammar.test.ts › selects by edge exists the items with an outbound edge of the type, and by not_exists the items with none`.

### `search-and-filters/filter-backref-eq`

When a `filter` holds `backref[<edge type>] eq "<id>"`, the server MUST select the items that are the target of an edge of that type whose source is that id.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref eq the items that an edge of the type from that item points at`, `› selects by an edge eq term and a backref eq term on every door as the listing does`.

### `search-and-filters/filter-backref-neq`

When a `filter` holds `backref[<edge type>] neq "<id>"`, the server MUST select every item that is not the target of an edge of that type from that id, an item with no inbound edge of that type included.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref neq every item without that inbound edge, an item with no inbound edge of the type among them`.

### `search-and-filters/filter-backref-exists`

When a `filter` applies `exists` to `backref[<edge type>]`, the server MUST select the items that are the target of at least one edge of that type.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref exists the items with an inbound edge of the type, and by not_exists the items with none`.

### `search-and-filters/filter-backref-not-exists`

When a `filter` applies `not_exists` to `backref[<edge type>]`, the server MUST select the items that are the target of no edge of that type.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref exists the items with an inbound edge of the type, and by not_exists the items with none`.

### `search-and-filters/filter-edge-refused`

If a `filter` applies to `edge[<edge type>]` or `backref[<edge type>]` an operator other than `eq`, `neq`, `exists` and `not_exists`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

### `search-and-filters/filter-state-default`

When `GET /items`, `GET /search` or `POST /items/bulk-actions` names no `state` and its `filter` holds a `state` term, the server MUST select only the items in the `active` state that the term selects.

**Reason:** the term narrows the default and does not replace it, so `filter=state eq "archived"` alone selects nothing. Naming `state=archived` reaches those items, as does `state=any` on `GET /items` and `GET /search`.

**Tests:** `compliance/filter-grammar.test.ts › meets the default state when no state is named, so state eq archived alone selects nothing`.

### `search-and-filters/filter-state-named`

When `GET /items`, `GET /items/stats`, `GET /search` or `POST /items/bulk-actions` names a `state` and its `filter` holds a `state` term, the server MUST select only the items the named `state` reaches that the term also selects.

**Tests:** `compliance/filter-grammar.test.ts › meets a named state, so the two must agree to select an item`.

### `search-and-filters/filter-state-stats`

When `GET /items/stats` names no `state` and its `filter` holds a `state` term, the server MUST count the items of every state that the term selects.

**Reason:** the door's default is every state (`search-and-filters/stats-every-state`), so the same `filter=state eq "archived"` that selects nothing on `GET /items` counts the archived items here.

**Tests:** `compliance/filter-grammar.test.ts › counts on GET /items/stats among every state when none is named`.

### `search-and-filters/filter-question-mark`

When a value in a `filter` expression, a `tags` parameter or the value of a `backref[<edge type>]` parameter of `GET /items`, `GET /items/stats`, `GET /search` or `POST /items/bulk-actions` holds a `?`, the server MUST match the `?` as that character and as nothing else.

**Tests:** `compliance/question-mark-values.test.ts › matches as itself in a filter on GET /items`, `› matches as itself in a tags parameter on GET /items`, `› matches as itself in a tags parameter on GET /items/stats, GET /search and POST /items/bulk-actions`, `› matches as itself in a filter on GET /items/stats`, `› matches as itself in a filter on GET /search`, `› matches as itself in a filter on POST /items/bulk-actions`, `› matches as itself in the anchor of an edge term, on every door that takes one`.

### `search-and-filters/tag-count-question-mark`

When a tag holds a `?`, the server MUST count it under its own name on `GET /metadata/tags`.

**Tests:** `compliance/question-mark-values.test.ts › counts a tag holding a ? under its own name on GET /metadata/tags`.

### `search-and-filters/filter-max-length`

The server MUST take a `filter` of 2,048 characters on `GET /items`, `GET /items/stats` and `GET /search`, inside the filter of `POST /items/bulk-actions`, and as a view's or a folder's `query.filter`.

**Tests:** `compliance/validation.test.ts › takes a filter of 2,048 characters and refuses one of 2,049, on the listing and the search`, `compliance/filter-grammar.test.ts › takes 2,048 characters and refuses 2,049, at each door`, `compliance/filter-characters.test.ts › counts a character outside the basic plane once, at each door`.

### `search-and-filters/filter-over-length`

If a `filter` on `GET /items`, `GET /items/stats` or `GET /search`, inside the filter of `POST /items/bulk-actions`, or as a view's or a folder's `query.filter` is longer than 2,048 characters, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/validation.test.ts › takes a filter of 2,048 characters and refuses one of 2,049, on the listing and the search`, `compliance/filter-grammar.test.ts › takes 2,048 characters and refuses 2,049, at each door`, `compliance/filter-characters.test.ts › counts a character outside the basic plane once, at each door`.

### `search-and-filters/filter-max-conditions`

The server MUST take a `filter` of 10 conditions joined by `AND`, or joined by `OR`, on `GET /items`, `GET /items/stats` and `GET /search`, inside the filter of `POST /items/bulk-actions`, and as a view's or a folder's `query.filter`.

**Tests:** `compliance/validation.test.ts › takes a filter of 10 conditions and refuses one of 11, on the listing and the search`, `compliance/filter-grammar.test.ts › takes 10 conditions and refuses 11, at each door`.

### `search-and-filters/filter-over-conditions`

If a `filter` on `GET /items`, `GET /items/stats` or `GET /search`, inside the filter of `POST /items/bulk-actions`, or as a view's or a folder's `query.filter` holds more than 10 conditions, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/validation.test.ts › takes a filter of 10 conditions and refuses one of 11, on the listing and the search`, `compliance/filter-grammar.test.ts › takes 10 conditions and refuses 11, at each door`.

### `search-and-filters/filter-shorthand-conditions`

When `GET /items` or `GET /items/stats` carries an `edge[<edge type>]` or `backref[<edge type>]` key, the server MUST count each such key as one condition of the `filter` toward `search-and-filters/filter-over-conditions`.

**Tests:** `compliance/filter-grammar.test.ts › counts an edge key as one of the 10 conditions`.

### `search-and-filters/filter-shorthand-length`

When `GET /items` or `GET /items/stats` carries a `filter` and an `edge[<edge type>]` or `backref[<edge type>]` key, the server MUST count the length of ` AND <key> eq "<value>"`, with a space either side of `AND`, for each such key toward the 2,048 characters of `search-and-filters/filter-over-length`.

**Tests:** `compliance/filter-grammar.test.ts › counts an edge key's clause and its AND toward the 2,048 characters`.

### `search-and-filters/filter-mixed-logic`

If a `filter` on `GET /items` or `GET /search` joins conditions with both `AND` and `OR`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/validation.test.ts › refuses a filter that mixes AND with OR, on the listing and the search`.

### `search-and-filters/filter-or-shorthand`

If `GET /items` or `GET /items/stats` carries an `edge[<edge type>]` or `backref[<edge type>]` key and a `filter` that uses `OR`, then the server MUST answer `400 validation_error`.

**Reason:** the shorthand is joined to the `filter` with `AND`, so the two cannot form one expression.

**Tests:** `compliance/validation.test.ts › refuses a filter that uses OR beside an edge shorthand, which joins it with AND`, `compliance/filter-grammar.test.ts › refuses OR beside an edge key and a backref key, and takes them beside AND`.

### `search-and-filters/shorthand-backslash`

If the value of an `edge[<edge type>]` or `backref[<edge type>]` key carries a backslash, then the server MUST answer `400 validation_error`.

**Reason:** an item id never carries a backslash, so a value holding one names no item and is a mistake in the request.

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

**Tests:** `compliance/numeric-property-filters.test.ts › witnesses every seeded item on both doors before filtering`, `› compares numeric properties as finite doubles on the listing and search`.

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

**Reason:** `not_exists` asks the question the caller means and answers the items whose property is absent or null, and `exists` the items that hold a value. A system field always exists, so a refusal about one names no presence test.

**Tests:** `compliance/null-filter.test.ts › is refused 400 on every operator, naming not_exists where a property can be absent`.

### `search-and-filters/filter-not-exists`

When a `filter` applies `not_exists` to a property, the server MUST select the items whose property is absent or null, and `exists` the items whose property holds a value.

**Tests:** `compliance/null-filter.test.ts › is not needed: not_exists asks for a property that is absent or null, and exists for one that has a value`.

### `search-and-filters/filter-null-quoted`

When a `filter` compares a field with `"null"` inside double quotes, the server MUST compare it as text.

**Tests:** `compliance/null-filter.test.ts › is refused on a system field, an edge and tags, and still read as text when quoted`.

### `search-and-filters/filter-string-escapes`

When a double-quoted value in a `filter` holds `\"` or `\\`, the server MUST read it as one `"` or one `\` that is part of the value.

**Reason:** with both escaped, any text can be written as a value, one that ends in a backslash included.

**Tests:** `compliance/filter-escapes.test.ts › reads an escaped quote and an escaped backslash as one character of the value`.

### `search-and-filters/filter-string-backslash`

When a double-quoted value in a `filter` holds a backslash that is not followed by `"` or `\`, the server MUST read the backslash as itself.

**Reason:** a value such as a Windows path is written as it reads.

**Tests:** `compliance/filter-escapes.test.ts › reads any other backslash as itself`.

### `search-and-filters/filter-time-instant`

When a `filter` on `GET /items` or `GET /search` compares `created_at`, `updated_at` or `occurred_at` with a timestamp literal using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare it as the instant it names, however its zone is spelled, reading a date alone as its midnight in UTC.

**Tests:** `compliance/canonical-time.test.ts › normalizes filter timestamps on listing and search`, `› compares filter timestamps with neq, gt, lt and lte as instants, on listing and search`.

### `search-and-filters/filter-time-refused`

If a `filter` on `GET /items` or `GET /search` compares `created_at`, `updated_at` or `occurred_at` with `eq`, `neq`, `gt`, `gte`, `lt` or `lte` against a literal that is not text, or is text that is neither an RFC 3339 date-time (`items/occurred-at-form`) nor a date alone as `YYYY-MM-DD`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/canonical-time.test.ts › refuses a time comparison with a literal that is not a timestamp, on every operator, naming validation_error`, `› refuses invalid time comparisons while retaining text operators`.

### `search-and-filters/filter-time-text`

When a `filter` on `GET /items` or `GET /search` compares `created_at`, `updated_at` or `occurred_at` with `contains` or `starts_with`, the server MUST match text fragments.

**Tests:** `compliance/canonical-time.test.ts › refuses invalid time comparisons while retaining text operators`.

### `search-and-filters/filter-entry-member`

When a `filter` on `GET /items` or `GET /search` compares `properties.<field>.<member>` with a value using `eq`, the server MUST select the items whose `<field>` is a list holding at least one object whose `<member>` equals the value, compared as `properties.<field>` is.

**Reason:** a person is found by any one of their email addresses, phone numbers or addresses, not only the first. A saved view's `filter` takes the same term (`views/filter-terms`).

**Tests:** `compliance/contact-lists.test.ts › finds a person by their second email, on the listing, the search and a view`.

### `search-and-filters/filter-entry-member-none`

When a `filter` compares `properties.<field>.<member>` and an item's `<field>` is absent or is not a list, or no object in it holds `<member>`, the server MUST NOT select the item by that condition.

**Reason:** the term reads the stored value and not the type's declaration, as every property term does, so it answers the same items for every type a listing spans.

**Tests:** `compliance/contact-lists.test.ts › selects no item whose field is not a list of objects holding the member`.

### `search-and-filters/filter-entry-member-refused`

If a `filter` compares `properties.<field>.<member>` with an operator other than `eq`, or names a property path of more than two names, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/contact-lists.test.ts › refuses %s with validation_error`.

## The status group term

A `status_group` term selects items by the group of the word their status field holds, as their own type resolves it (`types/status-groups`, `types/status-inherit`).

### `search-and-filters/status-group`

When a `filter`, on a listing or in a view's `query`, holds `status_group eq "<group>"`, the server MUST select the items whose status field holds a word their type puts in that group.

**Tests:** `compliance/status-groups.test.ts › %s`, `› selects by group in a saved view`.

### `search-and-filters/status-group-neq`

When a `filter` holds `status_group neq "<group>"`, the server MUST select the items whose status field holds a word their type puts in another group.

**Reason:** `status_group neq "completed" AND status_group neq "canceled"` then selects the open items of every type with a status field, and nothing else.

**Tests:** `compliance/status-groups.test.ts › %s`, `› selects by group in a saved view`.

### `search-and-filters/status-group-none`

When a `filter` holds `status_group not_exists`, the server MUST select the items whose type has no status field, those that hold no value in it, and those that hold a word their type does not declare.

**Reason:** such an item is in no group, so neither `eq` nor `neq` selects it (`types/status-word-held`).

**Tests:** `compliance/status-groups.test.ts › %s`.

### `search-and-filters/status-group-exists`

When a `filter` holds `status_group exists`, the server MUST select the items whose status field holds a word their type declares.

**Tests:** `compliance/status-groups.test.ts › %s`.

### `search-and-filters/status-group-refused`

If a `filter` compares `status_group` with a value other than `"not_started"`, `"in_progress"`, `"completed"` or `"canceled"`, or with an operator other than `eq`, `neq`, `exists` and `not_exists`, then the server MUST answer `400 validation_error`.

**Reason:** a word is a type's own, so a filter that names one is refused rather than silently selecting nothing; a word is matched with `properties.<field> eq`.

**Tests:** `compliance/status-groups.test.ts › refuses %s with validation_error`.

## The part term

A `part` term selects the items that are parts of another (`edges/parts-trash`): an item out of the bin that is the source of a `with-hosts` edge whose target is out of the bin. No listing leaves parts out unless its filter says so. A device answers the term from its working copy by the same rule (`device/filter-part`).

### `search-and-filters/part`

When a `filter`, on `GET /items`, `GET /items/stats`, in a view's `query` or in a bulk action's `filter`, holds `part eq true`, the server MUST select each item out of the bin that is the source of an edge of a `with-hosts` type whose target is out of the bin.

**Tests:** `correctness/edges/edges-parts.test.ts › selects parts with a host out of the bin on GET /items, stats, a saved view and a bulk filter`.

### `search-and-filters/part-not`

When a `filter` holds `part eq false` or `part neq true`, the server MUST select each item that `part eq true` does not select.

**Reason:** a part restored on its own while its only host is in the bin is not a part, so it is listed among the rest.

**Tests:** `correctness/edges/edges-parts.test.ts › selects parts with a host out of the bin on GET /items, stats, a saved view and a bulk filter`.

### `search-and-filters/part-hidden-host`

When a `filter` holds a `part` term, the server MUST judge it over every host of an item, whatever types the key may read.

**Tests:** `compliance/edge-hidden-limits.test.ts › judges the part term over a host the key cannot read, naming none`.

### `search-and-filters/part-refused`

If a `filter` compares `part` with an operator other than `eq` and `neq`, or with a value other than `true` and `false`, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/edges/edges-parts.test.ts › refuses any other operator or value with a validation error`.

## The order of the bin

### `search-and-filters/bin-order`

When `GET /items` names `state=trashed` alone and no `sort` or `updated_after`, the server MUST order the items by `trashed_at`, newest first unless `direction=asc`, then by `id` in the same direction, ordering an item without a `trashed_at` by its `updated_at`.

**Reason:** a bin reads as what went there most recently first, and creation order would put an old item binned a minute ago at the bottom. An item an archive restored to the bin without its time (`items/trash-archive-identity`) has no `trashed_at`, and its `updated_at` is no earlier than the move. A listing of any other set of states keeps the creation order, because its items have no one time in common.

**Tests:** `compliance/trashed-at.test.ts › lists the bin newest binned first when no sort is named`, `› reverses it with direction=asc`, `› walks the same order one page at a time`, `› orders a listing of several states by creation`.

### `search-and-filters/bin-order-sort`

When `GET /items` names `state=trashed` and a `sort`, the server MUST order the items by that `sort`.

**Tests:** `compliance/trashed-at.test.ts › still honors a named sort`.

## Sorting by a property

### `search-and-filters/sort-property`

When `GET /items` names `sort=properties.<field>`, the server MUST order the items by the scalar value each stores in that property, whatever the item's type and whether the `type` filter is concrete, a wildcard or absent.

**Tests:** `correctness/property-sort-pagination.test.ts › walks numeric properties whatever the type filter`, `› walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-ascending`

When `GET /items` sorts by a property ascending, the server MUST put numbers and booleans first in numeric order, with `false` equal to `0` and `true` equal to `1`, followed by strings in binary lexical order of their UTF-8 bytes, an empty string being a value and numeric text remaining text.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-descending`

When `GET /items` sorts by a property descending, the server MUST reverse the scalar order, including the order between numbers and strings.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-missing`

When `GET /items` sorts by a property, the server MUST put the items whose property is missing, null, an object or an array after every scalar, in either direction.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-ties`

When `GET /items` sorts by a property, the server MUST order items with equal values, numerically equal booleans and numbers and the whole null tail included, by item ID ascending in both directions.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-cursor`

When a client follows `next_cursor` through a `GET /items` listing sorted by a property, the server MUST deliver every matching item once, across type boundaries, scalar kinds and ties.

**Reason:** the cursor keeps the scalar kind of the value it stopped at.

**Tests:** `correctness/property-sort-pagination.test.ts › walks numeric properties whatever the type filter`, `› walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

## Pages and limits

The items of one page and the key that continues them are in `search-and-filters/page-envelope`.

This section holds the pages of `GET /items` and `GET /search`. The other listings state theirs beside the rest of their rules, such as `edges/list-limit-default`, `events/audit-limit-default`, `events/record-limit-default`, `items/owner-trash-limit-default`, `search-and-filters/owner-summaries-limit-default`, `views/items-limit`, `versions/history-default-limit`, `connectors/runs-limit-default`, `connectors/list-agreements-limit-default`, `inbound-webhooks/deliveries-limit-default` and `folder-status/inventory-limit`.

### `search-and-filters/limit-listing-default`

When `GET /items` names no `limit`, the server MUST answer the page that a `limit` of 50 answers.

**Tests:** `compliance/page-limits.test.ts › $door answers its default page where it names no limit`.

### `search-and-filters/limit-listing`

When `GET /items` names a `limit` from 1 to 500, the server MUST answer a page of at most that many items.

**Tests:** `correctness/pagination.test.ts › takes a limit of 500, reads 501 as 500 and refuses 0, on the listing`, `› basic pagination: limit restricts result count and signals more`.

### `search-and-filters/limit-listing-capped`

When `GET /items` names a `limit` above 500, the server MUST answer a page of at most 500 items.

**Reason:** a client built for a larger page keeps working against a server whose page is smaller, because a client walks a listing by `next_cursor`, not by the length of a page.

**Tests:** `correctness/pagination.test.ts › takes a limit of 500, reads 501 as 500 and refuses 0, on the listing`.

### `search-and-filters/limit-listing-refused`

If `GET /items` names a `limit` that is below 1 or is not a number, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `correctness/pagination.test.ts › takes a limit of 500, reads 501 as 500 and refuses 0, on the listing`, `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`.

### `search-and-filters/limit-search-default`

When `GET /search` names no `limit`, the server MUST answer the page that a `limit` of 20 answers.

**Tests:** `compliance/page-limits.test.ts › $door answers its default page where it names no limit`.

### `search-and-filters/limit-search`

When `GET /search` names a `limit` from 1 to 100, the server MUST answer a page of at most that many hits.

**Tests:** `correctness/pagination.test.ts › takes a limit of 100 and refuses 101 and 0, on the search`, `› search respects limit parameter`.

### `search-and-filters/limit-after-filter`

When `GET /items` or `GET /search` names a `limit` with a `type` or `state` filter, the server MUST fill the page with the items that the filters select, up to the limit.

**Reason:** a limit applied before the filters would answer a short or empty page while matching items remain.

**Tests:** `compliance/filter-lists.test.ts › counts only the items the state and type lists keep`.

### `search-and-filters/limit-search-refused`

If `GET /search` names a `limit` that is not a whole number of 1 to 100, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `correctness/pagination.test.ts › takes a limit of 100 and refuses 101 and 0, on the search`, `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`, `› $door takes its largest page and refuses a limit past it or a fraction`.

### `search-and-filters/cursor-continues`

When a client sends back the `next_cursor` of a page of `GET /items`, the server MUST answer the page that follows it, so that walking to the end delivers every item exactly once.

**Tests:** `correctness/pagination.test.ts › cursor continuation delivers every item exactly once`, `› cursor is opaque and enables next page retrieval`.

### `search-and-filters/cursor-last-page`

When a page of `GET /items` holds the last item, the server MUST answer `next_cursor` `null`.

**Tests:** `correctness/pagination.test.ts › the last page answers next_cursor: null`.

### `search-and-filters/cursor-other-listing`

If a request to an operation that answers `next_cursor` sends a `cursor` that another operation or another ordering issued, then the server MUST answer `400 validation_error` with `details.field` `cursor`.

**Reason:** a cursor names a place in the order of the operation that issued it, so at any other operation, or under another ordering, it would answer a page that is not the next page, with nothing to say so. The server signs each cursor for its operation and ordering, so it can tell.

**Tests:** `correctness/pagination.test.ts › refuses a cursor issued by another listing or ordering`, `compliance/cursor-other-listing.test.ts › is refused at every listing but the one that issued it, naming cursor`.

### `search-and-filters/cursor-any-limit`

When a `GET /items` request sends a `cursor` with a `limit` other than the one the page it came from named, the server MUST continue the listing from that page.

**Tests:** `correctness/pagination.test.ts › continues a cursor under another limit`.

## The order of a listing

### `search-and-filters/listing-default-order`

When `GET /items` names no `updated_after` and either names `sort=created_at` or names no `sort` and is not `state=trashed` alone, the server MUST order the items by `created_at`, newest first unless `direction=asc`, then by `id` in the same direction.

**Tests:** `correctness/pagination.test.ts › orders a listing with no sort by created_at, then by id in the same direction`.

### `search-and-filters/listing-sort-updated`

When `GET /items` names `sort=updated_at` and no `updated_after`, the server MUST order the items by `updated_at`, newest first unless `direction=asc`.

**Tests:** `correctness/pagination.test.ts › orders a listing by updated_at when it names that sort`.

### `search-and-filters/listing-catch-up-order`

When `GET /items` names `updated_after`, the server MUST order the items by `updated_at`, then by `id`, ascending.

**Reason:** the order is the one a catch-up cursor advances through (`search-and-filters/updated-after-order`), and an `id` breaks a tie between items a bulk write gave one `updated_at`.

**Tests:** `correctness/pagination.test.ts › orders a catch-up by updated_at, then by id, ascending`.

### `search-and-filters/listing-sort-invalid`

If `GET /items` names a `sort` that is not `created_at`, `updated_at`, `occurred_at` or `properties.<field>` with a field of lowercase letters, digits and underscores, or a `direction` that is not `asc` or `desc`, then the server MUST answer `400 validation_error` naming the parameter.

**Tests:** `correctness/pagination.test.ts › refuses a sort or direction it does not take`.

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

**Reason:** the score is relative to the items of the index it ranks in, so it compares hits only within one search.

**Tests:** `compliance/search-matching.test.ts › scores a hit by its rank and gives the better hit the higher score`.

### `search-and-filters/search-cursor`

When a client sends back the `next_cursor` of a page of `GET /search` with the same query, the server MUST continue the ranking, so that walking to `null` delivers every hit once.

**Tests:** `compliance/envelope.test.ts › walks to a null cursor, delivering every hit once`.

### `search-and-filters/search-cursor-refused`

If a `GET /search` request sends a `cursor` that another listing issued, that another search issued, or that does not parse, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/envelope.test.ts › refuses a cursor another listing issued, and one it cannot read`, `› refuses a cursor minted for another search`.

### `search-and-filters/search-cursor-parameters`

If a `GET /search` request sends a `cursor` that a search issued under a different `q`, `type`, `state`, `source`, `include`, `tags`, `filter`, `occurred_after`, `occurred_before`, `updated_after`, `updated_before`, `sort` or `direction`, then the server MUST answer `400 validation_error`.

**Reason:** a position is meaningful only in the ranking it came from, so a cursor continued under another order or another set of hits would skip or repeat hits with no signal.

**Tests:** `compliance/search-ordering.test.ts › refuses a cursor issued under another sort, direction or filter`, `› refuses a cursor under any other query, type, state, list or time bound`.

### `search-and-filters/search-cursor-any-limit`

When a `GET /search` request sends a `cursor` with a `limit` other than the one the page it came from named, the server MUST continue the search from that page.

**Tests:** `compliance/search-ordering.test.ts › continues a cursor under another limit`.

### `search-and-filters/search-cursor-default-order`

When a `GET /search` request sends a `cursor` issued under the default `sort` and `direction`, the server MUST continue it whether the request leaves `sort` and `direction` out or names `relevance` and `desc`.

**Tests:** `compliance/search-ordering.test.ts › continues a cursor whether the default order is spelled out or left out`.

### `search-and-filters/search-cursor-sorted`

When a client sends back the `next_cursor` of each page of a `GET /search` that names a `sort`, the server MUST continue that ordering, so that walking to `null` delivers every hit once.

**Tests:** `compliance/search-ordering.test.ts › walks a sorted search to the end, delivering every hit once`.

### `search-and-filters/search-depth`

When a page of `GET /search` holds the 10,000th item of the ranking, the server MUST answer `next_cursor` of `null`.

**Reason:** the server reads the ranking at most 10,000 items deep, so a search is narrowed rather than paged past that depth.

**Tests:** `compliance/search-depth.test.ts › stops paging a search at its 10,000th item`.

### `search-and-filters/search-sort-relevance`

When `GET /search` names no `sort`, or `sort=relevance`, the server MUST order the hits by relevance, the best match first.

**Tests:** `compliance/search-ordering.test.ts › orders a search by relevance, best match first, and worst first when ascending`.

### `search-and-filters/search-sort-relevance-ascending`

When `GET /search` names `direction=asc` and no `sort` or `sort=relevance`, the server MUST order the hits by relevance, the worst match first.

**Reason:** a direction is honored rather than refused, because every ordering a search takes has two directions and this one is well defined.

**Tests:** `compliance/search-ordering.test.ts › orders a search by relevance, best match first, and worst first when ascending`.

### `search-and-filters/search-sort-column`

When `GET /search` names `sort=created_at`, `sort=updated_at` or `sort=occurred_at`, the server MUST order the hits by that column, newest first unless `direction=asc`.

**Tests:** `compliance/search-ordering.test.ts › orders a search by a time column, newest first unless told otherwise`.

### `search-and-filters/search-sort-property`

When `GET /search` names `sort=properties.<field>`, the server MUST order the hits by the scalar value each stores in that property, in the order `search-and-filters/sort-property-ascending` and `search-and-filters/sort-property-descending` give a listing, and put the hits whose property is missing, null, an object or an array after every scalar in either direction.

**Tests:** `compliance/search-ordering.test.ts › orders a search by a property with the items that lack one last in both directions`.

### `search-and-filters/search-sort-ties`

When `GET /search` orders hits that tie on relevance or on a property, the server MUST order them by item ID ascending in both directions.

**Reason:** an unordered tie is two answers to one query.

**Tests:** `compliance/search-ordering.test.ts › breaks a tie by item ID, ascending`, `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-sort-invalid`

If `GET /search` names a `sort` that is not `relevance`, `created_at`, `updated_at`, `occurred_at` or `properties.<field>` with a field of lowercase letters, digits and underscores, or a `direction` that is not `asc` or `desc`, then the server MUST answer `400 validation_error` naming the parameter.

**Tests:** `compliance/search-ordering.test.ts › refuses a sort or direction it does not take`.

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

When a query is not wholly inside double quotes, the server MUST match only the items in which every whitespace-separated word of it matches, in any order and in any column.

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

When a query has Unicode `White_Space` around it, the server MUST ignore it.

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

While an item is not in the bin, the server MUST match a query against the item's `title`, `body`, `description` and `name` where each is a string, every other string property its type declares or inherits, and its tags.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/index-order`

When a query is a phrase, the server MUST match it against the string properties of an item beyond the four core ones joined in the order of their names, and against its tags joined in byte order.

**Reason:** two indexes that join the text in the same order answer the same phrase.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/index-undeclared`

The server MUST NOT match a property that the item's type does not declare.

**Reason:** a thumbnail's base64 or an undeclared property is not text a person wrote to be found.

**Tests:** `compliance/search-matching.test.ts › $name: $query`.

### `search-and-filters/search-file-text`

When the enrichment sweep has written an `extracted_text` onto a file item that is not in the bin, the server MUST match a query against that text as it matches every other string property the item's type declares or inherits.

**Reason:** the text of a document or the words an OCR pass read from an image are what a person looks for in a file. A type that inherits a file type cannot give `extracted_text` another `searchable` than `core.file` gives it (`types/child-shape`), so a file type always finds the text it extracts.

**Tests:** `compliance/enrichment-search.test.ts › finds a file by a word only its extracted text holds, once the sweep has written it`.

### `search-and-filters/search-file-text-pending`

While a file item carries no `extracted_text`, the server MUST NOT match the item by words that only its bytes hold.

**Reason:** a file is found at once by its title and tags and by its text once the sweep has read its bytes, so a search never matches words that only the bytes hold before then.

**Tests:** `compliance/enrichment-search.test.ts › finds a file by a word only its extracted text holds, once the sweep has written it`.

### `search-and-filters/index-not-string`

The server MUST NOT match a value that is not a string.

**Tests:** `compliance/fts-searchable.test.ts › does not hold a value that is not a string, though the same text is found in a string`.

### `search-and-filters/index-unregistered`

When the type of an item is not registered, the server MUST match the item by its `title`, `body`, `description`, `name` and tags alone.

**Tests:** `compliance/fts-searchable.test.ts › keeps the four core properties and the tags of an item whose type was removed with force`.

### `search-and-filters/index-type-change`

When a type is registered, replaced, or deleted with `force`, the server MUST match each item not in the bin of that type and of each type that inherits from it by what the type then marks searchable.

**Reason:** what an item contributes to the index is decided when it is written, so without this an item would keep answering by the fields its type had until the item is next written, and a field marked `searchable: false` would stay matched.

**Tests:** `compliance/fts-searchable.test.ts › items already stored follow a change to what their type marks searchable`, `› indexes the items of a type that inherits again when its parent changes what it marks searchable`.

### `search-and-filters/rank-bm25`

When `GET /search` names no `sort`, or `sort=relevance`, the server MUST rank hits by BM25 over the `title`, `body`, `description`, `name`, extra properties and tags at equal weight.

**Reason:** a device ranks by the same measure (`device/rank-bm25`), so the two orders agree where they rank the same items.

**Tests:** `compliance/search-matching.test.ts › $name: $query`, `› scores a hit by its rank and gives the better hit the higher score`.

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

The server MUST write an excerpt as HTML in which every `&`, `<`, `>`, `"` and `'` of the item's text is escaped as `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`.

**Reason:** an app shows the excerpt as HTML, and an item's text is what a person or a source wrote, never markup for that app to render.

**Tests:** `compliance/search-matching.test.ts › escapes the item's text in an excerpt and marks only the match`.

### `search-and-filters/excerpt-markup`

The server MUST NOT put markup in an excerpt other than pairs of `<mark>` and `</mark>`, each pair opened before it closes.

**Tests:** `compliance/search-matching.test.ts › escapes the item's text in an excerpt and marks only the match`.

## Counts and exports

### `search-and-filters/owner-read-boundary`

When a request carries only private local authority to `GET /items/stats` or `GET /export`, the server MUST retain that route's credential requirement.

**Reason:** Counts and exports answer what a credential reaches, and the local command is not a credential.

**Tests:** `compliance/owner-item-read.test.ts › keeps counts and exports closed to the private local command, which a credential reads`.

## Counting

`GET /items/stats` counts the items a listing matches.

### `search-and-filters/stats-counts-listing`

When `GET /items/stats` names the filters of a `GET /items` listing, the server MUST count the items that listing matches.

**Tests:** `compliance/item-stats.test.ts › counts the items a listing's filters match`.

### `search-and-filters/stats-group`

The server MUST group the counts of `GET /items/stats` by lifecycle state, by type when the request names `by=type`, or by source code when it names `by=source`.

**Tests:** `compliance/item-stats.test.ts › counts the items a listing's filters match`, `compliance/source-names.test.ts › counts items by source under a listing's filters`.

### `search-and-filters/stats-every-state`

When `GET /items/stats` names no `state`, the server MUST count the items of every state, the bin included.

**Reason:** the default answer is the breakdown across the states, so the listing's own default of `active` does not apply.

**Tests:** `compliance/item-stats.test.ts › counts the items a listing's filters match`, `› answers the listing's own count as the bucket of its state, and the sum of the buckets under state=any`, `compliance/state-default.test.ts › a named state and the sentinel still reach every item`.

### `search-and-filters/stats-empty-group`

When no item that `GET /items/stats` counts falls in a state or a type, the server MUST leave that state or type out of the counts, and not answer it as `0`.

**Tests:** `compliance/item-stats.test.ts › counts the items a listing's filters match`, `compliance/filter-grammar.test.ts › counts on GET /items/stats among every state when none is named`.

### `search-and-filters/stats-equals-listing`

When `GET /items/stats` and `GET /items` name the same filters, the server MUST count as many items in the bucket of the named state, or in the `active` bucket where none is named, as the listing lists, and under `state=any` as many as the sum of the buckets.

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

`POST /items/lookup` finds items by link, by natural key or by id.

### `search-and-filters/lookup-answer`

When the server takes a `POST /items/lookup` request, the server MUST answer `200` with `data` and `tombstones` and no other key.

**Tests:** `compliance/links.test.ts › looks items up by link in every state, and refuses links for a type naming none`.

### `search-and-filters/lookup-by-link`

When `POST /items/lookup` names a `type` and `links`, the server MUST answer the items of exactly that type that hold them.

**Reason:** a link is one item's within its type (`items/link-taken`), so a subtype's item holding the same value is not found.

**Tests:** `compliance/links.test.ts › answers by link only the items of the type named`, `› looks items up by link in every state, and refuses links for a type naming none`.

### `search-and-filters/lookup-by-key`

When `POST /items/lookup` names `source` and `source_ids`, the server MUST answer the items holding those natural keys, whatever their type.

**Reason:** an item retyped since it was written is still found.

**Tests:** `compliance/links.test.ts › looks items up by natural key whatever their type`.

### `search-and-filters/lookup-by-id`

When `POST /items/lookup` names `ids`, the server MUST answer the items with those ids, whatever their type.

**Tests:** `compliance/links.test.ts › looks items up by id in every state, where bulk-get leaves the bin out, and leaves a system item out`.

### `search-and-filters/lookup-every-state`

When `POST /items/lookup` finds an item, the server MUST answer it in whatever state it holds, the bin included.

**Reason:** a lookup asks whether a key is held, and an item in the bin still holds it. `POST /items/bulk-get` leaves the bin out (`items/bulk-get`).

**Tests:** `compliance/links.test.ts › looks items up by link in every state, and refuses links for a type naming none`, `› looks items up by natural key whatever their type`, `› looks items up by id in every state, where bulk-get leaves the bin out, and leaves a system item out`.

### `search-and-filters/lookup-order`

The server MUST answer the items of `POST /items/lookup` in the order the request named their keys, each item once.

**Tests:** `compliance/links.test.ts › looks items up by link in every state, and refuses links for a type naming none`, `› looks items up by id in every state, where bulk-get leaves the bin out, and leaves a system item out`.

### `search-and-filters/lookup-system-left-out`

The server MUST leave out of the items of `POST /items/lookup` a `system.*` item, whichever key names it.

**Tests:** `compliance/links.test.ts › looks items up by id in every state, where bulk-get leaves the bin out, and leaves a system item out`, `› leaves out a system item that holds a natural key a lookup names`.

### `search-and-filters/lookup-unreadable-left-out`

The server MUST leave out of the items of `POST /items/lookup` an item whose type the credential's type map cannot read.

**Tests:** `compliance/links.test.ts › leaves out an item the key may not read, and refuses a key that may not read the type`.

### `search-and-filters/lookup-tombstones`

When `POST /items/lookup` names links or natural keys, the server MUST answer under `tombstones` what purges left under `type` for those keys, in the order named.

**Reason:** `items/tombstone` states what a purge leaves, and `items/tombstone-own-type` that a tombstone is answered only under the type it was recorded under.

**Tests:** `compliance/links.test.ts › leaves a tombstone for a purged item's link and natural key`, `› answers tombstones in the order named`, `› keeps each tombstone to its type, read and moved`.

### `search-and-filters/lookup-tombstones-subtype`

When `POST /items/lookup` answers a credential that may read a type under `type` and not `type` itself, the server MUST answer `tombstones` as an empty list.

**Reason:** the tombstones record what purges left under `type`, so they are answered only to a credential that may read `type` itself.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers no tombstones to a key that reads only a type under the one named`.

### `search-and-filters/lookup-source-filter`

When `POST /items/lookup` names `ids`, or `source` and `source_ids`, the server MUST answer an item that the `enforcement.source_filter` holding for the credential leaves out of `GET /items`.

**Reason:** a lookup names the items it wants, as a read by id does (`types/source-filter-by-id`), so an item left out would read as an item that does not exist.

**Tests:** `compliance/schema-enforcement.test.ts › answers an item the instance's source filter leaves out of listings, as a read by key`.

### `search-and-filters/lookup-edges`

When `POST /items/lookup` names `include: ["edges"]`, the server MUST add to each item its outbound edges as `GET /items?include=edges` does.

**Tests:** `compliance/links.test.ts › hydrates edges on a lookup as the listing does`.

### `search-and-filters/lookup-type-unreadable`

If `POST /items/lookup` names a registered `type` and the credential may read neither it nor any type under it, then the server MUST answer `403 type_not_permitted`.

**Reason:** an empty page would say that the keys named nothing. A type under `type` that the credential may read is held to `search-and-filters/type-descendant-readable`.

**Tests:** `compliance/unreadable-type-filter.test.ts › answers 403 where it used to answer an empty 200, and 400 for an unregistered type`, `compliance/links.test.ts › leaves out an item the key may not read, and refuses a key that may not read the type`.

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

**Tests:** `compliance/links.test.ts › looks items up by link in every state, and refuses links for a type naming none`, `› refuses a lookup naming no selector, two, or more than 500 values`.

### `search-and-filters/lookup-bad-id`

If a `POST /items/lookup` body names an id that is malformed, then the server MUST answer `400 invalid_id`.

**Tests:** `compliance/links.test.ts › looks items up by id in every state, where bulk-get leaves the bin out, and leaves a system item out`, `compliance/unreadable-type-filter.test.ts › answers 400 for a body it cannot read before it asks whether the key may read the type`.

### `search-and-filters/lookup-bad-type`

If a `POST /items/lookup` body names a `type` that is malformed, a wildcard included, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`, `compliance/unreadable-type-filter.test.ts › refuses a wildcard type, which names no one type, to every key`.

### `search-and-filters/lookup-unknown-type`

If a `POST /items/lookup` body names a well-formed `type` that nothing registers, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`, `compliance/unreadable-type-filter.test.ts › answers 403 where it used to answer an empty 200, and 400 for an unregistered type`.

## Pages

Every list and every search answers the same envelope. A hydrated block of edges is a page of the same shape (`edges/hydrate`), and so is an item's history (`versions/include-first-page`).

### `search-and-filters/page-envelope`

When a list or a search answers, the server MUST carry the items under `data` and the cursor that continues them under `next_cursor`, `null` on the last page, and no other key but a sibling that the operation's own rule names.

**Reason:** a client reads every page from one shape, and the siblings are `occurrences/answer-keys`, the `min_copies` of `GET /blobs/stores`, and the `retention_days` of `GET /trash`.

**Tests:** `compliance/envelope.test.ts › GET %s answers data and next_cursor`, `› names thirty-one doors, every one the document publishes as a page`.

### `search-and-filters/page-whole-set`

When a list takes no `cursor`, the server MUST answer its whole set with `next_cursor` `null`.

**Tests:** `compliance/envelope.test.ts › answers a null cursor from every door that takes none`.

### `search-and-filters/page-grants`

The server MUST answer `GET /auth/grants` in the envelope of a list.

**Tests:** `compliance/envelope.test.ts › answers GET /auth/grants to a key with grants.manage in the same envelope`.

### `search-and-filters/page-full-last`

When the items of a page fill it exactly and it holds the last item, the server MUST answer `next_cursor` `null` on every operation that takes a cursor.

**Reason:** a walk then never ends on an empty page it was sent to. A page can still be short or empty with a cursor to follow, so a walk stops on `null` and never on a short page (`edges/read-list-short`).

**Tests:** `compliance/full-last-page.test.ts › %s answers null when the items fill the page exactly`, `› covers every door that takes a cursor`.

## Export

`GET /export` admits a credential and answers the items that caller may read and the edges between them, as NDJSON or as an archive that `POST /restore` reads. Management permissions alone grant no content access (`blobs/export-operator-refused`).

### `search-and-filters/export-lines`

When `GET /export` names no `format`, the server MUST answer NDJSON with one line per item, carrying the item and its metadata.

**Tests:** `compliance/export.test.ts › filters by type`, `› filters by state`, `› carries on each item only the extension namespaces the key may read, on both output formats`.

### `search-and-filters/export-edge-lines`

When `GET /export` answers items, the server MUST follow the item lines with a line for each edge between the exported items.

**Reason:** `edges/read-export` and `edges/read-export-ends` state which edges are left out.

**Tests:** `compliance/export.test.ts › carries an edge line behind the item lines it joins`.

### `search-and-filters/export-type-map`

When a credential requests an export, the server MUST leave out the items of every type that its type map may not read.

**Tests:** `compliance/export.test.ts › respects type permissions on a scoped key`.

### `search-and-filters/export-extensions`

When `GET /export` answers a credential with an item, the server MUST carry on it only the extension namespaces that credential may read, in both formats.

**Reason:** an archive written by a credential restores only the namespaces that credential may read. `keys-and-oauth/extension-map-only` states what a credential may read of an extension.

**Tests:** `compliance/export.test.ts › carries on each item only the extension namespaces the key may read, on both output formats`.

### `search-and-filters/export-format`

If `GET /export` names a `format` other than `ndjson` or `archive`, then the server MUST answer `400 validation_error`.

**Reason:** a format that the server does not offer must not be served as the default.

**Tests:** `compliance/export.test.ts › refuses a format outside the two it offers`.

### `search-and-filters/export-without-files`

When `GET /export?format=archive` names `files=false`, the server MUST carry no `blobs/<hash>` entry, list no blob in `blobs`, count none in `blob_count`, and name in `missing_blobs` each blob the archive would otherwise have carried.

**Reason:** a person who wants a copy of their items, and not the often far larger files they name, can take one, and a restore of it reports in `blobs_missing` the files the instance it restores into does not hold.

**Tests:** `compliance/export.test.ts › leaves out the bytes of files and names them under missing_blobs when it names files=false`.

### `search-and-filters/export-state-default`

When `GET /export` names no `state`, the server MUST carry the items of every state but `trashed`.

**Reason:** the archive this operation writes is what a restore reads back, so a default that dropped archived items would lose them on the round trip. The bin is the one thing a copy leaves behind.

**Tests:** `compliance/state-default.test.ts › an export that names no state carries archived items`, `compliance/export.test.ts › carries archived items and leaves out the bin when an archive names no state`.

### `search-and-filters/export-state-any`

When `GET /export` names `state=any`, the server MUST carry every item it holds, the bin included, in both formats.

**Tests:** `compliance/export.test.ts › carries every item it holds, the bin included, when it names state=any, on both formats`.

### `search-and-filters/export-state-trashed`

When `GET /export` names `state=trashed`, the server MUST carry only the items in the bin, in both formats.

**Tests:** `compliance/export.test.ts › carries only the items in the bin when it names state=trashed, on both formats`.

### `search-and-filters/archive-media-type`

When `GET /export` names `format=archive`, the server MUST answer a tar archive with `Content-Type: application/x-tar`.

**Reason:** the line files inside are compressed and the blobs are mostly compressed already, so compressing the whole archive again costs time for nothing.

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`.

### `search-and-filters/archive-same-selection`

When `GET /export?format=archive` names the filters of an NDJSON export, the server MUST select the items that export selects.

**Tests:** `compliance/export.test.ts › carries every item it holds, the bin included, when it names state=any, on both formats`, `› carries only the items in the bin when it names state=trashed, on both formats`, `› refuses a bound that is not an instant, on both output formats`.

### `search-and-filters/archive-entries`

The server MUST write an archive's entries in this order: `manifest.json`, then the gzip-compressed line files `instance.ndjson.gz`, `items.ndjson.gz`, `edges.ndjson.gz` and `rows.ndjson.gz`, then an uncompressed `blobs/<hash>` entry for each blob its manifest lists in `blobs`.

**Reason:** the manifest comes first, so a reader knows what the archive holds before it reads the rest, and the registrations come before the item, edge and row lines, so a restore can check each line as it arrives.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `search-and-filters/archive-manifest`

The server MUST write into the manifest of an archive its `version`, its `format` of `marfa-archive-v0`, a `created_at` instant, and in `item_count`, `edge_count`, `row_count`, `blob_count`, `type_count`, `edge_type_count`, `type_icon_count`, `source_count`, `setting_count`, `connector_state_count` and `connector_agreement_count` the number of each kind of entry or line the archive holds.

**Reason:** `instance/archive-version` and `instance/id-in-archive` state the version and the instance's name in the manifest.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`, `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `search-and-filters/archive-manifest-blobs`

The server MUST list in the manifest of an archive each blob it carries, with its MIME type and its size in bytes.

**Tests:** `compliance/export.test.ts › opens an archive with its manifest, and the manifest counts what the archive holds`.

### `search-and-filters/archive-missing-blobs`

When an archive would carry a blob of which no attached store holds a copy that the copy record records, at the blob's whole size, the server MUST name the blob in the manifest's `missing_blobs` with its MIME type and its size in bytes.

**Reason:** one lost file costs the backup that file and not the rest of the instance, and the manifest, which a reader reads first, says which file the archive lacks. The bytes a struck or dropped copy leaves in its store are not the blob's (`stores/no-bytes-not-found`).

**Tests:** `compliance/export-missing-blob.test.ts › names a blob whose file has left the disk under missing_blobs, and carries the rest`, `› names a blob whose struck copy is the only one under missing_blobs, and answers a whole archive`.

### `search-and-filters/archive-missing-unrecorded`

When an item that `GET /export?format=archive` carries is of `core.file` or a type that inherits from it, in its current version or a snapshot the archive carries, and its `blob_ref` is a whole `sha256:` hash that the instance holds no blob of and that the caller may read, the server MUST name the hash in the manifest's `missing_blobs` with a `mime_type` and a `size_bytes` of `null`.

**Reason:** a blob that a restore answered missing keeps being named by every later backup, with no record of it standing in for bytes the instance does not hold. Its type and size are not known, so they are not given.

**Tests:** `compliance/export-missing-blob.test.ts › names in a later archive's missing_blobs a file's blob that a restore answered missing`.

### `search-and-filters/archive-missing-unreadable`

When an item that `GET /export?format=archive` carries is of `core.file` or a type that inherits from it, in its current version or a snapshot the archive carries, and its `blob_ref` is a whole `sha256:` hash that the credential requesting the archive could not read through the blob operations, the server MUST name the hash in the manifest's `missing_blobs` with a `mime_type` and a `size_bytes` of `null`.

**Reason:** an archive written by a credential lacking `blobs.manage` leaves out the bytes of a file that only an earlier version names (`search-and-filters/archive-history-bytes`), and naming them tells a reader, a restore and `marfa export` that the archive lacks that file. The type and size are not given, and the hash is named whether or not the instance holds the blob, so the archive says no more of the blob than the blob operations do (`blobs/read-unreadable`).

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names in missing_blobs only a file's it could not`.

### `search-and-filters/archive-missing-only-blobs`

The server MUST NOT name in the manifest's `missing_blobs` a hash that the instance holds no blob of and that no carried file's `blob_ref` names.

**Reason:** a run of hex in an item's text, or in any other property, may be anything, such as a checksum someone noted down. Only the instance's own record, or a file's `blob_ref`, makes it a blob.

**Tests:** `compliance/export-missing-blob.test.ts › names in a later archive's missing_blobs a file's blob that a restore answered missing`.

### `search-and-filters/archive-unreadable-only-files`

The server MUST NOT name in the manifest's `missing_blobs` a hash that the credential requesting the archive could not read through the blob operations and that no carried file's `blob_ref` names.

**Reason:** only the instance's record makes such a hash a blob, so naming it would tell the credential whether the instance holds bytes that the blob operations answer as unknown (`blobs/read-unreadable`). An archive written by such a credential can therefore lack, without naming it, a blob that a hash outside a file's `blob_ref` refers to. An export by the owner, or by a credential holding `blobs.manage`, reads every blob.

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names in missing_blobs only a file's it could not`.

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

If the bytes `GET /export?format=archive` reads from a store's copy of a blob are as long as the blob and do not hash to its name, and the copy still does not hash to the name when it is read again under the blob's upload lock, then the server MUST strike that copy from the copy record.

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

The server MUST hold nothing in an archive but `manifest.json`, `instance.ndjson.gz`, `items.ndjson.gz`, `edges.ndjson.gz`, `rows.ndjson.gz` and the `blobs/` entries.

**Reason:** an archive carries no credential, so no key, session, grant, passkey, connector registration, webhook subscription or `marfa.secrets`, and no tombstone or runtime record, such as a run, a hold, a delivery, a folder report or a bulk job, though an instance holds them. A restore means setting up sign-in again.

**Tests:** `compliance/export.test.ts › holds nothing in an archive but its manifest, line files and blobs, and carries no webhook`.

### `search-and-filters/archive-types`

The server MUST carry in the `instance.ndjson.gz` of an archive a `type` line for every type, and an `edge_type` line for every edge type, registered on the instance beside the ones the build ships, whatever the selection and whatever the credential may read.

**Reason:** the registrations are the instance's own and not the selected items', so a restore into a new instance gets the types its items need.

**Tests:** `compliance/export.test.ts › carries every registered type and edge type in an archive, whatever its selection and credential reach`.

### `search-and-filters/archive-type-icons`

The server MUST carry in the `instance.ndjson.gz` of an archive one `type_icon` line, holding the `type_id` and the `icon`, for each icon the owner has chosen for a type, and count them in the manifest's `type_icon_count`.

**Reason:** the owner's icons are kept beside the definitions and not in them (`types/icon-kept`), so an archive that carried only definitions would lose every choice on a move to a new instance.

**Tests:** `compliance/type-icons.test.ts › carries the owner's icons in an archive and adds back those the instance lacks, replacing none`.

### `search-and-filters/restore-type-icons`

When `POST /restore` reads a `type_icon` line, the server MUST set that icon for the type only if the instance has no owner icon for it, count each icon set in `type_icons_added` and each icon left in `type_icons_skipped`, and replace no owner icon the instance already has.

**Reason:** a restore adds what the instance lacks and replaces nothing, and an icon the owner chose here since the export is newer than the archive's.

**Tests:** `compliance/type-icons.test.ts › carries the owner's icons in an archive and adds back those the instance lacks, replacing none`.

### `search-and-filters/restore-type-icons-skipped`

If a `type_icon` line of an archive names an icon that `types/icon-name` refuses, then the server MUST skip that line, set no icon for the type, and count it in `type_icons_skipped` and under `unknown_icon` in `type_icons_skipped_reasons`; an icon skipped because the instance has an owner icon for the type is counted under `already_set`.

**Reason:** an archive made by a build that pins other sets or versions holds a well-formed line this instance cannot draw, and one such line must not keep an owner from restoring everything else, as an edge a restore cannot place is skipped and counted instead of refusing the archive (`search-and-filters/restore-edge-skips`). The rule covers `type_icon` lines only: an archived type definition is held to the same check as a registered one, so a definition whose `display_hints.icon` `types/icon-name` refuses, a bare name among them, refuses the archive. Until the first public release an archive is read only by the build that wrote it, so no archive from before icons were Iconify IDs is expected to restore.

**Tests:** `compliance/type-icons.test.ts › skips and counts an icon outside the pinned sets, and refuses a line that names no type or no icon string, writing nothing`.

### `search-and-filters/restore-type-icons-refused`

If a `type_icon` line of an archive is not an object holding a `type_id` and a string `icon`, or names a type that neither the archive nor the instance registers, then the server MUST answer `POST /restore` with `400 invalid_schema` and write nothing.

**Reason:** a line that is damaged, or an icon for a type nothing registers (`types/icon-missing-type`), is a fault in the archive and not a difference of release, and a restore checks every line before it writes any.

**Tests:** `compliance/type-icons.test.ts › skips and counts an icon outside the pinned sets, and refuses a line that names no type or no icon string, writing nothing`.

### `search-and-filters/archive-sources`

The server MUST carry in the `instance.ndjson.gz` of an archive one `source` line, holding the `source` code and its `name` and `mark` or `null` for each, for every source with a name or mark set in a backup and, in an export, for each such source of the items the archive carries, and count them in the manifest's `source_count`.

**Reason:** a source's name and mark are kept beside its items and not in them, so an archive that carried only items would lose them on a move to a new instance.

**Tests:** `compliance/source-names.test.ts › carries a named source in an archive and adds it back where the instance names none, replacing none`.

### `search-and-filters/restore-sources`

When `POST /restore` reads a `source` line, the server MUST set that name and mark on the source only if the instance has neither set on it, count each source set in `sources_added` and each line left in `sources_skipped`, and replace no name or mark the instance already has.

**Reason:** a restore adds what the instance lacks and replaces nothing, and a name set here since the export is newer than the archive's.

**Tests:** `compliance/source-names.test.ts › carries a named source in an archive and adds it back where the instance names none, replacing none`.

### `search-and-filters/restore-sources-app`

When `POST /restore` reads a `source` line whose code starts with `oauth:`, the server MUST set the name and mark on that code with `restored:` before it, the code the restore gives the items of that source.

**Reason:** a restored item keeps no app's authority (`keys-and-oauth/claims-reserved`), so its source's name follows it to the restored code.

**Tests:** `compliance/source-names.test.ts › skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing`.

### `search-and-filters/restore-sources-shared-code`

If two `source` lines of an archive land on one code once `search-and-filters/restore-sources-app` has mapped them, then the server MUST keep the line that already carries that code, whatever the order of the lines, skip the other, and count it in `sources_skipped` and under `duplicate_code` in `sources_skipped_reasons`.

**Reason:** an instance can name both an app's source and the restored code it maps to, and an archive of it has to restore, not be refused.

**Tests:** `compliance/source-names.test.ts › restores the line that carries the code when two land on one`.

### `search-and-filters/restore-sources-skipped`

If a `source` line of an archive names a `mark` that `types/icon-name` refuses, then the server MUST skip that line, set nothing on the source, and count it in `sources_skipped` and under `unknown_mark` in `sources_skipped_reasons`; a line skipped because the instance has a name or mark set on the source is counted under `already_set`.

**Reason:** an archive made by a build that pins other icon sets holds a well-formed mark this instance cannot draw, as `search-and-filters/restore-type-icons-skipped` says of a type's icon.

**Tests:** `compliance/source-names.test.ts › skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing`.

### `search-and-filters/restore-sources-refused`

If a `source` line of an archive is not an object, holds a `source` code that `keys-and-oauth/source-code-length` refuses, as it stands or once `search-and-filters/restore-sources-app` has mapped it, holds neither a `name` nor a `mark`, holds a `name` that `PATCH /source` could not store as it stands, or holds a `mark` that is not a string, then the server MUST answer `POST /restore` with `400 invalid_schema` and write nothing.

**Tests:** `compliance/source-names.test.ts › skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing`.

### `search-and-filters/archive-settings`

When the credential requesting `GET /export?format=archive` holds `config.manage`, the server MUST carry in `instance.ndjson.gz` one `setting` line, holding the setting's `key` and its `value`, for each setting stored on the instance apart from `sign_in_address` and `addresses`.

**Reason:** an owner's settings are their own choices, and a restore that reset them would change the instance without saying so. The two addresses name where this instance answers, which a move changes. No setting holds a secret.

**Tests:** `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `search-and-filters/restore-settings`

When `POST /restore` reads a `setting` line, the server MUST store that setting only where the instance has none stored, and replace no setting the instance has.

**Reason:** a restore adds what the instance lacks and replaces nothing, and a setting chosen here since the export is newer than the archive's.

**Tests:** `compliance/export-instance-lines.test.ts › restores the settings, connector state and agreements the instance lacks, and replaces none it holds`.

### `search-and-filters/restore-settings-together`

If the settings that `POST /restore` would store, judged with the instance's own, break a rule that `/config` applies across settings (`instance/live-policy-validation`), then the server MUST refuse the archive with the `400 validation_error` and `details.errors` that `/config` answers for them, and store nothing.

**Reason:** a restore is not a way to hold settings that the configuration door would refuse, such as a heartbeat with no receiver or version windows out of order.

**Tests:** `compliance/export-instance-lines.test.ts › refuses settings the instance cannot hold together, answering as /config does, and stores none`.

### `search-and-filters/restore-setting-twice`

If the `instance.ndjson.gz` of an archive carries more than one `setting` line for the same key, then the server MUST answer `400 validation_error`.

**Reason:** two values for one setting have no single meaning, and the restore would otherwise count both as stored.

**Tests:** `compliance/export-instance-lines.test.ts › refuses an archive that carries one setting twice, and stores neither value`.

### `search-and-filters/archive-connector-state`

When the credential requesting `GET /export?format=archive` holds `connectors.manage`, the server MUST carry in `instance.ndjson.gz` one `connector_state` line, holding the `source` and its `state` document, for each source with a connector state document.

**Reason:** the state is what a connector has agreed with the instance about its source, and without it a restored instance has every connector import everything again. A connector's registration belongs to its key and stays out.

**Tests:** `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `search-and-filters/restore-connector-state`

When `POST /restore` reads a `connector_state` line, the server MUST store that state document only where the instance holds none for the source, and replace none it holds.

**Tests:** `compliance/export-instance-lines.test.ts › restores the settings, connector state and agreements the instance lacks, and replaces none it holds`.

### `search-and-filters/archive-connector-agreements`

When the credential requesting `GET /export?format=archive` holds `connectors.manage`, the server MUST carry in `instance.ndjson.gz` one `connector_agreement` line, holding the `source`, the `item_id`, `waiting` and the `record`, for each connector agreement whose item the archive carries.

**Reason:** an agreement pairs an item with a record outside, so it travels with the item and not without it.

**Tests:** `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

### `search-and-filters/restore-connector-agreements`

When `POST /restore` reads a `connector_agreement` line whose item the instance holds once the archive's items are written, the server MUST store that agreement only where the instance holds none for the source and the item, and replace none it holds.

**Tests:** `compliance/export-instance-lines.test.ts › restores the settings, connector state and agreements the instance lacks, and replaces none it holds`.

### `search-and-filters/archive-no-webhooks`

The server MUST NOT carry a webhook subscription in an archive.

**Reason:** a subscription belongs to the key or app that made it, and neither travels in an archive (`search-and-filters/archive-only`), so a restored subscription would belong to nothing. The owner makes it again after a restore.

**Tests:** `compliance/export.test.ts › holds nothing in an archive but its manifest, line files and blobs, and carries no webhook`, `compliance/export-instance-lines.test.ts › carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not`.

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

**Tests:** `compliance/archive-history.test.ts › carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names in missing_blobs only a file's it could not`.

### `search-and-filters/archive-selection-read`

The server MUST read every item, edge, registration and record an archive carries from one snapshot of the instance, and count in its manifest exactly the items, edges and rows its line files hold.

**Reason:** one snapshot is one committed state, so no write can make the items and edges an archive carries disagree with each other, and the selection is read whole before the first byte is sent, because the manifest comes first and a tar header carries each entry's size.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › counts every item the archive holds in its manifest when the headers arrive`.

### `search-and-filters/archive-item-as-read`

When an item is written after the selection read of `GET /export?format=archive` has begun, the server MUST carry the item as it stood before that write.

**Reason:** the archive's selection is one snapshot, taken before its headers are sent.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › carries an item as it stood when the export read it, whatever is written to it after the headers`.

### `search-and-filters/archive-no-later-item`

When an item is created after the selection read of `GET /export?format=archive` has begun, the server MUST NOT carry it.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › does not carry an item created after the headers arrived`.

### `search-and-filters/archive-edge-before`

When an edge between two carried items exists when the selection read of `GET /export?format=archive` begins, the server MUST carry the edge.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › carries an edge created before the export began, and not one created after its headers arrived`.

### `search-and-filters/archive-no-later-edge`

When an edge is created after the selection read of `GET /export?format=archive` has begun, the server MUST NOT carry it.

**Tests:** `compliance/export-snapshot.test.ts › carries the selection as it stood when the read began, and counts what its line files hold`, `compliance/export.test.ts › carries an edge created before the export began, and not one created after its headers arrived`.

### `search-and-filters/archive-restorable`

When `GET /export?format=archive` returns a complete archive, the server MUST ensure that the archive passes `POST /restore` validation into an empty store running the same build, without skipping any carried item or edge.

**Reason:** `schema.write` permits replacements that leave an earlier item that a restore refuses, such as a type that becomes an event while an item holds a rule no calendar read can unfold (`types/evolve-schema-write`), so the export checks every item and edge it carries with the restore's own checks. The guarantee excludes destination conflicts and the destination's own settings; missing blobs keep their declared missing status.

**Tests:** `compliance/export-write-order.test.ts › restores an archive as its selection stood when read, whatever lands while it is read`, `› restores a custom type retyped away and deleted between archive pages`.

### `search-and-filters/archive-items-shape-free`

When `GET /export?format=archive` selects an item that is not of a `core` or `system` type that this build ships, the server MUST NOT refuse the export because the item lacks a field its type requires, holds a value its type's field does not accept, or is of a type that is not registered.

**Reason:** the export checks the selection with the restore's checks (`search-and-filters/archive-restorable`), and a restore takes such an item (`search-and-filters/restore-items-shape-free`, `search-and-filters/restore-items-orphan`). A type gains a required field while its items stand (`types/field-gained`), and a forced delete leaves the items of a type (`types/delete-force`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-items-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`, `› restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `search-and-filters/archive-edges-unregistered`

When `GET /export?format=archive` selects an edge whose edge type is not registered, the server MUST NOT refuse the export because the edge type is not registered.

**Reason:** the export checks the selection with the restore's checks (`search-and-filters/archive-restorable`), and a restore takes such an edge (`search-and-filters/restore-edges-unregistered`). A forced delete leaves the edges of an edge type (`edges/types-delete-force-keeps`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-edges-unregistered.test.ts › keeps the edge as the archive holds it, reads it as the origin does, and restores its own export again`.

### `search-and-filters/archive-edges-end-unregistered`

When `GET /export?format=archive` selects an edge with an end that is an item of a type that is not registered, the server MUST NOT refuse the export because the edge type's `source_type_constraints` or `target_type_constraints` do not admit that end.

**Reason:** the export checks the selection with the restore's checks (`search-and-filters/archive-restorable`), and a restore takes such an edge (`search-and-filters/restore-edges-end-unregistered`). A forced delete leaves the items of a type and the edges between them (`types/delete-force`), so an instance that refused to export them could not be backed up.

**Tests:** `compliance/restore-edges-constraint-types.test.ts › keeps an edge whose source constraint names the deleted type, and still refuses a registered end the constraint does not admit`, `› keeps an edge whose target constraint names the deleted type`, `› judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names`.

### `search-and-filters/archive-entries-refused`

If an item or an edge of the selection of `GET /export?format=archive` is one a restore would refuse or skip, then the server MUST answer `409 export_entry_unrestorable` without sending archive bytes, with `details.entry` naming it by its `kind`, `id`, `type` and `field` and the `code` that restore refuses it with or the reason restore skips it for.

**Reason:** the fault is in the instance's own data, such as an item that a type's replacement schema no longer accepts, so the owner needs the item named to correct it.

**Tests:** `compliance/export-entries-refused.test.ts › answers 409 naming the entry, and exports once the entry is corrected`.

### `search-and-filters/archive-spool-ended`

When a `GET /export?format=archive` response ends, whether the archive was read whole or the client left, the server MUST leave nothing of the export on disk.

**Reason:** the export keeps what it has read in the `tmp` folder of the disk store, and a copy of the instance's content that nobody will read must not stay there.

**Tests:** `compliance/export-spool.test.ts › leaves nothing in the spool once the whole archive has been read`, `› leaves nothing in the spool once the client has left`.

### `search-and-filters/archive-spool-fault`

If the selection read, the check of its lines or the sending of `GET /export?format=archive` fails, then the server MUST leave nothing of the export on disk.

**Tests:** `compliance/export-faults.test.ts › is answered with an error, not an archive, and leaves nothing of the export on disk`.

### `search-and-filters/archive-spool-start`

When the process starts, the server MUST remove whatever an export that a stopped process was writing left on disk.

**Reason:** a process that is stopped during an export cannot remove its own copy.

**Tests:** `compliance/export-spool.test.ts › keeps the spool of an export a stopped process was writing until the next start, and then clears it`.

### `search-and-filters/archive-spool-reserve`

Where an instance keeps a reserve of free space, if the files that a `GET /export?format=archive` writes before its first byte would leave less free on the volume that holds the disk store's folder than the reserve, then the server MUST answer `507 insufficient_storage` without sending archive bytes.

**Reason:** the export keeps what it has read in the disk store's `tmp` folder, and the shipped image puts the database on the same volume, so the export of a large instance could take the room every other write needs (`blobs/upload-reserve`).

**Tests:** `compliance/export-reserve.test.ts › is refused 507 insufficient_storage before any archive byte, naming the reserve and the room, and leaves nothing on disk`, `› is sent whole while the volume has room beside the reserve, which is the witness for the refusal below`.

### `search-and-filters/archive-failed-read`

If a read fails after the body of `GET /export?format=archive` has begun, then the server MUST end the response with an error and not with a clean end.

**Reason:** the status and headers are sent before the first byte, so the failure shows only as a connection cut short and a tar with no end, which is an archive that nobody mistakes for a complete one.

**Tests:** `compliance/export-faults.test.ts › ends the response with an error, so the archive is cut short and cannot be taken for a whole one, and leaves nothing on disk`.

### `search-and-filters/export-credential-ended`

When the key or signed-in app that a `GET /export` request was admitted on is revoked, passes its expiry or is disconnected while the response is open, the server MUST end the response with an error and not with a clean end, in both formats and while an archive sends a blob.

**Reason:** what a key holds open ends with it (`keys-and-oauth/revoke-immediate`), and a response that ended cleanly after its credential ended would read as a whole copy.

**Tests:** `compliance/export-credential.test.ts › ends with an error when its key is revoked`, `› ends with an error when its key passes its expiry`, `› ends with an error when the app that opened it is disconnected`, `› ends with an error when its key is revoked while a blob is being sent`.

### `search-and-filters/export-credential-narrowed`

If the credential that a `GET /export` request was admitted on is narrowed while the response is open, so that it no longer reads something the export has still to send, then the server MUST end the response with an error and not with a clean end, in both formats.

**Reason:** an export that left out what the credential can no longer read would be a copy that is incomplete without saying so, and an archive has already promised its items, edges and blobs in its manifest.

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

`POST /restore` takes an archive that `GET /export?format=archive` wrote, with local authority, and answers counts of what it wrote and skipped.

### `search-and-filters/restore-operator`

If a working key sends `POST /restore`, then the server MUST answer `403 forbidden`.

**Reason:** full restoration can write server-managed records, so ordinary app and key permissions cannot authorize it.

**Tests:** `compliance/restore-archive.test.ts › requires local authority`.

### `search-and-filters/restore-roundtrip`

When local authority sends `POST /restore` with an archive that `GET /export?format=archive` wrote, the server MUST answer `200` with the counts of what it restored.

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`.

### `search-and-filters/restore-counts`

When `POST /restore` succeeds, the server MUST carry the counts `imported`, `duplicates`, `edges_imported`, `edges_skipped`, `edges_skipped_reasons`, `blobs_imported`, `types_registered`, `types_skipped`, `edge_types_registered`, `edge_types_skipped`, `type_icons_added`, `type_icons_skipped`, `type_icons_skipped_reasons`, `sources_added`, `sources_skipped`, `sources_skipped_reasons`, `settings_added`, `settings_skipped`, `connector_states_added`, `connector_states_skipped`, `connector_agreements_added`, `connector_agreements_skipped`, `rows_imported` and `rows_skipped`, each for the kind of thing it counts.

**Tests:** `compliance/restore-archive.test.ts › answers the restore result fields on the first restore and on a repeat`.

### `search-and-filters/restore-set-up-again`

When `POST /restore` succeeds, the server MUST answer in `set_up_again` a sentence saying that an archive holds no sign-in, keys, apps or webhooks, and that they are set up again on the instance.

**Reason:** an archive holds no credential (`search-and-filters/archive-only`), so after a move the owner signs in, makes keys, approves apps and makes webhooks again, and the answer says so where the owner reads the outcome.

**Tests:** `compliance/restore-archive.test.ts › answers the restore result fields on the first restore and on a repeat`.

### `search-and-filters/cli-restore-refused`

When `POST /restore` refuses an archive that `marfa restore` sends, whether before the body or while it arrives, the CLI MUST report that refusal's status and code.

**Reason:** a person restoring a large archive learns why it was refused, not that a connection broke.

**Tests:** `cli/archive-blobs.test.ts › reports the refusal of a large archive the server refuses before or while it arrives`.

### `search-and-filters/cli-restore-set-up-again`

When `POST /restore` answers `marfa restore` with `set_up_again`, the CLI MUST print that sentence on standard error.

**Reason:** the person running the command learns there and then that sign-in, keys, apps and webhooks are not restored.

**Tests:** `cli/archive-blobs.test.ts › prints the answer of a restore of it and exits 1 with blobs_missing`.

### `search-and-filters/restore-blobs-missing`

When `POST /restore` succeeds, the server MUST answer in `blobs_missing` the hash of each blob that the archive's manifest names in `blobs` or `missing_blobs`, that no entry of the archive carries bytes hashing to, that no attached store of the instance holds a recorded copy of at its recorded size, and that the object store does not hold under its name (`search-and-filters/restore-blob-from-store`).

**Reason:** an archive that lacks a file says so on the restore rather than restoring as though it were complete. Uploading the bytes again through `POST /blobs` restores the file.

**Tests:** `compliance/export-missing-blob.test.ts › answers in blobs_missing a blob the archive names and lacks, and none the instance holds`, `› answers in blobs_missing a blob the manifest lists that the archive carries no bytes for`, `compliance/restore-from-store.test.ts › answers in blobs_missing a file the object store does not hold`, `› answers nothing in blobs_missing on an instance that holds every file the archive names`.

### `search-and-filters/restore-blob-from-store`

When `POST /restore` reads an archive that names a blob it does not carry and that no attached store holds a recorded copy of, if the attached object store holds an object under the blob's name whose bytes hash to it and that names that store as its writer, then the server MUST record that object as the store's copy of the blob.

**Reason:** a backup or an archive exported with `files=false` leaves the files where the instance kept them, so a new instance started on the same bucket gets them back by restoring the archive. The bytes are read and checked before the copy is recorded, so an object that is not the blob is never served as it.

**Tests:** `compliance/restore-from-store.test.ts › takes each file from the object store it was kept in, checked against its name, and records the copy`.

### `search-and-filters/restore-store-unavailable`

If a store fails, or does not answer within 15 seconds, while `POST /restore` checks whether the instance holds a blob that the archive names and does not carry, and no other attached store holds a recorded copy of the blob whole, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** a store that cannot answer is no evidence that the instance lacks the blob, so the restore does not answer it in `blobs_missing`.

**Tests:** `compliance/export-missing-blob.test.ts › answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob`, `› restores an archive lacking a blob that the object store holds whole while the disk cannot be read for it`, `compliance/restore-from-store.test.ts › takes each file from the object store it was kept in, checked against its name, and records the copy`.

### `search-and-filters/restore-store-unfinished`

While a write or a deletion of a blob's bytes that the server stopped waiting for has neither been answered by its store nor given up by the server, if `POST /restore` names that blob in its archive, then the server MUST answer `503 blob_store_unavailable`.

**Reason:** on the disk, where a restore lands a blob's bytes, a late deletion could remove the bytes the restore would register, and waiting would hang the request on a store that may never answer. The caller still holds the archive and can send it again.

**Tests:** `compliance/blob-store-silent.test.ts › leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends`.

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

### `search-and-filters/cli-export-archive-wait`

When `marfa export --format archive` has sent its request, the CLI MUST wait up to 30 minutes for the server to begin its answer.

**Reason:** the server checks the whole selection before it sends an archive (`search-and-filters/archive-restorable`), so its first byte comes after a time that grows with the instance: about 4 seconds for 250,000 items on a fast computer at rest, and many times that on a small server that is busy, which can pass the 90 seconds the CLI gives most commands for an answer to begin. A bound that is too short ends the export of the instances that most need a backup, and the server then drops the request.

**Tests:** `cli/archive-wait.test.ts › waits for an archive whose first byte comes after the usual answer budget, says it is working, and writes the path once the archive ends whole`.

### `search-and-filters/cli-export-archive-working`

While `marfa export --format archive` waits for the server to begin its answer, the CLI MUST say on standard error, from the fifth second and every 15 seconds after, that it is still preparing the archive.

**Reason:** an export that says nothing for minutes looks like a hung command, and a person or a scheduler would end it.

**Tests:** `cli/archive-wait.test.ts › waits for an archive whose first byte comes after the usual answer budget, says it is working, and writes the path once the archive ends whole`.

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

When `POST /restore` skips an edge, the server MUST count it in `edges_skipped_reasons` under exactly one of these reasons: `already_present` when the instance already holds the edge, `endpoint_missing` when, once the archive's items are written, the instance holds no item under an endpoint's id, in the bin or out of it, `malformed` when the line does not give both endpoints and the edge type as strings, and otherwise the error code that `POST /edges` would answer for the edge, other than `edge_type_not_found`, which a restore does not give (`search-and-filters/restore-edges-unregistered`).

**Reason:** a restore judges each edge as `POST /edges` does, except where `search-and-filters/restore-edges-bin`, `search-and-filters/restore-edges-unregistered`, `search-and-filters/restore-edges-end-unregistered` and `edges/properties-restore-kept` say otherwise and for an `in-folder` edge to a revoked folder, which it keeps as the folder kept it (`edges/folder-revoked-keeps`). It skips an edge it refuses rather than refusing the archive.

**Tests:** `compliance/restore-archive.test.ts › answers the restore result fields on the first restore and on a repeat`, `› counts an edge that POST /edges would refuse under the code of its refusal, and keeps one whose type nothing registers`, `compliance/archive-scalars.test.ts › refuses an invalid edge version even when its endpoint is missing`.

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

When an archived item holds an id or a natural key that an item on the instance already holds, or a link that an item of its type already holds, the server MUST count it in `duplicates`.

**Reason:** a link is one item's within its type (`items/link-taken`).

**Tests:** `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `› answers the restore result fields on the first restore and on a repeat`, `compliance/links.test.ts › counts an archived item whose link another item holds as a duplicate`.

### `search-and-filters/restore-duplicate-kept`

When `POST /restore` counts an archived item as a duplicate, the server MUST leave the existing item's properties, tags, extensions and history as they are.

**Reason:** replaying a backup must not overwrite work made since the backup.

**Tests:** `compliance/archive-history.test.ts › leaves an existing item, its tags, its extensions and its history alone when the archive's copy is a duplicate`.

### `search-and-filters/restore-link-held`

If an archive registers a type with a `link_field` in which two items that a forced delete left share a value, then the server MUST answer `409 link_taken`.

**Reason:** a type that an archive registers is held to its `link_field` as `POST /types` holds one (`types/link-gained`).

**Tests:** `compliance/links.test.ts › stops a restore registering a link the items a forced delete left share`.

### `search-and-filters/restore-compatible-types`

When an otherwise valid archive carries a set of registrations accepted through the server's registration and replacement routes, the server MUST restore those registrations into an empty store regardless of their order in the archive.

**Reason:** an exported backup remains restorable when its registrations refer to each other, including mutual compatibility declarations and display hints, links, and merge policies that name inherited fields.

**Tests:** `compliance/restore-compatible-types.test.ts › round-trips accepted registrations into an empty store (reversed: %s)`, `› refuses a target change that breaks a reader and restores the accepted registry`, `compliance/type-tables.test.ts › restores a subtype whose type line restates a table of its parent (reversed: %s)`.

### `search-and-filters/restore-type-conflict`

If an archive registers a type or an edge type that the instance holds differently, then the server MUST answer `409 conflict` naming each in `details.conflicting_ids`.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that registers a type or an edge type this instance holds differently, naming each, and writes nothing`.

### `search-and-filters/restore-core-edge-type`

If an archive carries a core edge type, then the server MUST answer `409 conflict`.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that carries a core edge type with 409 conflict`.

### `search-and-filters/restore-type-unknown-key`

If an archive registers a type with a key `types/unknown-key` refuses, or an edge type with a key `edges/types-register-unknown-key` refuses, then the server MUST answer `400 invalid_schema` with `details.errors` naming the path of each such key.

**Reason:** an archive is held to what the registration doors take, so a registration they would refuse cannot come in by restore.

**Tests:** `compliance/restore-archive.test.ts › refuses a type and an edge type that carry one, naming its path, and restores the same archive without it`.

### `search-and-filters/restore-nothing`

When `POST /restore` takes an archive that carries no item, the server MUST answer `200` with `imported` of 0.

**Reason:** an archive of nothing is not an empty body, and its members are present and empty, which `search-and-filters/restore-members` tells from missing.

**Tests:** `compliance/restore-archive.test.ts › refuses an empty body, and takes an archive of nothing`.

### `search-and-filters/restore-empty-body`

If the body of `POST /restore` is empty, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/restore-archive.test.ts › refuses an empty body, and takes an archive of nothing`.

### `search-and-filters/restore-members`

If an archive lacks `manifest.json`, `instance.ndjson.gz`, `items.ndjson.gz`, `edges.ndjson.gz` or `rows.ndjson.gz`, then the server MUST answer `400 validation_error` naming each missing entry in the message and in `details.entries`.

**Reason:** an export writes all five even when it holds no item (`search-and-filters/archive-entries`), so a missing entry is a damaged archive or a file that is no archive, and an archive of nothing is told from it by its entries being empty (`search-and-filters/restore-nothing`). Without the check a restore answers `200` with counts of zero for a file it never read.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive without %s, naming it, and writes nothing`, `› refuses a tar that is no archive, naming every member it lacks`.

### `search-and-filters/restore-not-archive`

If the body of `POST /restore` is not a tar, or a line file in it is not a gzip stream or its compressed stream breaks partway, then the server MUST answer `400 validation_error`.

**Reason:** a damaged backup is an ordinary input and not a fault in the server.

**Tests:** `compliance/restore-archive.test.ts › refuses a body that is not a tar, or whose line file breaks partway, and goes on serving`.

### `search-and-filters/restore-keeps-serving`

When the server refuses a body of `POST /restore` that it cannot read, the server MUST go on answering other requests.

**Reason:** the process is every client's server, and a file that one operator sends must not stop it.

**Tests:** `compliance/restore-archive.test.ts › refuses a body that is not a tar, or whose line file breaks partway, and goes on serving`.

### `search-and-filters/restore-version`

If the `manifest.json` of an archive names a `version` other than 0, then the server MUST answer `400 validation_error` with a message saying that the archive is read only by the build that wrote it.

**Reason:** a version of 0 promises nothing between builds, so what a restore into another build does with an archive is outside the contract. Nothing is stated about archives after the first public release.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive at another format version, saying it is read only by the build that wrote it`.

### `search-and-filters/restore-manifest`

If the `manifest.json` of an archive is missing `version`, `blobs`, `item_count`, `edge_count` or `row_count`, or mistypes them, each count holding a non-negative integer, `missing_blobs`, an entry of `blobs`, which holds a string `mime_type` and a non-negative integer `size_bytes`, or an entry of `missing_blobs`, which holds the same or `null` for either, then the server MUST answer `400 validation_error` naming each field in the message and in `details.errors` as a dotted `path`.

**Reason:** another version is free to lay its fields out differently, so a manifest naming one is refused for its version and not its shape.

**Tests:** `compliance/restore-archive.test.ts › refuses a manifest missing or mistyping a field the restore reads, naming the field, and writes nothing`.

### `search-and-filters/restore-line-counts`

If the `item_count`, `edge_count` or `row_count` of an archive's manifest is not the number of lines that `items.ndjson.gz`, `edges.ndjson.gz` or `rows.ndjson.gz` holds, then the server MUST answer `400 validation_error` naming the count in `details.field`.

**Reason:** the manifest says what the archive holds before a reader reads the rest (`search-and-filters/archive-entries`), so a line file that holds other than it says was cut or changed after the export.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive whose %s is not the number of lines its file holds, and writes nothing`.

### `search-and-filters/restore-state`

If an archive records an item in a state that its type's lifecycle cannot produce, such as `revoked` for a canonical type, `trashed` for a `system.*` type or a value that is no state, then the server MUST answer `400 validation_error` naming the item.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

### `search-and-filters/restore-state-kept`

When `POST /restore` takes a canonical item in a state that its lifecycle contains, the server MUST write the item in the state recorded.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive recording a state the type's lifecycle cannot produce, and writes nothing`.

### `search-and-filters/restore-source`

When restoring an item whose `source`, after trimming whitespace and ignoring case, starts with `oauth:`, the server MUST store `restored:` followed by the exact archived source.

**Reason:** An archive carries history but no app credentials. A restored source cannot belong to a credential (`keys-and-oauth/claims-reserved`), so a later app sign-in cannot overwrite the archived item's natural key.

**Tests:** `compliance/restore-archive.test.ts › rewrites app sources exactly and accepts previously restored sources`, `compliance/version-writers-archive.test.ts › restores app-written items twice with their writers and separate natural keys`.

### `search-and-filters/restore-source-again`

When restoring an item whose `source` starts with `restored:`, the server MUST preserve that source unchanged.

**Tests:** `compliance/restore-archive.test.ts › rewrites app sources exactly and accepts previously restored sources`, `compliance/version-writers-archive.test.ts › restores app-written items twice with their writers and separate natural keys`.

### `search-and-filters/restore-app-connection`

When restoring a `system.connection` item whose `kind` property is `app`, the server MUST set its current `status` property to `revoked`.

**Reason:** A restored app connection records past access, not a live grant. Its other fields and archived version writers remain part of that history (`versions/writer-restore`).

**Tests:** `compliance/version-writers-archive.test.ts › marks restored app connections inactive without changing their recorded fields`.

### `search-and-filters/restore-scalars`

If an archive records a `version` of an item or an edge that is not a positive safe integer, or a `tier` of an item that is not `library` or `feed`, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`.

### `search-and-filters/restore-text`

If the `manifest.json` of an archive, or a line the restore reads from its `instance.ndjson.gz`, `items.ndjson.gz`, `edges.ndjson.gz` or `rows.ndjson.gz`, holds a string or an object key with a surrogate escape that has no partner, then the server MUST answer `400 validation_error` naming the entry or the line and the JSON pointer of the text, and write nothing.

**Reason:** a restore is not a way to plant text the write doors refuse (`items/json-text-well-formed`).

**Tests:** `compliance/well-formed-text.test.ts › refuses a %s that holds a surrogate escape with no partner, naming the line and where, and takes a pair there`.

### `search-and-filters/restore-scalars-held`

When an archive records an invalid `version` or `tier` for an item that the instance already holds, or for an edge whose endpoint is missing, the server MUST still refuse the archive.

**Tests:** `compliance/archive-scalars.test.ts › refuses invalid %s even when the item already exists`, `› refuses an invalid edge version even when its endpoint is missing`.

### `search-and-filters/restore-scalars-kept`

When `POST /restore` writes an item or an edge, the server MUST keep the `version` and the item's `tier` that the archive records, and write `1` and `library` where it records none.

**Reason:** zero can be a write precondition but is never a stored version (`versions/create-claim-none`), and resetting a version can make an old write precondition match unrelated content.

**Tests:** `compliance/archive-scalars.test.ts › restores $name without changing their meaning`.

### `search-and-filters/restore-dates`

If an archive records a `created_at` or `updated_at` of an item or an edge, or a `last_activity_at` of an item, that is not an instant, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-history.test.ts › refuses an item whose %s is malformed, and writes the item ahead of it nowhere`, `› refuses an edge whose date is malformed even when an endpoint is missing`.

### `search-and-filters/restore-dates-utc`

When `POST /restore` writes an item, the server MUST write its `created_at` and `updated_at`, and the `created_at` and `occurred_at` of each snapshot in its history, as the instants they name, in UTC to the millisecond.

**Reason:** canonical UTC values remain comparable with the filters and cursors of a listing, and with the dates of the versions the instance writes itself.

**Tests:** `compliance/archive-history.test.ts › writes an item's dates in UTC to the millisecond`, `compliance/restore-archive.test.ts › writes a snapshot's dates in UTC to the millisecond`.

### `search-and-filters/restore-history-shape`

If an archive records history that is not an array of snapshots, each an object with a valid snapshot ID, the item's own ID, object properties, a type identifier, a `library` or `feed` tier, `created_at` and `occurred_at` instants, and a `source_id` that is a string or null, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-history.test.ts › refuses an item whose %s is malformed, and writes the item ahead of it nowhere`.

### `search-and-filters/restore-history-version`

If an archive records a snapshot whose `version` is not a positive safe integer below the item's version, or repeats one of the same item's history, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-history.test.ts › refuses an item whose %s is malformed, and writes the item ahead of it nowhere`.

### `search-and-filters/restore-history-id`

If an archive records a snapshot ID that repeats another snapshot's of the archive, the same item's or another's, then the server MUST answer `400 validation_error` naming the line and the field.

**Tests:** `compliance/archive-history.test.ts › refuses an item whose %s is malformed, and writes the item ahead of it nowhere`.

### `search-and-filters/restore-malformed-held`

When an archive records a malformed date or history for an item that the instance already holds, the server MUST still refuse the archive.

**Tests:** `compliance/archive-history.test.ts › refuses a malformed date or history even when the item is one the instance already holds`.

### `search-and-filters/restore-history-exact`

When `POST /restore` writes an item's history, the server MUST keep each snapshot's `id`, `item_id`, `version`, `properties`, `type`, `tier`, `occurred_at`, `source_id` and `created_at`, with its dates as the instants they name (`search-and-filters/restore-dates-utc`).

**Tests:** `compliance/archive-history.test.ts › restores each snapshot field for field into an instance that has never seen the item`.

### `search-and-filters/restore-history-shape-free`

The server MUST NOT hold a restored snapshot's properties to the current shape of its type.

**Reason:** changing a type's schema does not rewrite the past.

**Tests:** `compliance/archive-history.test.ts › restores a snapshot the type's current shape would refuse, as it was`.

### `search-and-filters/restore-items-shape-free`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships, the server MUST NOT refuse it because its properties lack a field its type requires or hold a value its type's field does not accept.

**Reason:** a type gains a required field while its items stand (`types/field-gained`), so an archive that an export wrote can hold an item that its type no longer accepts, and an export that the same build cannot restore is not a usable backup (`search-and-filters/restore-no-count-limit`). The current items are held to the shape they had as a snapshot's properties are (`search-and-filters/restore-history-shape-free`). A `core` or `system` type that this build ships is read by the server's own code and cannot be deleted or replaced, so its items keep to it. A property that no type declares is still refused where strict mode names the type (`search-and-filters/restore-strict`), and an event's schedule and a task's `recurrence` are still judged (`occurrences/schedule-unreadable`).

**Tests:** `compliance/restore-items-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `search-and-filters/restore-items-properties-kept`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships, the server MUST store its properties as the archive holds them.

**Reason:** the properties are the person's own, and a restore that rewrote them to a shape the type has now would change the backup it restores.

**Tests:** `compliance/restore-items-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`, `› restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `search-and-filters/restore-schema-version-kept`

When `POST /restore` writes an item, the server MUST store the `schema_version` that the archive records for it.

**Reason:** `schema_version` is the `version` the item's type had when the item was created, and Marfa never changes it. Stamping the type's present version on an item written under an earlier one would say the item has a field it lacks.

**Tests:** `compliance/restore-items-shape.test.ts › restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type`.

### `search-and-filters/restore-items-orphan`

When `POST /restore` writes an item that is not of a `core` or `system` type that this build ships and whose type is not registered once the archive's own types are, the server MUST store the item under that type.

**Reason:** a forced delete removes a type and keeps its items (`types/delete-force`), and an export carries them without the type. The item is restored as such an item stands: its properties, tier, time and natural key refuse a write until a type is registered (`types/orphan-write`), and it is read, listed and searched (`types/orphan-read`) and has its tags, extensions and lifecycle state written (`types/orphan-kept-writable`) as it was. A type registered again holds its later writes (`types/orphan-reregistered`).

**Tests:** `compliance/restore-items-shape.test.ts › restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again`.

### `search-and-filters/restore-item-line`

If a line of the `items.ndjson.gz` of an archive holds no `item` object, then the server MUST answer `400 validation_error` naming the line in `details.line`.

**Reason:** a line that names no item is an archive that no instance wrote, and skipping it would leave it counted nowhere in the answer.

**Tests:** `compliance/restore-archive.test.ts › refuses an item line that holds no item, naming its line, and writes nothing`.

### `search-and-filters/restore-item-type`

If an archived item's `type` is missing or is not a type identifier, then the server MUST answer `400 validation_error` naming the item's ID in the message.

**Reason:** a forced delete leaves an item under an identifier a type was registered with (`search-and-filters/restore-items-orphan`), so an identifier that none could have been is an archive that no instance wrote.

**Tests:** `compliance/restore-archive.test.ts › refuses an item whose type is no identifier or whose properties are no object, and writes nothing`.

### `search-and-filters/restore-item-properties`

If an archived item's `properties` are present and are not an object, then the server MUST answer `400 invalid_properties` naming the item's ID in the message.

**Reason:** a restore that took them would store an item whose properties no read can return as an object.

**Tests:** `compliance/restore-archive.test.ts › refuses an item whose type is no identifier or whose properties are no object, and writes nothing`.

### `search-and-filters/restore-edges-unregistered`

When `POST /restore` writes an edge whose edge type is not registered once the archive's own edge types are, the server MUST store the edge under that edge type, as the archive holds it.

**Reason:** a forced delete removes an edge type and keeps its edges (`edges/types-delete-force-keeps`), and an export carries them without the edge type. The edge is restored as such an edge stands: it is read like any other (`edges/orphan-read`), it neither cascades a delete nor blocks one (`edges/orphan-delete`, `edges/orphan-delete-unblocked`), and it is announced like every restored edge (`search-and-filters/restore-announced`). `POST /edges` still names a registered edge type (`edges/create-type-unknown`).

**Tests:** `compliance/restore-edges-unregistered.test.ts › keeps the edge as the archive holds it, reads it as the origin does, and restores its own export again`, `compliance/restore-archive.test.ts › counts an edge that POST /edges would refuse under the code of its refusal, and keeps one whose type nothing registers`.

### `search-and-filters/restore-edges-unregistered-judged`

When `POST /restore` meets an edge whose edge type is not registered once the archive's own edge types are, the server MUST skip it, under the reason that `search-and-filters/restore-edge-skips` gives, where an endpoint is missing, an edge already holds its ID or its triple, or it runs from an item to itself.

**Reason:** with no edge type there is no constraint, cardinality or property schema to hold the edge to, and every edge type with a cycle check is shipped, so these are the refusals that need no edge type. An edge whose edge type the archive registers, or that is shipped, is judged by it.

**Tests:** `compliance/restore-edges-unregistered.test.ts › judges an edge of an unregistered type by what needs no edge type, still holds a registered one to its constraints, and refuses an edge whose type is no identifier`.

### `search-and-filters/restore-edge-type`

If an archived edge's `edge_type` is a string that is not an edge-type identifier, then the server MUST answer `400 validation_error` naming the edge's ID in the message.

**Reason:** a forced delete leaves an edge under an identifier an edge type was registered with (`search-and-filters/restore-edges-unregistered`), so an identifier that none could have been is an archive that no instance wrote. A line that gives the edge type as no string is skipped as `malformed` (`search-and-filters/restore-edge-skips`).

**Tests:** `compliance/restore-edges-unregistered.test.ts › judges an edge of an unregistered type by what needs no edge type, still holds a registered one to its constraints, and refuses an edge whose type is no identifier`.

### `search-and-filters/restore-edge-id`

If an archived edge carries an `id` that is not a UUIDv7 in lowercase, then the server MUST answer `400 validation_error` naming `id` in `details.field`.

**Reason:** an edge stored under such an ID could not be read or deleted by it, and one whose ID the restore replaced would be written again by every later restore of the same archive.

**Tests:** `compliance/restore-archive.test.ts › refuses an edge whose ID is not a lowercase UUIDv7, and writes nothing`.

### `search-and-filters/restore-edges-end-unregistered`

When `POST /restore` meets an edge with an end that is an item of a type that is not registered once the archive's own types are, the server MUST NOT refuse the edge because the edge type's `source_type_constraints` or `target_type_constraints` do not admit that end.

**Reason:** a forced delete removes a type and keeps its items and the edges between them (`types/delete-force`), and the type's parent and roles go with it, so no entry in the list, whether it names a registered type or not, can be judged against the end. `POST /edges` still refuses such an end (`edges/endpoint-unregistered`), and every other refusal of a restored edge is unchanged (`search-and-filters/restore-edge-skips`).

**Tests:** `compliance/restore-edges-constraint-types.test.ts › keeps an edge whose source constraint names the deleted type, and still refuses a registered end the constraint does not admit`, `› keeps an edge whose target constraint names the deleted type`, `› judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names`, `› restores an older archive whose item type is not registered, keeping the edge its constraint named the type for`.

### `search-and-filters/restore-edges-end-registered`

When `POST /restore` meets an edge with an end that is an item of a registered type, the server MUST judge that end against the edge type's constraint list as `POST /edges` does, whether or not the list also names a type that is not registered.

**Reason:** a type that other types name as parent cannot be deleted (`types/delete-subtypes`), so every ancestor of a registered type is registered, and an entry naming a type that is not registered admits no registered type.

**Tests:** `compliance/restore-edges-constraint-types.test.ts › keeps an edge whose source constraint names the deleted type, and still refuses a registered end the constraint does not admit`, `› judges a constraint that lists a registered and a deleted type by the endpoint: an end of the deleted type is kept, and an end of a registered type must be one the list names`.

### `search-and-filters/restore-snapshot-held`

If an archive records a snapshot ID that existing history already holds, then the server MUST answer `409 conflict`.

**Reason:** a history collision is not a duplicate current item and cannot overwrite another item's past.

**Tests:** `compliance/archive-history.test.ts › refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was`.

### `search-and-filters/restore-strict`

Where `enforcement.strict_mode` names the type of an archived item that the restore would write, if the item sets a property that no type declares, then the server MUST answer `400 invalid_properties`.

**Reason:** a restore is not a way to plant an item that `POST /items` would refuse. An item whose ID, natural key or link the instance already holds is counted in `duplicates` and written nowhere, so the lever has nothing to judge. `types/strict-mode` states the lever and `types/strict-mode-code` the code it carries.

**Tests:** `compliance/schema-enforcement.test.ts › strict-on rejects the same unknown property arriving through the restore door`, `› strict-on counts a restored item the instance already holds as a duplicate`.

### `search-and-filters/restore-strict-off`

Where `enforcement.strict_mode` does not name the type of an archived item, the server MUST take a property that no type declares and serve it back.

**Tests:** `compliance/schema-enforcement.test.ts › default-off accepts through the restore door as it does through the create door`.

### `search-and-filters/restore-blob-size`

Where the volume has room for an archive beside the instance's reserve (`blobs/restore-reserve`), the server MUST restore it even when it is larger than the request cap that every JSON body sits under.

**Reason:** the body streams to disk as an upload's does, so an archive that carries a blob larger than the cap restores.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`, `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`.

### `search-and-filters/restore-duration`

While a part of the body of `POST /restore` arrives at least once in every `upload_idle_timeout_ms`, the server MUST NOT end the request for the time the body takes.

**Reason:** an archive has no size cap (`search-and-filters/restore-blob-size`), so a large one over a slow link outlasts any fixed request deadline. The limit on a body that stops arriving is `search-and-filters/restore-idle`.

**Tests:** `compliance/upload-timing.test.ts › restores an archive whose body takes 66 seconds to arrive, a part at a time`.

### `search-and-filters/restore-idle`

If no byte of the body of `POST /restore` arrives for `upload_idle_timeout_ms`, 60000 milliseconds unless named, then the server MUST answer `408 request_timeout`.

**Reason:** a sender that has gone quiet would otherwise hold its request and the bytes it has sent for ever. The time counts the server's wait for the sender, not the time it takes to write what has arrived.

**Tests:** `compliance/upload-timing.test.ts › ends a restore with 408 request_timeout, writes nothing and removes what it spooled`.

### `search-and-filters/restore-refused-read`

When the server refuses `POST /restore` after it has started to read the body, the server MUST read the rest of the body, until it ends or no byte arrives for `MARFA_UPLOAD_IDLE_TIMEOUT_MS`, before it answers.

**Reason:** a client that is still sending reads no answer until its body is sent, so a server that stopped reading would leave it with a broken connection in place of the refusal.

**Tests:** `compliance/restore-archive.test.ts › reads the rest of a large body and answers the refusal, to the owner, and answers a working key before the body`.

### `search-and-filters/restore-refused-early`

When the server refuses `POST /restore` before it has started to read the body, the server MUST answer with `Connection: close` within 2 seconds, after reading at most `max_request_bytes` of the body.

**Reason:** a caller without local authority has proved nothing, so the server reads no more of what it sends than a client already sending a small archive has in flight, which lets that client hear the refusal instead of a reset. A client that sent `Expect: 100-continue`, as `marfa restore` does, has sent no body, and the server reads none.

**Tests:** `compliance/restore-archive.test.ts › answers a caller with no credential within two seconds and closes the connection while it keeps sending`, `› reads the rest of a large body and answers the refusal, to the owner, and answers a working key before the body`.

### `search-and-filters/restore-idle-unwritten`

When the server answers `POST /restore` with `408 request_timeout`, the server MUST NOT write any item, type registration or blob of the archive.

**Tests:** `compliance/upload-timing.test.ts › ends a restore with 408 request_timeout, writes nothing and removes what it spooled`.

### `search-and-filters/restore-blob-bytes`

When `POST /restore` takes a blob that the archive carries, the server MUST answer its bytes on `GET /blobs/{hash}` byte for byte, under the type that the manifest names.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.

### `search-and-filters/restore-blob-type`

If the manifest of an archive names for a blob a `mime_type` that is empty or holds a character outside printable ASCII, then the server MUST keep the blob under `application/octet-stream`.

**Reason:** a blob's type is served as a response header and sent to an object store as one, and a header carries only printable ASCII. An upload names its type in a header, so only a restore can bring such a type, and a blob kept under it could be neither served nor copied to another store.

**Tests:** `compliance/restore-archive.test.ts › keeps a blob whose manifest names a type no header can carry under application/octet-stream`.

### `search-and-filters/restore-blob-held`

When an archive carries a blob that the disk store holds a recorded copy of whole, the server MUST keep that copy and not write the blob's bytes again.

**Reason:** content addressing means the copy is already those bytes, and another request can be reading it while the restore runs.

**Tests:** `compliance/restore-faults.test.ts › keeps the copy the disk holds and writes the bytes no second time`, `› replaces a disk copy that has rotted at the same size with the bytes the archive carries`.

### `search-and-filters/restore-blob-hash`

When an entry of an archive holds bytes that do not hash to its name, the server MUST leave the entry out and not count it in `blobs_imported`.

**Tests:** `compliance/restore-archive.test.ts › restores an archive carrying a blob larger than the request cap, byte for byte, and leaves out an entry that does not hash to its name`.

### `search-and-filters/restore-unread-entry`

When an archive carries an entry under a name that the restore does not read, the server MUST restore the rest of the archive and leave the entry unread.

**Reason:** an archive is a file that anyone can hand an operator, and a small compressed entry can expand to more memory than the server has.

**Tests:** `compliance/restore-archive.test.ts › steps past an entry it does not read`.

### `search-and-filters/restore-text-cap`

If the `manifest.json`, or a line of the `instance.ndjson.gz`, `items.ndjson.gz` or `edges.ndjson.gz` of an archive, is larger than 64 MiB, then the server MUST answer `400 validation_error` naming the entry.

**Reason:** the restore parses each of these whole, so this limit bounds the memory a restore takes. The line files are otherwise read a line at a time, so an archive of any number of items or registrations restores.

**Tests:** `compliance/restore-archive.test.ts › refuses a line longer than 64 MiB, and writes nothing`.

### `search-and-filters/restore-entry-twice`

If an archive carries `manifest.json`, `instance.ndjson.gz`, `items.ndjson.gz`, `edges.ndjson.gz` or a `blobs/` entry more than once, then the server MUST answer `400 validation_error` naming the entry.

**Reason:** a repeated entry has no single meaning, and reading both would let a later copy add lines that the first never listed.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive carrying an entry twice, and writes nothing`.

### `search-and-filters/restore-registration-twice`

If the `instance.ndjson.gz` of an archive registers the same type ID, or the same edge-type ID, on more than one line, then the server MUST answer `400 validation_error`.

**Reason:** two registrations of one ID have no single meaning, as two icons for one type have none.

**Tests:** `compliance/restore-archive.test.ts › refuses an archive that registers a type or an edge type twice, and writes nothing`.

### `search-and-filters/restore-no-count-limit`

When local authority restores an archive that the same build wrote, the server MUST take its counts of items, edges, types and edge types without a limit of its own.

**Reason:** an export that the same build cannot restore is not a usable backup.

**Tests:** `compliance/archive-limits.test.ts › restores an archive of more than 5,000 items, 20,000 edges, 200 types and 200 edge types, as one the same build wrote`.

### `search-and-filters/restore-item-at-cap`

When an archived item's properties, those of one of its earlier versions, or an archived edge's properties are exactly as large as the largest body the bulk write operations take, the server MUST restore the item or edge.

**Tests:** `compliance/archive-limits.test.ts › takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the line and the field, and writes nothing`.

### `search-and-filters/restore-item-over-cap`

If an archived item's properties, those of one of its earlier versions, or an archived edge's properties are larger than the largest body the bulk write operations take, then the server MUST answer `413 request_too_large` naming the line and the field in `details`.

**Reason:** a restore is not a way to plant an item that the write operations would refuse, and the cap is the largest bulk body (`items/bulk-body-cap`).

**Tests:** `compliance/archive-limits.test.ts › takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the line and the field, and writes nothing`.

### `search-and-filters/restore-refused-nothing`

If the server refuses an archive, then the server MUST leave no item, history, type, edge type, blob, event or audit record that the restore wrote.

**Reason:** the registrations, the blob bytes and the items commit together or not at all, so an owner who gives up on a restore does not hold types or items they did not ask for and can run the same restore again.

**Tests:** `compliance/restore-archive.test.ts › leaves no item, type, edge type, blob, event or audit record behind when a later item is refused`, `compliance/archive-scalars.test.ts › refuses invalid $field=$value before writing the archive`, `compliance/archive-history.test.ts › refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was`.

### `search-and-filters/restore-failed-nothing`

If a write fails while the server restores an archive, then the server MUST leave no item, type, edge type, event or audit record that the restore wrote.

**Tests:** `compliance/restore-faults.test.ts › leaves no item, type, edge type, event or audit record when a write fails ($fault), the next blob-integrity run removes the bytes it placed, and it restores whole when tried again`.

### `search-and-filters/restore-failed-blobs`

If a write fails while the server restores an archive, then the server MUST queue for deletion the blob bytes the restore placed that no item names, so that `blob-integrity` and `blob-orphans` runs remove them.

**Reason:** the bytes are placed before the transaction opens and stay unrecorded and queued for deletion, so nothing serves them, and clean-up removes only what no record names.

**Tests:** `compliance/restore-faults.test.ts › leaves no item, type, edge type, event or audit record when a write fails ($fault), the next blob-integrity run removes the bytes it placed, and it restores whole when tried again`.

### `search-and-filters/restore-stopped-nothing`

If the process stops while the server restores an archive, then the server MUST leave no item, type, edge type, event or audit record that the restore wrote, and remove the blob bytes it placed that no item names.

**Reason:** the bytes are written before the transaction opens, which nothing can roll back, so the copy cleanup of `blob-replicate` and `blob-integrity` removes them.

**Tests:** `compliance/restore-faults.test.ts › leaves no item, type, edge type, event or audit record when the process stops while it writes, and the next copy cleanup removes the bytes it placed`.

### `search-and-filters/restore-announced`

When a restore commits, the server MUST announce the items it wrote on the event stream.

**Tests:** `compliance/restore-archive.test.ts › leaves no item, type, edge type, blob, event or audit record behind when a later item is refused`.

### `search-and-filters/restore-announced-order`

When a restore commits, the server MUST tell subscribers about its events in event-log order, ahead of the events of any write committed after it.

**Reason:** a subscriber that received a later event first would move its cursor past events it never saw (`events/live-no-repeat`).

**Tests:** `compliance/restore-concurrent.test.ts › tells subscribers about its events in log order, ahead of the events of any write committed after it`.

### `search-and-filters/restore-hidden`

While a restore writes, the server MUST NOT show its items, registrations or events to other requests.

**Reason:** a reader that saw part of a restore would see items that a failed restore then takes away.

**Tests:** `compliance/restore-faults.test.ts › shows other requests none of its items, registrations, blobs or events until it commits`.

### `search-and-filters/restore-writers-wait`

While a restore writes, if another request has to write and waits for the restore longer than the instance's write wait, then the server MUST answer that request `503 write_contention`.

**Reason:** the restore holds the write lock until it commits, and a caller retries a `503` (`errors/contention`), whose `details.budget_ms` names the budget (`errors/contention-budget`).

**Tests:** `compliance/restore-concurrent.test.ts › is answered 201, or 503 write_contention carrying the write wait, and nothing else`, `compliance/restore-faults.test.ts › waits for the restore, and is answered 503 write_contention naming the write wait once it has waited that long`.

### `search-and-filters/restore-bytes-kept`

When the server removes the blob bytes of a restore that did not commit, the server MUST NOT remove bytes that a committed item names.

**Reason:** content addressing means that another request can be told the same bytes are stored while the restore runs.

**Tests:** `compliance/restore-faults.test.ts › keeps the bytes a committed item names, and removes those no item names`, `› keeps the bytes of an upload requested while the failed restore ran`.

## Owner item summaries

### `search-and-filters/owner-summaries-authority`

When the private local command sends `GET /items/summaries`, the server MUST admit the read.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-projection`

When `GET /items/summaries` succeeds, the server MUST return each item as exactly `id`, `type`, `version`, `name`, `source` and `created_at`, with its name computed as in `types/item-name-fields`, `types/item-name-markdown`, `types/item-name-text` and `types/item-name-empty`.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-selection`

When `GET /items/summaries` lists items, the server MUST exclude trashed and `system.*` items, apply instance source filtering and, when supplied, match `type` as an exact identifier.

**Tests:** `compliance/item-summaries.test.ts › keeps archived items, exact types and source filtering while excluding system items`.

### `search-and-filters/owner-summaries-search`

When `GET /items/summaries` receives `q`, the server MUST match the trimmed query as a case-insensitive substring of the computed name before pagination.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-order`

When `GET /items/summaries` returns a page, the server MUST order matches by `created_at` descending with `id` descending as a tie-break, using `limit` and `cursor` for pagination.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-limit-default`

When `GET /items/summaries` names no `limit`, the server MUST answer the page that a `limit` of 50 answers.

**Tests:** `compliance/page-limits.test.ts › $door answers its default page where it names no limit`.

### `search-and-filters/owner-summaries-limit-bounds`

If `GET /items/summaries` names a `limit` that is not a whole number of 1 to 200, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`, `› $door takes its largest page and refuses a limit past it or a fraction`.

### `search-and-filters/owner-summaries-boundary`

When the owner requests item summaries, the server MUST retain other content routes' existing credential requirements without minting an API key.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-refusal`

When `GET /items/summaries` refuses a request, the server MUST return only its error envelope without item content.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-cli`

When a caller runs `marfa --socket PATH items summaries`, the CLI MUST send the optional `--type`, `--q`, `--limit` and `--cursor` filters to `GET /items/summaries` through private local authority and return its summary page.

**Tests:** `cli/item-summaries.test.ts › lists and searches names through local authority without item content`.
