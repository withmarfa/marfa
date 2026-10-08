# The device

A device holds a working copy: a local store of one slice of one server, hydrated over HTTP, kept current from the event log and read locally, with a queue of the writes the server has not answered. `queue-and-verdicts.md` states the queue and the answer to every write, `folders.md` states a folder, and the server's own chapters state what the server answers.

## The working copy

A slice is a type list, a tier, which is `library`, `feed` or `all`, and the edge types it holds whole. A pin holds one row by id whatever the slice says of it.

### `device/slice-held`

A device MUST hold a row the item listing marks as listed whose type is a type its slice names, or a type under one by name or by declared parent, at a tier its slice holds.

**Tests:** `device/hydration.test.ts › asks the item listing for each declared type at the slice's tier, every state`, `device/working-copy.test.ts › holds the declared types and their subtrees and nothing else`, `› holds one tier and not the other`, `device/catch-up.test.ts › holds an item whose type was registered after the stream opened, in the slice through its parent`.

### `device/slice-type-outside`

Where a row is not pinned, a device MUST NOT hold it while its type is outside the slice.

**Tests:** `device/working-copy.test.ts › holds the declared types and their subtrees and nothing else`, `device/catch-up.test.ts › does not add a row that was never in the slice`.

### `device/slice-tier-outside`

Where a row is not pinned and its type is not a `system.*` type, a device MUST NOT hold it at a tier its slice does not hold.

**Tests:** `device/working-copy.test.ts › holds one tier and not the other`.

### `device/slice-edge-whole`

Where a slice names an edge type to hold whole, a device MUST hold every edge of that type the edge listing gives it, whichever of the edge's ends the copy holds.

**Reason:** a slice that holds no projects can still answer what lies beneath one when it holds `parent-of` whole.

**Tests:** `device/working-copy.test.ts › holds a named edge type whole, whichever end it holds`.

### `device/slice-edge-walk`

When a device hydrates an edge type held whole, a device MUST read the edge listing for that type until a page answers no `next_cursor`, past a page that is short or empty.

**Reason:** the listing leaves out an edge the key cannot read and leaves its page short (`edges/read-list-withheld` and `edges/read-list-short`), so only the cursor says the listing is done.

**Tests:** `device/hydration.test.ts › walks every page of an edge type held whole`, `› walks past an empty edge page that still carries a cursor`, `device/fidelity.test.ts › matches the edge listing a hydration walks for a type held whole`.

### `device/pin-holds`

When a device pins a row, a device MUST hold the row whatever its slice says of it.

**Tests:** `device/catch-up.test.ts › keeps a pinned row outside the slice current`.

### `device/pin-reads-edges`

When a device pins a row, a device MUST read the row and the edges it draws before the pin returns.

**Tests:** `device/catch-up.test.ts › keeps the edges of a type held whole when it unpins a row`, `› keeps a pinned row outside the slice current`.

### `device/pin-again-reads`

When a device pins a row it holds pinned already, a device MUST read the row again.

**Tests:** `device/catch-up.test.ts › reads a row pinned already again, and says it was`.

### `device/pin-says-pinned`

When a device pins a row, a device MUST say whether the row was pinned already.

**Tests:** `device/catch-up.test.ts › reads a row pinned already again, and says it was`.

### `device/pin-not-hydrated`

While its copy does not hold the read view of a completed hydration, a device MUST refuse a pin `hydration_incomplete`, sending nothing.

**Tests:** `device/catch-up.test.ts › refuses a pin on a copy that has not completed a hydration, sending nothing`.

### `device/pin-absent`

If the server answers a pin's read that it holds no such row and its bin holds none either, then a device MUST refuse the pin `not_found`, unless the row is a create of this device's that the server has not answered.

**Tests:** `device/catch-up.test.ts › refuses to pin a row the server does not hold`, `› lets a held row go when neither the server nor its bin holds a row it pins`.

### `device/pin-absent-evicts`

If the server answers a pin's read that it holds no such row and its bin holds none either, then a device MUST let go a row of that id the copy holds, unless the row is a create of this device's that the server has not answered.

**Reason:** the read is certified under the copy's read view, so the server's answer is that the row is gone for this copy.

**Tests:** `device/catch-up.test.ts › lets a held row go when neither the server nor its bin holds a row it pins`.

### `device/pin-absent-unpinned`

If a device refuses a pin of a row it did not hold pinned, then a device MUST leave the row unpinned.

**Reason:** a pin left behind would have every hydration ask for a row the server does not hold.

**Tests:** `device/catch-up.test.ts › refuses to pin a row the server does not hold`, `device/bin-live.test.ts › refuses to pin a row in the bin, saying so`.

### `device/pin-own-create`

Where a row is a create of this device's that the server has not answered, a device MUST take a pin of it although the server answers that it holds no such row.

**Tests:** `device/catch-up.test.ts › pins a row of its own create the server does not hold yet, and moves the pin to the id the create is answered with`.

### `device/pin-follows-create`

When a pinned create is answered with the id of another row, a device MUST move the pin to that id.

**Tests:** `device/catch-up.test.ts › pins a row of its own create the server does not hold yet, and moves the pin to the id the create is answered with`.

### `device/pin-refused-create`

When a certified read confirms that the server holds no row for a pinned create it refused, a device MUST let the row go with its pin.

**Tests:** `device/catch-up.test.ts › takes the pin off a row whose create was refused`, `› keeps the pin until a fresh read confirms absence after a create refusal`.

### `device/pin-refused-create-unread`

If the read that would confirm a refused create's absence fails, then a device MUST keep the pin.

**Tests:** `device/catch-up.test.ts › keeps the pin until a fresh read confirms absence after a create refusal`.

### `device/pin-waiting-write`

When a device pins a row that a write of its own still waits on, a device MUST show the waiting write over the row the pin reads.

**Tests:** `device/catch-up.test.ts › lays a waiting write over a row it pins`.

### `device/pin-survives-hydration`

When a device hydrates, a device MUST keep every pin it holds, the hydration that follows an expired copy included.

**Tests:** `device/catch-up.test.ts › keeps a pinned row outside the slice current`, `› keeps a pin across the hydration that follows an aged-out cursor`.

### `device/pin-read-on-hydration`

When a device hydrates, a device MUST hold each pinned row as the server answers it then, read by id where the slice does not bring it.

**Tests:** `device/catch-up.test.ts › keeps a pinned row outside the slice current`, `› keeps a pin across the hydration that follows an aged-out cursor`.

### `device/pin-gone-kept`

If a hydration's read of a pinned row answers that the server holds no such row, then a device MUST keep the pin and hold no row for it.

**Reason:** the server answers a row of a type the key can no longer read as one it does not hold.

**Tests:** `device/catch-up.test.ts › keeps a pin the key can no longer read, and completes the hydration`, `device/fidelity.test.ts › matches the refusals a device must not retry`.

### `device/pin-gone-completes`

If a hydration's read of a pinned row answers that the server holds no such row, then a device MUST complete the hydration.

**Reason:** a row the key can no longer read would otherwise stop every hydration of the copy.

**Tests:** `device/catch-up.test.ts › keeps a pin the key can no longer read, and completes the hydration`.

### `device/unpin-says`

When a device takes a pin off, a device MUST say whether the row was pinned.

**Tests:** `device/catch-up.test.ts › says whether a row it unpins was pinned`.

### `device/unpin-lets-go`

When a device takes the pin off a row its slice does not take and no write of its own to the row waits, a device MUST let the row go.

**Tests:** `device/catch-up.test.ts › lets an unpinned row outside the slice go`.

### `device/unpin-edges`

When a device lets an unpinned row go, a device MUST let go the edges the row draws, but those of a type its slice holds whole.

**Tests:** `device/catch-up.test.ts › keeps the edges of a type held whole when it unpins a row`.

### `device/unpin-waiting`

When a device takes the pin off a row its slice does not take while a write of its own to the row still waits, a device MUST keep the row.

**Tests:** `device/catch-up.test.ts › keeps a row it unpins while a write to it still waits, and lets it go once answered`, `› lets an unpinned row kept for a waiting write go at the next catch-up that touches it, keeping the write`.

### `device/unpin-answered`

When the write that kept an unpinned row its slice does not take is answered, a device MUST let the row go.

**Tests:** `device/catch-up.test.ts › keeps a row it unpins while a write to it still waits, and lets it go once answered`.

### `device/unpin-hydration`

When a device hydrates, a device MUST let go a row that is not pinned and that its slice does not take, whether or not a write of its own to the row still waits, and keep the write queued.

**Tests:** `device/catch-up.test.ts › lets an unpinned row kept for a waiting write go at the next hydration, keeping the write`.

### `device/origin-refused`

If a device is asked to reach a server at an origin other than the one its copy was hydrated from, by scheme, host, port or path prefix, then a device MUST refuse `wrong_server`.

**Tests:** `device/working-copy.test.ts › binds to one origin and refuses a store opened against another`, `› refuses a store opened at another path prefix of its host, sending nothing there`, `device/local-refusals.test.ts › refuses a write to a store bound to another server`.

### `device/origin-refused-names`

When a device refuses `wrong_server`, a device MUST name the origin the copy belongs to and the origin it was offered.

**Tests:** `device/working-copy.test.ts › binds to one origin and refuses a store opened against another`, `› refuses a store opened at another path prefix of its host, sending nothing there`.

### `device/origin-refused-sends-nothing`

When a device refuses `wrong_server`, a device MUST send nothing to the server it was offered and leave the copy as it was.

**Tests:** `device/local-refusals.test.ts › refuses a write to a store bound to another server`, `device/working-copy.test.ts › refuses a store opened at another path prefix of its host, sending nothing there`.

### `device/origin-key-free`

When a device opens a store at the origin it is bound to under another key, a device MUST use the store and send its requests under that key.

**Reason:** the key is no part of the copy's identity, so a rotated key does not strand a copy.

**Tests:** `device/working-copy.test.ts › opens a store under another key at the origin it is bound to`.

### `device/key-not-stored`

A device MUST NOT write its key to the store.

**Tests:** `device/working-copy.test.ts › keeps the key out of the store`.

### `device/instance-marker`

If a catch-up's stream names an instance other than the one the copy was hydrated from, then a device MUST expire the copy.

**Reason:** a larger cursor in another instance's log is not progress in this one.

**Tests:** `device/catch-up.test.ts › hydrates again when another instance answers at the same address`.

### `device/instance-follow`

If the server's root names an instance other than the one the copy was hydrated from when a device opens a held stream, then a device MUST expire the copy.

**Tests:** `device/catch-up.test.ts › hydrates again when another instance answers at the same address`.

### `device/instance-follow-marker`

If a held stream names an instance other than the one the copy was hydrated from, then a device MUST expire the copy.

**Tests:** `device/catch-up.test.ts › expires the copy when a held stream's marker names another instance`.

### `device/instance-drain-expires`

If the server's root names an instance other than the one the copy was hydrated from when a drain is about to send, then a device MUST expire the copy.

**Tests:** `device/queue.test.ts › sends nothing to another instance at the same address, keeping the queue`.

### `device/instance-drain-sends-nothing`

If the server's root names an instance other than the one the copy was hydrated from when a drain is about to send, then a device MUST send no write.

**Tests:** `device/queue.test.ts › sends nothing to another instance at the same address, keeping the queue`.

### `device/instance-unconfirmed`

If the server's root answers a failure that clears on its own when a drain is about to send, then a device MUST end the pass with no write sent.

**Reason:** a restart is when another instance appears, so a server that cannot say which instance it is cannot be sent a write.

**Tests:** `device/queue.test.ts › sends nothing while the server cannot say which instance it is`.

### `device/instance-unconfirmed-says`

If a drain's pass ends because the server could not say which instance it is, then a device MUST say so in the drain's report.

**Tests:** `device/queue.test.ts › sends nothing while the server cannot say which instance it is`.

### `device/instance-unconfirmed-uncounted`

If a drain's pass ends because the server could not say which instance it is, then a device MUST count nothing against any write.

**Tests:** `device/queue.test.ts › sends nothing while the server cannot say which instance it is`.

### `device/instance-unconfirmed-settings`

If the server's root answers a failure that clears on its own when a folder's settings edit is about to be sent, then a device MUST send nothing.

**Tests:** `device/folders.test.ts › sends no settings edit while the server cannot say which instance it is`.

### `device/late-answer`

If an answer to a request made under a copy arrives after a hydration has begun replacing that copy, then a device MUST NOT let the answer expire or change the new copy.

**Tests:** waiting on #1890.

### `device/proof-lost`

While its copy holds a slice and no valid cursor, read view or instance, a device MUST refuse a local read `hydration_incomplete`, through a reading handle as through the writer.

**Tests:** `device/read-view.test.ts › refuses reads of a stored copy that lost its instance, through a reader as through the writer`.

### `device/reading-handle-reads`

While another process holds the writer role for a store it opens, a device MUST answer reads from the store.

**Tests:** `device/working-copy.test.ts › gives a second opener a reading handle that refuses writes`.

### `device/reading-handle-refuses`

While a device holds a reading handle, a device MUST refuse every write `reading_handle`, a hydration, a catch-up and a held stream included.

**Reason:** two writers of one file would each queue into it and neither would see the other's rows.

**Tests:** `device/working-copy.test.ts › gives a second opener a reading handle that refuses writes`, `device/local-refusals.test.ts › refuses a hydration, a catch-up and a follow from a reading handle`.

### `device/reading-handle-queues-nothing`

While a device holds a reading handle, a device MUST queue nothing.

**Tests:** `device/local-refusals.test.ts › refuses a write from a reading handle`.

### `device/read-refused-in-progress`

While a hydration has started and not completed, a device MUST refuse a local read `hydration_incomplete`.

**Reason:** what such a copy holds is a piece of a copy, and an answer from it would read as the whole.

**Tests:** `device/working-copy.test.ts › refuses a read after an interrupted hydration`, `device/hydration.test.ts › leaves an interrupted hydration to be run again, never resumed`.

### `device/read-refused-expired`

While its copy is expired, a device MUST refuse a local read `hydration_incomplete`.

**Reason:** an expired copy is complete as of the moment it stopped and can no longer be kept current, and a copy that has quietly stopped tracking is the failure this chapter guards against.

**Tests:** `device/catch-up.test.ts › refuses reads after the cursor ages out, until a hydration`.

### `device/write-refused-incomplete`

While a hydration has started and not completed, or its copy is expired, a device MUST refuse a local write `hydration_incomplete`.

**Tests:** `device/working-copy.test.ts › refuses a local write after an interrupted hydration`, `› reports complete for a copy whose cursor aged out until a catch-up learns it, asking nothing to report`.

### `device/read-after-hydration`

When a hydration completes, a device MUST answer local reads again.

**Tests:** `device/catch-up.test.ts › refuses reads after the cursor ages out, until a hydration`, `device/hydration.test.ts › leaves an interrupted hydration to be run again, never resumed`.

### `device/read-never-hydrated`

While its copy has never hydrated, a device MUST answer a local read from what the copy holds.

**Tests:** `device/working-copy.test.ts › answers a read before any hydration from what the copy holds`.

### `device/report-fields`

A device MUST report its state as the origin it is bound to, the instance it was hydrated from, its slice's types and tier, the edge types it holds whole, the rows it holds pinned, its cursor, how many items and edges it holds, the version of the catalog it holds and its hydration.

**Tests:** `device/working-copy.test.ts › reports its slice, cursor and hydration state before it has hydrated`, `› holds a named edge type whole, whichever end it holds`, `device/catch-up.test.ts › keeps a pinned row outside the slice current`, `› refuses reads after the cursor ages out, until a hydration`, `device/queue.test.ts › sends nothing to another instance at the same address, keeping the queue`, `device/catalog.test.ts › moves the catalog version when a catch-up reads a changed catalog, and only then`.

### `device/report-before-hydration`

A device MUST answer its state report before it has hydrated.

**Reason:** the report is how a caller learns that a hydration is owed.

**Tests:** `device/working-copy.test.ts › reports its slice, cursor and hydration state before it has hydrated`.

### `device/report-no-request`

When a device reports its state, a device MUST send nothing to the server.

**Reason:** `expired` is the record of an answer rather than a reading of the log, so a copy whose cursor aged out reports `complete` until a catch-up or a held stream learns it.

**Tests:** `device/working-copy.test.ts › reports complete for a copy whose cursor aged out until a catch-up learns it, asking nothing to report`.

### `device/report-never`

While no hydration has started and none has declared a slice, a device MUST report its hydration as `never`.

**Tests:** `device/working-copy.test.ts › reports its slice, cursor and hydration state before it has hydrated`, `device/save-before-sync.test.ts › saves a note against the types Marfa ships, shows it to a read, and queues it`.

### `device/report-in-progress`

While a hydration has started and not completed, whether it still runs or was interrupted, a device MUST report its hydration as `in_progress`.

**Tests:** `device/working-copy.test.ts › reports an interrupted re-hydration as in progress, not as a copy that aged out`.

### `device/report-complete`

While its copy holds its slice, a cursor, the read view and the instance it was hydrated under, a device MUST report its hydration as `complete`.

**Tests:** `device/hydration.test.ts › refuses a type name outside the grammar, or one the server does not hold, keeping the copy it had`, `device/read-view.test.ts › keeps a certified offline copy after an uncertified %i`, `device/working-copy.test.ts › reports complete for a copy whose cursor aged out until a catch-up learns it, asking nothing to report`.

### `device/report-expired`

While no hydration is under way and its copy holds a slice and no valid cursor, read view or instance, a device MUST report its hydration as `expired`.

**Reason:** `expired` and `never` are the two a caller must not confuse: reads are refused on the first and answered on the second, and only the first needs a hydration to be read again.

**Tests:** `device/catch-up.test.ts › refuses reads after the cursor ages out, until a hydration`, `device/queue.test.ts › sends nothing to another instance at the same address, keeping the queue`, `device/read-view.test.ts › reports a hydration that ended on an invalid page as expired, not in progress`, `› refuses reads of a stored copy that lost its instance, through a reader as through the writer`.

## Hydration

A hydration reads the server's copy stream and listings under one certified read view (`read-views.md`) and replaces the copy with what they hold.

### `device/hydrate-empty-refused`

If a hydration declares no type, then a device MUST refuse it `invalid` before it reads anything.

**Tests:** `device/hydration.test.ts › refuses an empty type list and a bare wildcard before reading anything`.

### `device/hydrate-bare-wildcard`

If a hydration declares `*` alone, then a device MUST refuse it `invalid` before it reads anything.

**Tests:** `device/hydration.test.ts › refuses an empty type list and a bare wildcard before reading anything`.

### `device/hydrate-grammar`

If a hydration declares a type name outside the type grammar (`types/id-grammar` and `types/id-reserved-scope-root`), or a wildcard whose root is not lowercase dotted segments, then a device MUST refuse it `invalid`, naming it, before it reads anything.

**Tests:** `device/hydration.test.ts › refuses a type name outside the grammar, or one the server does not hold, keeping the copy it had`, `› refuses a wildcard whose root breaks the grammar before reading anything, and takes one that names nothing`.

### `device/hydrate-wildcard-empty`

When a hydration declares a wildcard that names no type the catalog holds, a device MUST take it as declared.

**Tests:** `device/hydration.test.ts › refuses a wildcard whose root breaks the grammar before reading anything, and takes one that names nothing`.

### `device/hydrate-unheld-type`

While the read view is the one the copy was hydrated under, if a hydration declares a type the catalog it read does not hold, then a device MUST refuse it `unknown_type`, naming the type, before it clears the copy.

**Reason:** the listing refuses such a type only once the copy is gone, and a mistyped name would leave the device with no copy at all.

