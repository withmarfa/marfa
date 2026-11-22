# Search, filters, lookup, export and restore

The query grammar the listing operations share, the full-text search, the counts, the lookup by link, natural key or id, the pages every list answers, and the export and restore of an instance. How a recurring event unfolds and what a calendar window holds is `occurrences.md`.

## A query key an operation does not declare

Every operation declares the query keys it takes. The rules here hold for all of them, the item listing and the search among them.

### `search-and-filters/undeclared-key`

When a request carries a query key that its operation does not declare, and `search-and-filters/undeclared-key-exempt` does not name the operation, the server MUST answer `400 validation_error` naming each such key in `details.unknown_parameters`.

**Reason:** the validator drops a key it does not declare, so a misspelled bound answers the whole set and cannot be told from a filter that matched every item. A rule that holds on some operations leaves the caller to find out which, by being wrong once.

**Tests:** `compliance/declared-refusals.test.ts › is refused 400 and named on every published door but the OAuth protocol endpoints, the event stream included`, `› names a misspelled key on the event stream rather than opening it unfiltered`, `sync/time-filters.test.ts › honors the item listing's own-time bound and refuses a name it does not declare`, `correctness/edges/edges-list.test.ts › refuses an unknown query key and an unknown edge id`, `compliance/audit.test.ts › refuses an undeclared bound rather than answering the whole trail`, `compliance/connectors.test.ts › refuses a query key the runs listing does not declare`, `compliance/inbound-webhooks.test.ts › refuses a query key the listing does not declare, rather than answering unfiltered`, `compliance/item-stats.test.ts › refuses a query key it does not declare, naming it`, `compliance/envelope.test.ts › refuses an offset query key`.

### `search-and-filters/undeclared-key-no-credential`

If a request to an operation that takes a credential carries an undeclared query key and no credential, then the server MUST answer `401`.

**Reason:** the refusal of the key comes after the credential check, so a bare request answers `401` whatever its query holds.

**Tests:** `compliance/declared-refusals.test.ts › is refused after the credential, so a bare request still answers 401`.

### `search-and-filters/undeclared-key-turned-away`

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

The server MUST NOT refuse as undeclared a query key sent to `POST /inbound/{token}`, to a discovery document under `/.well-known/`, to a browser page under `/auth/`, or to an OAuth protocol endpoint under `/oauth/`, `POST /oauth/register` excepted.

**Reason:** a sender's query string belongs to the sender, and a redirect reaches the browser pages carrying the OAuth flow's own parameters.

**Tests:** `compliance/declared-refusals.test.ts › takes a query on the doors that are not this server's to declare, and still refuses one on the client registration door`.

### `search-and-filters/undeclared-key-register`

If a request to `POST /oauth/register` carries an undeclared query key, then the server MUST answer `400 validation_error` naming it in `details.unknown_parameters`.

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

If a credential whose type map reads a well-formed concrete type that nothing registers sends a `type` filter with an entry naming it, then the server MUST answer `400 unknown_type` on `GET /items`, `GET /items/stats`, `GET /search`, `GET /export`, `GET /occurrences` and `GET /events`.

**Reason:** an empty page is the one answer a client cannot tell from a quiet instance, so a mistyped name, a type registered under another handle and a type deleted since the client last read the registry would all read as nothing here. A wildcard is not refused, because what it names may be nothing (`search-and-filters/type-wildcard-none`).

**Tests:** `compliance/unreadable-type-filter.test.ts › $name answers 400 unknown_type to a key whose map reads the name`, `› GET /events holds each entry of a list to the rule`, `correctness/pagination.test.ts › a nonexistent type is refused rather than answered with an empty page`, `compliance/item-stats.test.ts › counts the items a listing's filters match`, `compliance/filter-lists.test.ts › refuses the list for an entry it would refuse alone`.

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

When `GET /items`, `GET /items/stats` or `GET /search` names a `tags` list that holds a blank entry beside a tag, the server MUST ignore the blank entry.

**Reason:** a client that builds the list by joining values can leave a trailing comma, and an empty page or an empty count would read as no item carrying the tag.

**Tests:** `correctness/tags.test.ts › ignores a blank entry of a tags list on the listing, the stats and the search`.

### `search-and-filters/tags-count`

If `GET /items`, `GET /items/stats`, `GET /search` or the `filter` of `POST /items/bulk-actions` names more than 100 distinct tags, then the server MUST answer `400 validation_error` naming the field that holds them.

**Reason:** an item holds at most 100 tags (`items/tags-count`), so a longer list is not a real request. Blank entries and repeats do not count.

