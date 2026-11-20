# The core's API for apps

This page is the reference for an app developer who embeds the Rust core through `marfa-core` itself or the Swift binding (`bindings/swift`, packaged by `withmarfa/marfa-swift`). The Node module (`bindings/node`) is used only by the contract's device fixtures and is not published. The contract states what the core does: `conformance/spec/device.md`, `queue-and-verdicts.md` and the `folder-` chapters. This page adds the calls, the types and what crosses each binding.

## Identify an instance

`marfa_core::instance_description(url)` reads the server's public JSON description without a working copy or a credential. The Swift binding exports the same call and an `InstanceDescription` record with `name`, `version`, `instance_id`, `contract` and `features`.

The read keeps the address's path prefix, asks for JSON and sends no credential, including one embedded in the URL. It returns the configured display name, or the server's default `Marfa`, and does not invent a name when the answer is malformed. A connection failure, an HTTP refusal, a redirect or a malformed description returns an error. A description can be read from a server on another contract, so a client can identify it before opening a working copy; reading it does not establish contract compatibility or access to any data.

A call that sends the server an item ID, a file hash, an event cursor or a name a person wrote first reads the root, and reads it again after a credential renewal. This covers a pin, a table hold or read, a link resolved by its ID or its name, the bin, a catch-up, a drain, a trash, a purge, a count, a view write, a folder's settings and its status reports. A catch-up and a follow read the root again before the reads that apply each event, and a follow before each stream it opens; this adds one request for each event that reads the server. A fetch of files reads it again every 25 files, or once the files fetched reach 64 MiB. If the root names an instance other than the one the copy was built from, the call sends nothing more and ends `CopyExpired` with the reason `instance_changed`, and a writing handle expires the copy. A trash the server already accepted still returns its result, with `settled` false and `behind` naming the instance. A resolver that met another instance answers no later name. A hydration takes its instance from its latest read of the log's head and confirms it again after a credential renewal; another instance found then ends it `CopyExpired` with the reason `instance_changed`. The root read and the request are two requests, so a server that takes the address between them still receives that one request.

## Trash several items at once

An app that deletes a selection previews, then trashes, on `Core` (the Swift binding carries both as `preview_trash(ids)` and `trash_items(preview)`):

- `preview_trash(ids)` takes 1 to 20 distinct ids (an id named twice counts once; none or more than 20 is refused `Validation` before anything is sent) and answers the server's preview: each item once with what its trash takes (`takes`, cut at 100 with `truncated` set), the `count` of every item the trash would take, and a `digest`. It needs the server, confirms the instance as a read does, and a reading handle may call it.
- `trash_items(preview)` sends the preview's ids and digest in one request, never queued, so an offline app uses the single queued `delete_item` instead. It is refused `Invalid`, sending nothing, while a write waits for a named item or one listed in `takes` (for any item where a `takes` was truncated), a create that names such an item's `source_id` included, with the commands that clear each. A refusal from the server, `trash_plan_changed` for a digest that no longer matches included, comes back typed and changes nothing.
- Once the server accepts, `trash_items` attempts to catch up with the server's events within five seconds and returns a `TrashReport`. With `settled` true, every item the copy holds that the trash took, listed or not, is in the bin, or as a later event left it. With `settled` false, the trash still happened, `behind` says why the copy has not caught up, and the follow or the next catch-up settles it.
- Until `trash_items` returns, a write to an item it names or lists in `takes` (to any item, where a `takes` was truncated) is refused `Validation` with the code `item_being_removed` and its `id` in the details. That includes a create that names the item's natural key, a move of an edge to start from it, a release of a write to it, a change to it as a view or a folder, and a second trash or a purge of it. A purge holds its item the same way, and refuses while a write to the item, or a create that names its `source_id`, waits. Where a `takes` was truncated, a create that names an id or a `source_id` is refused too, while a create that names neither, a new view or a new folder is not. Try again once the call returns.
- A `Network` failure may follow a trash the server made. The `item.trashed` events settle the copy; preview again before trashing again.

## Read many rows, and what changed

An app that holds what it shows in memory reads many rows in one call, then rereads only what changed. On `Core`:

- `get_items_shown(ids, include_bin)` answers each item held, once each, in the order named, from one snapshot. An ID not held is left out, and so is an item in the bin unless `include_bin` is set. Part way through a hydration, the answer is `Partial`. `get_items_kept` keeps a damaged row.
- `get_edge(id)` and `get_edges(ids)` answer edges by ID; `get_edge_kept` and `get_edges_kept` keep a damaged edge.
- `body_links_of(ids)` answers `body_links` for each item held outside the bin that it can read, against one catalog, and leaves out the rest.
- `changes_since(cursor, most)` answers the items and edges changed since `cursor`, each split into those held and those removed, the tables whose state or rows changed (including fills, events and local writes), each by item and name, and the cursor to pass next. It answers `everything` and names none without a cursor, with a cursor from another store, from beyond what the copy recorded, from before a change to the types or from before a removed edge the copy no longer records, or where more than `most` items, edges or tables changed.
  - An item is named where its row, tags, an edge at it, its pin or a write queued for it changed, so a name may change nothing on screen. An item whose body links read differently only because another item changed, such as a link that starts to resolve when its target arrives, is not named.
  - Like every read of edges, it is refused `HydrationIncomplete` while a hydration is part way or the copy is stale. Take the cursor before reading what it covers, and keep the earlier cursor until that read succeeds: make a reread refused `HydrationIncomplete` again from the earlier cursor once the copy is whole.
  - The copy records one change for each item and each edge it has held. When the writer opens a store that holds more than 20,000 records of edges it no longer holds, it lets go of those beyond the latest 10,000 changes (`EDGE_CHANGES_KEPT`), so a cursor from before one it let go of answers `everything`. A reading handle lets go of nothing.

The Swift binding exposes these as `get_items`, `edge`, `get_edges`, `body_links_of` and `changes_since`. The `marfa` binary reads them with `device items bulk-get`, `device items bulk-links`, `device edges get`, `device edges bulk-get` and `device changed`.

`Core::counts(ids, counted)` counts linked items or table rows for up to 100 item IDs. It returns one `ItemCount` per distinct ID in first-requested order. For links, `total` includes active items and `status_groups` gives the counts in each of the four groups. For table rows, each answer carries only the ID, total and `held`. A table held whole has `held` set to true. Other tables require a server connection.

In Swift, pass `Counted.backref(edgeType:)` to count the items each anchor links to, `Counted.edge(edgeType:)` to count the items that link to each anchor, or `Counted.table(table:)` to count rows. In Node, pass one of `{ backref: edgeType }`, `{ edge: edgeType }` or `{ table: name }` as the second argument. Node returns an object with a `counts` array.

If a local link count fails with `not_answerable`, ask the server with `servedCounts(ids:counted:)` in Swift or `servedCounts(ids, counted)` in Node. Pass the same arguments. Each result has `held` set to false. Propagate other errors to the caller.

The request uses the copy's server and current credential. If the copy records an instance, it checks the anonymous root before requesting counts and includes the recorded instance in `X-Marfa-Instance-Id`. If the root identifies another instance, the request is not sent: the call returns `wrong_server` at a new origin and `copy_expired` at the recorded origin, where a writing handle also expires the copy. The root check and the count are two requests, so another instance can take the address between them and still receive the count. A conforming server refuses a request that names another instance with `409 instance_changed` and returns no counts, and the call returns `copy_expired`. A reading handle stores nothing during a served count and never expires the copy; the writing handle expires it when it next finds the other instance.

The server's answer must be an object with a `counts` array containing each requested ID once, in request order. Totals and group counts must be nonnegative integers. A link count must include all four status groups, and their sum must fit within the total. A row count must omit `status_groups`. If any check fails, the whole call fails with `decoding`.

To time these reads and a whole listing over a copy of many notes, run from `core/`:

```sh
CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true MARFA_READ_BENCH_ROWS=50000 cargo test --release -p marfa-core --lib read_bench -- --nocapture
```

The release profile needs debug assertions because the core's tests use fault points that only such a build holds.

## Read views offline

`list_views`, `view`, `list_in_view`, `search_in_view` and `view_groups` on `Core` read the views a copy holds, without the server, as the contract's `device/view-read` and the statements after it say. The Node and Swift bindings expose the same reads. View settings stay JSON values; a group carries a JSON scalar or null key and a count.

## Name and preview an item

`Core::item_displays(items)` answers each item's name and preview text, in order, from its type, its properties and the catalog the copy holds, without asking the server. An app passes the rows it already holds, so the listings and their packed layout carry neither.

- The name follows the server's rule in `conformance/spec/types.md`, so a name taken from a body has its Markdown removed, and is none where the server would say `Untitled`.
- A part with no title of its own, passed with its ID, is named after its host, such as "Comment on Fix login bug" (`device/item-name-part`); its preview then keeps every line of its body.
- The preview is the type's body field with its Markdown removed, at most 240 code points (`device/item-preview-field` and the statements after it).