**Tests:** `device/hydration.test.ts › refuses a type name outside the grammar, or one the server does not hold, keeping the copy it had`.

### `device/hydrate-unheld-edge-type`

While the read view is the one the copy was hydrated under, if a hydration names an edge type to hold whole that the edge type catalog does not hold, then a device MUST refuse it `unknown_type`, naming the edge type, before it clears the copy.

**Tests:** `device/hydration.test.ts › refuses a type name outside the grammar, or one the server does not hold, keeping the copy it had`.

### `device/hydrate-unreadable-type`

While the read view is the one the copy was hydrated under, if a hydration declares a type that the key reads neither itself nor any type under it, then a device MUST refuse it `forbidden`, naming the type, before it clears the copy or changes its queue.

**Reason:** the listing refuses such a type `403 type_not_permitted` (`search-and-filters/type-unreadable`) only once the copy is gone.

**Tests:** `device/hydration.test.ts › refuses a type the key cannot read, naming it, before anything is cleared`.

### `device/hydrate-readable-descendant`

Where the key reads a type under a declared type, by name or by declared parent, a device MUST hydrate the declared type although the key does not read it.

**Reason:** the listing serves a type's readable descendants (`search-and-filters/type-descendant-readable`).

**Tests:** `device/hydration.test.ts › hydrates a type whose descendant alone the key reads, by name or by declared parent`.

### `device/hydrate-unreadable-non-key`

Where the credential is not a key, if the item listing refuses a declared type `403 type_not_permitted`, then a device MUST refuse the hydration `forbidden`, naming the type, before it clears the copy.

**Reason:** such a credential cannot read its own type map, so the first page of each declared type is the only way to learn it before the copy is cleared.

**Tests:** `device/hydration.test.ts › refuses a type the key cannot read, naming it, before anything is cleared`.

### `device/hydrate-head-first`

When a device hydrates, a device MUST read the log's head before it reads any row.

**Reason:** a head read after the pages would step over a write made while they were read.

**Tests:** `device/hydration.test.ts › takes the cursor before the snapshot, so a write during the snapshot replays`.

### `device/hydrate-listing`

When a device hydrates, a device MUST read the item listing for each type its slice names, at the slice's tier, in every state, with each row's edges and metadata.

**Reason:** a row leaving the active state is a change a catch-up has to see, so the copy holds every state and a local read chooses which to answer.

**Tests:** `device/hydration.test.ts › asks the item listing for each declared type at the slice's tier, every state`, `device/working-copy.test.ts › holds both tiers in a slice of both, hydrated again from one of them`.

### `device/hydrate-page-walk`

When a device hydrates, a device MUST read each item listing until a page answers no `next_cursor`, past a page that is empty.

**Tests:** `device/hydration.test.ts › walks past an empty page that still carries a cursor`, `› reports the counts, the pages and the cursor it stored`.

### `device/hydrate-repeated-cursor`

If a listing a hydration walks answers a `next_cursor` the hydration has already read, then a device MUST expire the copy `copy_expired` with the reason `read_view_invalid`.

**Reason:** a listing that hands back a cursor it gave before would be walked for good.

**Tests:** `device/hydration.test.ts › expires the copy when a listing hands back a cursor it already read`.

### `device/hydrate-replays`

When a device has read a hydration's pages, a device MUST apply the events written since the head it read before it reports the hydration complete.

**Tests:** `device/hydration.test.ts › applies a write made during the snapshot before the hydration returns`.

### `device/hydrate-live-marker`

If a hydration's replay ends before a valid live marker, then a device MUST end the hydration `stream_incomplete` and not report it complete.

**Tests:** `device/hydration.test.ts › does not complete a hydration whose replay sends no live marker`.

### `device/hydrate-replaces`

When a device hydrates, a device MUST replace the rows and edges it held with those of the slice the hydration declares.

**Tests:** `device/hydration.test.ts › replaces what the store held`.

### `device/hydrate-edge-types-replaced`

When a device hydrates, a device MUST hold whole only the edge types that hydration names.

**Tests:** `device/catch-up.test.ts › hydrates again with other edge types held whole, and applies no event of one it no longer holds`, `device/working-copy.test.ts › holds a named edge type whole, whichever end it holds`.

### `device/hydrate-catalog-replaced`

When a device hydrates, a device MUST replace the item type and edge type catalogs it holds with the server's.

**Tests:** `device/catalog.test.ts › answers every catalog read on a copy that has never reached a server with the types Marfa ships`, `› replaces a server's catalog it holds with the one the next hydration reads`.

### `device/hydrate-keeps-queue`

When a device hydrates, a device MUST keep its queue and show each write still waiting over the new copy.

**Tests:** `device/catch-up.test.ts › hydrates again when the server's log ends behind its cursor, keeping the queue`, `device/working-copy.test.ts › holds both tiers in a slice of both, hydrated again from one of them`, `device/save-before-sync-live.test.ts › sends what it saved with no server once it has joined, after registering the type the key may`.

### `device/hydrate-not-resumed`

When a device hydrates after an interrupted hydration, a device MUST read every page of the slice again.

**Tests:** `device/hydration.test.ts › leaves an interrupted hydration to be run again, never resumed`.

### `device/hydrate-report`

When a hydration completes, a device MUST report the types, tier and edge types it declared, how many items and edges the copy then holds, how many listing pages it read and the cursor it stored.

**Tests:** `device/hydration.test.ts › reports the counts, the pages and the cursor it stored`, `› walks every page of an edge type held whole`, `› applies a write made during the snapshot before the hydration returns`, `device/working-copy.test.ts › holds a named edge type whole, whichever end it holds`.

### `device/hydrate-every-type`

When a folder whose search names no type hydrates its copy, a device MUST read the item listing naming no type, which leaves `system.*` out (`folders.md` 2), and report the slice's types as `*`.

**Tests:** `device/folders.test.ts › holds exactly what its search matches`, `› takes every type, and any default type, where its search names no type`.

## Catch-up

A device takes an event when it applies it or skips it; both move its cursor past the event. Every rule here holds within an unchanged read view; a changed one expires the copy (`device/view-changed`).

### `device/catch-up-resumes`

When a device catches up, a device MUST open the event stream at the cursor it holds.

**Tests:** `device/catch-up.test.ts › resumes at the stored cursor and applies what the stream carries`, `› leaves the cursor at the last applied event when the stream ends early`.

### `device/catch-up-takes`

When a catch-up's stream carries an event, a device MUST take it by the rules of this chapter, applying it where it changes the copy and skipping it otherwise.

**Tests:** `device/catch-up.test.ts › resumes at the stored cursor and applies what the stream carries`, `› applies a transition, a delete and a restore, none of which move the version`.

### `device/catch-up-cursor-taken`

When a device takes an event, a device MUST set its cursor to that event's id, never to the highest id it has seen.

**Reason:** the server delivers ids in order (`events/ids-ascending`), so the two agree while every event is taken, and a mark set from what merely arrived would step over an event it did not take for good.

**Tests:** `device/catch-up.test.ts › keeps the last id applied rather than the highest, so a late lower id is not stepped over`.

### `device/catch-up-older-version`

If an event carries a version older than the version of the row or edge the copy holds, then a device MUST skip it.

**Tests:** `device/catch-up.test.ts › skips an event older than the row it holds and still advances the cursor`.

### `device/catch-up-older-stamp`

If an event carries the version of the row or edge the copy holds and an `updated_at` before the one held, then a device MUST skip it.

**Reason:** a transition, a delete, a restore and a tag write move `updated_at` and leave the version where it was, so the version alone cannot order them.

**Tests:** `device/catch-up.test.ts › skips an event at the version it holds that was stamped before the row it holds`.

### `device/catch-up-skip-advances`

When a device skips an event, a device MUST move its cursor past it.

**Reason:** a cursor left behind would fetch the same stale event on every catch-up.

**Tests:** `device/catch-up.test.ts › skips an event older than the row it holds and still advances the cursor`, `› skips an event at the version it holds that was stamped before the row it holds`.

### `device/catch-up-same-stamp`

When an event carries the version and the `updated_at` of the row the copy holds, a device MUST apply it.

**Reason:** every transition, delete, restore and tag write carries the version the copy holds, and a device that skipped them would never learn a row had been archived, deleted or restored.

**Tests:** `device/catch-up.test.ts › applies a transition, a delete and a restore, none of which move the version`, `› applies a tag write that leaves the version where it was`.

### `device/server-row-order`

When a device takes a row from any read of the server, a device MUST NOT replace a row it holds that is later by version and then by `updated_at`.

**Reason:** a held stream applies events while a drain's or a pin's read is out, and a read written over a later event would roll the row back under a cursor already past that event.

**Tests:** `device/verdicts.test.ts › refused: keeps the row the copy holds where the read-back answers an older one`, `device/catch-up.test.ts › keeps the row it holds where a pin's read answers an older one`.

### `device/catch-up-leaves-slice`

When an event shows that a row that is not pinned has left the slice by its type or its tier, a device MUST let the row go, whether or not a write of its own to the row still waits.

**Tests:** `device/catch-up.test.ts › evicts a row that leaves the slice`, `› learns a row retyped out of its slice, asking the stream for every type`, `› applies nothing on a held stream from outside its slice`, `› lets an unpinned row kept for a waiting write go at the next catch-up that touches it, keeping the write`.

### `device/catch-up-unlisted`

When an event marks a row that is not pinned as not listed for the copy, a device MUST let the row go.

**Tests:** `device/catch-up.test.ts › lets a row the stream lists as outside the item listing go`.

### `device/catch-up-leaving-edges`

When a row leaves the copy, a device MUST let go the edges it draws, but those of a type the slice holds whole.

**Tests:** `device/catch-up.test.ts › applies an edge of a type held whole whatever its source`, `› keeps the edges a held row draws to a row that leaves the slice`.

### `device/catch-up-leaving-edges-to`

When a row leaves the copy, a device MUST keep the edges a row it holds draws to it.

**Tests:** `device/catch-up.test.ts › keeps the edges a held row draws to a row that leaves the slice`.

### `device/catch-up-purged-edges`

When an event says a row was purged, a device MUST let go the row and every edge at either end of it.

**Tests:** `device/catch-up.test.ts › drops the edges at both ends of a purged row`.

### `device/catch-up-purged-pin`

When an event says a pinned row was purged, a device MUST take the pin off.

**Tests:** `device/catch-up.test.ts › takes the pin off a purged row`.

### `device/catch-up-never-held`

When an event names a row that is not pinned, that the copy does not hold and that the slice does not take, a device MUST NOT add the row.

**Tests:** `device/catch-up.test.ts › does not add a row that was never in the slice`, `› keeps a pinned row outside the slice current`.

### `device/catch-up-pinned`

When an event names a pinned row, a device MUST apply it whatever the row's type and tier.

**Tests:** `device/catch-up.test.ts › keeps a pinned row outside the slice current`, `› keeps a pinned row that leaves the slice`.

### `device/catch-up-edge-whole`

Where an edge's type is held whole, a device MUST apply an event for the edge whatever its source.

**Tests:** `device/catch-up.test.ts › applies an edge of a type held whole whatever its source`.

### `device/catch-up-edge-source`

Where an edge's type is not held whole, a device MUST apply an event that creates or changes the edge only where the copy holds the edge's source or a write of its own to the edge still waits.

**Tests:** `device/catch-up.test.ts › applies an edge of a type held whole whatever its source`, `› moves an edge whose source moved within the slice, and drops one whose source moved outside it`, `› keeps an edge whose source moved outside the slice while a move of its own waits`.

### `device/catch-up-edge-moved-out`

When an event moves an edge whose type is not held whole to a source the copy does not hold, a device MUST let the edge go, unless a write of its own to the edge still waits.

**Reason:** an edge's frames name its new source (`edges/move-source` and `edges/move-announced`), and no later frame would reach a copy that does not hold that source.

**Tests:** `device/catch-up.test.ts › moves an edge whose source moved within the slice, and drops one whose source moved outside it`, `› keeps an edge whose source moved outside the slice while a move of its own waits`.

### `device/catch-up-edge-own-write`

While a write of its own to an edge still waits, a device MUST show that write over the server's change to the edge.

**Tests:** `device/catch-up.test.ts › keeps an edge whose source moved outside the slice while a move of its own waits`, `› lays its own waiting move of an edge's target over the server's change to the edge`, `› applies an edge event beneath an edge edit it has not had answered`.

### `device/catch-up-entering-tags`

When an event brings a row into the copy, a device MUST hold the row with its tags.

**Tests:** `device/catch-up.test.ts › adds a row entering the slice by retype, with its tags and its edges`.

### `device/catch-up-created-edges`

When an event creates a row the slice takes, a device MUST take the row's edges from the edge events that follow it, reading nothing for them.

**Tests:** `device/catch-up.test.ts › takes a created row's edges from the frames after it, reading nothing for them`.

### `device/catch-up-entering-edges`

When an event brings a row the copy did not hold into the slice by a retype or a move of tier, a device MUST read every page of the row's edges before it applies the event.

**Reason:** the frames of the edges the row drew went by while the copy did not hold it.

**Tests:** `device/catch-up.test.ts › adds a row entering the slice by retype, with its tags and its edges`, `› adds a row entering the slice by a move of tier, with its edges`, `› adds a row entering the slice with every page of its edges`.

### `device/catch-up-entering-read-fails`

If a catch-up cannot read the edges of a row entering the slice, then a device MUST end the catch-up with its cursor before that event.

**Tests:** `device/catch-up.test.ts › leaves the cursor before a row entering the slice whose edges it could not read`.

### `device/follow-entering-read-fails`

If a held stream cannot read the edges of a row entering the slice for a reason that clears on its own, then a device MUST open the stream again after its wait rather than end it.

**Tests:** `device/catch-up.test.ts › keeps a held stream going over a row entering the slice whose edges it could not read at first`.

### `device/stream-every-type`

A device MUST ask the event stream for every type the key reads, never for its slice's types alone.

**Reason:** the server narrows a stream by the type a row has now, so a stream narrowed to the slice withholds the frame of a row retyped out of it.

**Tests:** `device/catch-up.test.ts › learns a row retyped out of its slice, asking the stream for every type`.

### `device/catch-up-catalog-first`

When a device catches up, a device MUST read the item type and edge type catalogs before it opens its stream.

**Tests:** `device/catch-up.test.ts › refreshes the type catalog before applying`.

### `device/catch-up-catalog-unknown-type`

When an event names a type the catalog does not hold, a device MUST read the catalogs again before it takes the event.

**Tests:** `device/catch-up.test.ts › reads the catalog again, once for each, for a type an event names that it does not hold`.

### `device/catch-up-catalog-image`

When an event carries an image data URI under a property the catalog does not know as its type's thumbnail, a device MUST read the catalogs again before it takes the event.

**Reason:** the catalog cannot tell such a property from one the type has since made its thumbnail, whose base64 must stay out of the index.

**Tests:** `device/catch-up.test.ts › reads the catalog once for an image under a property no type declares, not once for each event carrying it`.

### `device/catch-up-catalog-once`

When a catch-up has read the catalogs again for a type or a property an event names, a device MUST take later events naming it by the catalog as it is, without reading it again.

**Reason:** a type the server will not describe would otherwise cost one read of the catalog for every event naming it.

**Tests:** `device/catch-up.test.ts › reads the catalog again, once for each, for a type an event names that it does not hold`, `› reads the catalog once for an image under a property no type declares, not once for each event carrying it`.

### `device/expire-aged-cursor`

If the stream says the log no longer holds the event after the cursor (`catchup_too_old`), then a device MUST end the catch-up or the held stream `copy_expired`.

**Tests:** `device/catch-up.test.ts › ends on an aged-out cursor and hydrates again rather than reconnecting`, `› ends a follow whose cursor the log has aged past, and forgets the cursor`.

### `device/expire-log-behind`

If the stream's head, its live marker or a `cursor_ahead` frame names a position behind the cursor, then a device MUST end the catch-up or the held stream `copy_expired`.

**Reason:** a server restored from an earlier point holds a log that ends behind the cursor (`events/stream-cursor-head` and `events/cursor-ahead`), and its later events are not the ones the copy missed.

**Tests:** `device/catch-up.test.ts › hydrates again when the server's log ends behind its cursor, keeping the queue`, `› hydrates again when the server says its cursor is ahead of the log`, `› hydrates again when the live marker is behind its cursor`, `› ends a follow whose server's log ends behind its cursor, and forgets the cursor`, `device/fidelity.test.ts › matches the frame a cursor past the log's head gets`.

### `device/expire-drops-cursor`

When a device expires its copy, a device MUST drop its cursor.

**Tests:** `device/catch-up.test.ts › refuses reads after the cursor ages out, until a hydration`, `› ends a follow whose server's log ends behind its cursor, and forgets the cursor`.

### `device/expire-no-reconnect`

When a held stream's copy expires, a device MUST end the stream rather than ask for it again.

**Tests:** `device/catch-up.test.ts › ends a follow whose cursor the log has aged past, and forgets the cursor`, `› ends a follow whose server's log ends behind its cursor, and forgets the cursor`.

### `device/expire-keeps-queue`

When a device expires its copy, a device MUST keep its queue.

**Tests:** `device/catch-up.test.ts › hydrates again when the server's log ends behind its cursor, keeping the queue`, `device/queue.test.ts › sends nothing to another instance at the same address, keeping the queue`, `device/read-view.test.ts › expires on %s without losing unsent work`.

### `device/catch-up-incomplete`

If a catch-up's stream ends before its live marker, then a device MUST end the catch-up `stream_incomplete`.

**Reason:** a catch-up that stopped short of the head must not read as a clean pass.

**Tests:** `device/catch-up.test.ts › leaves the cursor at the last applied event when the stream ends early`, `› reports reaching the head, and reports stopping short of it`.

### `device/catch-up-incomplete-cursor`

If a catch-up's stream ends before its live marker, then a device MUST keep its cursor at the last event it took and keep its copy complete.

**Tests:** `device/catch-up.test.ts › leaves the cursor at the last applied event when the stream ends early`, `device/read-view.test.ts › requires the actual live marker even when the announced head is already held`.

### `device/catch-up-silence`

If a catch-up's stream sends nothing at all for its idle wait before its live marker, then a device MUST end the catch-up `stream_incomplete` at the last event it took.

**Tests:** `device/catch-up.test.ts › ends a catch-up on silence before the marker, at the last event it took`.

### `device/catch-up-ends-on-marker`

When a catch-up's stream sends its live marker, a device MUST end the catch-up.

**Tests:** `device/catch-up.test.ts › moves the cursor past the rows the stream withheld, and resumes from there`.

### `device/marker-moves-cursor`

When a live marker names a cursor past the last event a catch-up or a held stream took, a device MUST move its cursor to the marker's.

**Reason:** the events between are ones the credential withheld (`events/stream-live-cursor`), and a cursor left before them would stop short of the head on every catch-up and age out on a quiet slice.

**Tests:** `device/catch-up.test.ts › moves the cursor past the rows the stream withheld, and resumes from there`, `› moves a held stream's cursor past the rows it withheld`, `device/fidelity.test.ts › matches the marker that ends a replay whose rows were withheld`.

### `device/marker-malformed`

If a live marker names no position, then a device MUST expire the copy.

**Tests:** `device/catch-up.test.ts › expires the copy when a live marker names no position`.

### `device/catch-up-report`

When a catch-up ends on its live marker, a device MUST report how many events it applied, how many it skipped, the cursor it reached and that it reached the log's head.

**Tests:** `device/catch-up.test.ts › resumes at the stored cursor and applies what the stream carries`, `› skips an event at the version it holds that was stamped before the row it holds`, `› reports reaching the head, and reports stopping short of it`, `› moves the cursor past the rows the stream withheld, and resumes from there`.