**Tests:** `compliance/search-bounds.test.ts › takes 100 distinct tags and refuses 101, at each door that takes tags`, `› does not count blank entries or repeated tags`.

### `search-and-filters/tags-length`

If `GET /items`, `GET /items/stats`, `GET /search` or the `filter` of `POST /items/bulk-actions` names a tag longer than 128 characters, then the server MUST answer `400 validation_error` naming the field that holds it.

**Reason:** a tag longer than that cannot be stored (`items/tag-text`).

**Tests:** `compliance/search-bounds.test.ts › takes a tag of 128 characters and refuses one of 129, at each door that takes tags`.

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

If `GET /items` or `GET /items/stats` names `beneath` and the key cannot read `parent-of` edges, then the server MUST answer `403 edge_type_not_permitted`.

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

When `GET /items` names a `type` that is a hidden type written exactly, not as a wildcard (`items/hidden-types`), the server MUST list the items of that type, and of its subtypes that are hidden, that the credential may read.

**Reason:** a caller that asks for `system.folder` has already said what it wants, so the default that leaves hidden items out of a listing does not apply to it.

**Tests:** `compliance/folders.test.ts › creates a folder as a system.folder, read back through the item doors`, `compliance/views.test.ts › creates a view as a system.view with its query, sort and group, read back through the item doors`.

## Filter grammar

`GET /items`, `GET /items/stats` and `GET /search` take a `filter` expression, `POST /items/bulk-actions` takes one inside its filter, and a view and a folder take one as `query.filter`. An expression is one or more conditions, `<field> <operator> <value>`, with no value after `exists` and `not_exists` (`search-and-filters/filter-malformed`). Numbers on properties are `search-and-filters/filter-numeric`, times on properties are `search-and-filters/filter-property-instant`, times are `search-and-filters/filter-time-instant`, and the escapes in a string are `search-and-filters/filter-string-escapes`. An edge term is also `edges.md`'s (`edges/filter-edge-full`, `edges/filter-term-hidden`).

### `search-and-filters/filter-one-grammar`

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

When a `filter` compares a property holding text, `id`, `type`, `state`, `source` or `source_id` with a double-quoted string using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare the whole value by code point, with regard to case, except that a property text and a literal that both read as a datetime are compared as `search-and-filters/filter-property-instant` says.

**Reason:** `type eq "core.entity"` therefore selects that identifier alone, where the `type` key takes the types under it too (`types/listing-subtree`).

**Tests:** `compliance/filter-grammar.test.ts › compares the whole value, with regard to case, in code point order`, `› compares a system field's whole value, with regard to case`, `› compares a type term with the identifier alone, not the types under it`.

### `search-and-filters/filter-tier`

When a `filter` compares `tier` with a double-quoted string using `eq` or `neq`, the server MUST select the items whose tier is, or is not, that string.

**Reason:** the `tier` key of a listing narrows to one tier by name (`search-and-filters/tier-narrows`), and a `filter` term does the same inside an expression that also holds `OR`.

**Tests:** `compliance/filter-grammar.test.ts › selects by tier with eq and neq, and refuses exists on it`.

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

If a `filter` applies `exists` or `not_exists` to `id`, `type`, `state`, `tier`, `source`, `source_id`, `version`, `created_at`, `updated_at` or `occurred_at`, then the server MUST answer `400 validation_error`.

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

When a `filter` holds `backref[<edge type>] eq "<id>"`, the server MUST select the items that are the to item of an edge of that type whose from item is that id.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref eq the items that an edge of the type from that item points at`, `› selects by an edge eq term and a backref eq term on every door as the listing does`.

### `search-and-filters/filter-backref-neq`

When a `filter` holds `backref[<edge type>] neq "<id>"`, the server MUST select every item that is not the to item of an edge of that type from that id, an item with no inbound edge of that type included.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref neq every item without that inbound edge, an item with no inbound edge of the type among them`.

### `search-and-filters/filter-backref-exists`

When a `filter` applies `exists` to `backref[<edge type>]`, the server MUST select the items that are the to item of at least one edge of that type.

**Reason:** which inbound edges count is `edges/filter-backref`.

**Tests:** `compliance/filter-grammar.test.ts › selects by backref exists the items with an inbound edge of the type, and by not_exists the items with none`.

### `search-and-filters/filter-backref-not-exists`

When a `filter` applies `not_exists` to `backref[<edge type>]`, the server MUST select the items that are the to item of no edge of that type.

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

When a tag holds a `?`, the server MUST count it under its own name on `GET /tags`.

**Tests:** `compliance/question-mark-values.test.ts › counts a tag holding a ? under its own name on GET /tags`.

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

