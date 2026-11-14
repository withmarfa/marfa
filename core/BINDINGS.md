# The core's API for apps

This page is the reference for an app developer who embeds the Rust core through `marfa-core` itself, the Swift binding (`bindings/swift`, packaged by `withmarfa/marfa-swift`) or the Node module `@withmarfa/core` (`bindings/node`). The contract states what the core does: `conformance/spec/device.md`, `queue-and-verdicts.md` and `folders.md`. This page adds the calls, the types and what crosses each binding.

## Identify an instance

`marfa_core::instance_description(url)` reads the server's public JSON description without a working copy or a credential. The Swift binding exports the same call and an `InstanceDescription` record with `name`, `version`, optional `release`, `instance_id`, `contract` and `features`.

The read keeps the address's path prefix, asks for JSON and sends no credential, including one embedded in the URL. It returns the configured display name, or the server's default `Marfa`, and does not invent a name when the answer is malformed. A connection failure, an HTTP refusal, a redirect or a malformed description returns an error. A description can be read from a server on another contract, so a client can identify it before opening a working copy; reading it does not establish contract compatibility or access to any data.

## Read many rows, and what changed

An app that holds what it shows in memory reads many rows in one call, then rereads only what changed. On `Core`:

- `get_items_shown(ids, include_bin)` answers each item held, once each, in the order named, from one snapshot. An ID not held is left out, and so is an item in the bin unless `include_bin` is set. Part way through a hydration, the answer is `Partial`. `get_items_kept` keeps a damaged row.
- `get_edge(id)` and `get_edges(ids)` answer edges by ID; `get_edge_kept` and `get_edges_kept` keep a damaged edge.
- `body_links_of(ids)` answers `body_links` for each item held outside the bin that it can read, against one catalog, and leaves out the rest.
- `changes_since(cursor, most)` answers the items and edges changed since `cursor`, each split into those held and those removed, with the cursor to pass next. It answers `everything` and names none without a cursor, with a cursor from another store, from beyond what the copy recorded, from before a change to the types or from before a removed edge the copy no longer records, or where more than `most` items or edges changed.
  - An item is named where its row, tags, an edge at it, its pin or a write queued for it changed, so a name may change nothing on screen. An item whose body links read differently only because another item changed, such as a link that starts to resolve when its target arrives, is not named.
  - Like every read of edges, it is refused `HydrationIncomplete` while a hydration is part way or the copy is stale. Take the cursor before reading what it covers, and keep the earlier cursor until that read succeeds: make a reread refused `HydrationIncomplete` again from the earlier cursor once the copy is whole.
  - The copy records one change for each item and each edge it has held. When the writer opens a store that holds more than 20,000 records of edges it no longer holds, it lets go of those beyond the latest 10,000 changes (`EDGE_CHANGES_KEPT`), so a cursor from before one it let go of answers `everything`. A reading handle lets go of nothing.

The Swift binding exposes these as `get_items`, `edge`, `get_edges`, `body_links_of` and `changes_since`. The `marfa` binary reads them with `device items bulk-get`, `device items bulk-links`, `device edges get`, `device edges bulk-get` and `device changed`.

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

Within one `Core` or one `Folders`, `renew` is called once at a time: calls refused together wait for one renewal and send its token, a folder still sending the token renewed away gets the new one without a call, and a folder that the `Folders` opens after a renewal starts with the renewed token. Separate `Core` and `Folders` objects call `renew` on their own and may call it at the same time, so an app that opens more than one with the same sign-in must serialize renewals across them.

A renewer must:

- Keep the new access token and refresh token before it returns, because a refresh token is spent once the server answers.
- Return the access token it holds, without renewing, when `refused` differs from it.
- Throw `Ended`, and delete the refresh token, on a token endpoint's `invalid_grant` or `invalid_client`.
- Give the token request a time limit, and throw `Unavailable` when it times out or there is no network, because stopping a watch waits for a renewal under way.
- Never wait synchronously on the main thread inside `renew`.
- Never log the refused token.

A renewer that cannot renew throws a `RenewalError`, and the queued writes stay queued whichever it throws:

- `Ended` ends the call `SignedOut`, and every later refusal ends `SignedOut` without asking the renewer again.
- `Unavailable` ends it `Network`, which a drain takes as environmental and reports as unavailable.
- `Failed`, or any other error the renewer throws, ends it `Invalid`.

The Node module takes no renewer.

## Errors

Every surface names a core error by `CoreError::code`: the `code` in the binary's `--json` envelope, `code()` on the Swift error, and `code` on an error the Node module throws or rejects with. A test that crosses every `CoreError` holds the Swift word to the core's.

- A refusal says where it came from the same way on every surface. `server` holds what a server sent, its `status`, `code` and `details`, and is absent or `nil` unless a server answered, whatever code the device then gave the refusal. Every Swift error a server's answer can end has it: `NotFound`, `Unauthorized`, `Forbidden`, `Validation`, `UnknownType`, `RateLimited`, `Server`, `Unnamed`, `Redirected`, `ContractMismatch` (its `status` alone where the body was not read), `CopyExpired` and `StreamIncomplete`. A code the body did not name is absent from `server`, where `Server` keeps its own `code` as `unknown`. The Swift error's `code` is the code the device named the refusal by; the Node error's and the envelope's `local` holds that code and its `details` where it differs from the server's own, or no server answered.
- The Node error is an `Error` whose message starts `code: `, with the fields the Swift error carries as properties: `server`, `local`, `retryAfterSeconds`, `origin`, `location`, `path`, `reason`, `unsent`, `agreed`, `expected`, `got`, `served`, `writeSent` and `hash`, each where the error has it.
- `onEnd` of a Node `follow` receives that same error, or one coded `listener_threw` where an `onChange` threw.
- A catch-up keeps the catalog it took whatever ends it, so a failed one says whether it changed: `catalogChanged` on the Node error, `CatchUpError.Failed(error:catalogChanged:)` in Swift, and `catalog_changed` in the binary's `--json` envelope.

## The Node module

- `withdraw(id)` and `discard(id)` return `Promise<boolean>`: await them to read the result or catch a refusal. `withdraw` reads rows from the server, and `discard` can wait for a running drain. Both run off the JavaScript thread.
- Build and test it as `core/AGENTS.md` says. `core/scripts/binding-proof.sh` drives the built module through an offline write and its verdict against a real server.

## The Swift package

`bindings/swift/build.sh` builds the XCFramework and its glue for macOS, iOS and the simulator. `withmarfa/marfa-swift` runs it at the commit it pins.