### `device/cursor-zero`

When a device hydrates an instance whose log is empty, a device MUST store the cursor `0`.

**Tests:** `device/catch-up.test.ts › resumes from zero after hydrating an empty instance, and applies the first event`.

### `device/cursor-zero-resumes`

While its cursor is `0`, a device MUST resume a catch-up from it and apply the first event the instance writes.

**Reason:** a cursor is too old only when the event after it has been retired (`events/catchup-too-old`), and `0` is the log's beginning rather than the absence of a cursor.

**Tests:** `device/catch-up.test.ts › resumes from zero after hydrating an empty instance, and applies the first event`, `device/fidelity.test.ts › matches the replay a cursor of zero gets against a log that begins at one`.

## What a device never does locally

Each rule here holds because the silent alternative is a working copy that disagrees with the server with nothing anywhere to say so.

### `device/edit-sends-named`

When a device sends an edit, a device MUST send each property the caller named with the value the caller gave it, and no property the caller did not name.

**Reason:** two values for one field are the server's to reconcile; a device that combined them would have to be believed by every other device.

**Tests:** `device/local-refusals.test.ts › refuses to merge two values for one field`.

### `device/edit-takes-answer`

When the server answers an edit, a device MUST hold the row the server answers it with.

**Tests:** `device/local-refusals.test.ts › refuses to merge two values for one field`.

### `device/version-local-create`

A device MUST hold a row of its own create that the server has not answered at version `0`.

**Reason:** the server's versions start at 1, so a row at 0 is one no server has answered for.

**Tests:** `device/local-refusals.test.ts › refuses to advance a version of its own accord`.

### `device/version-waiting-edit`

While an edit of a row waits, a device MUST show the row at the version it held before the edit.

**Tests:** `device/local-refusals.test.ts › refuses to advance a version of its own accord`.

### `device/version-from-answer`

When the server answers a write, a device MUST hold the row at the version the server answers.

**Tests:** `device/local-refusals.test.ts › refuses to advance a version of its own accord`.

### `device/conflict-blocked`

If the server refuses a write `409 version_conflict`, then a device MUST report the write `blocked` with the reason `conflict_unresolved`, keeping the server's envelope.

**Tests:** `device/verdicts.test.ts › reports a conflict rather than resolving it`, `device/local-refusals.test.ts › refuses to resolve a conflict it was refused`.

### `device/conflict-unresolved`

If the server refuses a write `409 version_conflict`, then a device MUST send nothing more for the write on a later drain until it is released.

**Reason:** a conflict is the server's to resolve; a device that resolved it would have to be believed by every other device.

**Tests:** `device/local-refusals.test.ts › refuses to resolve a conflict it was refused`.

### `device/conflict-version-kept`

If the server refuses a write `409 version_conflict`, then a device MUST keep the row at the version it held.

**Tests:** `device/local-refusals.test.ts › refuses to resolve a conflict it was refused`, `device/verdicts.test.ts › reports a conflict rather than resolving it`.

### `device/create-tags-queued`

When a create names tags, a device MUST queue each tag as a write of its own that waits on the create.

**Tests:** `device/local-refusals.test.ts › refuses a local create whose tags and edges it cannot queue`, `device/queue.test.ts › queues an edge, a tag and an extension as writes of their own`.

### `device/edit-undeclared-sent`

When an edit names a property its type does not declare, a device MUST send that property.

**Reason:** a device that sent only the fields it knew would answer as though it had not been asked for the rest.

**Tests:** `device/local-refusals.test.ts › refuses an update carrying a field it cannot send`.

### `device/filter-grammar-refused`

If a local list or a local search names a filter that the server's listing grammar refuses, then a device MUST refuse it `validation`, carrying the server's `validation_error`, whether or not the search has words.

**Reason:** a filter a device ignored would answer every row, which reads as a matched filter and is the hardest wrong answer to notice.

**Tests:** `device/local-refusals.test.ts › refuses a list filter the grammar refuses, as the server does`, `› refuses a search filter the grammar refuses, as the server does`, `› refuses a search filter the grammar refuses on a search with no words`, `device/fidelity.test.ts › answers each filter expression with the ids the server answers`.

### `device/filter-limits-answered`

A device MUST answer a filter of ten conditions, and one of 2048 UTF-16 code units.

**Tests:** `device/local-refusals.test.ts › refuses a list filter the grammar refuses, as the server does`, `› counts a filter's length in UTF-16 code units, as the server does`.

### `device/filter-length-units`

If a filter is longer than 2048 UTF-16 code units, then a device MUST refuse it `validation`, carrying the server's `validation_error`, however few characters it holds.

**Tests:** `device/local-refusals.test.ts › counts a filter's length in UTF-16 code units, as the server does`.

### `device/filter-null-message`

If a filter compares a field with `null` by an operator that takes a value, then a device MUST refuse it with the server's message, which names `not_exists`.

**Tests:** `device/fidelity.test.ts › answers each filter expression with the ids the server answers`, `device/local-refusals.test.ts › refuses a list filter the grammar refuses, as the server does`.

### `device/filter-backref`

If a local list or a local search names a `backref` condition, then a device MUST refuse it `invalid`, carrying no server code.

**Reason:** a copy holds the edges its own items draw and not an edge drawn to one of them from a row outside the slice, so it would miss rows such a condition selects.

**Tests:** `device/local-refusals.test.ts › refuses a backref condition on a list and a search`.

### `device/filter-hidden-edge-type`

When a filter names `edge[<type>]` for an edge type the key may not read, a device MUST answer it from the edges the copy holds, those it queued and the server has not answered among them.

**Reason:** a local list makes no read of the server to learn the key's edge permissions, so it cannot tell such a type from one nothing in its slice draws, where the server refuses the term (`edges/filter-term-hidden`).

**Tests:** `device/fidelity.test.ts › answers from the copy an edge term the server refuses to a key that may not read its type`.

### `device/no-age-expiry`

A device MUST NOT let a row go because of its age.

**Reason:** the event log has a retention and items do not, and a copy swept by age would drop rows the server holds while it reports the slice complete.

**Tests:** `device/working-copy.test.ts › keeps an item however old it is`.

## Blobs

### `device/hydrate-no-bytes`

When a device hydrates, a device MUST NOT fetch blob bytes.

**Tests:** `device/working-copy.test.ts › holds an item whose bytes it has not fetched`.

### `device/blob-ref-held`

A device MUST hold an item that names a blob with the blob's reference, whether or not it holds the bytes.

**Tests:** `device/working-copy.test.ts › holds an item whose bytes it has not fetched`.

### `device/thumbnail-from-row`

When a device is asked for an item's thumbnail, a device MUST answer it from the row the copy holds.

**Reason:** a phone cannot hold a library's bytes and can hold its thumbnails, which travel with the item (`items/thumbnail-inline`).

**Tests:** `device/working-copy.test.ts › holds the thumbnail an item carries`.

### `device/thumbnail-not-held`

If a device is asked for the thumbnail of an item the copy does not hold, then a device MUST refuse the ask as not held rather than answer that the item carries none.

**Tests:** `device/working-copy.test.ts › holds the thumbnail an item carries`.

### `device/thumbnail-not-searched`

A device MUST NOT match a local search against the base64 of an item's thumbnail, however the row reached the copy and whenever its type's catalog learned the thumbnail.

**Tests:** `device/working-copy.test.ts › holds the thumbnail an item carries`, `› keeps a thumbnail out of its index when its type arrives after the stream opened`, `› keeps a thumbnail out of its index when its type gains one after the stream opened`, `› keeps a thumbnail out of its index when it follows, in one item, an image already read again for`, `› keeps a thumbnail out of its index when its property was read again for before its type declared it`, `› keeps a thumbnail out of its index when a catch-up meets it after an image already read again for`, `› keeps a thumbnail out of its index when a catch-up applies it`, `› keeps a thumbnail out of its index when a drain's answer carries it`, `› keeps a thumbnail out of its index when a local edit writes it`, `› keeps a thumbnail out of its index when a refused write's row is read back`, `› keeps a thumbnail out of its index when a refused create lands on the row its key names`, `› keeps a thumbnail out of its index when a waiting edit is laid over a row an event brought`.

### `device/bytes-absent`

If a device can get no bytes for a blob, from the server's own `404`, an unreachable server or a link that does not serve them, then a device MUST refuse the ask `bytes_absent`, naming the blob's hash.

**Tests:** `device/working-copy.test.ts › says the bytes are absent rather than the item`, `› says the bytes are absent when the link does not serve them`, `device/contract.test.ts › reads a blob as absent only on the server's own 404, never on a proxy's`.

### `device/bytes-absent-item-whole`

While a device holds no bytes for a blob, a device MUST still answer the item that names the blob.

**Reason:** the item is whole and only the bytes are absent.

**Tests:** `device/working-copy.test.ts › says the bytes are absent rather than the item`.

## Local reads

A local list and a local search read the copy alone. They take the server's listing grammar and answer it as the server does, so a question answers the same rows online and offline.

### `device/list-default-active`

When a local list names no state, a device MUST answer only rows in the active state.

**Reason:** the server's listing gives the same default (`items/bin-hidden` and `items/archived-hidden`), and a device whose default differed would answer one question differently with nothing to say which answer the caller got.

**Tests:** `device/working-copy.test.ts › answers the active state on a local list that names none`.

### `device/search-default-active`

When a local search names no state, a device MUST answer only rows in the active state.

**Reason:** the server's search gives the same default (`search-and-filters/state-search-default`).

**Tests:** `device/working-copy.test.ts › answers the active state on a local search that names none`.

### `device/read-named-state`

When a local list or a local search names a state, a device MUST answer the rows in that state.

**Tests:** `device/working-copy.test.ts › answers the active state on a local list that names none`, `› answers the active state on a local search that names none`.

### `device/get-archived`

A device MUST answer a local read by id of an archived row.

**Reason:** the server reads an archived row by id (`items/archived-readable`), and narrowing a read that names one row would hide a row the caller holds the id of.

**Tests:** `device/working-copy.test.ts › reads an archived row by id and reports a trashed one as absent`.

### `device/get-trashed`

A device MUST answer a local read by id of a row in the bin as it answers a row the copy does not hold.

**Reason:** the server answers a row in the bin as missing (`items/get-missing`).

**Tests:** `device/working-copy.test.ts › reads an archived row by id and reports a trashed one as absent`.

### `device/search-no-bin`

A device MUST NOT answer a row in the bin to a local search, whatever state the search names and whenever the row went to the bin.

**Reason:** the server keeps a trashed row out of its search index (`search-and-filters/search-bin`).

**Tests:** `device/working-copy.test.ts › keeps a row in the bin out of the index, whatever state a search names`, `› stops finding a row once an event puts it in the bin`.

### `device/list-bounds-exclusive`

When a local list names `occurred_after` or `occurred_before`, a device MUST leave out a row whose own time is the bound.

**Reason:** the server takes both bounds as exclusive (`search-and-filters/own-time-exclusive`), and the row on the bound is the one that tells the two readings apart.

**Tests:** `device/working-copy.test.ts › excludes a row sitting exactly on either bound`.

### `device/list-bound-alone`

When a local list names one time bound, a device MUST narrow by that bound alone.

**Tests:** `device/working-copy.test.ts › takes each bound on its own`.

### `device/time-bound-server`

When a local list names a time bound, a device MUST read it as the server reads it, as the same instant to the millisecond in UTC.

**Tests:** `device/time-comparisons-live.test.ts › normalizes exclusive time bounds as the server does`.

### `device/time-bound-invalid`

If a local list names a time bound that is not a time the server reads, then a device MUST refuse it `validation`, carrying the server's `validation_error`.

**Tests:** `device/time-comparisons-live.test.ts › normalizes exclusive time bounds as the server does`.

### `device/time-filter-server`

When a filter compares `occurred_at`, `created_at` or `updated_at` by `eq`, `neq`, `gt`, `gte`, `lt` or `lte`, a device MUST read the literal as the server reads it, as the same instant to the millisecond in UTC.

**Tests:** `device/time-comparisons-live.test.ts › normalizes and validates time filters on %s`.

### `device/time-filter-invalid`

If a filter compares a time field by `eq`, `neq`, `gt`, `gte`, `lt` or `lte` with a literal that is not text or not a time the server reads, then a device MUST refuse it `validation`, carrying the server's `validation_error`.

**Tests:** `device/time-comparisons-live.test.ts › normalizes and validates time filters on %s`.

### `device/time-filter-text`

When a filter compares a time field by `contains` or `starts_with`, a device MUST compare it as text.

**Tests:** `device/time-comparisons-live.test.ts › normalizes and validates time filters on %s`.

### `device/time-unsent-shown`

When a device shows a row of its own write that the server has not answered, a device MUST show each time the write gives at the instant the server would store, in the server's spelling.

**Tests:** `device/time-comparisons-live.test.ts › compares an unsent projection canonically and keeps its queued request`, `› projects every accepted spelling to the server's exact instant`.

### `device/time-unsent-sent-as-given`

When a device queues a write that gives a time, a device MUST send the time as the caller spelled it, under the write's own idempotency key.

**Tests:** `device/time-comparisons-live.test.ts › compares an unsent projection canonically and keeps its queued request`, `› projects every accepted spelling to the server's exact instant`.

### `device/search-narrows-like-list`

When a local search names a type or tags, a device MUST narrow it as a local list narrows: a type with its subtree, by name and by declared parent, and every tag given required.

**Tests:** `device/working-copy.test.ts › narrows a local search by type and tags as a list does`.

### `device/filter-as-server`

When a local list or a local search names a filter the server's listing grammar takes (`search-and-filters/filter-mixed-logic` and `edges/filter-edge`), a device MUST answer the rows the server answers from the same rows.

**Reason:** a copy that answered one expression otherwise than the server would show one set of rows offline and another online for the same question.

**Tests:** `device/working-copy.test.ts › narrows a local list by a property, a tag and the grammar's logic`, `› narrows a local list by an edge from an item`, `› narrows a local search by the listing grammar and beneath, as a list does`, `device/fidelity.test.ts › answers each filter expression with the ids the server answers`, `device/numeric-filters-live.test.ts › matches numeric equality and range filters between local and server %s`.

### `device/filter-case-ascii`

When a filter compares by `contains` or `starts_with`, a device MUST match without regard to ASCII case.

**Tests:** `device/fidelity.test.ts › answers each filter expression with the ids the server answers`.

### `device/filter-numeric-bound`

When a filter bounds a property by a number, a device MUST compare the property as a number, so text holding `10` is above `4` and text holding `abc` is not.

**Tests:** `device/fidelity.test.ts › answers each filter expression with the ids the server answers`.

### `device/filter-system-number`

When a filter compares a text system field such as `source_id` with a number or a boolean, a device MUST match the text the server matches, so `5.0` matches `eq 5` and `5` does not, and `1.0` matches `eq true`.

**Tests:** `device/fidelity.test.ts › answers each filter expression with the ids the server answers`.

### `device/filter-property-kind`

When a filter compares a property with a number or a boolean, a device MUST match no property that holds text, so a number property holding `5` matches `eq 5`, one holding `1` matches `eq true`, and text matches neither.

**Tests:** `device/fidelity.test.ts › answers each filter expression with the ids the server answers`, `device/numeric-filters-live.test.ts › matches numeric equality and range filters between local and server %s`.

### `device/filter-nested-number`

When a filter compares the text of an array or an object property, a device MUST read a number inside it as the server's stored text spells it, so `100000000000000000000` rather than `1e+20`.

**Tests:** `device/fidelity.test.ts › answers each filter expression with the ids the server answers`.

### `device/filter-edge-held`

When a filter names an `edge[<type>]` condition, a device MUST answer it from the edges the copy holds.

**Tests:** `device/working-copy.test.ts › narrows a local list by an edge from an item`, `device/fidelity.test.ts › answers from the copy an edge term the server refuses to a key that may not read its type`.

### `device/beneath`

When a local list or a local search names `beneath` an item, a device MUST answer that item and every item it reaches along `parent-of` edges from parent to child at any depth, as far as the copy holds those edges.

**Reason:** `beneath` is the device's own and has no server counterpart.

**Tests:** `device/working-copy.test.ts › narrows a local list to an item and everything beneath it`, `› narrows a local search by the listing grammar and beneath, as a list does`.

### `device/beneath-references`

When a local list names `beneath` an item, a device MUST NOT take a `references` edge as making a child.

**Tests:** `device/working-copy.test.ts › narrows a local list to an item and everything beneath it`.

### `device/beneath-cycle`

When a `parent-of` cycle the copy holds lies beneath an item, a device MUST end the walk there and answer each item on it once.

**Tests:** `device/working-copy.test.ts › ends beneath on a parent-of cycle, answering each row once`.

## Edges a copy holds

A copy holds the edges its items draw, and every edge of a type the slice holds whole. The replies in a thread point at the thread they are in and a file points at what it is attached to, so what points at the item on screen is a question an app asks of it.

### `device/edges-to`

When a caller reads the edges to an item, a device MUST answer each edge the copy holds whose target is that item, answered or still waiting in the queue, and no other edge.

**Reason:** a copy that answered only one end would leave an app asking every item it holds for its edges.

**Tests:** `device/working-copy.test.ts › answers the edges the copy holds to an item, the unanswered ones with them`.

### `device/edges-whole-either-end`

Where a slice holds an edge type whole, a device MUST answer an edge of that type from either end, whichever of its ends the copy holds.

**Tests:** `device/working-copy.test.ts › reads a held-whole edge from either end`.

### `device/edge-source-unheld`

If a caller creates an edge from a row the copy does not hold, of a type the slice does not hold whole, then a device MUST refuse it `invalid`, queueing nothing.

**Reason:** no event about the edge would reach the copy, so it would sit there as written for good.

**Tests:** `device/local-refusals.test.ts › refuses a local edge from a row the copy does not hold`.

### `device/edge-source-left-unheld`

When a hydration leaves the source of an edge create still waiting outside the slice, a device MUST NOT hold the edge, unless the slice holds its type whole.

**Reason:** nothing would keep such an edge current.

**Tests:** `device/queue.test.ts › holds no waiting edge whose source a re-hydration left outside the slice, nor its answer`.

### `device/edge-source-left-queued`

When a hydration leaves the source of an edge create still waiting outside the slice, a device MUST keep the create queued.

**Reason:** the caller was told the write was queued, so it is sent.

**Tests:** `device/queue.test.ts › holds no waiting edge whose source a re-hydration left outside the slice, nor its answer`.

## Bytes, fetched and sent

### `device/blob-link-credential`

When a device fetches bytes it does not hold, a device MUST ask the server for the blob's link with its credential.

**Tests:** `device/working-copy.test.ts › answers a second ask for the same bytes from what it holds`.

### `device/blob-link-as-given`

When a device follows a blob's link, a device MUST request the link exactly as the server gave it.

**Tests:** `device/working-copy.test.ts › answers a second ask for the same bytes from what it holds`.

### `device/blob-link-no-credential`

When a device follows a blob's link, a device MUST NOT send its credential.

**Tests:** `device/working-copy.test.ts › answers a second ask for the same bytes from what it holds`.

### `device/blob-hash-checked`

If bytes a device fetched do not hash to the name they were asked for under, then a device MUST refuse the ask `decoding`.

**Tests:** `device/working-copy.test.ts › keeps no bytes that do not hash to the name they were fetched under`.

### `device/blob-hash-not-kept`

If bytes a device fetched do not hash to the name they were asked for under, then a device MUST NOT keep them.

**Reason:** bytes kept under a name they do not hash to would answer a different file for that name from then on.

**Tests:** `device/working-copy.test.ts › keeps no bytes that do not hash to the name they were fetched under`.