If a `filter` at a door that takes one joins conditions with both `AND` and `OR`, then the server MUST answer `400 validation_error`.

**Reason:** the grammar has no parenthesis, so a mixed expression has no single meaning, at any of the doors `search-and-filters/filter-one-grammar` names.

**Tests:** `compliance/validation.test.ts › refuses a filter that mixes AND with OR, on the listing and the search`, `compliance/filter-grammar.test.ts › refuses %s at each door with validation_error`.

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

### `search-and-filters/filter-range-numbers`

When a `filter` on `GET /items` or `GET /search` bounds a property with a number using `gt`, `gte`, `lt` or `lte`, the server MUST select only the items whose property is a JSON number, and never one whose property is text, a boolean, an array, an object, missing or `null`.

**Reason:** text that reads as a number, and a boolean read as `0` or `1`, would otherwise sit among the numbers a range selects.

**Tests:** `compliance/numeric-property-filters.test.ts › bounds a property by a number only on a number, on the listing and the search`.

### `search-and-filters/filter-range-text`

When a `filter` on `GET /items` or `GET /search` bounds a property with a text literal using `gt`, `gte`, `lt` or `lte`, the server MUST select only the items whose property is text.

**Tests:** `compliance/numeric-property-filters.test.ts › bounds a property by a number only on a number, on the listing and the search`.

### `search-and-filters/filter-property-instant`