Both bindings expose it as `item_displays` (`itemDisplays` in Node). `conformance/fixtures/item-display.json` holds the cases that the core's unit tests, the server's tests and both halves of the contract are held to.

## Show an item as read-only

`Item::read_only` is what the server answered for the row (`items/read-only-answered`): advice that an app shows the item as not editable. The core refuses no write for it, and sends an edit of a read-only row as any other. A row the server has not answered, such as one saved here and not yet sent, holds `false`.

The copy reads the value again as `device/read-only-refresh` and the statements after it say. It moves the rows `PACE.read_only_page` at a time, one transaction each, so a read gets through between two pages. The rows that moved show in `changes_since`, and a follow tells one `item.updated` change that names no row. `CatchUpReport` and `FollowReport` count them as `read_only_held`, apart from `applied`, which counts events (`device/read-only-report`).

To time a flip of many rows and a read beside it, run from `core/`:

```sh
MARFA_READ_BENCH_ROWS=200000 cargo test --release -p marfa-core --lib read_only_bench -- --nocapture
```

## Build a filter

`FilterExpression` holds a listing's `filter` as values, so an app builds one, and edits a saved one, without writing the grammar by hand.

- An expression is a list of `FilterCondition`s and the one `FilterJoin` between them, `All` for `AND` or `Any` for `OR`, since the grammar never mixes them and has no groups or `NOT`.
- A condition names a `FilterField` (a system field, a property, a member of a list's entries, `tags`, `status_group`, or an outbound or backref edge type), a `FilterOperator`, and a `FilterValue` (text, a number or a boolean) exactly where the operator takes one.
- `FilterField::operators()` answers the operators the grammar takes on a field.

`FilterExpression::encode()` writes the text and `FilterExpression::decode(text)` reads it, both through the one parser that answers views offline. Each refuses what the server refuses, with the server's `validation_error` and message, including text over 2,048 UTF-16 code units. `encode` escapes every quote and backslash in a text value, so any text can be written, and refuses a number that is not finite. Decoding what `encode` wrote gives back the same expression, except the join of a single condition, which the text does not carry and which reads back as `All`. Encoding what `decode` read gives the text's canonical spelling, which the server reads the same way.

Both bindings expose `encode_filter`, `decode_filter` and `filter_operators` (`encodeFilter`, `decodeFilter` and `filterOperators` in Node, which take and answer the model's JSON form). `conformance/fixtures/filter-expressions.json` holds the cases that the core's unit tests, the Node binding's tests and the server's parser are held to.

## Read a link's parts and what it could name

An editor reads links from the core rather than parsing them itself.

- `link_parts(text)`, a free function that needs no store, answers every `[[link]]` in a text in order, repeats and heading-only links included, with its name, heading, row (a heading that begins with `^`, as in `[[item#^row]]`) and alias. Each is placed as a range of UTF-16 code units, which is how Swift's `NSString` and a JavaScript string count (`device/link-parts`).
- `Core::link_candidates(item, targets)` answers, for the text between each link's brackets, every item the copy holds outside the bin that its name answers to by ID, title or file path, and whether it is `Bound`, `Ambiguous` or `Unresolved`. With `item`, each is read as a link in that item's body, `Bound` where saving it there would bind it without the server (`device/link-candidates`). A single held candidate stays `Unresolved`, since the copy holds a slice.

The Swift binding exposes them as `link_parts` and `link_candidates`, the Node module as `linkParts` and `linkCandidates`, and the binary as `device items link-parts` and `device items link-candidates`.

## Watch a store

`Core::watch` (`watch` in the Swift and Node bindings) adds a listener to the one watch a store has, and starts it if it was idle. However many listeners there are, one source runs, and only while one is attached. A hydration or catch-up takes the stream from the watch for its duration and gives it back, so an app need not stop its listeners around either. The contract's `device/watch-tells` and the statements after it say what a listener hears.

One thread tells every listener, so `changed` must return promptly.

## Stop a call

Each binding takes a `Stop` on the calls that can be stopped, such as a hydration, a catch-up, a drain and a read of the server's catalog. Raise it when the app's own cancellation is requested. What a stopped call leaves is in the contract (`device/stop-canceled` and the statements after it).

## What a queued write survives

A call that returns a queued write has synced it to the store's log, so the write is still there after the app is killed. On Linux it also survives a system crash or a power cut. On a Mac, iPhone or iPad the sync does not empty the drive's own cache, so a system crash or a sudden power cut can still lose the last writes; the store stays whole, because each checkpoint empties that cache. The store syncs every commit, including each page of a hydration, so a write or a hydration takes a little longer than it would without the sync.

## A store another build made

A writer upgrades in place a store an earlier build made, from the first version this build upgrades, and keeps every write its queue holds. A store of a later version, or of one earlier than that, is refused with the error coded `wrong_schema` and left unchanged. `readUnsent` lists each write such a store holds that the server has not taken, in queue order, with its id, its kind as the store names it, its item, its body and its verdict, so an app can show the person what removing it would lose. With the writes it gives a `confirmation`, an opaque string that stands for every field of every listed write, in that order.

`readUnsent` does not open a core or upgrade the store. It holds the writer lock and reads the database through a read-only connection. It refuses with `reading_handle` while another core holds that lock, `store_damaged` while a set-aside of the store is unfinished or while its file is empty and its write-ahead log holds committed writes, or `store` if it cannot read the queue. A path with no store lists no writes and makes no writer lock there. The kind and verdict are raw strings and can include values this build does not recognize. A waiting write has no verdict: Node omits the field, and Swift returns `nil`.

To remove the store, pass `removeStore` the `confirmation` that `readUnsent` gave with the writes the person was shown and agreed to lose. The removal holds the writer lock while it reads the store's unsent writes again and removes the store, so no write can be queued or changed between the two. If the writes differ in any way from those the confirmation was given with, such as a write added or answered, or a write whose body or verdict changed under the same id, it refuses with `unsent_differs` and leaves the store as it was. The refusal's `unsent` holds how many writes the store holds that the server has not taken, or none if it cannot read them. Call `readUnsent` again, show the person the writes and ask before you remove the store with the new confirmation. To finish a removal that stopped part way, call `readUnsent` on the path again and pass its confirmation.

## A store that cannot be read

A store SQLite cannot read, whole or in part, is refused with the error code `store_damaged`. A refusal at open names its `path` and gives `unsent`, the number of writes its queue holds that the server has not taken, or none if the queue cannot be read in full.

A refusal during a later call has an empty `path`. Close every handle on the store, then call `checkStore` to read its pages, check its indexes against their rows and obtain a refusal with the path and count. `setAsideDamaged` keeps the damaged file under `<store>.damaged-<n>` beside it and creates a store at the original path with each write it can read. Its result gives the number of carried and unread writes, the unread IDs it could identify, and whether it read the whole queue, every record that decides how a carried write is sent and every record of the bytes an earlier set-aside keeps. If it could not read every write and record, every byte the cache held at that point stays, whatever the file budget, until the store set aside is removed or moved from where the set-aside put it. Hydrate the new store before draining it. If `held` is nonzero, writes whose original instance could not be read remain blocked `instance_changed` until released. If `recordUnread` is nonzero, writes whose record of how they are sent could not be read remain blocked `record_unread` until released. If the store is now built from another instance than the one such a write was made against, or the set-aside could not tell which that was, releasing it blocks it `instance_changed` and answers that nothing was released; release it again to send it. While a set-aside is unfinished, `removeStore`, `removeStoreLosingAll` and `replaceRefused` refuse `store_damaged`; call `setAsideDamaged` again to finish it.

Every `store_damaged` refusal carries `setAsideStopped` in Node and Swift: true while a file stands at `<store>.carrying`, so that an app offers no removal or replacement; false for any other damage. A set-aside that stopped left the file, and `setAsideDamaged` finishes it. A file that is not a set-aside's makes `setAsideDamaged` refuse and name it: move the file elsewhere, then remove, replace or set aside. Test it, never the text of the refusal's `reason`.

Use `removeStoreLosingAll` when the person agrees to lose every unsent write. It reads the queue under the writer lock and refuses with `unsent_differs` and the count in `unsent` if the complete list of unsent writes reads and holds any. Call `readUnsent`, show the person those writes, and pass their confirmation to `removeStore`. If the list cannot be read in full, even where some rows read, or is empty, removal proceeds under the same lock.

## A server restored to an earlier point

A server put back to an earlier copy of its database no longer holds what it took after that point, and its event log reuses the ids it gave then. A catch-up or `follow` finds this in three ways, ends `CopyExpired`, and the next `hydrate` reports `restarted` as `head_past_log`:

- The server's log ends before the cursor the copy holds.
- The event at the last id the copy took differs from the one it took. The core keeps that event's fingerprint and asks the stream for one event before its cursor, so each stream it opens replays one event the copy already holds.
- The server no longer holds a write it accepted from this copy. The core keeps a receipt of each create, edit, delete and edge write the server accepted, until the stream shows the change or for 30 days, and checks each unseen receipt once per stream, after the replay. A move into the bin counts as a delete, and a later move out of the bin from this copy lets the delete's receipt go. A delete is shown only by its own `item.trashed`, `item.purged` or `edge.deleted` event: an `item.trashed` at or after the time of the item the read after the delete found in the bin, so another client's trash at the same version before it does not count. Every receipt of a row whose read answers about that row alone (a body that does not read, or a `4xx` other than `401`, `404`, `408`, `425` or `429`) is set aside and not read again, by this check or by the comparison after a `hydrate`, which never fails on such a read.

When a write is refused and the read after it finds no item or edge the server once gave the copy, the copy keeps the row, because a purge and a restored server answer the same. The stream's purge or delete event lets it go; otherwise the receipt check finds the restore.

The next `hydrate` clears the copy and fills it from the server, as for any expired copy, and then compares what the copy held with what the server now holds. For each item, tag set, edge, removal and file the copy held that the server lacks or holds at an earlier point, it queues a write that puts it back, blocked `server_restored`. Nothing is sent until the person releases those writes; a released write keeps its idempotency key, because it was never sent. Withdraw one to drop it. A queued write for an item the server lost, and a write the server refused because it had lost the item or edge, waits on the kept create and is never sent before it. A refused write queued before the create waits one drain for it.

The comparison keeps only what the copy held. A tag change alone keeps no receipt, a purge is not put back, an item the copy held in the bin or revoked is not created again, a removal another device made is not repeated, and a row another writer moved on since the copy held it, to a later time at a later version or at the same version with the same fields, is left as the server holds it. A hydration of the same instance and reach that starts for another reason, such as a changed slice, sets aside the rows the unseen receipts name, compares each with the row the fill brings, reads the server only for a row the fill did not bring, and keeps what the server lost of them. Any `hydrate` also reads the server once for each item or edge the fill brought at an earlier version or time than the copy held, set aside or not, because the fill keeps the copy's later row over it: the stream may already have shown this copy's write, and a restore whose new writes age the log past the cursor reads as a cursor aged out, which fills the copy in place. Where the server lacks the row or holds it at an earlier point, the copy's row is kept as a write blocked `server_restored`; where it holds the row as the copy does or later, as after a write answered while the fill read past it, the copy takes the server's row and keeps nothing. The `hydrate` report is the same either way; what is kept shows only in the queue. Once a restore is found, or the comparison finds a row the server lost, every removal receipt is read, even where the copy held nothing to set aside. A hydration under another reach skips this check, because a row the new key cannot read answers as a lost one. So work lost in a restore that also gives the server another reach, such as a backup from before a change to a type, a permission or a key's maps, is not kept: the stream ends `reach_changed`, and the hydration under the new reach skips the check. A copy rebuilt from another instance keeps nothing, and `marfa backups restore` and `marfa restore` add to what the server holds, so neither starts the check.

Table rows carry no version, so the core keeps a receipt of each row a row write or an undo changed or deleted, with the answer's `last_activity_at`, until that batch's `rows.changed` event or for 30 days. A receipt finds a restore where the server lacks the row or holds it at an earlier `updated_at`. Before anything clears a held table or fills it again, the core sets aside the rows its unseen receipts name, or every row the copy held of it once a restore is found, and compares them once a fill has made the table whole (`device/restored-rows-kept`). Until then, no row write to that table is sent, so a drain between `hydrate` and `fillTables` leaves it queued; what the server answers of a row write sent before that is laid on the rows set aside. Each row the server lost is kept as a row write blocked `server_restored`, and the row writes queued to the table since go after it.

Limits: a server that withholds a purge's event from the key reads as one that lost the item. Where the server withheld events after the last one the copy took, a restore to a point among them that then writes past the copy's cursor is not found by the log, only by the receipts, and the copy does not take the events that server writes at or before its cursor. In that check before a fill, an item another device purged, whose event aged out before the fill, also reads as lost, so the copy keeps it as a create blocked `server_restored` that the person can withdraw. For table rows: only a table the copy held whole or was filling, of an item no create waits for that is neither read-only nor of a `system.` type, is compared; a row the server lacks is put back without the columns withheld from the key; a row write whose answer the device does not hold leaves no receipt, so a restore that lost only that write is found only by the log; an undo's answer gives no values, so a row an undo changed is not compared; a row with a write that has no answer yet is compared by its values alone; a row another writer changed at the same `updated_at` with other values, and a row this device deleted that an archive restore brings back at its own earlier `updated_at`, read as lost and are kept, blocked; and a row patch the restored server took before the restore was found leaves the row at a later `updated_at`, so the columns it did not name are not kept.

## Hold and write tables

`holdTable`, `letGoTable`, `heldTables`, `fillTables`, `tableRows`, `tableRow`, `tableTotals`, `writeRows` and `undoRows` on `Core` hold a type's tables in the copy, read their rows and queue row writes, as the sections of `device.md` from "Tables a device holds" to "Writing a table on a device", and "Row writes" in `queue-and-verdicts.md`, say.

- `tableRows`, `tableRow` and `tableTotals` answer in the server's shapes, with `held` set where the copy answered from a table it holds whole and unset where it asked the server. Node answers a plain object, and Swift a `JsonObject`.
- `writeRows` queues one write of kind `write_rows` for each call, and `undoRows` one of kind `undo_rows` for the batch named. A drain sends consecutive row writes to the same table in one request and gives each write its own verdict.
- A hold's and a fill's counts cross as numbers. In Swift, a held table's `state` is the enum `TableState` (`owed`, `filling`, `whole` and `online` in Node), its item is `itemId` (`item` in Node), and a read's options are the record `RowsAsked`, whose `direction` is `SortDirection` and whose `limit` is a `UInt32`.
- When a follow finishes filling a table or finds it over the cap, it emits one `tableFilled` change with the item ID and table name. Read the table again when you receive this change (`device/follow-table-filled`).

## Folders in an app

The Swift and Node bindings' `add`, `sync`, `confirm_first_sync`, `confirm`, `restore` and `remove` ask a process that holds the folder to let it go, wait up to 10 seconds, and past that are refused with the error coded `reading_handle`, naming the folder. A watch an app runs through a binding lets the folder go to a command or another call and takes it back, as the command line's watch does, and tells its listener with the events `HandedOver`, `HeldElsewhere`, `TakenBack`, `Removed` and `Unlisted`. A folder removed or taken off the registry ends that watch.

The core finds whether a folder sits in synced or network storage (`Folder::storage_cause`). The Swift binding gives the finding to an app on `Folders::add`'s answer and on the watch's `Watching` event, so the app can warn the person as the command line does.

## Values across the bindings

Both bindings hand properties, a queued write's body and its answer across as values, not as JSON text: the Node module as plain objects, the Swift crate as `JsonValue`, `JsonObject` and `JsonMember`, which the generated Swift holds as types of its own.

- A `JsonObject` keeps its keys in order.
- Sent to the core, a number that is not finite and a key that repeats are refused `Invalid`.
- An integer that `i64` holds crosses exact; any other number crosses as an `f64`.
- A queued write's answer crosses as the JSON it held, or as its text where it was not JSON.

### Nesting depth

The core refuses, when it queues a write, a body that nests deeper than `MAX_JSON_DEPTH` (64) levels, counting each array or object inside another and the body's own levels, because the server refuses a request body nested more deeply (`items/json-depth`). It is refused `Invalid` in every binding, and nothing is queued. An item's or an edge's properties sit one level down in the body, so a property's value may nest 62 levels; an extension's body is the object itself. The Swift binding refuses a value deeper than the limit before it converts it.

### Packed listings in Swift

The Swift binding's `list`, `get_items`, `list_in_folder` and `list_in_view` answer a `Listing` whose `rows` hold its items packed into one buffer, in the layout `bindings/swift/src/packed.rs` states, which `withmarfa/marfa-swift` reads back as `Item`s. A whole copy's listing read field by field as UniFFI records costs Swift several microseconds an item; one buffer costs a fraction of that.

- The buffer starts with the layout's version, `FORMAT`, which the reader checks. A change to `Item`, `JsonValue` or the layout changes that version and is a change to that reader too.
- A row whose stored properties nest deeper than `MAX_JSON_DEPTH` reads as unreadable on every read, so the reader never meets one.

### Damaged rows

A row whose stored properties are not one JSON object is damaged. The core's reads refuse a damaged row, and so does every write that reads an item's or an edge's stored properties to write from them (an edit, a delete, a read-back, a hold beneath a waiting write), so nothing writes from empty properties. A read that needs only an edge's ends and type, such as a hydration looking for the edge it is about to create, still finds it, and a server copy of the row replaces it.

The Swift binding keeps a damaged row instead in `list`, `get`, `get_items`, `search`, `edge`, `get_edges`, `edges_from`, `edges_to`, `edges_of_type`, `list_in_folder`, `search_in_folder`, `list_in_view`, `search_in_view` and `conflicted_copies_of`: the row comes with empty properties and `unreadable_properties` naming why, so one damaged row fails no list or search. These are the core's `*_kept` reads.

- A damaged row matches no property condition (`properties.<field>` in a `filter`), so a filtered list or search leaves it out.
- A body link's lookup of placements ignores a damaged placement edge.
- A write waiting on a damaged row stays queued. A hydration or catch-up that has not fetched the row again leaves it as it is, and the server's copy takes the write when it arrives.

The command line and the Node module refuse the read.

## Renew a credential in Swift

An app signed in with OAuth holds a refresh token the core never sees, so it renews its own credential. The Swift binding's `Core::open` and `Folders::new` take an optional `CredentialRenewer`. When the server refuses the token sent, the core calls its `renew` with that token, on the thread that was refused, and sends the request again, once, with the token it answers.

A catch-up or a hydration whose stream the server ends for its credential, with a `StreamIncomplete` frame whose reason is `credential_ended`, calls `renew` the same way and reads on from the last event it took, so no event is applied twice. A catch-up whose stream ends again before it takes an event is not renewed for again, and a hydration renews once, so each ends `StreamIncomplete` with that reason. Where `renew` throws `Ended`, or the copy holds a key, the call ends `StreamIncomplete` with that reason, which the app treats as an ended sign-in; any other `RenewalError` ends it as listed below.

Within one `Core` or one `Folders`, `renew` is called once at a time: calls refused together wait for one renewal and send its token, a folder still sending the token renewed away gets the new one without a call, and a folder that the `Folders` opens after a renewal starts with the renewed token. Separate `Core` and `Folders` objects call `renew` on their own and may call it at the same time, so an app that opens more than one with the same sign-in must serialize renewals across them.

A renewer must:

- Keep the new access token and refresh token before it returns, because a refresh token is spent once the server answers.
- Return the access token it holds, without renewing, when `refused` differs from it.
- Throw `Ended`, and delete the refresh token, on a token endpoint's `invalid_grant` or `invalid_client`.
- Throw `Refused`, with the `RenewalFailure` that fits, and keep the refresh token, when the token endpoint refuses the renewal any other way (`invalid_request`, `invalid_scope`, `unauthorized_client`), answers a redirect, or answers what the renewer cannot read.
- Give the token request a time limit, and throw `Unavailable` when it times out or there is no network, because stopping a watch waits for a renewal under way.
- Never wait synchronously on the main thread inside `renew`.
- Never log the refused token.

A renewer that cannot renew throws a `RenewalError`, and the queued writes stay queued whichever it throws:

- `Ended` ends the call `SignedOut`, and every later refusal ends `SignedOut` without asking the renewer again.
- `Unavailable` ends it `Network`, which a drain takes as environmental and reports as unavailable.
- `Refused` ends it `RenewalRefused`, whose `reason` is `Refused` (the server refused the renewal and the sign-in still stands), `Redirected` (the token endpoint answered a redirect, which is not followed) or `Unreadable` (the answer could not be read, or the server is not a sign-in server). Its `message` is for logs. It is not `Invalid`, which is an app's own bad arguments, and a drain does not take it as environmental: it ends with the error, and the next refusal asks the renewer again.
- `Failed`, or any other error the renewer throws, ends it `Invalid`.

The Node module takes no renewer.

A token the renewer returns counts as the credential it replaced, so a write whose answer was lost goes again under its idempotency key and the server answers it from its record. When the current credential is another one, such as the token of a new sign-in passed to a new `Core`, the core first reads what the server holds of the write's subject. It reads the item in every state, so a delete that moved it to the bin is found there. It settles the write `accepted` when the server already holds it, sends it again when the server does not, and leaves it unsent while the read gets no answer. A create that names its id, an edge create, a table row write and an upload go again without the read (`queue-and-verdicts/resend-read-first`).

A delete, an edge delete or a move to the bin whose subject the read cannot find stays without a verdict and unsent, with `404` as its last failure and a reason in the drain's report. The server gives the same `404` for an item the new credential may not read, so the core cannot tell whether the write landed (`queue-and-verdicts/resend-removal-unseen`). A create by natural key that names no source stays unsent in the same way unless the server holds it, or the current credential's own source is the one the server stamped it with: sent under another source, it would make a second item (`queue-and-verdicts/resend-create-elsewhere`). The core learns a key's source from the server, which names none for a signed-in app's token. When neither credential's source is known, the core takes both as tokens of one app and sends the create again, and the server answers it from its record or merges it into the item by its natural key. If the copy moved between the tokens of two different apps, a create that landed under the first then makes a second item. A create whose item shows only some of the edges it names also stays unsent, since the rest may be edges the current credential may not read (`queue-and-verdicts/resend-create-hidden`). Each drain counts one refusal against such a write, and at the fifth it is `dead`. The app can withdraw it. Released, it is read again under the current credential; only a drain under the credential that sent it sends it again.

A write sent again under the new credential runs afresh on the server. A single tag add or removal, a lifecycle move, a restore, and a create by natural key on an item the copy held name the version the copy held when the write was first sent. A property edit the copy had not read by then makes the server answer `409 version_conflict`, and the write is blocked `conflict_unresolved` (`queue-and-verdicts/resend-names-version`). The core then names that version on every send under the same key, so a drain back under the first credential, whose record of the key holds no version, is answered `key_spent`. Released from that block, the write goes under a fresh key and names no version, under this credential or a later one. A version does not move with tags or state, so another device's tag or state change is not caught, and a delete that landed before another device restored the item is sent again. A write that replaces every tag and an extension write carry no version, so either can overwrite newer work of the same kind. A create by natural key sent again unread, or onto an item the copy did not hold when it first sent it, names no version either. The server applies it as an upsert, so it rolls back another device's edit of a property it sends, and drops an edge another device added of a type it names, since it first landed.

## Errors

Every surface names a core error by `CoreError::code`: the `code` in the binary's `--json` envelope, `code()` on the Swift error, and `code` on an error the Node module throws or rejects with. A test that crosses every `CoreError` holds the Swift word to the core's.

- A refusal says where it came from the same way on every surface. `server` holds what a server sent, its `status`, `code`, `details` and `requestId` (the `X-Request-ID` header, absent where it sent none), and is absent or `nil` unless a server answered, whatever code the device then gave the refusal. Every Swift error a server's answer can end has it: `NotFound`, `Unauthorized`, `Forbidden`, `Validation`, `UnknownType`, `RateLimited`, `Server`, `Unnamed`, `Redirected`, `ContractMismatch` (its `status` alone where the body was not read), `CopyExpired` and `StreamIncomplete`. A code the body did not name is absent from `server`, where `Server` keeps its own `code` as `unknown`. The Swift error's `code` is the code the device named the refusal by; the Node error's and the envelope's `local` holds that code and its `details` where it differs from the server's own, or no server answered.
- The Node error is an `Error` whose message starts `code: `, with the fields the Swift error carries as properties: `server`, `local`, `retryAfterSeconds`, `origin`, `location`, `path`, `reason`, `unsent`, `expected`, `got`, `served`, `writeSent` and `hash`, each where the error has it.
- `onEnd` of a Node `follow` receives that same error, or one coded `listener_threw` where an `onChange` threw.
- A panic inside a Swift call that throws ends the call with `Fault` (code `fault`), never an error the generated Swift keeps to itself. The message is fixed and says nothing of what the call was doing. A `Core` whose connection a panic left unusable answers every later call that reads or writes the store with `Fault` too, so an app that sees one should close that `Core` and open another. A call that throws nothing, such as `linkParts`, has no error to carry a panic, so a panic there stops the app. A panic on the core's own thread, as in `follow` or `watch`, reaches the listener's `ended` as `Fault`.
- A catch-up keeps the catalog it took whatever ends it, so a failed one says whether it changed: `catalogChanged` on the Node error, `CatchUpError.Failed(error:catalogChanged:)` in Swift, and `catalog_changed` in the binary's `--json` envelope. A Swift catch-up that panicked says `true`, because the panic hid whether it changed.

## The Node module

- `withdraw(id)` returns `Promise<string[]>` containing every withdrawn write ID, including the other writes in a table batch. It returns an empty list when the queued write is ineligible; an unknown ID raises an error. `discard(id)` returns `Promise<boolean>`. Await either call to read the result or catch an error. Both run off the JavaScript thread: `withdraw` reads rows from the server, and `discard` can wait for a running drain.
- Build and test it as `core/AGENTS.md` says. `core/scripts/binding-proof.sh` drives the built module through an offline write and its verdict against a real server.

## The Swift package

`withdraw(id:)` returns `[String]` containing every withdrawn write ID, including the other writes in a table batch. It returns an empty list when the queued write is ineligible; an unknown ID raises an error.

`bindings/swift/build.sh` builds the XCFramework and its glue for macOS, iOS and the simulator. `withmarfa/marfa-swift` runs it at the commit it pins.