### `device/blob-kept-beside`

When a device has fetched bytes, a device MUST keep them beside the store, in a folder named for the store's file with `.blobs` after it.

**Tests:** `device/working-copy.test.ts › answers a second ask for the same bytes from what it holds`.

### `device/blob-answered-locally`

When a device is asked again for bytes it keeps, a device MUST answer them without asking the server.

**Reason:** a device that fetched again on every read would spend a phone's data on a photo it already holds.

**Tests:** `device/working-copy.test.ts › answers a second ask for the same bytes from what it holds`.

### `device/blob-refetched`

When bytes a device kept have been taken away from beside the store, a device MUST fetch them again the next time they are asked for.

**Tests:** `device/folders.test.ts › keeps no copy beside the store of bytes its file holds, and fetches them again when asked`.

### `device/upload-copied`

When a device queues an upload, a device MUST copy the file's bytes beside the store, named by their hash, so that a later change to the file does not change what is sent.

**Tests:** `device/queue.test.ts › queues an upload and sends its bytes when it drains`, `› names an upload's bytes in the queue and never holds them`.

### `device/upload-not-in-store`

A device MUST NOT write an upload's bytes into the store.

**Tests:** `device/queue.test.ts › names an upload's bytes in the queue and never holds them`.

### `device/upload-empty`

If a device is asked to queue an upload of an empty file, then a device MUST refuse it `invalid` and queue nothing.

**Reason:** the server holds no empty blob (`blobs/upload-empty`).

**Tests:** `device/queue.test.ts › queues an upload and sends its bytes when it drains`.

### `device/upload-drained`

When a drain reaches an upload, a device MUST send the bytes it holds for it to `POST /blobs`, under the upload's MIME type, with its credential.

**Tests:** `device/queue.test.ts › queues an upload and sends its bytes when it drains`.

### `device/upload-answer-hash`

If the server's answer to an upload names other bytes, or none, then a device MUST leave the upload unanswered and count a refusal against it.

**Tests:** `device/queue.test.ts › counts an upload whose answer names other bytes`.

### `device/upload-bytes-gone`

If the bytes of a queued upload are gone from beside the store when a drain reaches it, then a device MUST refuse the upload, naming the bytes, and send nothing for it.

**Reason:** such a write can never be sent, and left waiting it would stay unanswered for good.

**Tests:** `device/queue.test.ts › refuses an upload whose bytes are no longer held`.

### `device/upload-bytes-unopened`

If the bytes of a queued upload are beside the store but cannot be opened when a drain reaches it, then a device MUST leave the upload unanswered and uncounted for the next drain, saying why in the drain's report.

**Tests:** `device/queue.test.ts › leaves an upload whose held bytes cannot be opened unanswered, and says why`.

### `device/attach-three-writes`

When a device attaches a file to an item, a device MUST queue an upload, a file item naming the bytes, and an `attached-to` edge from the file item to the item.

**Tests:** `device/queue.test.ts › attaches a file as an upload, a file item and an edge, each waiting on the one before`.

### `device/attach-item-waits`

When a device attaches or adds a file, a device MUST make the file item wait on the upload.

**Tests:** `device/queue.test.ts › attaches a file as an upload, a file item and an edge, each waiting on the one before`, `› adds a file as an upload and a file item, linked to nothing`.

### `device/attach-edge-waits`

When a device attaches a file, a device MUST make the `attached-to` edge wait on the file item.

**Tests:** `device/queue.test.ts › attaches a file as an upload, a file item and an edge, each waiting on the one before`.

### `device/attach-refused-with-upload`

If the server refuses an attachment's upload, then a device MUST refuse the file item and the edge that wait on it.

**Tests:** `device/queue.test.ts › refuses an attachment whose upload the server refuses, and what waits on it`.

### `device/attach-given`

When a device attaches a file under a title, a type or a tier, a device MUST give the file item that title, type and tier.

**Tests:** `device/queue.test.ts › attaches under the title, type and tier it is given`.

### `device/attach-held-only`

If a device is asked to attach a file to an item the copy does not hold, or holds in the bin, then a device MUST refuse it `not_found` and queue nothing.

**Tests:** `device/queue.test.ts › attaches only to an item the copy holds outside the bin`.

## The server the command talks to

The `marfa` command is built for one contract version, the version of the document it was generated from, and every answer names the contract it speaks in `X-Marfa-Contract` (`instance/contract-header`).

### `device/command-contract-mismatch`

If an answer names a contract other than the one the command was built for, then the command MUST refuse it `contract_mismatch` with exit 1.

**Reason:** a body shaped for another contract may be shaped and sized in ways the command cannot read.

**Tests:** `device/contract.test.ts › refuses an answer on another contract rather than reading it`, `› refuses contract_mismatch from every command but status`, `› refuses an event stream on another contract, and reads one on its own`, `› reads every door on its own contract, so the refusal above is the contract's`, `› names an invocation for every command in the table, and nothing else`, `› drives every command the binary has, or says why not`.

### `device/command-mismatch-prints-nothing`

When the command refuses an answer for its contract, the command MUST print nothing of the answer.

**Tests:** `device/contract.test.ts › refuses an answer on another contract rather than reading it`, `› refuses contract_mismatch from every command but status`.

### `device/command-unnamed-success`

If a success names no contract, then the command MUST refuse it `contract_mismatch` with exit 1.

**Tests:** `device/contract.test.ts › refuses a success that names no contract`.

### `device/command-contract-twice`

If an answer names its contract on two header lines that differ, then the command MUST refuse it `contract_mismatch`.

**Tests:** `device/contract.test.ts › refuses an answer that names its contract twice, differently`.

### `device/command-contract-repeated`

When an answer names the command's own contract on two header lines, the command MUST read it as an answer on that contract.

**Tests:** `device/contract.test.ts › refuses an answer that names its contract twice, differently`.

### `device/command-write-sent`

If the answer to a write the command sent names another contract, then the command MUST say in its refusal that the write was sent and may have taken effect.

**Reason:** the contract is named by the answer, so the server acted on the write before the command could read that it speaks another contract.

**Tests:** `device/contract.test.ts › says a write it refused for its contract was sent and may have taken effect`.

### `device/command-unnamed-refusal`

If a refusal names no contract, then the command MUST report it `unnamed_answer` with exit 3, naming its status.

**Reason:** the server names its contract on every answer, so a refusal naming none is from something in front of it, such as a proxy.

**Tests:** `device/contract.test.ts › hands on a refusal that names no contract, as a proxy's would`.

### `device/command-redirect`

If an answer to the command is a `3xx`, then the command MUST refuse it `redirect` with exit 1, naming the status and the destination, without following it.

**Tests:** `device/contract.test.ts › refuses a redirect without following it`.

### `device/command-no-root-first`

When the command sends a call other than a mint, `status` or `whoami`, the command MUST send that call alone, with no read of the server's root before it.

**Tests:** `device/contract.test.ts › reads an answer on its own contract, sending only the call`.

### `device/command-mint-root-first`

When the command sends a write whose answer is the only copy of what it mints, `keys create`, `keys bootstrap` or `webhooks create`, the command MUST first read the server's root.

**Reason:** a mint refused for its contract has already minted a key or a secret nobody can read.

**Tests:** `device/contract.test.ts › sends no mint to a server whose root names another contract, or none`.

### `device/command-mint-not-sent`

If the server's root names another contract, or none, then the command MUST NOT send a mint.

**Tests:** `device/contract.test.ts › sends no mint to a server whose root names another contract, or none`.

### `device/command-root-header`

The command MUST take the contract the server speaks from the `X-Marfa-Contract` header of the root's answer, whatever the root's body says.

**Tests:** `device/contract.test.ts › takes the served contract from the answer's header, whatever the root's body says`, `› sends no mint to a server whose root names another contract, or none`.

### `device/status-other-contract`

When `status` reads a server on another contract, the command MUST report the contract the server speaks beside the one it was built for, and exit 0.

**Tests:** `device/contract.test.ts › still says which server this is, and that its contract is another`, `› says in words that the server speaks another contract`, `› takes the served contract from the answer's header, whatever the root's body says`.

### `device/status-other-contract-no-counts`

When `status` reads a server on another contract, the command MUST NOT ask it for the item counts.

**Tests:** `device/contract.test.ts › still says which server this is, and that its contract is another`.

### `device/whoami-other-contract`

When `whoami` reads a server on another contract, the command MUST report the contract the server speaks beside the one it was built for, and exit 0.

**Tests:** `device/contract.test.ts › takes the served contract from the answer's header, whatever the root's body says`.

### `device/status-counts-not-permitted`

If the server refuses `status` the item counts `403 type_not_permitted`, then the command MUST still describe the server, say the counts need a working key and exit 0.

**Reason:** a credential whose type permissions reach no type, the operator key among them, is refused the counts (`keys-and-oauth.md` 1).

**Tests:** `device/contract.test.ts › describes the server to a key that reaches no type, and says the counts need a working key`.

### `device/status-counts-refused`

If the server refuses `status` the item counts for any other reason, then the command MUST fail with that refusal.

**Tests:** `device/contract.test.ts › hands on any other refusal of the counts`.

### `device/operations-offline`

The command MUST print its table of operations without sending a request.

**Tests:** `device/contract.test.ts › sends nothing to print the table`.

### `device/bootstrap-stdin`

When `keys bootstrap` is not given `--secret`, the command MUST read the one-time secret from the first line of its standard input.

**Reason:** a secret on the command line is left in the shell's history.

**Tests:** `device/contract.test.ts › mints the operator key with a bootstrap secret read from stdin`.

### `device/bootstrap-blank`

If `keys bootstrap` reads a blank line for its secret, then the command MUST refuse it `invalid` and send nothing.

**Tests:** `device/contract.test.ts › mints the operator key with a bootstrap secret read from stdin`.

### `device/redeliver-request`

When `webhooks redeliver <id> <delivery_id>` runs, the command MUST send one `POST /webhooks/{id}/deliveries/{delivery_id}/redeliver` with its credential and no body, each identifier encoded as a path segment of its own.

**Reason:** the server decides from its current authority and retained deliveries whether to send again (`events/redeliver-current`).

**Tests:** `device/contract.test.ts › posts redelivery with encoded ids and no body`.

### `device/credential-lock-unsafe`

If the command's credential lock is not safe to use, then the command MUST refuse `invalid`, naming the credential lock, before it sends anything.

**Tests:** `device/credential-locks.test.ts › refuses an unsafe credential lock across environment overrides before contacting the server`, `› refuses to keep a key under an unsafe credential lock, keeping nothing and sending nothing`, `› refuses a sign-in under an unsafe credential lock before asking for a code`.

### `device/credential-lock-taken`

While another process changes the credential kept for a server, as a refresh, `logout` or `keys forget` does, the command MUST keep no credential for that server through `login` or `keys keep` until that change ends.

**Reason:** a credential written beside a refresh in another process would be overwritten by the refreshed one, or brought back after a logout.

**Tests:** `device/credential-locks.test.ts › keeps a key only once another process has finished changing the kept credential`, `› keeps a sign-in's token only once another process has finished changing the kept credential`.

### `device/credential-refresh-then-logout`

If `logout` runs while another process refreshes the kept sign-in for the same server, then the command MUST revoke the refresh token that the refresh keeps.

**Reason:** a revocation of the token the refresh replaced would leave the rotated one standing.

**Tests:** `device/credential-locks.test.ts › revokes the token a refresh under way keeps, when a sign-out waits on it`.

### `device/credential-logout-then-refresh`

If a refresh of a kept sign-in starts while `logout` for the same server runs in another process, then the command MUST NOT refresh or keep again the sign-in that `logout` forgets.

**Reason:** a refresh that read the credential before the logout ended would bring back a sign-in the person ended.

**Tests:** `device/credential-locks.test.ts › brings back no sign-in a sign-out under way forgets, when a refresh waits on it`.

### `device/command-logout-forgets`

When `logout` signs out of a kept sign-in, the command MUST forget the kept token, whether or not the server takes its revocation.

**Tests:** `device/credential-locks.test.ts › reports a sign-out the server did not revoke as revoked: false, and forgets the token either way`.

### `device/command-logout-not-revoked`

If a sign-in kept no revocation endpoint, or the server refuses its revocation or cannot be reached, then `logout` MUST report `revoked: false`.

**Reason:** a sign-out that claimed a revocation it never had would leave a person believing a token is dead while it stands until it expires.

**Tests:** `device/credential-locks.test.ts › reports a sign-out the server did not revoke as revoked: false, and forgets the token either way`.

### `device/command-keys-forget-offline`

When `keys forget` runs, the command MUST forget the credential kept for the server without sending a request.

**Reason:** a credential is often forgotten for a server that is gone.

**Tests:** `device/credential-locks.test.ts › forgets a kept key without sending anything`.

## Held open

A held stream is a catch-up that does not end at the head. It takes each event by the rules a catch-up takes it by.

### `device/follow-applies`

While a device holds a stream open, a device MUST apply each event as it arrives, under the rules a catch-up applies it by.

**Reason:** a device that learned of a change only when a caller asked would show an item open on a screen as it was when the person last asked.

**Tests:** `device/catch-up.test.ts › applies each event on a held stream as it arrives, and resumes from its cursor when the stream drops`, `› applies an event on a held stream beneath a write it has not had answered`, `› applies an edge event on a held stream beneath an edge edit it has not had answered`, `› applies nothing on a held stream from outside its slice`, `› keeps a row that moves between its tiers on a held stream`.

### `device/follow-tells`

While a device holds a stream open, a device MUST tell its caller of each event that changed the copy, with the item or the edge it was about and the cursor it left, while the stream is still held.

**Tests:** `device/catch-up.test.ts › applies each event on a held stream as it arrives, and resumes from its cursor when the stream drops`, `› applies nothing on a held stream from outside its slice`, `› names the edge a held stream's change was about`.

### `device/follow-untold`

While a device holds a stream open, a device MUST NOT tell its caller of an event that did not change the copy.

**Tests:** `device/catch-up.test.ts › applies each event on a held stream as it arrives, and resumes from its cursor when the stream drops`.

### `device/follow-reopens`

If a held stream ends, drops or is called incomplete by the server, then a device MUST open it again from the cursor it holds.

**Reason:** a stream opened again from the cursor loses nothing between the two and applies nothing twice.

**Tests:** `device/catch-up.test.ts › applies each event on a held stream as it arrives, and resumes from its cursor when the stream drops`, `› opens a held stream again from its cursor when the server calls it incomplete`.

### `device/follow-backoff`

If every held stream ends at once, then a device MUST ask for the next after a wait that grows each time.

**Tests:** `device/catch-up.test.ts › asks again at a falling rate when every stream ends at once, and ends on an answer no retry changes`.

### `device/follow-backoff-cap`

While a device waits to ask for a held stream again, a device MUST NOT wait more than thirty seconds unless the server names a longer wait.

**Tests:** waiting on #1890.

### `device/follow-server-failing`

If the server answers a held stream with a failure that clears on its own, then a device MUST ask again after its wait.

**Tests:** `device/catch-up.test.ts › asks again at a falling rate when every stream ends at once, and ends on an answer no retry changes`, `› tells a held stream's caller once that the server cannot be reached, and once that it can again`.

### `device/follow-ends-unretryable`

If the server answers a held stream with a refusal no retry changes, then a device MUST end the stream with that refusal.

**Tests:** `device/catch-up.test.ts › asks again at a falling rate when every stream ends at once, and ends on an answer no retry changes`.

### `device/follow-catalog-reopen`

When a held stream meets an event the catalog cannot answer for, a device MUST open the stream again at once from its cursor, reading the catalogs first, rather than apply the event.

**Tests:** `device/catch-up.test.ts › holds an item whose type was registered after the stream opened, in the slice through its parent`.

### `device/follow-catalog-once`

While held streams follow one another because of the catalog, a device MUST open them again at most once for each type or property an event names.

**Reason:** a type the server will not describe, or an image under a property declared as text, would otherwise cost one stream for every event naming it.

**Tests:** `device/catch-up.test.ts › reads the catalog once for a type the server will not describe, not once for each event naming it`, `› reads the catalog once a stream for an image under a property declared as text, and holds it as text`.

### `device/follow-forgets`

When a held stream ends for a reason other than the catalog, a device MUST read the catalogs again for a type or property the next stream's events name.

**Reason:** a type may have made a property its thumbnail since.

**Tests:** `device/working-copy.test.ts › keeps a thumbnail out of its index when its property was read again for before its type declared it`.

### `device/follow-stop`

When a held stream is told to stop, a device MUST end it at once, even while a stream is still being asked for.

**Tests:** `device/catch-up.test.ts › ends a follow at once when stopped while its stream is still being asked for`.

### `device/command-follow-interrupted`

When `follow` is interrupted, the command MUST end it with its report, as when its time is up.

**Tests:** `device/catch-up.test.ts › prints its report when interrupted, as it does when its time is up`.

### `device/command-follow-reader-gone`

When the reader of `follow`'s output has gone, the command MUST end the follow.

**Tests:** `device/catch-up.test.ts › ends a follow whose reader has gone, rather than going on untold`.

### `device/follow-unreachable`

If a held stream cannot be had for a reason that clears on its own, then a device MUST tell its caller `server.unreachable` once, with why and naming no item and no edge, however many attempts follow.

**Reason:** an app told nothing would show offline and online alike, and would have to drain on a timer to send what it queued once the server came back.

**Tests:** `device/catch-up.test.ts › tells a held stream's caller once that the server cannot be reached, and once that it can again`.

### `device/follow-reachable`

When a held stream is had again after the device told `server.unreachable`, a device MUST tell its caller `server.reachable` once.

**Tests:** `device/catch-up.test.ts › tells a held stream's caller once that the server cannot be reached, and once that it can again`.

### `device/follow-at-once-silent`

When a held stream is had at once, a device MUST tell its caller neither `server.unreachable` nor `server.reachable`.

**Tests:** `device/catch-up.test.ts › applies an event on a held stream beneath a write it has not had answered`.

### `device/follow-told-reachable`

When a held stream is had at once, and its caller says it was last told `server.unreachable` by an earlier held stream, a device MUST tell the caller `server.reachable`.

**Reason:** a caller restarts its follow around a catch-up, a hydration or a new key, and a new follow that said nothing would leave it believing the server still gone.

**Tests:** waiting on #1890.

### `device/follow-told-not-again`

If a held stream cannot be had for a reason that clears on its own, and its caller says it was last told `server.unreachable` by an earlier held stream, then a device MUST NOT tell the caller `server.unreachable` again.

**Tests:** waiting on #1890.

### `device/event-id-number`

If a catch-up's or a held stream's stream names an event id that is not a number, then a device MUST end it `decoding` and keep the cursor it had.

**Reason:** a cursor no start can resume from would leave the copy stuck.

**Tests:** `device/catch-up.test.ts › refuses an event id that is not a number, keeping the cursor it had`, `› ends a follow on an event id that is not a number, keeping its cursor`.

### `device/event-no-data`

When a catch-up's stream sends a frame that names an id and an event and carries no data, a device MUST take the frame as no event and apply nothing of what it names to the frame after it.

**Tests:** `device/catch-up.test.ts › takes a frame that names an id and carries no data as no event`.

### `device/event-line-bound`

If a catch-up's stream sends a line of more than 67,108,864 bytes (64 MiB), its line ending included, then a device MUST end the catch-up `decoding` and keep the cursor it had.

**Reason:** no event the server sends comes near the bound, and holding a line without one would take memory without end.

**Tests:** `device/catch-up.test.ts › refuses a line longer than 64 MiB, keeping the cursor it had`.

## A store opened to read

### `device/reader-not-writer`