When a `filter` on `GET /items` or `GET /search` compares a text property that reads as a datetime (`types/datetime-value`) with a text literal that reads as one, using `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, the server MUST compare the instants they name, to the millisecond, a date alone as its midnight in UTC, whichever type declares the property, with the order of `search-and-filters/sort-property-datetime` and `search-and-filters/sort-property-datetime-range`.

**Reason:** one instant written two ways is one moment, and the order of the moments is not the order of the characters. A difference below a millisecond is not kept, so `2026-01-01T05:00:00.0004Z` equals `2026-01-01T05:00:00.000Z`.

**Tests:** `compliance/datetime-property-compare.test.ts › filters by instant, so one instant written two ways is equal and an earlier time is lower`, `› filters a search by instant and sorts what it keeps by instant`, `› filters an instant before the year 0000 below and one after the year 9999 above every other`.

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

A `part` term selects the items that are parts of another (`edges/parts-trash`): an item out of the bin that is the from item of a `with-hosts` edge whose to item is out of the bin. No listing leaves parts out unless its filter says so. A device answers the term from its working copy by the same rule (`device/filter-part`).

### `search-and-filters/part`

When a `filter`, on `GET /items`, `GET /items/stats`, in a view's `query` or in a bulk action's `filter`, holds `part eq true`, the server MUST select each item out of the bin that is the from item of an edge of a `with-hosts` type whose to item is out of the bin.

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

**Reason:** a bin reads as what went there most recently first, and creation order would put an old item binned a minute ago at the bottom. An item an archive restored to the bin without its time (`items/trash-archive-unrecorded`) has no `trashed_at`, and its `updated_at` is no earlier than the move. A listing of any other set of states keeps the creation order, because its items have no one time in common.

**Tests:** `compliance/trashed-at.test.ts › lists the bin newest binned first when no sort is named`, `› reverses it with direction=asc`, `› walks the same order one page at a time`, `› orders a listing of several states by creation`.

### `search-and-filters/bin-order-sort`

When `GET /items` names `state=trashed` and a `sort`, the server MUST order the items by that `sort`.

**Tests:** `compliance/trashed-at.test.ts › still honors a named sort`.

## Sorting by a property

### `search-and-filters/sort-property`

When `GET /items` names `sort=properties.<field>`, the server MUST order the items by the scalar value each stores in that property, whatever the item's type and whether the `type` filter is concrete, a wildcard or absent.

**Tests:** `correctness/property-sort-pagination.test.ts › walks numeric properties whatever the type filter`, `› walks mixed scalar kinds across types, with ascending ID ties and nulls last`.

### `search-and-filters/sort-property-ascending`

When `GET /items` sorts by a property ascending, the server MUST put numbers and booleans first in numeric order, with `false` equal to `0` and `true` equal to `1`, followed by strings in binary lexical order of their UTF-8 bytes, an empty string being a value and numeric text remaining text, except that a string that reads as a datetime is placed as `search-and-filters/sort-property-datetime` says.

**Tests:** `correctness/property-sort-pagination.test.ts › walks mixed scalar kinds across types, with ascending ID ties and nulls last`, `compliance/datetime-property-compare.test.ts › sorts a text that only looks like a date or a datetime by its bytes, in both directions`.

### `search-and-filters/sort-property-datetime`

When `GET /items` sorts by a property, the server MUST order a string that reads as a datetime (`types/datetime-value`) by the instant it names, to the millisecond, a date alone as its midnight in UTC, whichever type declares the property.

**Reason:** the value stays as it was written and only its place in the order changes, so one instant written with different offsets or precision sorts as one moment, and a list that holds items of two types sorts the same whether a type declares the property a `datetime` or a `string`. A difference below a millisecond is not kept: values that differ only by less than one, such as `2026-01-01T05:00:00.0004Z` and `2026-01-01T05:00:00.000Z`, tie and then order by id (`search-and-filters/sort-property-ties`).

**Tests:** `compliance/datetime-property-compare.test.ts › sorts by instant however its time is written, across a datetime and a text declaration`, `› keys an instant to the millisecond, so a smaller difference ties by id and the next millisecond follows`.

### `search-and-filters/sort-property-datetime-range`

When `GET /items` sorts by a property whose string reads as a datetime naming an instant before `0000-01-01T00:00:00Z` or after `9999-12-31T23:59:59.999Z`, the server MUST place the earlier instant before every other datetime and the later instant after every other datetime, each in the order of the instants.

**Reason:** the offset `+05:00` puts `0000-01-01T00:00:00+05:00` in the year before 0000, and `-05:00` puts `9999-12-31T23:00:00-05:00` in the year after 9999, so neither fits the four-digit years the sort otherwise keys.

**Tests:** `compliance/datetime-property-compare.test.ts › puts an instant before the year 0000 first and one after the year 9999 last, among the instants`.

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

### `search-and-filters/cursor-short`

When an operation answers a `next_cursor`, the server MUST make the cursor only of letters, digits, `-` and `_`, beginning with a letter, and of at most 100 characters when the listing's order holds no text.

**Reason:** a person copies a cursor from a screen into the next command as a separate argument, which a command line reads as a flag if it begins with `-`, and a long one is hard to copy and to read. A listing ordered by a text value holds that value in its cursor.

**Tests:** `compliance/cursor-other-listing.test.ts › is short and made only of characters a URL carries as they are`.

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

If `GET /items` names a `sort` that is not `created_at`, `updated_at`, `occurred_at`, `last_activity_at` or `properties.<field>` with a field of lowercase letters, digits and underscores, or a `direction` that is not `asc` or `desc`, then the server MUST answer `400 validation_error` naming the parameter.

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

### `search-and-filters/search-q-length`

If `GET /search` carries a `q` longer than 500 characters once its surrounding whitespace is trimmed, then the server MUST answer `400 validation_error` naming `q`.

**Reason:** a character outside the Basic Multilingual Plane counts once, and a query that is cut short would answer as though the person had typed less.

**Tests:** `compliance/search-bounds.test.ts › takes a q of 500 characters and refuses one of 501, counting characters and not bytes`.

### `search-and-filters/search-q-words`

If `GET /search` carries a `q` that is not wholly inside double quotes and holds more than 16 distinct whitespace-separated words, then the server MUST answer `400 validation_error` naming `q`.

**Tests:** `compliance/search-bounds.test.ts › takes 16 distinct words and refuses 17`.

### `search-and-filters/search-repeated-word`

When a query is not wholly inside double quotes and repeats a word, the server MUST match it as it matches the query with each repeated word typed once, at the place of its last copy.

**Reason:** a repeat adds no condition, so it does not count toward `search-and-filters/search-q-words`, and a last word typed more than once still matches as a prefix, as it does typed once.

**Tests:** `compliance/search-bounds.test.ts › searches a repeated word once and does not count it again`, `› matches a repeated last word as a prefix, as typing it once does`.

### `search-and-filters/search-matches`

When `GET /search` carries a `q`, the server MUST answer the items whose searchable text or tags match it, and no other item but the items of the row hits `tables/search-row-hit` adds.

**Tests:** `correctness/persistence.test.ts › search for distinctive text returns matching items`, `› search for nonexistent string returns empty results`.

### `search-and-filters/search-hidden`

The server MUST leave hidden items (`items/hidden-types`) out of the matches of `GET /search` unless the request names `include=hidden` or a `type` that is a hidden type written exactly (`search-and-filters/type-hidden-exact`).

**Reason:** a search that names a hidden type has said what it wants, as a listing does (`search-and-filters/system-named-type`).

**Tests:** `compliance/hidden-types.test.ts › leaves an app item out of a search unless the search asks for hidden items`, `› answers a search that names a hidden type with the items of that type, as a listing does`.

### `search-and-filters/search-id-not-text`

The server MUST NOT match an item on its identifier alone.

**Reason:** an identifier is not searchable content, so it matches only where it also appears in an indexed field or a tag.

**Tests:** `compliance/fts-searchable.test.ts › matches searchable content and tags without matching an item identifier alone`.

### `search-and-filters/search-tags-with-text`

When `GET /search` carries a `q` of several words, one that an item's tag holds and the others its searchable text holds, the server MUST answer the item.

**Reason:** an item's tags are searched with its text, so a query need not say which words are tags.

**Tests:** `compliance/fts-searchable.test.ts › matches a query whose words are split between an item's tag and its text`.

### `search-and-filters/search-score`

The server MUST carry on each hit of `GET /search` a positive `relevance_score`, higher for a hit ranked better and equal for hits of equal rank.

**Reason:** the score is relative to the items of the index it ranks in, so it compares hits only within one search.

**Tests:** `compliance/search-matching.test.ts › scores a hit by its rank and gives the better hit the higher score`.

### `search-and-filters/search-score-unreadable`

The server MUST NOT let an item or a row that a credential may not read change the `relevance_score` or the order of a hit of `GET /search` that it answers that credential.

**Reason:** BM25 weighs a word by how many entries of its corpus hold it and a text by the corpus's mean length, so a corpus wider than what the credential may read would tell it what the rest says.

**Tests:** `compliance/table-rows-search.test.ts › scores and orders a key's hits by what it may read, whatever the items and rows it may not read hold`.

### `search-and-filters/search-cursor`

When a client sends back the `next_cursor` of a page of `GET /search` with the same query while no item it may read is written, the server MUST continue the ranking, so that walking to `null` delivers every hit once.

**Reason:** BM25 weighs a word by how many entries of the corpus hold it, so a write moves every hit's rank and a walk read across writes reads several rankings. `search-and-filters/search-cursor-sorted-writes` states what a walk by a column keeps while writes land.

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

**Tests:** `compliance/search-ordering.test.ts › walks a sorted search to the end, delivering every hit once`, `compliance/datetime-property-compare.test.ts › orders a search by instant, and pages through it with a cursor`.

### `search-and-filters/search-cursor-sorted-writes`

When a client walks a `GET /search` that names a `sort` other than `relevance` by sending back the `next_cursor` of each page, and items are created, changed or deleted between the pages, the server MUST deliver once each hit that exists throughout the walk and whose sort value does not change.

**Reason:** a position in the order of a column is the value and the ID of the last hit, and it stays where it was whatever is written, while a count of hits delivered moves with every write before it.

**Tests:** `compliance/search-walk-writes.test.ts › delivers each item that exists throughout once when items are created, edited and deleted between pages, in property order`, `› delivers each item that exists throughout once while the ties of a value are split by a page and joined by a new item`, `› delivers each item that exists throughout once, in last_activity_at order, whichever way and with new items at either end`, `› delivers each item that exists throughout once when a sort value changes between pages, never delivering an item that was not changed twice`.

### `search-and-filters/search-depth`

When a page of `GET /search` holds the 10,000th hit of the ranking, the server MUST answer `next_cursor` of `null`.

**Reason:** the server reads the ranking at most 10,000 hits deep, so a search is narrowed rather than paged past that depth.

**Tests:** `compliance/search-depth.test.ts › stops paging a search at its 10,000th item`.

### `search-and-filters/search-sort-relevance`

When `GET /search` names no `sort`, or `sort=relevance`, the server MUST order the hits by relevance, the best match first.

**Tests:** `compliance/search-ordering.test.ts › orders a search by relevance, best match first, and worst first when ascending`.

### `search-and-filters/search-sort-relevance-ascending`

When `GET /search` names `direction=asc` and no `sort` or `sort=relevance`, the server MUST order the hits by relevance, the worst match first.

**Reason:** a direction is honored rather than refused, because every ordering a search takes has two directions and this one is well defined.

**Tests:** `compliance/search-ordering.test.ts › orders a search by relevance, best match first, and worst first when ascending`.

### `search-and-filters/search-sort-column`

When `GET /search` names `sort=created_at`, `sort=updated_at`, `sort=occurred_at` or `sort=last_activity_at`, the server MUST order the hits by that column, newest first unless `direction=asc`.

**Tests:** `compliance/search-ordering.test.ts › orders a search by a time column, newest first unless told otherwise`, `compliance/search-walk-writes.test.ts › orders a search by last_activity_at, which a row moves and updated_at does not`, `correctness/pagination.test.ts › orders a search by last_activity_at, a tie by id ascending in both directions, and pages through the tie`.