When a device opens a store to read, a device MUST NOT claim the writer role.

**Reason:** a helper that opened the store as a second writer would, started first, lock the app out of its own store.

**Tests:** `device/working-copy.test.ts › opens a store to read without claiming the writer role, and is told when it saves`.

### `device/reader-writes-nothing`

When a device opens a store to read, a device MUST NOT change the store's file, even where it is the last to close after a writer that died.

**Tests:** `device/working-copy.test.ts › opens a store to read without claiming the writer role, and is told when it saves`, `device/read-view.test.ts › refuses reads of a stored copy that lost its instance, through a reader as through the writer`.

### `device/reader-told-of-saves`

While a device holds a store open to read, a device MUST tell its caller each time another connection saves to the store.

**Reason:** a reader with no signal would have to read everything again to learn whether anything changed.

**Tests:** `device/working-copy.test.ts › opens a store to read without claiming the writer role, and is told when it saves`.

### `device/reader-absent`

If a device is asked to open a store to read at a path where no store has been made, then a device MUST refuse and make no file there.

**Tests:** `device/working-copy.test.ts › opens a store to read without claiming the writer role, and is told when it saves`, `device/cli-outcomes.test.ts › reports an absent reading store: %j`.

### `device/command-reader-no-store`

If a command opens a store to read at a path where no store has been made, then the command MUST refuse it `no_store` with exit 2.

**Tests:** `device/cli-outcomes.test.ts › reports an absent reading store: %j`, `device/working-copy.test.ts › opens a store to read without claiming the writer role, and is told when it saves`.

### `device/command-reader-not-a-store`

If a command opens a store to read at a path that holds a file that is not a store, then the command MUST NOT refuse it `no_store`.

**Tests:** `device/cli-outcomes.test.ts › reports an absent reading store: %j`.

### `device/reader-missing-table`

If a device opens to read a store that lacks a table this build adds, then a device MUST refuse it `invalid`, saying to open it once with this build's writer.

**Tests:** `device/working-copy.test.ts › opens a store made before a table this build adds, and adds it`.

### `device/added-table`

When a device opens to write a store made before a table this build adds, a device MUST add the table and open the store.

**Tests:** `device/working-copy.test.ts › opens a store made before a table this build adds, and adds it`.

### `device/wrong-schema`

If a store was made by another build of the core, at another schema version or with tables of another shape than this build makes, then a device MUST refuse every open of it, as a writer or to read, `wrong_schema` before it reads anything, naming the store's path.

**Reason:** the schema version does not move before the first public release, so a table's shape is what tells one build's store from another's.

**Tests:** `device/working-copy.test.ts › refuses to read a store a writer of another schema version made`, `› refuses a store another build shaped, by name, with the writes it holds unsent`.

### `device/wrong-schema-says`

When a device refuses a store `wrong_schema`, a device MUST say how many writes it holds that the server has not taken, waiting, blocked, refused or dead.

**Tests:** `device/working-copy.test.ts › refuses a store another build shaped, by name, with the writes it holds unsent`, `› names a blocked write among the writes a store of another shape holds unsent`.

### `device/wrong-schema-no-delete`

When a device refuses a store `wrong_schema`, a device MUST NOT advise deleting the store.

**Reason:** only the build that made the store can send or show the writes it holds.

**Tests:** `device/working-copy.test.ts › refuses a store another build shaped, by name, with the writes it holds unsent`.

### `device/writer-per-file`

A device MUST give each store file its own writer role, so two stores in one directory that share a stem each have a writer.

**Reason:** every core opening a store has to claim the role the same way, or two cores would each claim it beside the other, so every client on a machine moves to a core together.

**Tests:** `device/working-copy.test.ts › gives two stores sharing a stem a writer each`.

## Where a store is made

### `device/command-makes-store`

When `hydrate` or `status` names a path where no store has been made, the command MUST make a store there.

**Reason:** the state report is how a caller learns that a hydration is owed before the first one.

**Tests:** `device/working-copy.test.ts › makes a store only to hydrate or to report its state, and refuses a path with none to every other command`.

### `device/command-no-store`

If a `device` command other than `hydrate` and `status` names a path where no store has been made, then the command MUST refuse it `no_store` and leave the path as it found it.

**Reason:** a read answered from a store made for a mistyped path is an empty copy that reads as a real one, and a write queued there is a queue nothing will drain.

**Tests:** `device/working-copy.test.ts › makes a store only to hydrate or to report its state, and refuses a path with none to every other command`.

## Who may read a store

### `device/owner-only`

When a device makes a store, its journals, its writer lock or the folder of bytes beside it, a device MUST make each readable by its owner alone.

**Reason:** a store holds what its key reads, and made with the process's defaults it would be readable by every account on the machine.

**Tests:** `device/working-copy.test.ts › makes a store, its lock and its bytes readable by their owner alone`.

## A file on its own

### `device/add-file-writes`

When a device adds a file on its own, a device MUST queue an upload and a file item naming the bytes.

**Tests:** `device/queue.test.ts › adds a file as an upload and a file item, linked to nothing`.

### `device/add-file-no-edge`

When a device adds a file on its own, a device MUST queue no edge.

**Reason:** a photo or a document that belongs to no item is still a file a person keeps, and linking it would relate it to an item it has nothing to do with.

**Tests:** `device/queue.test.ts › adds a file as an upload and a file item, linked to nothing`.

### `device/add-file-given`

When a device adds a file under a title, a type, a tier or tags, a device MUST give the file item that title, type, tier and tags.

**Tests:** `device/queue.test.ts › adds a file under the title, type, tier and tags it is given`.

### `device/add-file-tags-wait`

When a device adds a file with tags, a device MUST queue each tag as a write of its own that waits on the file item.

**Tests:** `device/queue.test.ts › adds a file under the title, type, tier and tags it is given`.

### `device/file-mime-default`

Where a file is attached or added with no MIME type, a device MUST take the MIME type from the file's extension, whatever its case, an EPUB and the Office formats among them, and `application/octet-stream` for one it does not know.

**Reason:** a file sent as bytes of no known kind is one no reader opens as what it is.

**Tests:** `device/queue.test.ts › adds a file as an upload and a file item, linked to nothing`, `› attaches under the title, type and tier it is given`, `› types an added file by its extension, whatever its case, where it is told nothing`.

### `device/file-type-default`

Where a file is attached or added with no type, a device MUST give the file item `core.file.image`, `core.file.audio` or `core.file.video` for a MIME type of that kind, and `core.file` for any other.

**Tests:** `device/queue.test.ts › types an added file by its extension, whatever its case, where it is told nothing`, `› adds a file as an upload and a file item, linked to nothing`.

### `device/file-title-default`

Where a file is added with no title, a device MUST give the file item the file's name as its title.

**Tests:** `device/queue.test.ts › adds a file as an upload and a file item, linked to nothing`.

## The type catalog

### `device/catalog-replaced-catch-up`

When a device catches up, a device MUST replace the item type and edge type catalogs it holds with the server's.

**Tests:** `device/catalog.test.ts › moves the catalog version when a catch-up reads a changed catalog, and only then`.

### `device/catalog-replaced-follow`

When a device opens a held stream, a device MUST replace the item type and edge type catalogs it holds with the server's.

**Tests:** `device/catalog.test.ts › tells a held stream's caller when it reads a changed catalog`.

### `device/catalog-offline`

A device MUST answer a read of either catalog from its copy alone, with no server named or reachable.

**Reason:** an app shows a row by its type's fields and an edge by its type's names, so a catalog it could read only online would leave it unable to show a row offline.

**Tests:** `device/catalog.test.ts › reads a registered type with its label and inherited fields, and an edge type's reverse name, from the copy alone`.

### `device/catalog-type-read`

A device MUST answer an item type as `GET /types/{id}` answers it (`types/read`): its label and parent as declared, its fields with those it inherits, each naming the type that declares it and a field declared again nearer the type taking the place of the one above, and the display hints of the nearest type that declares any, taken whole.

**Tests:** `device/catalog.test.ts › reads a registered type with its label and inherited fields, and an edge type's reverse name, from the copy alone`, `device/fidelity.test.ts › reads a registered type and edge type from a working copy as the server answers them`, `device/folders.test.ts › takes the display hints of the nearest type that declares any, whole, as the server resolves them`.

### `device/catalog-edge-type-read`

A device MUST answer an edge type as `GET /edge-types` lists it (`edges/types-list`, `edges/types-shipped-flag`, `edges/types-reverse-listed` and `edges/types-written-at-listed`): its label, cardinality, reverse name, the end whose file writes it, its endpoint constraints, its cascade, its properties and whether Marfa ships it.

**Tests:** `device/catalog.test.ts › reads a registered type with its label and inherited fields, and an edge type's reverse name, from the copy alone`, `device/fidelity.test.ts › reads a registered type and edge type from a working copy as the server answers them`, `› matches the edge types a working copy holds and a folder reads its frontmatter lines by`.

### `device/catalog-read-consistent`

When a device reads the catalog while a refresh replaces it, a device MUST answer from one catalog, wholly before or wholly after the refresh.

**Tests:** waiting on #1890.

### `device/catalog-replace-whole`

If a refresh of the catalog fails part way, then a device MUST keep the catalogs and the catalog version it held.

**Tests:** `device/catalog.test.ts › keeps the catalogs and the version it held when a refresh fails after the item types`.

### `device/catalog-shipped`

While its copy has never reached a server, a device MUST answer a read of either catalog with the types and edge types Marfa ships and the types its app declares, never with an empty list.

**Reason:** an empty list would read as an instance with no types at all.

**Tests:** `device/catalog.test.ts › answers every catalog read on a copy that has never reached a server with the types Marfa ships`, `device/save-before-sync.test.ts › knows the types and edge types Marfa ships, and says so of one it has never been told of`, `› checks a write against the types the app declares, and holds an unknown one back`.

### `device/catalog-unknown`

If a device is asked for a type or an edge type its catalog does not hold, then a device MUST refuse `not_found`, naming it.

**Tests:** `device/catalog.test.ts › refuses a type the copy's catalog does not hold, naming it`, `› replaces a server's catalog it holds with the one the next hydration reads`.

### `device/catalog-version-absent`

While its copy has never held a server's catalog, a device MUST report no catalog version.

**Tests:** `device/catalog.test.ts › answers every catalog read on a copy that has never reached a server with the types Marfa ships`.

### `device/catalog-version-moves`

When a refresh changes either catalog, a device MUST move the catalog version it reports, and at no other time.

**Reason:** a caller compares the version rather than reading both catalogs again after every save.

**Tests:** `device/catalog.test.ts › moves the catalog version when a catch-up reads a changed catalog, and only then`.

### `device/catalog-changed-told`

When a held stream reads a catalog that differs from the one the copy held, a device MUST tell its caller `catalog.changed`, naming no item and no edge, with the cursor the stream holds.

**Tests:** `device/catalog.test.ts › tells a held stream's caller when it reads a changed catalog`.

## Certified read access

A device keeps its copy under the read view the server certifies (`read-views.md`): it holds the instance, cursor and read view of the copy stream that hydrated it, and presents them back on every read that fills the copy.

### `device/resume-presents-view`

When a device resumes a copy stream, a device MUST send the cursor it holds and the read view its copy was hydrated under.

**Tests:** `device/read-view.test.ts › requires the actual live marker even when the announced head is already held`.

### `device/live-marker-required`

If a catch-up's stream ends before a live marker, then a device MUST NOT report the catch-up complete, even where the head the stream announced is the cursor it holds.

**Tests:** `device/read-view.test.ts › requires the actual live marker even when the announced head is already held`.

### `device/proof-invalid`

If a certified answer carries a read view that is missing, malformed or not the copy's, or a listing classification that is missing or not a boolean, then a device MUST expire the copy, keeping its queue.

**Tests:** `device/read-view.test.ts › expires on %s without losing unsent work`, `device/fidelity.test.ts › matches copy marker tuples and conditional listing proofs`.

### `device/page-termination`

If a certified page answers no `next_cursor` member, then a device MUST expire the copy, keeping its queue.

**Reason:** a page that does not say it is the last cannot be told from a listing cut short.

**Tests:** `device/read-view.test.ts › refuses a certified page without explicit termination while retaining unsent work`, `› reports a hydration that ended on an invalid page as expired, not in progress`.

### `device/proof-invalid-reason`

When a device expires its copy for a proof it cannot accept, a device MUST end the operation `copy_expired` with the reason `read_view_invalid`.

**Tests:** `device/catch-up.test.ts › hydrates again when another instance answers at the same address`, `device/hydration.test.ts › expires the copy when a listing hands back a cursor it already read`.

### `device/view-changed`

If the server says the copy's read view has changed, then a device MUST end the operation `copy_expired` with the reason `read_view_changed`, expiring the copy and keeping its queue.

**Reason:** a retype, a narrowed grant or a changed source filter cannot then leave old rows readable as current.

**Tests:** `device/read-view-live.test.ts › expires on real %s and rebuilds without losing unsent work`, `› ends a real held stream when grants narrow, keeping unsent work`.

### `device/listed-membership`

Where the server lists a row as not a member of the item listing, a device MUST NOT hold the row unless it is pinned.

**Reason:** a pin is authorized by the direct read alone, and taking it off must not turn a row a source filter leaves out into listed data.

**Tests:** `device/read-view-live.test.ts › keeps real direct pins separate from source-filtered listing membership`.

### `device/uncertified-keeps-copy`

If a read under the copy's read view meets a dropped connection, a rate limit, a server failure or a refusal naming no contract, then a device MUST keep the copy complete.

**Reason:** a temporary inability to read does not revoke a copy already certified.

**Tests:** `device/read-view.test.ts › keeps a certified offline copy after an uncertified %i`, `› keeps a certified offline copy after %s`.

### `device/credential-ended`

If a read under the copy's read view is refused `401` naming the contract and the credential cannot be renewed, then a device MUST expire the copy `copy_expired` with the reason `credential_ended`.

**Tests:** `device/contract.test.ts › refuses an event stream's refusal on another contract rather than reading its envelope`.

### `device/read-back-keeps-verdict`

If the read that follows a write's answer fails, then a device MUST keep the verdict, the refusal count, the request and the idempotency key the write had.

**Reason:** a write receipt settles that write, and the read only settles what the copy holds.

**Tests:** `device/contract.test.ts › ends the pass when the read a refusal is reconciled against answers on another contract`, `› ends the pass when the read of the row a create landed on answers on another contract`.

## Saving before a first sync

### `device/save-before-sync`

While its copy has never hydrated, a device MUST take a write, checked against the types the copy holds.

**Reason:** an app has a person's save in its hand whatever the network is doing, and a copy that refused the save until a first sync would make it depend on a network the person was not using.

**Tests:** `device/save-before-sync.test.ts › saves a note against the types Marfa ships, shows it to a read, and queues it`.

### `device/save-before-sync-queued`

While its copy has never hydrated, a device MUST queue each write it takes.

**Tests:** `device/save-before-sync.test.ts › saves a note against the types Marfa ships, shows it to a read, and queues it`.

### `device/save-before-sync-shown`

While its copy has never hydrated, a device MUST show a write it takes to a local read at once.

**Tests:** `device/save-before-sync.test.ts › saves a note against the types Marfa ships, shows it to a read, and queues it`, `device/working-copy.test.ts › answers a read before any hydration from what the copy holds`.

### `device/save-before-sync-library`

While its copy has never hydrated, a device MUST hold a create that names no tier at the tier `library`.

**Tests:** `device/save-before-sync.test.ts › saves a note against the types Marfa ships, shows it to a read, and queues it`, `device/save-before-sync-live.test.ts › sends what it saved with no server once it has joined, after registering the type the key may`.

### `device/save-before-sync-joins`

When a copy that has never hydrated hydrates against a server, a device MUST keep its queue so the first drain sends it.

**Tests:** `device/save-before-sync-live.test.ts › sends what it saved with no server once it has joined, after registering the type the key may`.

### `device/create-slice-tier`

When a create names no tier, a device MUST send it at the slice's tier, at `library` in a slice of both, unless its natural key names a row the copy holds.

**Reason:** a create sent with no tier would land at the key's default tier, which may not be where the copy showed it.

**Tests:** `device/slice-tiers-live.test.ts › creates offline at each tier in a slice of both, and the server holds each where it was shown`, `› re-saves a feed row by its natural key in a slice of both without moving it`.

### `device/declared-checked`

A device MUST refuse `validation` a write to a type its app declared that misses a required field or gives a field a value of the wrong type.

**Reason:** an app that saves offline is held to the rules its types will be held to online.

**Tests:** `device/save-before-sync.test.ts › checks a write against the types the app declares, and holds an unknown one back`.

### `device/unknown-type-write`

If a write names a type the copy was never told of, then a device MUST refuse it `unknown_type`.

**Tests:** `device/save-before-sync.test.ts › checks a write against the types the app declares, and holds an unknown one back`, `› holds the app's latest declarations alone`.

### `device/declaration-refused`

If an app declares a type whose identifier breaks the type grammar or uses a reserved root, that names a type Marfa ships, that has a field with no known type, or that names a parent the copy does not know, then a device MUST refuse the declaration `invalid`.

**Tests:** `device/save-before-sync.test.ts › refuses a declaration that names a type of Marfa's, one it cannot read, or a parent it does not know`.

### `device/declaration-refused-whole`

If a device refuses one type of a declaration, then a device MUST declare none of the declaration's types.

**Tests:** `device/save-before-sync.test.ts › refuses a declaration that names a type of Marfa's, one it cannot read, or a parent it does not know`.

### `device/declaration-replaces`

When an app declares types, a device MUST replace every type the app declared before with them.

**Reason:** the declarations are the app's whole set, so a type it no longer declares is no longer held to.

**Tests:** `device/save-before-sync.test.ts › holds the app's latest declarations alone`, `› checks a write against the types the app declares, and holds an unknown one back`.

### `device/declaration-dropped-queued`

When an app stops declaring a type, a device MUST keep a write already queued under it.

**Reason:** the caller was told the save was queued, and a server that lacks the type refuses it with its own verdict.

**Tests:** `device/save-before-sync.test.ts › holds the app's latest declarations alone`.

### `device/hydrate-registers`

When a device hydrates, a device MUST register on the instance each type its app declared that the instance does not hold, where the key may.

**Reason:** a slice can then name the type, and the server holds a write to it to the type's rules.

**Tests:** `device/save-before-sync-live.test.ts › sends what it saved with no server once it has joined, after registering the type the key may`.

### `device/hydrate-registers-parents`

When a hydration registers declared types, a device MUST register each parent before its children.

**Tests:** `device/save-before-sync.test.ts › registers a declared parent before its child, and fails a hydration whose registration meets a failing server`.

### `device/hydrate-register-fails`

If the server answers a registration with a failure that clears on its own, then a device MUST fail the hydration rather than report the type as one the key may not register.

**Tests:** `device/save-before-sync.test.ts › registers a declared parent before its child, and fails a hydration whose registration meets a failing server`.

### `device/hydrate-unregistered-said`

When a hydration could not register a declared type, a device MUST report it with the server's code for the refusal.

**Tests:** `device/save-before-sync-live.test.ts › says which declared types the key could not register, and the server refuses the write that names one`.

### `device/unregistered-write-waits`

Where a declared type is left unregistered, a device MUST keep a write to it queued for the server's own verdict.

**Reason:** a type the instance lacks does not strand what was saved under it.

**Tests:** `device/save-before-sync-live.test.ts › says which declared types the key could not register, and the server refuses the write that names one`.

## Stopping a long call

### `device/stop-canceled`

When a stop is raised during a hydration, a catch-up or a drain, a device MUST end the call `canceled` soon after.