### `search-and-filters/search-sort-property`

When `GET /search` names `sort=properties.<field>`, the server MUST order the hits by the scalar value each stores in that property, a time by its instant, in the order `search-and-filters/sort-property-ascending` and `search-and-filters/sort-property-descending` give a listing, and put the hits whose property is missing, null, an object or an array after every scalar in either direction.

**Tests:** `compliance/search-ordering.test.ts › orders a search by a property with the items that lack one last in both directions`, `compliance/datetime-property-compare.test.ts › orders a search by instant, and pages through it with a cursor`.

### `search-and-filters/search-sort-ties`

When `GET /search` orders hits that tie on relevance, on a time column or on a property, the server MUST order them by item ID ascending in both directions.

**Reason:** an unordered tie is two answers to one query.

**Tests:** `compliance/search-ordering.test.ts › breaks a tie by item ID, ascending`, `compliance/search-matching.test.ts › $name: $query`, `correctness/pagination.test.ts › orders a search by last_activity_at, a tie by id ascending in both directions, and pages through the tie`.

### `search-and-filters/search-sort-invalid`

If `GET /search` names a `sort` that is not `relevance`, `created_at`, `updated_at`, `occurred_at`, `last_activity_at` or `properties.<field>` with a field of lowercase letters, digits and underscores, or a `direction` that is not `asc` or `desc`, then the server MUST answer `400 validation_error` naming the parameter.

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

When `GET /search` names no `sort`, or `sort=relevance`, the server MUST rank an item's own hit by BM25 over the `title`, `body`, `description`, `name`, extra properties and tags, counting a word in the `title` three times as much as the same word in any other of them.

**Reason:** a person names a thing by its title, so an item that holds the query in its title comes before one that holds it only elsewhere, other things equal. A device ranks by the same measure over the items it holds (`device/rank-bm25`), so a device that holds what its key may read orders as the server orders for that key.

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

`GET /items/stats` breaks one filtered set of items down by state, type or source. `POST /items/counts` counts, for each of up to 100 items, what the item links to or holds.

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

When `GET /items/stats` names `include=hidden`, the server MUST count the hidden items (`items/hidden-types`) that the credential may read.

**Tests:** `compliance/item-stats.test.ts › counts the system items under include=hidden and refuses any other include`.

### `search-and-filters/type-hidden-exact`

If a listing, a search or a count names types and does not name `include=hidden`, then the server MUST NOT return an item of a hidden type unless one of the names is a hidden type written exactly, not as a wildcard, that is that type or is above it.

**Reason:** naming a type opts in only to that hidden type. A hidden subtype of a visible type stays hidden, naming one hidden type opens no other, and a wildcard such as `app.*` narrows hidden items a request asked for with `include=hidden` but does not ask for them itself, so it cannot gather every app's machinery at once.

**Tests:** `compliance/hidden-types.test.ts › opens a type filter to the hidden type it names and no other, though a visible type it names has that other as a subtype`, `› opens no hidden type to a wildcard, which narrows hidden items only where include=hidden asks for them`.

### `search-and-filters/stats-system-default`

When `GET /items/stats` names neither `include=hidden` nor a `type` that is a hidden type written exactly, the server MUST leave the hidden items (`items/hidden-types`) out of its counts.

**Tests:** `compliance/item-stats.test.ts › counts the system items under include=hidden and refuses any other include`.

### `search-and-filters/stats-include-other`