**Tests:** `device/stop.test.ts › ends it between pages, leaving a copy that refuses reads and a queue that is as it was`, `› ends it while it waits on a stream, keeping the cursor it had`, `› ends it before the next write is sent, leaving that write queued and unsent`.

### `device/command-stopped-exit`

When a hydration, a catch-up or a drain that the command stopped on Ctrl-C ends `canceled`, the command MUST exit with status 3.

**Tests:** `device/stop.test.ts › ends it between pages, leaving a copy that refuses reads and a queue that is as it was`, `› ends it while it waits on a stream, keeping the cursor it had`, `› ends it before the next write is sent, leaving that write queued and unsent`.

### `device/stop-hydration-replacing`

When a hydration that has begun replacing the copy is stopped, a device MUST leave a copy that refuses reads until a hydration completes.

**Tests:** `device/stop.test.ts › ends it between pages, leaving a copy that refuses reads and a queue that is as it was`.

### `device/stop-hydration-queue`

When a hydration is stopped, a device MUST leave its queue as it was.

**Tests:** `device/stop.test.ts › ends it between pages, leaving a copy that refuses reads and a queue that is as it was`, `› reports canceled after a stopped head read ends or is refused, without retrying or changing the queue`.

### `device/stop-catch-up-cursor`

When a catch-up is stopped, a device MUST keep the cursor of the last event it took.

**Tests:** `device/stop.test.ts › ends it while it waits on a stream, keeping the cursor it had`, `› reports canceled after a stopped stream opening is refused, keeping its cursor and queue`.

### `device/stop-drain-in-flight`

When a drain is stopped while a write is in flight, a device MUST settle that write's answer as an unstopped drain would before the drain ends.

**Tests:** `device/stop.test.ts › ends it before the next write is sent, leaving that write queued and unsent`.

### `device/stop-drain-no-send`

When a drain is stopped, a device MUST send no write after the stop.

**Tests:** `device/stop.test.ts › ends it before the next write is sent, leaving that write queued and unsent`.

### `device/stop-drain-rest-queued`

When a drain is stopped, a device MUST leave every write it had not sent queued for the next drain.

**Tests:** `device/stop.test.ts › ends it before the next write is sent, leaving that write queued and unsent`.

### `device/command-second-ctrl-c`

When the command receives a second Ctrl-C before the call has stopped, the command MUST end the process at once with status 130.

**Tests:** `device/stop.test.ts › ends the process on a second Ctrl-C, where a first one waits for the call to notice`.

### `device/stop-before-read-returns`

When a stop is raised before an in-flight read returns, a device MUST end the hydration or the catch-up `canceled`, even where the read then fails.

**Reason:** a failed answer or an ended stream must not replace an explicit stop with a network or replay failure.

**Tests:** `device/stop.test.ts › reports canceled after a stopped head read ends or is refused, without retrying or changing the queue`, `› reports canceled after a stopped stream opening is refused, keeping its cursor and queue`.

### `device/stop-no-retry`

When a hydration's head read is stopped, a device MUST NOT read the head again.

**Tests:** `device/stop.test.ts › reports canceled after a stopped head read ends or is refused, without retrying or changing the queue`.

### `device/stop-first-request`

When a stop is raised while the first request of a hydration, a catch-up, a drain or a read of the server's item types or edge types still waits on the server, a device MUST end the call `canceled` at once.

**Reason:** a server that cannot be reached can hold a request far longer than an app that closes a copy or cancels a sync can wait, and the request left behind is only ever a read: the head read, the catalog read, or the root a drain asks before it sends.

**Tests:** `device/stop.test.ts › ends a hydration at once on Ctrl-C, while its head read still waits`, `› ends a catch-up at once on Ctrl-C, while its catalog read still waits`, `› ends a drain at once on Ctrl-C, while it still asks which instance the server is`, `› ends a read of the server's catalog at once on Ctrl-C, while it still waits`.

### `device/stop-first-request-unchanged`

When a stop ends a hydration, a catch-up, a drain or a read of the server's item types or edge types while its first request still waits on the server, a device MUST leave the copy and the queue as they were.

**Tests:** `device/stop.test.ts › ends a hydration at once on Ctrl-C, while its head read still waits`, `› ends a catch-up at once on Ctrl-C, while its catalog read still waits`, `› ends a drain at once on Ctrl-C, while it still asks which instance the server is`, `› ends a read of the server's catalog at once on Ctrl-C, while it still waits`.

## Names a write carries

### `device/tag-bound`

If a create, a tag add, a metadata merge or replace, a file added with tags, or a folder's scan of a document's tags (`folders.md` 55) adds a tag that is empty, blank as JavaScript's `trim` reads blank, or longer than 128 UTF-16 code units, then a device MUST refuse it `validation`, carrying the server's `validation_error`.

**Reason:** a write the server refuses (`items/tag-text`) stays in the queue until a drain, long after the person saved it, so the bound is held where the write is made.

**Tests:** `device/name-bounds-live.test.ts › refuses a tag the server refuses, on every door, before it saves or queues anything`, `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`.

### `device/tag-count`

If a create, a tag add, a metadata merge or replace, a file added with tags, or a folder's scan of a document's tags (`folders.md` 55) names more than 100 tags, or would leave the row the copy shows more than 100 tags and more than it held, then a device MUST refuse it `validation`, carrying the server's `validation_error`.

**Reason:** the server holds the same bound (`items/tags-count`), and a write it refuses would come back refused long after the person saved it.

**Tests:** `device/name-bounds-live.test.ts › refuses a write naming more than 100 tags, or leaving a row more than 100 it did not hold, as the server does`, `device/folder-names.test.ts › is flagged with its reason and queues nothing of it, while a swap on a full item and the files after it are saved`.

### `device/tag-bound-nothing-saved`

When a device refuses a tag `validation`, a device MUST save and queue nothing of the write.

**Tests:** `device/name-bounds-live.test.ts › refuses a tag the server refuses, on every door, before it saves or queues anything`, `› refuses a write naming more than 100 tags, or leaving a row more than 100 it did not hold, as the server does`.

### `device/tag-bound-taken`

When a write adds a tag the server takes, a device MUST take it and queue it, a tag of 128 UTF-16 code units and a row of 100 tags included.

**Tests:** `device/name-bounds-live.test.ts › takes a tag the server takes, queues it, and has it accepted when the queue drains`, `› refuses a write naming more than 100 tags, or leaving a row more than 100 it did not hold, as the server does`.

### `device/property-name-empty`

If a create, an edit or a folder's scan of a document (`folders.md` 55) names a property with no characters, then a device MUST refuse it `validation`, carrying the server's `validation_error`.

**Reason:** the server refuses such a name on every write (`items/property-name-empty`), and a device that took it would hold a row the server never will.

**Tests:** `device/name-bounds-live.test.ts › refuses a property with no name on create and edit, and takes one with a name`, `device/folder-names.test.ts › is flagged with its reason while the files either side of it are saved`.

### `device/property-name-nothing-saved`

When a device refuses a property name `validation`, a device MUST save and queue nothing of the write.

**Tests:** `device/name-bounds-live.test.ts › refuses a property with no name on create and edit, and takes one with a name`.

## Property order

A device shows a row's properties in the order the server answers them, before the server has answered and after.

### `device/order-answered`

When the server answers a write, a device MUST hold the row's properties in the order the answer gives them.

**Reason:** an app shows an item as a document in its properties' order. A write that another device's write reaches first is merged by the server (`items/property-order-merge`), in an order no device can know beforehand, and a natural-key create can land on a row the server already holds, so the answer is what settles the order.

**Tests:** `device/property-order-live.test.ts › shows a create in the order the server answers it, before the answer and after`, `› shows an edit in the order the server answers it, before the answer and after`, `› keeps a whole edit's order through a hydration and onto an answer ahead of it`.

### `device/order-create`

While a device holds a create that the server has not answered, a device MUST hold the fields the type declares first, in the order a read of the type lists them with a parent's fields before its own and a field declared again in the place it first took, then every other property in the order written.

**Reason:** the server answers a create in this order (`items/property-order-create`), so a copy that held another would move a person's fields under them as the queue drained.

**Tests:** `device/property-order-live.test.ts › shows a create in the order the server answers it, before the answer and after`.

### `device/order-array-index`

A device MUST hold a property whose name is an array index before every other property, in numeric order.

**Reason:** the server is JavaScript, whose objects put such names first (`items/property-order-index`).

**Tests:** `device/property-order-live.test.ts › shows a create in the order the server answers it, before the answer and after`.

### `device/order-merge`

While a device holds an edit that merges properties at the version the copy holds, a device MUST keep each property where the row holds it and hold each property the edit adds after them, in the order sent.

**Reason:** the server merges in this order (`items/property-order-merge`).

**Tests:** `device/property-order-live.test.ts › shows an edit in the order the server answers it, before the answer and after`.

### `device/order-replace`

While a device holds an edit that replaces the properties at the version the copy holds, a device MUST hold them in the order the edit sends them.

**Reason:** the server answers a whole edit in the order sent (`items/property-order-replace`).

**Tests:** `device/property-order-live.test.ts › shows an edit in the order the server answers it, before the answer and after`, `› keeps a whole edit's order through a hydration and onto an answer ahead of it`.

### `device/order-replace-kept`

While an edit that replaces the properties waits to be sent, a device MUST keep the order it was made in through a hydration and when it is moved onto the answer to an earlier write to the row.

**Tests:** `device/property-order-live.test.ts › keeps a whole edit's order through a hydration and onto an answer ahead of it`.

## Folders, read and written from a copy

A working copy reads a `system.folder` that its slice or a pin takes, answers a list or a search in it, and writes its settings through the folder operations.

### `device/folder-system-tier`

Where a slice names a `system.*` type, a device MUST hold that type's rows at either tier.

**Reason:** the server gives a `system.folder` the `library` tier, which says nothing about it, and a copy of the feed still needs the folders it shows.

**Tests:** `device/folder-settings-live.test.ts › holds the folders a slice names, at either tier`.

### `device/folder-read`

When a caller reads a folder the copy holds, a device MUST answer its state and its settings, whether the folder is active or revoked.

**Reason:** an app shows every folder a person made by its title, a revoked one among them.

**Tests:** `device/folder-settings-live.test.ts › holds the folders a slice names, at either tier`, `› creates, changes and revokes at once, holding the answer and queueing nothing`.

### `device/folder-read-backref`

When a caller reads a folder the copy holds whose search carries a `backref` condition, a device MUST answer its settings.

**Reason:** the server takes such a folder (`items/folder-create`), and an app shows it by its title though no copy can answer its search.

**Tests:** `device/folder-settings-live.test.ts › refuses settings no folder follows before anything is sent, and fails offline with nothing kept`.

### `device/folder-list`

When a caller lists or searches in a folder, a device MUST answer the items of the search's types and their subtypes, at the search's tier, in the states it names or `active` and `archived` where it names none, that its `filter` matches, and no `system.*` row.

**Reason:** an app that shows a folder beside the folder on disk would otherwise show one set of items there and another in the files, with nothing to say which is right (`folders.md` 2).

**Tests:** `device/folder-settings-live.test.ts › lists and searches in a folder what the folder's search holds`.

### `device/folder-list-beneath`

Where the copy holds `parent-of` whole, when a caller lists in a folder whose search names `beneath` an item, a device MUST answer the items that `beneath` holds, the named item among them.

**Tests:** `device/folder-settings-live.test.ts › refuses a folder search its slice cannot answer whole, and a folder it does not hold`.

### `device/folder-unanswerable`

If the copy's slice does not take a type or the tier that a folder's search can hold, or the search names `beneath` while the copy does not hold `parent-of` whole, then a device MUST refuse a list or a search in that folder `invalid`.

**Reason:** answered from part of the folder, a list reads as the whole of it, which is the wrong answer hardest to notice.

**Tests:** `device/folder-settings-live.test.ts › refuses a folder search its slice cannot answer whole, and a folder it does not hold`.

### `device/folder-unanswerable-named`

If a device refuses a list in a folder because its slice cannot answer the folder's search, then a device MUST name in the refusal the type, the tier or `parent-of` that the slice lacks.

**Reason:** the remedy is a hydration with what is named.

**Tests:** `device/folder-settings-live.test.ts › refuses a folder search its slice cannot answer whole, and a folder it does not hold`.

### `device/folder-list-backref`

If a folder's search carries a `backref` condition, then a device MUST refuse a list in that folder `invalid`, naming the condition.

**Reason:** a copy holds the edges its items draw but not every edge drawn to them, so it would otherwise ignore the condition.

**Tests:** `device/folder-settings-live.test.ts › refuses settings no folder follows before anything is sent, and fails offline with nothing kept`.

### `device/folder-list-revoked`

If a folder is revoked, then a device MUST refuse a list or a search in it `invalid`, naming it revoked.

**Reason:** a revoked folder has no settings to follow.

**Tests:** `device/folder-settings-live.test.ts › creates, changes and revokes at once, holding the answer and queueing nothing`.

### `device/folder-list-not-folder`

If the row a list in a folder names is not a `system.folder`, then a device MUST refuse the list `invalid`, naming `system.folder`.

**Tests:** `device/folder-settings-live.test.ts › refuses a folder search its slice cannot answer whole, and a folder it does not hold`.

### `device/folder-not-held`

If the copy does not hold a folder, then a device MUST refuse a list or a search in it `not_found` with the code `not_held`.

**Reason:** the remedy is to hold the folder, by a pin or by naming `system.folder` in the slice, not to change the slice's types.

**Tests:** `device/folder-settings-live.test.ts › refuses a folder search its slice cannot answer whole, and a folder it does not hold`.

### `device/folder-write-at-once`

When a caller creates, changes or revokes a folder through a working copy, a device MUST send the write to `POST /folders`, `PATCH /folders/{id}` or `POST /folders/{id}/revoke` before the call returns.

**Reason:** the folder operations are the only ones that write a `system.folder` (`items/system-types`), and a drain sends to the item operations, so a folder write kept for later would wait on an operation no drain reaches.

**Tests:** `device/folder-settings-live.test.ts › creates, changes and revokes at once, holding the answer and queueing nothing`.

### `device/folder-write-unqueued`

When a caller creates, changes or revokes a folder through a working copy, a device MUST NOT queue the write.

**Tests:** `device/folder-settings-live.test.ts › creates, changes and revokes at once, holding the answer and queueing nothing`.

### `device/folder-write-offline`

If a folder write through a working copy cannot reach the server, then a device MUST refuse it `network`, leaving nothing queued.

**Reason:** a caller told nothing failed would believe the folder made, and a write kept for later would be sent by no drain.

**Tests:** `device/folder-settings-live.test.ts › refuses settings no folder follows before anything is sent, and fails offline with nothing kept`.

### `device/folder-write-backref`

If folder settings sent through a working copy carry a `backref` condition, then a device MUST refuse them `invalid` before anything is sent.

**Reason:** the server takes a `backref` condition, which no copy can answer, so a folder made with one could be followed by no folder on disk and listed in no copy.

**Tests:** `device/folder-settings-live.test.ts › refuses settings no folder follows before anything is sent, and fails offline with nothing kept`.

### `device/folder-write-grammar`

If folder settings sent through a working copy carry a `filter` the listing grammar refuses or a default tag the server refuses, then a device MUST refuse them `validation` before anything is sent.

**Reason:** the server refuses such a filter (`items/folder-setting-invalid`), and a default tag the server refuses on an item would be refused on every new file the folder makes.

**Tests:** `device/folder-settings-live.test.ts › refuses settings the server would refuse, or defaults its search would not hold, before anything is sent`.

### `device/folder-write-defaults`

If folder settings sent through a working copy name a default type or a default tier that the folder's search does not hold, then a device MUST refuse them `invalid` before anything is sent.

**Reason:** a new file made with such a default would fall outside its own folder (`folders.md` 3), and the server takes the settings.

**Tests:** `device/folder-settings-live.test.ts › refuses settings the server would refuse, or defaults its search would not hold, before anything is sent`.

### `device/folder-change-as-stands`

When a caller changes a folder the copy holds, a device MUST check the settings as they will stand after the change.

**Reason:** a change to the defaults alone can be one the search they stand beside does not hold.

**Tests:** `device/folder-settings-live.test.ts › refuses settings the server would refuse, or defaults its search would not hold, before anything is sent`.

### `device/folder-write-held`

When a folder operation accepts a write and the copy's slice or a pin takes the row, a device MUST hold the row as the server answers it before the call returns.

**Reason:** an app that made a folder shows it at once.

**Tests:** `device/folder-settings-live.test.ts › creates, changes and revokes at once, holding the answer and queueing nothing`.

### `device/folder-write-accepted`

When a folder operation accepts a write to a folder whose search carries a `backref` condition, a device MUST answer the write as accepted.

**Reason:** the write has taken effect, and a caller told it failed would send it again.

**Tests:** `device/folder-settings-live.test.ts › refuses settings no folder follows before anything is sent, and fails offline with nothing kept`.

## A file's size

### `device/file-size`

When a device takes in bytes for a file item by attaching a file to an item or by adding one on its own, a device MUST store their length as `size_bytes` on the file item it saves, where the item's type is `core.file` or inherits from it.

**Reason:** an app lists files from the copy, and before the first drain no server has measured the bytes. The device counts them as it copies them in, so the copy shows the size the server will set from the same bytes (`blobs/file-size-set`).

**Tests:** `device/file-size-live.test.ts › shows a file's size in the copy before it drains, and the server's once it has`.

## Purging

A purge goes from a device to `POST /items/{id}/purge` at once, at the version the person was shown: the copy's, or the one a read of the bin answered, which the caller names.

### `device/purge-not-held`

If the copy does not hold a row and the caller names no version for it, then a device MUST refuse to purge it `not_found` with the code `not_held`, sending nothing.

**Reason:** a row the copy does not hold, named with no version, is one nobody can say the person was shown.

**Tests:** `device/purge.test.ts › refuses a row the copy does not hold, sending nothing`.

### `device/purge-not-in-bin`

If the row the copy shows is not in the bin, then a device MUST refuse to purge it `validation` with the code `invalid_transition`, sending nothing.

**Reason:** the copy shows a row with this device's waiting writes laid over it, so a restore it queued shows the row restored while the server still holds it in the bin. Restoring does not move the version, so the server's version check would let the purge destroy what the person brought back.

**Tests:** `device/purge.test.ts › refuses a row the copy shows restored, sending nothing and keeping the restore`, `device/purge-live.test.ts › refuses a purge of a row not in the bin, keeping it`.

### `device/purge-waiting-write`

If a write to a row has no answer yet, or is blocked or dead, then a device MUST refuse to purge the row `invalid`, sending nothing.

**Reason:** the write would reach a row that is gone, and a write that carried a person's content would be lost to a purge they may not have meant it for. A blocked or dead write waits until it is released, withdrawn or discarded.

**Tests:** `device/purge.test.ts › refuses a row a write to which still waits, sending nothing`, `› refuses a row a blocked write names, sending nothing`.

### `device/purge-other-instance`

Where the copy names the instance it was hydrated from, if another instance answers at the copy's origin, then a device MUST refuse a purge `copy_expired`, sending nothing.

**Reason:** a purge cannot be taken back, so nothing is sent while the instance is unconfirmed, as a drain sends nothing.

**Tests:** `device/purge.test.ts › sends nothing to another instance at the same address, and expires the copy`.

### `device/purge-other-instance-expires`

Where the copy names the instance it was hydrated from, if another instance answers at the copy's origin when a purge is asked for, then a device MUST expire the copy.

**Reason:** a copy facing another instance is one that cannot be kept current.

**Tests:** `device/purge.test.ts › sends nothing to another instance at the same address, and expires the copy`.

### `device/purge-at-once`

When a device purges a row, a device MUST send `POST /items/{id}/purge` before the call returns.

**Reason:** a purge held for later would destroy a row long after the person who asked had stopped looking.

**Tests:** `device/purge.test.ts › refuses a row the copy does not hold, sending nothing`, `device/purge-live.test.ts › purges a row in the bin at once, queueing nothing`.

### `device/purge-unqueued`

When a device purges a row, a device MUST NOT queue the purge.

**Tests:** `device/purge.test.ts › refuses a row the copy does not hold, sending nothing`, `device/purge-live.test.ts › purges a row in the bin at once, queueing nothing`.

### `device/purge-version-held`

When a caller purges a row the copy holds and names no version, a device MUST send the version the copy holds.

**Reason:** trashing does not move the version, so a row another device restored and edited since is refused (`items/purge-version`) rather than destroyed.

**Tests:** `device/purge.test.ts › refuses a row the copy does not hold, sending nothing`, `device/purge-live.test.ts › refuses a purge of a row that moved since the copy read it, keeping it`.

### `device/purge-version-named`

When a caller names a version for a purge, a device MUST send that version, whether or not the copy holds the row.

**Reason:** a row read from the bin is not held, and the version the read answered is the one the person was shown.

**Tests:** `device/purge.test.ts › sends the version the caller names over the one the copy holds`, `device/bin-live.test.ts › purges a row read from the bin at the version it was read at`.

### `device/purge-refused-kept`

If the server refuses a purge, then a device MUST leave the copy's rows and its queue as they were.

**Reason:** a copy that looked as though it had purged would disagree with the server for good.

**Tests:** `device/purge-live.test.ts › refuses a purge the key may not make, keeping the row`, `› refuses a purge of a row that moved since the copy read it, keeping it`.

### `device/purge-unsent-kept`

If a purge cannot be sent, then a device MUST refuse it `network` and leave the copy's rows and its queue as they were.

**Tests:** `device/local-refusals.test.ts › queues no purge, and keeps the row, when the purge cannot be sent`.

### `device/purge-accepted`

When the server accepts a purge, a device MUST take the row, the edges at both its ends and its pin out of the copy.

**Reason:** the acceptance is the server's word that the row is gone.

**Tests:** `device/purge-live.test.ts › takes the row and its pin out once the server accepts, and the event after changes nothing`, `› takes the edges at both ends of a purged row out of the copy`, `device/purge.test.ts › refuses a row the copy does not hold, sending nothing`.

### `device/purge-event-after`

When the `item.purged` event of a purge the copy has taken out reaches the copy, a device MUST change nothing.

**Tests:** `device/purge-live.test.ts › takes the row and its pin out once the server accepts, and the event after changes nothing`.

### `device/purge-unanswered`

If a purge is sent and no answer comes, then a device MUST keep the row and refuse the purge `network`.

**Reason:** the server may have purged the row and the answer been lost. The outcome is unknown, so the copy keeps what it was last told, and the `item.purged` event takes the row out where the server did purge it.

**Tests:** `device/purge.test.ts › keeps the row when a purge that was sent is never answered`.

## The bin

### `device/bin-read`

When a caller reads the bin, a device MUST answer the server's bin, a page at a time.

**Reason:** a local read answers no row in the bin, and a copy holds a row in the bin only while its slice or a pin takes it, so the bin a person is shown is the server's `GET /items?state=trashed`. The server answers no time a row went to the bin, so a row's `updated_at` stands for it.

**Tests:** `device/bin-live.test.ts › reads the server's bin a page at a time, holding nothing`.

### `device/bin-unheld`

When a caller reads the bin, a device MUST NOT hold what it reads in the copy.

**Reason:** a page held in the copy would enter rows no event keeps current.

**Tests:** `device/bin-live.test.ts › reads the server's bin a page at a time, holding nothing`.

### `device/bin-offline`

If the server cannot be reached when a caller reads the bin, then a device MUST refuse `network`.

**Reason:** a bin answered from the copy offline would read as the whole bin while missing every row outside the slice.

**Tests:** `device/purge.test.ts › refuses to read the bin while the server cannot be reached`.

### `device/pin-trashed`

If a caller pins a row the server holds in the bin, then a device MUST refuse `not_found` with the code `trashed`, pinning nothing.

**Reason:** a read by id answers a row in the bin as one that is gone (`items/get-missing`), so the device asks the bin which it is, and the caller can offer to restore the row rather than report it lost.

**Tests:** `device/bin-live.test.ts › refuses to pin a row in the bin, saying so`, `› keeps a row it holds in the bin when a pin of it is refused`.

### `device/pin-trashed-held`

If a pin of a row is refused because the server holds the row in the bin, then a device MUST keep the row where the copy holds it.

**Reason:** a slice holds its rows in the bin as in any other state, and a refused pin is not news that the row is gone.

**Tests:** `device/bin-live.test.ts › keeps a row it holds in the bin when a pin of it is refused`.

### `device/read-back-binned`

If a drain reads back a row by id and the server answers it as gone while its bin holds the row, then a device MUST keep the row the copy holds.

**Reason:** a read by id answers a row in the bin as one that is gone (`items/get-missing`), and a slice holds its rows in the bin as in any other state.

**Tests:** `device/bin-live.test.ts › keeps a row it holds in the bin when a drain reads it back`.

### `device/pin-trashed-unread`

If a caller pins a row the server holds in the bin, of a type the key may not read, then a device MUST refuse it `not_found` without the code `trashed`.

**Reason:** the server answers a row of a type the key may not read as a missing one, in the bin too (`keys-and-oauth.md` 20), so the copy tells the key nothing more of it.

**Tests:** `device/bin-live.test.ts › refuses a pin of a row in the bin of a type the key may not read as one that is gone`.

## A slice of both tiers

### `device/tier-all-hydrate`

Where a slice's tier is `all`, a device MUST hold the rows of both tiers that a hydration reads.

**Reason:** an app that shows an inbox, the feed, beside a person's record, the library, needs both in one copy. Held as two copies of one tier each, an item triaged offline leaves the feed's copy at once and cannot enter the library's until a catch-up reads it from the server.

**Tests:** `device/working-copy.test.ts › holds both tiers in a slice of both, hydrated again from one of them`, `device/slice-tiers-live.test.ts › hydrates both tiers, keeps a triage made offline through a restart and its drain, and sees a move made elsewhere`.

### `device/tier-all-listing`

Where a slice's tier is `all`, when a device hydrates, a device MUST ask `GET /items` for `tier=all` (`search-and-filters/tier-both`).

**Reason:** the event stream carries both tiers already, so the listing is the one read that names a tier.

**Tests:** `device/working-copy.test.ts › holds both tiers in a slice of both, hydrated again from one of them`.

### `device/tier-all-move`

Where a slice's tier is `all`, when a local edit, a drain's answer, a catch-up or a held stream moves a row from one tier to the other, a device MUST keep the row and show it at its new tier.

**Reason:** a move of tier inside the slice is not a row leaving it.

**Tests:** `device/catch-up.test.ts › keeps a row that moves between its tiers on a catch-up`, `› keeps a row that moves between its tiers on a held stream`, `device/slice-tiers-live.test.ts › hydrates both tiers, keeps a triage made offline through a restart and its drain, and sees a move made elsewhere`.

## Links and embeds in a body

A body written through a working copy is read by the rule a folder reads a Markdown file's body by (`folders.md` 11 and 12). These rules say what a working copy does, which has no directory and no file record.

### `device/body-edges`

When a create or an edit through a working copy changes an item's body, a device MUST queue the edges that the links and embeds of the change name.

**Reason:** an app on a binding or the command line has no folder, so without this a link it saves names nothing, and every app would need its own copy of the rule.

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`, `› makes an embed of an image and of a video, by name and by path, the file's attached-to edge`.

### `device/body-field`

A device MUST read an item's body from the property `folders.md` 7 names: the type's `body_field`, or `body` for a type that names none.

**Reason:** `core.event` keeps its body in `description`, so a link there is a link.

**Tests:** `device/body-edges-live.test.ts › makes no edge for a link to the item itself or in a comment, and reads an event's description as its body`.

### `device/body-unchanged`

When an edit through a working copy leaves the item's body as it was, a device MUST NOT queue an edge write for it.

**Tests:** `device/body-edges-live.test.ts › queues no edge write for an edit that leaves the body as it was`.

### `device/body-link`

When a body carries a link that names one item, a device MUST queue a `references` edge from the item to the item it names.

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`, `› reads an alias and a heading as the name before them, and a link in code as text`.

### `device/body-link-by-id`

When a body carries a link by the id of an item the copy holds, a device MUST queue the link's `references` edge as the write is saved.

**Tests:** `device/body-edges-live.test.ts › reports a refused edge write against its link, and keeps the body`.

### `device/body-link-by-title`

If a body's link names no item by an id the copy holds and no item the item already has a `references` edge to, then a device MUST NOT queue its edge until the server's lookup has answered.

**Reason:** a working copy holds a slice and its pins, so it cannot tell alone that a title names one item.

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`.

### `device/body-link-forms`

When a body carries `[[name|shown]]` or `[[name#part]]`, a device MUST read the link as naming `name`.

**Tests:** `device/body-edges-live.test.ts › reads an alias and a heading as the name before them, and a link in code as text`.

### `device/body-link-text`

When a body carries a heading-only link, or a link in inline code, a code block or a comment, a device MUST NOT make an edge of it.

**Tests:** `device/body-edges-live.test.ts › reads an alias and a heading as the name before them, and a link in code as text`, `› makes no edge for a link to the item itself or in a comment, and reads an event's description as its body`.

### `device/body-link-self`

When a body carries a link that names its own item, by id or by title, a device MUST NOT make an edge of it.

**Tests:** `device/body-edges-live.test.ts › makes no edge for a link to the item itself or in a comment, and reads an event's description as its body`.

### `device/body-link-queued-create`

When a body carries a link to an item whose create waits in the queue, a device MUST send the link's edge after that create.

**Reason:** this is what lets a link name an item created earlier in the same queue (`queue-and-verdicts.md` 4).

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`.

### `device/body-embed`

When a body carries an embed of a file, by `![[name]]` or `![](path)`, a device MUST queue an `attached-to` edge from the one file item it names to the item.

**Reason:** the embed is how the body says which file it shows, so an app can find the file item and show or play it, and a photo, a recording and a PDF are embedded alike.

**Tests:** `device/body-edges-live.test.ts › makes an embed of an image and of a video, by name and by path, the file's attached-to edge`.

### `device/body-embed-note`

When a body carries an embed of a note, a device MUST read it as text and make no edge of it.

**Tests:** `device/body-edges-live.test.ts › makes an embed of an image and of a video, by name and by path, the file's attached-to edge`.

### `device/body-edge-own-write`

When a body's change names an edge, a device MUST queue the edge as a write of its own, with its own verdict.

**Reason:** a refused edge then leaves the body saved, and the body's write is refused alone where the server refuses it (`queue-and-verdicts.md` 33).

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`, `› reports a refused edge write against its link, and keeps the body`.

### `device/body-pin`

When a body's link names an item only the server holds, a device MUST pin that item before it queues the edge.

**Reason:** a copy holds no edge to a row it does not hold, and the pin lets the copy say offline what the link names, as a folder pins the other end of a line (`folders.md` 11).

**Tests:** `device/body-edges-live.test.ts › pins an item only the server holds before its edge is queued, and lets the pin go once no edge needs it`.

### `device/body-pin-release`

When no `references` edge reaches an item a body's link pinned, a device MUST let that pin go.

**Reason:** the pin was made for the edge alone.

**Tests:** `device/body-edges-live.test.ts › pins an item only the server holds before its edge is queued, and lets the pin go once no edge needs it`.

### `device/body-edge-held`

When a body names an edge of a type and ends the copy holds already, a device MUST NOT queue another.

**Reason:** one triple is one edge (`edges/create-duplicate`), so a body naming an item twice, or naming an item a folder, an attach or another device linked already, makes none.

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`, `› makes an embed of an image and of a video, by name and by path, the file's attached-to edge`, `› embeds an attached file by the text the attach answers, with no second edge`, `› agrees with a folder on the same item, and neither repeats the other's edge`.

### `device/body-edge-refused`

If the server refuses a body's edge write, then a device MUST keep the refused write in the queue until it is discarded.

**Reason:** a refused write is kept as any refused write is (`queue-and-verdicts.md` 47), so the person can see it.

**Tests:** `device/body-edges-live.test.ts › reports a refused edge write against its link, and keeps the body`.

### `device/body-edge-duplicate`

When the server refuses a body's edge create because the edge exists, a device MUST take that create out of the queue.

**Reason:** two writers that make the same edge before either hears of the other each send a create, and the second is refused as a duplicate. The edge it asked for stands, so keeping the refusal would report as failed a link that works. The copy takes the server's edge from the event log.

**Tests:** `device/body-edges-live.test.ts › settles an edge two copies both made as one, and leaves no refusal`.

### `device/body-edge-lost`

When the write a body's edges were made from is answered `conflicted` on the body, a device MUST take those edge writes out of the queue unsent.

**Reason:** the server kept another body on the item and wrote this one to a conflicted copy (`queue-and-verdicts.md` 11), so the edges this body asked for are not the item's: a link taken out of the losing body would delete an edge the kept body names.

**Tests:** `device/body-edges-live.test.ts › sends no edge write whose body lost to another device's, and keeps the edge the kept body names`.

### `device/body-name-saved`

When a link or an embed in a body names no item the copy can resolve, a device MUST save the body as typed.

**Reason:** an app has a person's save in its hand whatever the network is doing, so a name waits rather than refusing the save or being dropped.

**Tests:** `device/body-edges-live.test.ts › reports a name it cannot resolve, keeps the body as typed, and resolves it once the item arrives by catch-up`.

### `device/body-name-drain`

When a drain reaches the server, a device MUST resolve the pending names of the bodies it holds and send their edges in that drain.

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`, `› waits offline, and resolves and sends at the drain after reconnecting`.

### `device/body-name-arrives`

When an item that a waiting name names reaches the copy by a catch-up or a hydration, a device MUST make the name's edge by the next drain.

**Tests:** `device/body-edges-live.test.ts › reports a name it cannot resolve, keeps the body as typed, and resolves it once the item arrives by catch-up`, `› resolves a waiting name at the next hydration`.

### `device/body-name-pending`

While a device has not asked the server about a name in a body, a device MUST answer the name `pending` when a caller reads the item's links and embeds.

**Tests:** `device/body-edges-live.test.ts › makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds`, `› makes an embed of an image and of a video, by name and by path, the file's attached-to edge`, `› waits offline, and resolves and sends at the drain after reconnecting`.

### `device/body-name-missing`

When the server's lookup names no item for a name in a body, a device MUST answer the name `missing` and make no edge.

**Tests:** `device/body-edges-live.test.ts › reports a name it cannot resolve, keeps the body as typed, and resolves it once the item arrives by catch-up`, `› resolves a waiting name at the next hydration`.

### `device/body-name-ambiguous`

When the server's lookup names more than one item for a name in a body, a device MUST answer the name `ambiguous` and make no edge.

**Tests:** `device/body-edges-live.test.ts › reports an ambiguous name and makes no edge`.

### `device/body-name-refused`

If the server refuses a body's edge write, then a device MUST answer the link `refused`.

**Tests:** `device/body-edges-live.test.ts › reports a refused edge write against its link, and keeps the body`.

### `device/body-links-read`

When a caller reads an item's links and embeds, a device MUST answer each link and each embed of a file in its body, in the order of the body, with its text as typed, the name it reads and the item it names or the reason it names none.

**Reason:** an app shows a link it can follow and an embedded file it can show or play, and has to show a name that resolves to nothing as unresolved rather than guess. The command reads them with `device items links`.

**Tests:** `device/body-edges-live.test.ts › reads an alias and a heading as the name before them, and a link in code as text`, `› makes an embed of an image and of a video, by name and by path, the file's attached-to edge`.

### `device/body-links-offline`

When a caller reads an item's links and embeds, a device MUST answer from the copy alone.

**Tests:** `device/body-edges-live.test.ts › waits offline, and resolves and sends at the drain after reconnecting`.

### `device/body-link-removed`

When a write takes a link or an embed out of a body, a device MUST queue the delete of the edge the body named through it.

**Reason:** taking a link out removes its edge as in a folder (`folders.md` 31). The body before the write is read against the same edges as the body after it, so a link both carry reads alike in both and is never removed by an edit elsewhere in the body.

**Tests:** `device/body-edges-live.test.ts › takes the edge with a link taken out, and leaves edges of another type and ones no body named`, `› makes an embed of an image and of a video, by name and by path, the file's attached-to edge`, `› agrees with a folder on the same item, and neither repeats the other's edge`.

### `device/body-link-removed-only`

When a write takes a link out of a body, a device MUST NOT delete an edge of another type between the same items, or a `references` edge no body named.

**Reason:** a body makes only `references` and `attached-to`, so any other edge was made by somebody else.

**Tests:** `device/body-edges-live.test.ts › takes the edge with a link taken out, and leaves edges of another type and ones no body named`.

### `device/body-edge-waits`

When a body's change names an edge, a device MUST queue the edge's write to wait on the write that changed the body.

**Reason:** what waits on a refused write is refused with it (`queue-and-verdicts.md` 16), so an edge never lands for a body the server refused.

**Tests:** `device/body-edges-live.test.ts › queues a body's edge to wait on the write that changed the body`.

### `device/body-retype`

When an edit moves an item to another type, a device MUST read the body before the edit from the old type's body property and the body after it from the new type's.

**Reason:** a body that a retype only moves makes no change to the item's edges.

**Tests:** `device/body-edges-live.test.ts › reads a retyped item's body in the property its new type keeps it in`.

### `device/body-older-version`

When an edit based on a version older than the one the copy holds changes an item's body, a device MUST read the body's edges from the row the server answers the edit with, once it answers.

**Reason:** the server merges such an edit (`queue-and-verdicts.md` 43), and the copy cannot tell what the merge makes of the body until it is answered.

**Tests:** `device/body-edges-live.test.ts › reads an edit based on an older version once the server answers it, and sends its edges at the next drain`.

### `device/body-link-renamed`

While the edge a body's link made stands, a device MUST answer the link with the item it named, even after that item is renamed.

**Tests:** `device/body-edges-live.test.ts › takes the edge of a link to an item renamed since, when the link is taken out`.

### `device/body-link-renamed-removed`

When a write takes out of a body a link to an item renamed since its edge was made, a device MUST queue the delete of that edge.

**Tests:** `device/body-edges-live.test.ts › takes the edge of a link to an item renamed since, when the link is taken out`.

### `device/body-name-dropped`

If a body no longer carries a name that waits, whoever changed the body, then a device MUST NOT make the name's edge when an item it names arrives.

**Tests:** `device/body-edges-live.test.ts › stops waiting on a name once another writer takes it out of the body`.

### `device/embed-attached-first`

When an embed's name answers to a file attached to the item and to other file items, a device MUST resolve the embed to the attached file.

**Reason:** an embed is read against the item's attachments first, so an attach's embed text names the file it attached whatever else shares its name.

**Tests:** `device/body-edges-live.test.ts › reads an embed as the file attached to the item before other file items of that name`.

### `device/attach-embed`

When a device attaches a file to an item under a title that names it alone among the item's attachments, a device MUST answer the attach with the text that embeds it, `![[title]]`.

**Reason:** an app attaches a photo and writes its embed into the body, and saving that body reads back as the edge the attach made, not a second edge or a second file item.

**Tests:** `device/body-edges-live.test.ts › embeds an attached file by the text the attach answers, with no second edge`.

### `device/embed-text`