If `GET /items/stats` names an `include` other than `hidden`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/item-stats.test.ts › counts the system items under include=hidden and refuses any other include`.

### `search-and-filters/counts-linked`

When `POST /items/counts` names `backref` or `edge` with an edge type, the server MUST answer, for each item in `ids`, `total` as the number of items that a `GET /items` listing with the filter `backref[<edge type>]` or `edge[<edge type>]` anchored on that item and no `state` lists, and `status_groups` as how many of them fall in each of `not_started`, `in_progress`, `completed` and `canceled`.

**Reason:** a count that differs from the list a person opens next is wrong, so the listing's own default decides what counts: only `active` items, never an archived item, an item in the bin or a hidden item (`items/hidden-types`).

**Tests:** `compliance/item-counts.test.ts › counts what each anchor links, by status group, and equals the listing`, `› counts the items that link to an anchor as well as the items it links to`.

### `search-and-filters/counts-status-groups`

When `POST /items/counts` counts linked items, the server MUST answer `status_groups` with all four groups, `0` included.

**Tests:** `compliance/item-counts.test.ts › counts what each anchor links, by status group, and equals the listing`.

### `search-and-filters/counts-ungrouped`

When `POST /items/counts` counts an item with no status field, no status value or a status word its type no longer declares, the server MUST add it to `total` only.

**Tests:** `compliance/item-counts.test.ts › counts what each anchor links, by status group, and equals the listing`.

### `search-and-filters/counts-reading`

When `POST /items/counts` counts linked items, the server MUST count only the items of the types the credential reads, only through edges whose from item the credential reads, and only the items the credential's source filter shows.

**Tests:** `compliance/item-counts.test.ts › counts only what the credential reads, through the edges it reads, under its source filter`.

### `search-and-filters/counts-edge-anchor`

When an id in `ids` of a `POST /items/counts` that names `edge` is an item the credential does not read, the server MUST count the readable items that link to it, as the `GET /items` listing with the filter `edge[<edge type>]` anchored on it lists them.

**Reason:** `GET /edges` already shows a readable edge's to item to the credential that reads the edge, so the count tells it nothing the listing does not.

**Tests:** `compliance/item-counts.test.ts › counts the readable items that link to an anchor the credential cannot read, as the listing does`.

### `search-and-filters/counts-edge-anchor-source-filter`

Where a source filter applies to the key, when an id in `ids` of a `POST /items/counts` that names `edge` is an item the filter leaves out, the server MUST NOT leave out the readable items that link to it, as the listing does not.

**Reason:** the source filter narrows the items counted, and the listing with the `edge` filter applies it to those and not to the anchor.

**Tests:** `compliance/item-counts.test.ts › counts through an anchor the source filter hides exactly as the listing does`.

### `search-and-filters/counts-backref-anchor`

When an id in `ids` of a `POST /items/counts` that names `backref` is no item or an item the credential does not read, the server MUST answer `total` as `0` and every group as `0`, exactly as for an item with nothing linked.

**Reason:** edges from an item the credential cannot read are never counted (`edges/filter-backref`), so the answer for such an item is the answer for an id no item holds, and tells the credential nothing of whether the item exists.

**Tests:** `compliance/item-counts.test.ts › answers a missing and an unreadable anchor alike for backref and for tables`.

### `search-and-filters/counts-rows-anchor`

When an id in `ids` of a `POST /items/counts` that names `table` is no item or an item the credential does not read, the server MUST answer `total` as `0`, exactly as for an item that holds no row.

**Reason:** the tables door answers a host the credential cannot read as it answers one that does not exist, so a count that differed would tell the credential the item exists.

**Tests:** `compliance/item-counts.test.ts › answers a missing and an unreadable anchor alike for backref and for tables`.

### `search-and-filters/counts-rows`

When `POST /items/counts` names `table`, the server MUST answer, for each item in `ids` whose type the credential reads and that is not in the bin, `total` as the number of rows the item holds in that table, with no `status_groups`.

**Tests:** `compliance/item-counts.test.ts › counts a table's rows, and answers 0 for a table the type does not declare`.

### `search-and-filters/counts-rows-none`

When `POST /items/counts` names a `table` that the type of an item in `ids` does not declare, or that holds no row of the item, or the item is in the bin, the server MUST answer `total` as `0`.

**Tests:** `compliance/item-counts.test.ts › counts a table's rows, and answers 0 for a table the type does not declare`.

### `search-and-filters/counts-order`

The server MUST answer `POST /items/counts` with `counts` holding one entry for each distinct id in `ids`, in the order the ids first appear.

**Tests:** `compliance/item-counts.test.ts › answers in request order, once for a repeated id, and refuses more than 100 ids`.

### `search-and-filters/counts-id-rules`

The server MUST refuse the `ids` of `POST /items/counts` by the rules `POST /items/bulk-get` applies to its own: more than 100 ids, `ids` that is not a list, a malformed id and no `ids`.

**Tests:** `compliance/item-counts.test.ts › answers in request order, once for a repeated id, and refuses more than 100 ids`, `› refuses a request that does not name what to count, with the codes the other doors use`.

### `search-and-filters/counts-one-counted`

If `POST /items/counts` names none or more than one of `backref`, `edge` and `table`, a `backref` or `edge` that is not an edge type, a `table` that is not a table name, or a body key it does not declare, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/item-counts.test.ts › refuses a request that does not name what to count, with the codes the other doors use`.

### `search-and-filters/counts-no-type`

If the credential of a `POST /items/counts` request reads no type, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/item-counts.test.ts › refuses a request that does not name what to count, with the codes the other doors use`.

### `search-and-filters/counts-no-edge-type`

If a `POST /items/counts` request names an edge type that its credential does not read, then the server MUST answer `403 edge_type_not_permitted`.

**Tests:** `compliance/item-counts.test.ts › refuses a request that does not name what to count, with the codes the other doors use`.

### `search-and-filters/counts-is-a-read`

The server MUST answer `POST /items/counts` to a read-only key and to an app token that reads the types and edges it counts.

**Tests:** `compliance/item-counts.test.ts › is a read, open to a read-only key and to an app token for chosen types, and takes no reach header`.

### `search-and-filters/counts-no-reach`

If a `POST /items/counts` request carries `X-Marfa-Reach`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/item-counts.test.ts › is a read, open to a read-only key and to an app token for chosen types, and takes no reach header`.

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

The server MUST leave out of the items of `POST /items/lookup` a hidden item (`items/hidden-types`), whichever key names it.

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

If a `POST /items/lookup` body names a well-formed `type` that nothing registers and the credential's type map reads it, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/links.test.ts › refuses a lookup naming no selector, two, or more than 500 values`, `compliance/unreadable-type-filter.test.ts › answers 403 where it used to answer an empty 200, and 400 for an unregistered type`.

## Pages

Every list and every search answers the same envelope. A hydrated block of edges is a page of the same shape (`edges/hydrate`), and so is an item's history (`versions/include-first-page`).

### `search-and-filters/page-envelope`

When a list or a search answers, the server MUST carry the items under `data` and the cursor that continues them under `next_cursor`, `null` on the last page, and no other key but a sibling that the operation's own rule names.

**Reason:** a client reads every page from one shape, and the siblings are `occurrences/answer-keys`, the `min_copies` of `GET /blobs/stores`, the `retention_days` of `GET /trash`, and the `vendor`, `client_id` and `types` of `GET /app-vendors/{vendor}/data` (`keys-and-oauth/app-data-list`).

**Tests:** `compliance/envelope.test.ts › GET %s answers data and next_cursor`, `› names forty doors, every one the document publishes as a page`.

### `search-and-filters/page-whole-set`

When a list takes no `cursor`, the server MUST answer its whole set with `next_cursor` `null`.

**Tests:** `compliance/envelope.test.ts › answers a null cursor from every door that takes none`.

### `search-and-filters/page-grants`

The server MUST answer `GET /grants` in the envelope of a list.

**Tests:** `compliance/envelope.test.ts › answers GET /grants to a key with grants.manage in the same envelope`.

### `search-and-filters/page-full-last`

When the items of a page fill it exactly and it holds the last item, the server MUST answer `next_cursor` `null` on every operation that takes a cursor.

**Reason:** a walk then never ends on an empty page it was sent to. A page can still be short or empty with a cursor to follow, so a walk stops on `null` and never on a short page (`connectors/list-agreements-short-page`).

**Tests:** `compliance/full-last-page.test.ts › %s answers null when the items fill the page exactly`, `› covers every door that takes a cursor`.

## Export

`GET /export` admits a credential and answers the items that caller may read and the edges between them, as NDJSON or as an archive that `POST /restore` reads. Management permissions alone grant no content access (`blobs/export-blobs-manage-no-map-refused`).

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

## Owner item summaries

### `search-and-filters/owner-summaries-authority`

When the private local command or a credential that reads some type sends `GET /items/summaries`, the server MUST admit the read.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`, `compliance/owner-tasks.test.ts › lists item summaries of only the types a credential reads, and refuses one that reads none`.

### `search-and-filters/owner-summaries-reach`

When a credential sends `GET /items/summaries`, the server MUST list only items of the types the credential reads.

**Tests:** `compliance/owner-tasks.test.ts › lists item summaries of only the types a credential reads, and refuses one that reads none`.

### `search-and-filters/owner-summaries-no-reach`

If a credential whose type map reaches no type sends `GET /items/summaries`, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/owner-tasks.test.ts › lists item summaries of only the types a credential reads, and refuses one that reads none`.

### `search-and-filters/owner-summaries-projection`

When `GET /items/summaries` succeeds, the server MUST return each item as exactly `id`, `type`, `version`, `name`, `source` and `created_at`, with its name computed as in `types/item-name-fields`, `types/item-name-markdown`, `types/item-name-text` and `types/item-name-empty`.

**Tests:** `compliance/item-summaries.test.ts › pages name matches without leaking content or widening other owner reads`.

### `search-and-filters/owner-summaries-selection`

When `GET /items/summaries` lists items, the server MUST exclude trashed and hidden items (`items/hidden-types`), apply instance source filtering and, when supplied, match `type` as an exact identifier.

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