When a caller asks for the text that embeds a file attached to an item, a device MUST answer `![[title]]` where the file's title names it alone among the item's attachments.

**Reason:** an app can write the embed of a file attached earlier. The command asks with `device items embed`.

**Tests:** `device/body-edges-live.test.ts › embeds an attached file by the text the attach answers, with no second edge`.

### `device/embed-text-not-file`

If the item named for an embed text is not a file item, then a device MUST refuse `invalid`.

**Tests:** `device/body-edges-live.test.ts › embeds an attached file by the text the attach answers, with no second edge`.

### `device/embed-text-not-attached`

If the file named for an embed text is not attached to the item named, then a device MUST refuse `invalid`.

**Reason:** an embed is read against the item's attachments first, and only those can be told apart offline.

**Tests:** `device/body-edges-live.test.ts › embeds an attached file by the text the attach answers, with no second edge`.

### `device/attach-title`

When a file is attached to an item under no title its caller gave, a device MUST title the file item with the first of its name, `name 2.ext`, `name 3.ext` that no other attachment of the item answers to.

**Reason:** two attachments of one item under one name would make an embed of either name both, which is the usual case for pasted images, all called `image.png`.

**Tests:** `device/body-edges-live.test.ts › embeds an attached file by the text the attach answers, with no second edge`.

### `device/attach-title-given`

When a file is attached to an item under a title its caller gives, a device MUST title the file item with that title.

**Tests:** `device/body-edges-live.test.ts › keeps a title its caller gives, and answers no embed text where that title is shared`.

### `device/attach-embed-shared`

If a file is attached to an item under a title another of the item's attachments answers to, then a device MUST answer the attach with no embed text.

**Reason:** an embed of a shared title would name both attachments.

**Tests:** `device/body-edges-live.test.ts › keeps a title its caller gives, and answers no embed text where that title is shared`.

## Ids a caller names

### `device/id-format`

When a caller creates an item through a working copy under an id of its own, a device MUST refuse an id that is not a lowercase UUIDv7 `validation` with the code `invalid_id`, before it saves or queues anything.

**Reason:** the server refuses such an id (`items/create-id-format` and `items/get-malformed-id`). A copy that queued one would show a row that can never reach the server, and could not read the row back to put itself right when the create was refused.

**Tests:** `device/local-refusals.test.ts › refuses a create or an edge naming an id the server refuses, before it saves or queues anything`.

### `device/edge-id-format`

When a caller creates an edge through a working copy under an id of its own, a device MUST refuse an id that is not a lowercase UUIDv7 `validation` with the code `invalid_id`, before it saves or queues anything.

**Reason:** the server refuses such an id on `POST /edges` as on `POST /items`.

**Tests:** `device/local-refusals.test.ts › refuses a create or an edge naming an id the server refuses, before it saves or queues anything`.

### `device/read-back-invalid-id`

When the server answers a read-back by id `400 invalid_id`, a device MUST take the answer as the server holding no such row.

**Reason:** an id the server could never have given a row names no row, as plainly as a `404` says so. Read as a failure, the read-back would stay owed, the row the create showed would stay in the copy, and a discard of the create would be refused while the read-back waited.

**Tests:** `device/verdicts.test.ts › refused: takes a read-back answered 400 invalid_id as the server holding no such row`.

## Before a first hydration

### `device/drain-no-cursor`

If a caller drains a working copy that has never completed a hydration, then a device MUST refuse the drain `no_cursor`, sending nothing and leaving the queue as it was.

**Reason:** each answer is read back under the read view a hydration gives the copy (`queue-and-verdicts.md` 12), so a copy without one would send its first write, fail to settle the answer, and fail the same way at every later drain.

**Tests:** `device/save-before-sync-live.test.ts › refuses a drain before its first hydration, sending nothing and keeping the queue`.

### `device/drain-incomplete`

If a caller drains a working copy whose hydration is in progress or was interrupted, then a device MUST refuse the drain `hydration_incomplete`, sending nothing and leaving the queue as it was.

**Tests:** `device/working-copy.test.ts › refuses a local write after an interrupted hydration`.

### `device/drain-expired`

If a caller drains a working copy whose cursor has aged out, then a device MUST refuse the drain `copy_expired`, sending nothing.

**Tests:** `device/working-copy.test.ts › reports complete for a copy whose cursor aged out until a catch-up learns it, asking nothing to report`.

### `device/catalog-served`

Where a working copy names a server, when a caller reads the server's item types or edge types, a device MUST answer the types the server lists, before a first hydration as after it.

**Reason:** a slice of every type the key reads names each namespace under `.*`, and an app learns the namespaces from the catalog before it hydrates.

**Tests:** `device/save-before-sync-live.test.ts › reads the server's catalog before its first hydration, leaving the copy's own as it was`.

### `device/catalog-served-unheld`

When a device reads the server's item types or edge types, a device MUST leave the copy's own catalog, its catalog version and its declared types as they were.

**Reason:** holding the server's catalog would replace the declared types the copy checks saves against while it is offline.

**Tests:** `device/save-before-sync-live.test.ts › reads the server's catalog before its first hydration, leaving the copy's own as it was`.

### `device/catalog-no-server`

Where a working copy names no server, if a caller reads the server's item types or edge types, then a device MUST refuse `no_server`.

**Reason:** an answer from the copy's own catalog would pass the shipped and declared types off as the server's.

**Tests:** `device/save-before-sync.test.ts › refuses a read of the server's catalog with no_server, answering no types from its own`.

## Type names in a local read

### `device/type-grammar`

If a local list or search names a `type` outside the server's type grammar (`types/id-grammar` and `types/id-reserved-scope-root`), then a device MUST refuse it `validation` with the code `validation_error`.

**Reason:** a local read that answered an empty list would say the type holds nothing where the server says the name is no type at all, so a mistyped name would go unnoticed offline and fail only online.

**Tests:** `device/local-refusals.test.ts › refuses a list or a search naming a type outside the server's grammar`.

## The docs site

`marfa docs` reads the public docs site, `https://docs.marfa.so` unless `MARFA_DOCS_URL` names another. The docs site is not a Marfa instance: the command needs no server, working copy or key to read it.

### `device/docs-site`

When `marfa docs` sends a request, the command MUST send it to the address in `MARFA_DOCS_URL` where that holds more than white space, whatever `MARFA_API_URL` holds.

**Reason:** an agent can read the docs before it has a server, a working copy or a key.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `device/docs-paths`

When `marfa docs` reads the docs site, the command MUST read a page from `/<path>.md`, a search from `/api/docs/search` and the list of pages from `/api/docs/topics`.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `device/docs-no-credential`

When `marfa docs` sends a request to the docs site, the command MUST send no credential, whatever `MARFA_API_KEY` holds.

**Reason:** the docs site has no keys, so a credential sent to it would reach a host that never asked for one.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `device/docs-no-contract`

When the docs site answers `marfa docs` naming no contract, the command MUST read the answer.

**Reason:** the docs site names no contract, so the check the command holds a server's answers to would refuse every page.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `device/docs-page-missing`

If the docs site answers `404` for the page `marfa docs` is given, then the command MUST exit 1 with `docs_page_not_found`, naming the path.

**Reason:** a retry does not change a missing page. The message points to `marfa docs search`, where an agent that guessed a path can find the page it meant.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`, `› names the page a docs site does not hold, and the site that answers with a fault`.

### `device/docs-unreachable`

If the docs site cannot be reached, or answers with a server fault or a status the command does not read, then the command MUST exit 3 with `docs_unreachable`, naming the site's address.

**Reason:** a refused connection, a read that timed out and a `5xx` are statements about the environment rather than about the page asked for, and clear without anybody doing anything.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`, `› names the page a docs site does not hold, and the site that answers with a fault`.

### `device/docs-page-names`

When `marfa docs` is given a page by its path, with or without leading and trailing slashes, a leading `docs/`, a trailing `.md`, a query or a fragment, or by the whole `http` or `https` address of the page, the command MUST read the one page at `/<path>.md`.

**Tests:** `device/contract.test.ts › reads one docs page however it is named: with a slash, under docs/, with .md, or by its address`.

### `device/docs-json-refused`

If the docs site answers a success to `marfa docs search` with anything but a JSON object whose `hits` is an array of hits that each carry a `title` and a `url`, or to `marfa docs topics` with anything but a JSON object whose `pages` is an array of pages that each carry a `title` and a `url`, then the command MUST exit 3 with `decoding`, printing nothing to standard output.

**Reason:** an answer the command cannot read is not a refusal and not a lost connection, and printing it would pass a proxy's or a catch-all page's words off as the docs.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs search or topics answer that is not the JSON read, printing none of it`.

### `device/docs-html`

If the docs site answers a page `marfa docs` asked for as `text/html`, then the command MUST exit 3 with `decoding`, printing nothing to standard output.

**Reason:** a site's catch-all page is never the page asked for.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs page served as HTML, printing none of it`.

### `device/docs-too-large`

If the body of a success the docs site answers `marfa docs` with is larger than 10 MiB, which is 10,485,760 bytes, then the command MUST exit 3 with `decoding`, printing nothing to standard output.

**Reason:** a page or the list of pages is far smaller, so a body that large is not what the command asked for, and a retry does not change it. It is not `docs_unreachable`, which says the site may answer next time.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs answer larger than the command reads`.

### `device/docs-not-utf8`

If the body of a success the docs site answers `marfa docs` with is not UTF-8, then the command MUST exit 3 with `decoding`, printing nothing to standard output.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs page that is not UTF-8`.

### `device/docs-redirect-followed`

When the docs site answers a request of `marfa docs` with a redirect that is no more than the fifth in a row, the command MUST follow it.

**Reason:** the docs site may move a page, and the command sends no credential for a redirect to carry to another host. A working copy follows no redirect from a server (`device/redirect-not-followed`).

**Tests:** `device/contract.test.ts › follows up to five redirects in a row from the docs site, and exits 3 with docs_unreachable past that`.

### `device/docs-redirect-loop`

If the docs site answers more than five redirects in a row to one request of `marfa docs`, then the command MUST exit 3 with `docs_unreachable`.

**Reason:** more than five redirects in a row is a loop, which is the site failing.

**Tests:** `device/contract.test.ts › follows up to five redirects in a row from the docs site, and exits 3 with docs_unreachable past that`.

### `device/docs-json-url`

Where `--json` is given, when `marfa docs` reads a page, the command MUST report in `url` the address it asked for, whether or not a redirect led it to another.

**Tests:** `device/contract.test.ts › reports the address a docs page was asked for, not the one a redirect led to`.

### `device/docs-url-key`

If `--url` or `--key` is given to `marfa docs`, then the command MUST exit 2 with `usage` and send no request.

**Reason:** both name a Marfa server and a credential for it, and the docs site takes neither, so a person who gave one would believe it was used.

**Tests:** `device/contract.test.ts › refuses --url and --key on docs with usage, sending nothing`.

### `device/docs-path-refused`

If the page `marfa docs` is given, once leading and trailing slashes, a leading `docs/`, a trailing `.md`, a query and a fragment are taken away, is not one or more segments divided by `/`, each of one or more ASCII letters, digits, `-`, `_`, `.` or `~` and neither `.` nor `..`, then the command MUST exit 1 with `invalid` and send no request.

**Reason:** a path outside that set could leave the docs site's pages or carry another request in its name.

**Tests:** `device/contract.test.ts › refuses a docs page path it does not accept with invalid, sending nothing`.

### `device/docs-site-refused`

If `MARFA_DOCS_URL` holds more than white space and is not an `http` or `https` address with a host and no query or fragment, then the command MUST exit 1 with `invalid` and send no request.

**Tests:** `device/contract.test.ts › refuses a docs address that is not http or https with invalid, sending nothing`.

## Search, matched as the server matches

A local search matches, ranks and excerpts as the server's search does, so a query answers the same rows online and offline. The server's halves are the `search-and-filters` rules of the same names.

### `device/search-stem`

A device MUST reduce every word of the indexed text and of a query to its stem, so that `run` followed by another word matches `running` and `runs` and not `runner`.

**Reason:** a device that matched whole words only would lose a row that the server finds (`search-and-filters/search-stem`).

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-all-words`

When a query is not wholly inside double quotes, a device MUST match only the rows in which every whitespace-separated word of it matches, in any order and in any column.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-last-prefix`

When a query is not wholly inside double quotes, a device MUST match its last word as the start of a word.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-earlier-whole`

When a query is not wholly inside double quotes, a device MUST match every word of it but the last as a whole stem.

**Reason:** a prefix on every word would match `marshland` for `marsh landscape`, which the server does not.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-phrase`

When a query begins and ends with a double quote and holds at least one character between them, a device MUST match the text between them as a phrase, with its words adjacent and in order.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-phrase-whole`

When a query is a phrase, a device MUST match the last word of the phrase as a whole stem and not as a prefix.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-quote-text`

When a double quote in a query is not the first and the last character of a phrase, a device MUST read it as text.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-trim`

When a query has whitespace or byte-order marks around it, a device MUST ignore them.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-syntax-text`

A device MUST read an operator word, a column name before a colon, a star, a leading minus and a double quote inside a word of a query as words to match, and never as search syntax.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/search-no-word`

When a query holds only spaces, a device MUST match nothing.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/index-fields`

While a row is not in the bin, a device MUST match a query against the row's `title`, `body`, `description` and `name` where each is a string, every other string property its type declares or inherits, and its tags.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/index-order`

When a query is a phrase, a device MUST read the string properties of a row beyond the four core ones in the order of their names, and its tags in byte order.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/index-unsearchable`

A device MUST NOT match a property that its type declares as a string with `searchable: false`.

**Reason:** the properties a person marked private stay unmatched.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/index-undeclared`

A device MUST NOT match a property that the row's type does not declare.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/index-type-change`

A device MUST match each row it holds by what the types of its current catalog mark searchable, so a changed catalog that the device takes changes what its rows match.

**Reason:** what a row contributes to the index is decided when it is written, so without this a row would keep answering by the fields its type had.

**Tests:** `device/search-live.test.ts › holds a changed type's searchable fields against rows it already holds`.

### `device/rank-bm25`

A device MUST order hits by BM25 over the `title`, `body`, `description`, `name`, extra properties and tags at equal weight, best first.

**Reason:** BM25 is relative to the rows of the index it ranks in, so a device that holds a slice of the instance scores by that slice: its order equals the server's only where the rows they hold are the same.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/rank-ties`

A device MUST order hits of equal rank by item identifier, ascending.

**Tests:** `device/search-live.test.ts › answers the server's hits, in the server's order: $name: $query`.

### `device/excerpt-words`

When a hit's text matches the query, a device MUST write an excerpt of at most 32 words.

**Tests:** `device/search-live.test.ts › excerpts a match as the server does, from the column that holds it`.

### `device/excerpt-column`

A device MUST draw the excerpt of a hit from the column that matches it best.

**Tests:** `device/search-live.test.ts › excerpts a match as the server does, from the column that holds it`.

### `device/excerpt-mark`

A device MUST wrap each matched word of an excerpt in `<mark>` and `</mark>`.

**Tests:** `device/search-live.test.ts › excerpts a match as the server does, from the column that holds it`.

### `device/excerpt-cut`

When an excerpt cuts the text, a device MUST write `...` where it is cut.

**Tests:** `device/search-live.test.ts › excerpts a match as the server does, from the column that holds it`.

### `device/excerpt-escaped`

A device MUST write an excerpt as HTML in which every `&`, `<`, `>`, `"` and `'` of the row's text is escaped as `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`.

**Reason:** an app shows the excerpt as HTML, and a row's text is never markup for that app to render.

**Tests:** `device/search-live.test.ts › escapes the row's text in an excerpt as the server does`.

### `device/excerpt-markup`

A device MUST NOT put markup in an excerpt other than pairs of `<mark>` and `</mark>`, each pair opened before it closes.

**Tests:** `device/search-live.test.ts › escapes the row's text in an excerpt as the server does`.

## What the real server cannot be made to produce

The device fixtures drive a scripted server where the precondition cannot be arranged over the wire against the real one. `device/fidelity.test.ts` asserts that every scripted answer the real server can also give matches the real one's shape; these are the answers it cannot check.

- **Invalid copy proof.** The real server does not omit or forge its certificate, listing classification or completion marker, so scripted answers exercise fail-closed decoding.
- **A transport failure.** A dropped connection, a refused connection and a read that times out are properties of the network between the device and the server. Nothing the API offers provokes one.
- **A server at rest.** Offline and reconnect need the server to stop answering and start again under a device that is still running. Stopping the suite's own server ends the run.
- **A revoked credential mid-queue.** Revoking the running key would take the rest of the file's fixtures with it, and the refusal is asserted for its effect on the queue rather than for the server's answer, which `keys-and-oauth.md` 13 already covers.
- **A `409 version_conflict` answered to a write that asked the server to resolve.** The server resolves such a write inside its own transaction (`versions/auto-resolved`), so the refusal a device has to classify (`queue-and-verdicts.md` 23) is one the real server does not give for a write it can resolve. A write carrying only `edges` and a stale version is refused rather than resolved, because there is nothing to merge, but that is not a write that asked for resolution.
- **An answer on another contract, or a success naming none.** The run's server names the contract the binary was built for on every answer, and nothing over the wire asks it for another.
- **A `5xx`.** The server answers one for a fault, and a fault it can be made to have is a defect rather than a fixture. Contention on the write lock is the other `5xx` it answers, and that one is the contract rather than a fault: `503 write_contention`, which a device retries without counting it against the row (`errors/contention`). It is provoked from outside this suite, by holding the lock from another process.
- **A `429`.** Rate limiting is off on the run's server, because a run's own key minting would spend the key operations' allowance (`README.md`). The real server does answer one, and `keys-and-oauth.md` 33 asserts it against a server booted with the limiter on.
- **A read answered before an event the copy has since taken.** A follow and a drain on one core race, and an event applied between a read's request and its write leaves the read older than the row the copy holds (`device/server-row-order`). The run's server answers a read with the row as it stands when it is asked, so the scripted server answers with the older row, standing for the read that lost the race.
- **A placement path with a leading separator.** The edge operation refuses one (`edges/folder-path`), so only a path written past it carries one; the fixture serves one to hold the folder to reading it from its root (`folders.md` 30).
- **A `404 item_not_found` naming the bin, and a `403` naming the grant a key lacks.** The server does not yet say either in `details`; the device reads both where they come (`queue-and-verdicts.md` 48), and the fixtures script the shapes the server will answer.
- **An aged-out cursor.** A cursor is too old only when the event after it has been retired (`events/catchup-too-old`), and an event is retired only once it is older than the retention, an hour at the shortest: a request can run the sweep but cannot age an event, so the terminal `catchup_too_old` frame cannot be provoked against the run's server. The frame's shape is held by the server's own test, which retires a row directly.
- **Another instance at the copy's origin.** The run has one server, and a device cannot be put in front of a second at its address while it runs. A server restored behind the copy is reachable: the `cursor_ahead` frame a cursor past the head gets is held against the real server's (`device/fidelity.test.ts`).
- **A create queued under an id the server cannot hold.** A device refuses such an id before it queues it (`device/id-format`), so only a store an earlier build made carries one. `device/verdicts.test.ts` scripts the refusal and the read-back that follow it (`device/read-back-invalid-id`).
- **An ordinary unkeyed create refused `ancestor_unavailable`.** The server gives this refusal to a conditional natural-key create, whose receipt is terminal. The scripted refusal of an ordinary create exercises the generic classifier and the withdrawal of the writes held for it, without claiming that the server gives that combination: `device/classification.test.ts › refuses unsent the writes held for a withdrawn create, and never releases them`, `› clears with the answered rows those only a withdrawn write was keeping, but for one carrying content`.
