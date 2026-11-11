# Events

`GET /events` is a server-sent event stream of the writes to items and edges, resumable by cursor, and outbound webhooks deliver those events to a URL, except the writes `items/bulk-fanout` holds back. The audit log, which records the writes the events announce, closes the chapter.

Every rule about a stream is about the plain stream unless it says otherwise. The copy stream, `GET /events?edges=all&copy=1`, is `reach/copy-bootstrap` and the rules after it in `reach.md`. What a stream does when the server stops is `instance/stop-ends-streams` and the rules after it. The answer to a viewer past the instance's cap is `errors/stream-capacity`.

## Event types

Every event and stream frame the server sends is a row of the table below, which is written from the server's own event names and so cannot differ from them. An event is also the `event:` of its frame. A row names the statements that hold a write to its event. Writes that announce nothing include those of `events/settings-silent`, `connectors/agreements-silent-live` and `inbound-webhooks/receipt-no-event`.

<!-- event-types-table:start -->

| Event                | Sent to              | When it is sent                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item.created`       | Streams and webhooks | A write creates an item (`events/create-announced`).                                                                                                                                                                                                                                                             |
| `item.updated`       | Streams and webhooks | A write to an item, however little it changes (`events/update-announced`, `events/update-edges-only-announced`, `housekeeping/enrichment-announced`, `types/move-announced`, `items/folder-announced`, `views/announced`).                                                                                       |
| `item.deleted`       | Streams and webhooks | An item moves to the bin (`items/delete-announced`, `items/trash-cascade-announced`, `events/owner-trash-announced`, `housekeeping/feed-expiry-announced`), or a cascade revokes a `system.*` item (`events/cascade-revoke-announced`).                                                                          |
| `item.restored`      | Streams and webhooks | An item in the bin is restored (`items/restore-announced`, `events/owner-trash-announced`).                                                                                                                                                                                                                      |
| `item.purged`        | Streams and webhooks | An item is destroyed (`items/purge-announced`, `events/owner-trash-announced`, `events/sweep-purge-announced`, `views/delete-announced`).                                                                                                                                                                        |
| `item.state_changed` | Streams and webhooks | A transition moves the item it names to another state, into and out of the bin included (`items/transition-announced`, `events/job-announced`), or a key revokes a folder (`items/folder-announced`). A delete and a restore do not send it (`events/delete-no-state-change`, `events/restore-no-state-change`). |
| `metadata.changed`   | Streams and webhooks | A tag operation commits for an item, whether or not it changes the tags (`items/tag-announced`), or an extension namespace is written or deleted (`items/extension-announced`).                                                                                                                                  |
| `rows.changed`       | Streams and webhooks | A batch changes the rows of one table of an item (`tables/rows-event`), on a copy stream too (`tables/rows-event-copy-sent`).                                                                                                                                                                                    |
| `edge.created`       | Streams and webhooks | An edge is created (`edges/create-announced`, `events/edge-bulk-announced`, `events/edge-inline-announced`, `versions/copy-edges-announced`).                                                                                                                                                                    |
| `edge.updated`       | Streams and webhooks | An edge is written: its properties, or one of its ends moving to another item (`edges/update-announced`, `edges/move-announced`, `events/edge-bulk-announced`).                                                                                                                                                  |
| `edge.deleted`       | Streams and webhooks | An edge is deleted (`edges/delete-announced`, `events/edge-inline-announced`, `items/purge-edges`, `events/sweep-purge-edges`).                                                                                                                                                                                  |
| `stream_cursor`      | Streams              | First, when the stream read the log as it opened: where the log stood then.                                                                                                                                                                                                                                      |
| `stream_live`        | Streams              | Once the catch-up is over: everything up to its cursor has been sent or withheld, and what follows is live.                                                                                                                                                                                                      |
| `stream_incomplete`  | Streams              | Last, when the stream can no longer deliver what it opened with.                                                                                                                                                                                                                                                 |
| `catchup_too_old`    | Streams              | Last, when the log no longer holds the events after the `Last-Event-ID` the client sent.                                                                                                                                                                                                                         |
| `cursor_ahead`       | Streams              | Last, when the `Last-Event-ID` the client sent is past the latest event in the log.                                                                                                                                                                                                                              |
| `reach_changed`      | Streams              | Last on a copy stream, when its reach changes.                                                                                                                                                                                                                                                                   |

<!-- event-types-table:end -->

## Opening a stream

### `events/stream-opens`

When a credential that reads at least one type sends `GET /events`, the server MUST answer `200` with `Content-Type` `text/event-stream`.

**Tests:** `compliance/events-contract.test.ts › opens with a stream_cursor frame naming the log head`.

### `events/stream-unauthenticated`

If `GET /events` carries no credential, or a bearer value no credential holds, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/events-contract.test.ts › answers 401 to a request with no usable credential, ahead of every fault in the request`, `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `compliance/events-contract.test.ts › refuses a subscription with no credential`.

### `events/stream-reads-no-type`

If a credential whose type map reaches no type sends `GET /events`, then the server MUST answer `403 type_not_permitted`.

**Reason:** a stream such a credential opened would never carry an event.

**Tests:** `compliance/events-contract.test.ts › answers 403 type_not_permitted to a credential that reads no type, ahead of every fault in the request`.

### `events/stream-undeclared-key`

If `GET /events` names a query key the operation does not declare and that does not start with an underscore, then the server MUST answer `400 validation_error` with the key in `details.unknown_parameters`.

**Reason:** a misspelled `type` would otherwise open a stream of every type.

**Tests:** `compliance/events-contract.test.ts › names an undeclared query key ahead of the type, the edges and the cursor`, `compliance/declared-refusals.test.ts › names a misspelled key on the event stream rather than opening it unfiltered`.

### `events/stream-refusal-order`

When one `GET /events` request meets more than one refusal, the server MUST answer the first of these: no usable credential, `401`; a credential whose type map reaches no type, `403`; `X-Marfa-Reach`, `400`; a query key the operation does not declare and that does not start with an underscore, `400`; `type`, `400` or `403`; `edges`, `400`; `Last-Event-ID`, `400`; and a viewer past the instance's cap, `503`.

**Reason:** a caller is told of a fault it can fix before it is told to wait.

**Tests:** `compliance/events-contract.test.ts › answers 401 to a request with no usable credential, ahead of every fault in the request`, `› answers 403 type_not_permitted to a credential that reads no type, ahead of every fault in the request`, `› names an undeclared query key ahead of the type, the edges and the cursor`, `› reads the type, then the edges, then the cursor, and names the first fault it meets`, `compliance/stream-capacity.test.ts › answers the fault in a request ahead of 503, so a viewer past the cap learns of a fault it can fix`.

### `events/writes-while-open`

While an event stream is open, the server MUST accept writes.

**Tests:** `compliance/edge-events.test.ts › accepts writes while an event stream is open`.

## What a stream sends first

A stream opens with `stream_cursor`, replays the events after the cursor a client resumed from, and marks the end of the replay with `stream_live`.

### `events/stream-cursor-first`

When the server opens a stream having read the log's head, the server MUST send `stream_cursor` as the first typed frame, with `event_type` `stream_cursor`.

**Tests:** `compliance/events-contract.test.ts › opens with a stream_cursor frame naming the log head`.

### `events/stream-cursor-no-id`

The server MUST send `stream_cursor` without an `id:` line.

**Reason:** a client that resumes from the last `id:` it received never resumes from a frame that is not an event.

**Tests:** `compliance/events-contract.test.ts › opens with a stream_cursor frame naming the log head`.

### `events/stream-cursor-head`

The server MUST give the `cursor` of `stream_cursor` as the id, in decimal, of the last event the log holds.

**Tests:** `compliance/events-contract.test.ts › opens with a stream_cursor frame naming the log head`.

### `events/stream-cursor-empty-log`

While the log holds no event, the server MUST give the `cursor` of `stream_cursor` as `"0"`.

**Tests:** `sync/stream-contract.test.ts › announces cursor 0 on a log that holds no event`.

### `events/stream-cursor-resumable`

When a client resumes from the `cursor` of `stream_cursor`, the server MUST send every event written after the announcement and none written before it.

**Tests:** `sync/stream-contract.test.ts › announces a cursor a client can resume from`.

### `events/stream-live-after-replay`

When a stream has sent the replay, the server MUST send `stream_live` before any frame after it.

**Reason:** `stream_live` is how a client learns it has caught up, and a frame the filter or the credential withheld means the last frame it was sent may be well behind the head.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-no-id`

The server MUST send `stream_live` without an `id:` line.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-cursor`

The server MUST give the `cursor` of `stream_live` as a string at or past the head it announced.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-skips-covered`

When a client resumes from the `cursor` of `stream_live`, the server MUST NOT send it what the replay covered, the events the filter or the credential withheld included.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-resumes-later`

When a client resumes from the `cursor` of `stream_live`, the server MUST send it every event written after the marker.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

## Cursors

A cursor is the id of the last event a client applied. A stream resumes after it.

### `events/resume-replays-after`

When `Last-Event-ID` names a cursor whose next event the log still holds, the server MUST replay every retained event after it, and not the event at the cursor.

**Tests:** `sync/replay.test.ts › carries a bulk write, so a catch-up after an import is complete`, `sync/resume.test.ts › a reader that closes at the head and resumes from its last id misses nothing and repeats nothing`, `compliance/catchup-too-old.test.ts › answers 200 and a terminal catchup_too_old frame naming the oldest retained id and the cursor, and delivers a cursor still in the log`.

### `events/cursor-malformed`

If `Last-Event-ID` is not a decimal number written without a sign, spaces, leading zeros or another base, or is larger than `9223372036854775807`, then the server MUST answer `400 validation_error`.

**Reason:** a cursor the log never issued, read as no cursor, would replay nothing and hide the client's mistake.

**Tests:** `compliance/events-contract.test.ts › refuses a cursor that is not a decimal event id`, `› reads an empty Last-Event-ID as no cursor, and refuses one with an embedded space, twenty digits or an exponent`.

### `events/cursor-malformed-path`

If `Last-Event-ID` is refused as malformed, then the server MUST name `Last-Event-ID` in `details.errors[].path`.

**Tests:** `compliance/events-contract.test.ts › refuses a cursor that is not a decimal event id`, `› reads an empty Last-Event-ID as no cursor, and refuses one with an embedded space, twenty digits or an exponent`.

### `events/cursor-empty`

When `Last-Event-ID` is empty, the server MUST treat the request as one with no cursor.

**Reason:** an SSE client that holds no id sends the header empty.

**Tests:** `compliance/events-contract.test.ts › reads an empty Last-Event-ID as no cursor, and refuses one with an embedded space, twenty digits or an exponent`.

### `events/cursor-zero`

When `Last-Event-ID` is `0` and the log's first event is `1`, the server MUST replay from the first event rather than refuse the cursor.

**Reason:** a cursor names the last event applied and not the first one wanted, and `0` is the cursor of every device that hydrated an instance with an empty log.

**Tests:** `compliance/catchup-too-old.test.ts › replays from a cursor of zero when the log begins at one`.

### `events/cursor-ahead`

When `Last-Event-ID` names a cursor past the log's head, the server MUST answer `200` with a terminal `cursor_ahead` frame carrying `requested` and `head`.

**Reason:** a cursor past the head is one the log never issued, which a client holds after the instance is restored behind it, and replaying from it would skip every new event up to its number. The client reads its state again from the API.

**Tests:** `compliance/events-contract.test.ts › refuses a cursor past the log's head with a terminal cursor_ahead frame`.

### `events/cursor-ahead-no-id`

The server MUST send `cursor_ahead` without an `id:` line.

**Reason:** a client that does not read the frame, such as a browser `EventSource`, reconnects with the last `id:` it received, and an `id:` on this frame would become the cursor it resumes from.

**Tests:** `compliance/events-contract.test.ts › refuses a cursor past the log's head with a terminal cursor_ahead frame`.

### `events/cursor-ahead-closes`

When the server has sent `cursor_ahead`, the server MUST close the stream.

**Tests:** `compliance/events-contract.test.ts › refuses a cursor past the log's head with a terminal cursor_ahead frame`.

### `events/cursor-ahead-no-live`

When the server ends a stream with `cursor_ahead`, the server MUST NOT send `stream_live`.

**Tests:** `compliance/events-contract.test.ts › refuses a cursor past the log's head with a terminal cursor_ahead frame`.

### `events/catchup-too-old`

If the oldest event the log retains has an id greater than the cursor plus one, then the server MUST answer `200` with a terminal `catchup_too_old` frame carrying `min_retained_id` and `requested`.

**Reason:** the event after the cursor is gone, so a replay would leave a gap the client could not see. The client reads its state again from the API.

**Tests:** `compliance/catchup-too-old.test.ts › answers 200 and a terminal catchup_too_old frame naming the oldest retained id and the cursor, and delivers a cursor still in the log`.

### `events/catchup-too-old-no-id`

The server MUST send `catchup_too_old` without an `id:` line.

**Reason:** the same as `events/cursor-ahead-no-id`: an `id:` would carry a reconnect past the gap, and the client would never be told to read its state again.

**Tests:** `compliance/catchup-too-old.test.ts › answers 200 and a terminal catchup_too_old frame naming the oldest retained id and the cursor, and delivers a cursor still in the log`.

### `events/catchup-too-old-closes`

When the server has sent `catchup_too_old`, the server MUST close the stream.

**Tests:** `compliance/catchup-too-old.test.ts › answers 200 and a terminal catchup_too_old frame naming the oldest retained id and the cursor, and delivers a cursor still in the log`.

### `events/catchup-too-old-no-live`

When the server ends a stream with `catchup_too_old`, the server MUST NOT send `stream_live`.

**Tests:** `compliance/catchup-too-old.test.ts › answers 200 and a terminal catchup_too_old frame naming the oldest retained id and the cursor, and delivers a cursor still in the log`.

### `events/catchup-boundary`

When the oldest event the log retains has an id exactly one above the cursor, the server MUST replay from that event rather than refuse the cursor.

**Tests:** `compliance/catchup-too-old.test.ts › answers 200 and a terminal catchup_too_old frame naming the oldest retained id and the cursor, and delivers a cursor still in the log`.

### `events/catchup-sweep-overtakes`

If the retention sweep retires the next events of a replay while it reads, then the server MUST end the stream with `catchup_too_old` rather than replay over the gap.

**Tests:** `compliance/stream-prologue-holds.test.ts › ends with catchup_too_old instead of replaying over the gap`.

### `events/retention-prefix`

When the server retires events from the log, the server MUST retire an event only together with every event before it.

**Reason:** a hole in the middle of the log would let a cursor look valid while the events after it were gone.

**Tests:** `compliance/event-retention.test.ts › retires the oldest events together, keeping every event from the oldest one within the window`, `› never leaves a hole: an event past the window that stands above one within it is kept`.

### `events/retention-keeps-newest`

The server MUST NOT retire the newest event the log holds.

**Reason:** the oldest retained id is then always there for a reader to check a cursor against.

**Tests:** `compliance/event-retention.test.ts › keeps the newest event however old it is`.

## Order and exactly once

### `events/ids-ascending`

The server MUST send the event frames of one stream in ascending id order, edge frames among item frames.

**Tests:** `sync/resume.test.ts › a reader that closes at the head and resumes from its last id misses nothing and repeats nothing`, `› a purge's edge.deleted frames carry lower ids than its item.purged frame, live and replayed`.

### `events/purge-edges-before-item`

When a purge announces the edges it took and the item, the server MUST give each `edge.deleted` a lower id than the `item.purged`, on the live stream and on a replay.

**Reason:** a purge announces the item's edges before the item.

**Tests:** `sync/resume.test.ts › a purge's edge.deleted frames carry lower ids than its item.purged frame, live and replayed`.

### `events/resume-exactly-once`

When a client closes a stream and resumes from the last id it received, the server MUST send every event after that id exactly once.

**Tests:** `sync/resume.test.ts › a reader that closes at the head and resumes from its last id misses nothing and repeats nothing`.

### `events/restart-keeps-ids`

When the server restarts, the server MUST keep the id of every event it announced.

**Reason:** a cursor is a sound resume point across a deploy or a crash only if the same event keeps the same id.

**Tests:** `sync/restart-resume.test.ts › keeps the id of every event it announced, and numbers the next write after the last`.

### `events/restart-numbers-after`

When the server restarts, the server MUST give the first write after it an id above the last event announced before it.

**Tests:** `sync/restart-resume.test.ts › keeps the id of every event it announced, and numbers the next write after the last`.

### `events/restart-resume-once`

When a client resumes after a restart from the last id it received before it, the server MUST send each later event exactly once and none at or below that id.

**Tests:** `sync/restart-resume.test.ts › delivers nothing twice to a stream that resumes from the last id it received before the restart`.

### `events/live-no-repeat`

The server MUST NOT send a stream an event at or below an id it has already sent it.

**Reason:** a client keeps the last id it applied as its cursor, so an event sent again at or below it would be applied twice or out of order.

**Tests:** `compliance/stream-prologue-holds.test.ts › sends an event written while the replay waited once, and none at or below an id it has sent`, `› does not send an event a stream opened between the commit and the next write again`.

### `events/unreadable-row-not-replayed`

If a stream reaches an event in the log that the server can no longer read, then the server MUST end the stream with a terminal `catchup_too_old` frame in place of that event and of every event after it.

**Reason:** the event is gone from the stream's point of view, so sending what follows it would leave a gap the client could not see, which is what `events/catchup-too-old` refuses. The log is the only carrier of an event, so the client reads its state again from the API.

**Tests:** `compliance/stream-unreadable-rows.test.ts › ends with catchup_too_old at an event it cannot read, and does not send it`.

### `events/unreadable-row-too-old-fields`

When the server ends a stream with `catchup_too_old` because the stream reached an event it cannot read, the server MUST give `min_retained_id` the id of the oldest event the log holds and `requested` the `Last-Event-ID` the client sent, or the log's head when the stream opened with none.

**Reason:** the fields say what is true of the log and of the request, so a client that reads them is not told that the log lost events it still holds. The event that cannot be read is in the log's retained range, so `min_retained_id` may be at or below `requested` plus one, and the client still reads its state again.

**Tests:** `compliance/stream-unreadable-rows.test.ts › ends with catchup_too_old at an event it cannot read, and does not send it`.

## Filters

### `events/type-subtree`

When `type` names a type, the server MUST send, live and on a replay, only the events whose item is of that type or a subtype of it.

**Tests:** `sync/replay.test.ts › resolves a type filter through the same subtree the live stream does`, `› delivers a subtype's events live to a stream filtered by its parent type, and withholds an unrelated type`.

### `events/type-wildcard`

When `type` is a pattern such as `core.*`, the server MUST send the events of the types it matches that the credential may read and withhold the rest.

**Tests:** `compliance/unreadable-type-filter.test.ts › GET /events streams the readable types a wildcard matches and withholds the rest`.

### `events/type-wildcard-none-read`

When `type` is a pattern that matches no type the credential reads, the server MUST open the stream.

**Reason:** the credential may read nothing under it yet, so the stream is empty and not refused.

**Tests:** `compliance/unreadable-type-filter.test.ts › a wildcard over types the key reads none of is an empty page, not a refusal`.

### `events/type-list-union`

When `type` is a comma-separated list, the server MUST send the events of every entry's type and subtypes and of no other type.

**Tests:** `sync/replay.test.ts › takes a list of types as their union, up to ten entries and not eleven`.

### `events/type-list-ten`

When `type` holds at most ten entries, blank entries not counted, the server MUST NOT refuse it for the number of entries.

**Tests:** `sync/replay.test.ts › takes a list of types as their union, up to ten entries and not eleven`.

### `events/type-list-eleven`

If `type` holds more than ten entries, blank entries not counted, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`, `sync/replay.test.ts › takes a list of types as their union, up to ten entries and not eleven`.

### `events/type-wildcard-refused`

If a `type` entry is `*`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`.

### `events/type-grammar-refused`

If a `type` entry is outside the type identifier grammar, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`.

### `events/type-refusal-path`

If a `type` entry is refused with `400 validation_error`, then the server MUST name `type` in `details.errors[].path`.

**Tests:** `compliance/events-contract.test.ts › reads the type, then the edges, then the cursor, and names the first fault it meets`.

### `events/type-unknown`

If a `type` entry is a concrete identifier no type registers, then the server MUST answer `400 unknown_type`.

**Tests:** `compliance/events-contract.test.ts › answers 400 unknown_type to a type nothing registers and 403 type_not_permitted to one the key may not read, taking the entries of a list in order`, `compliance/unreadable-type-filter.test.ts › GET /events holds each entry of a list to the rule`.

### `events/type-unreadable`

If a `type` entry is a registered type the credential may not read and reads no subtype of, then the server MUST answer `403 type_not_permitted`.

**Tests:** `compliance/events-contract.test.ts › answers 400 unknown_type to a type nothing registers and 403 type_not_permitted to one the key may not read, taking the entries of a list in order`, `compliance/unreadable-type-filter.test.ts › GET /events holds each entry of a list to the rule`.

### `events/type-entry-order`

When more than one `type` entry is refused, the server MUST answer for the first in the list.

**Tests:** `compliance/events-contract.test.ts › answers 400 unknown_type to a type nothing registers and 403 type_not_permitted to one the key may not read, taking the entries of a list in order`.

### `events/edges-none`

When `edges` is `none`, the server MUST withhold edge events and still send item events.

**Tests:** `compliance/events-contract.test.ts › withholds edge events under edges=none and announces them under edges=all`.

### `events/edges-all`

When `edges` is `all`, the server MUST send edge events the credential may read.

**Tests:** `compliance/events-contract.test.ts › withholds edge events under edges=none and announces them under edges=all`.

### `events/edges-default`

When `GET /events` names no `edges`, the server MUST send edge events the credential may read.

**Tests:** `compliance/edge-events.test.ts › SSE delivers edge.created and edge.deleted`.

### `events/edges-invalid`

If `edges` is neither `all` nor `none`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`.

### `events/edges-ignore-type`

While `type` is set and `edges` is not `none`, the server MUST send every edge event the credential may read, whatever the types of the edge's ends.

**Reason:** `type` selects item frames; an edge is selected by `edges` and by what the credential may read.

**Tests:** `sync/stream-contract.test.ts › delivers edge events to a stream filtered by item type`, `› sends an edge event under a type filter whatever the types of its ends`.

## What an event frame carries

The cascade marks `trashed_by_cascade`, `trashed_with`, `restored_with` and `purged_with` are stated with the operations that set them, `items/cascade-mark` and the rules after it, `items/restored-with` and `items/purge-edges`.

### `events/item-events`

The server MUST send an item event as `item.created`, `item.updated`, `item.deleted`, `item.restored`, `item.purged` or `item.state_changed`, with `event_type` naming it and `item` holding the item.

**Tests:** `sync/identity.test.ts › keeps the id a client mints for an item, on the item and on the event`, `sync/post-commit.test.ts › a write that rolls back announces nothing, while one that commits does`, `compliance/cascade-marks.test.ts › marks an item a cascade trashed with the item named, and no item trashed on its own`, `compliance/events-contract.test.ts › announces item.restored when a trashed item comes back`, `› announces item.state_changed on a lifecycle transition`, `sync/deletions.test.ts › announces a purge, so a client offline across it learns the item is gone`, `compliance/events-contract.test.ts › names the event in event_type on an item frame and on an edge frame`.

### `events/item-frame-metadata`

The server MUST carry on every item event `metadata`, holding the item's tags and the extension namespaces the subscriber may read, as the item held them after the write, or before the purge for `item.purged`.

**Reason:** a working copy holds the tags of an item an event brings in from the frame (`device/catch-up-entering-tags`), and reads the item only when the frame carries none (`device/catch-up-entering-read-tags`), so a frame without them leaves an item created with tags in the copy with none.

**Tests:** `compliance/event-frame-metadata.test.ts › carries on every item event the tags and extensions the write left, only the namespaces the subscriber may read, on a live stream`, `› carries the same metadata on an event a stream replays`.

### `events/deleted-trashed-at`

When the server sends `item.deleted`, the server MUST set the `trashed_at` of the frame's `item` to the time the move to the bin recorded on that item, for the item a delete or a transition named and for each item a cascade took with it.

**Reason:** a working copy keeps the frame's item (`device/bin-held-event`), and orders its bin by that item's `trashed_at` (`device/bin-local-order`). A frame still holding the item as it was before the move says `null`, so a copy that heard another client bin an item could not place it in the bin.

**Tests:** `compliance/cascade-marks.test.ts › holds the time the listing answers, for the item named and the item a cascade took, by DELETE and by transition`.

### `events/metadata-event`

When a tag write or an extension write commits, the server MUST send `metadata.changed` carrying `item` and `metadata`, whatever the extension's namespace.

**Tests:** `compliance/events-contract.test.ts › announces metadata.changed on a tag write`, `› announces metadata.changed on an extension write under any namespace`.

### `events/metadata-namespaces`

When the server sends a frame carrying `metadata`, the server MUST include only the extension namespaces the subscriber may read.

**Reason:** `keys-and-oauth/extension-map-only` gates every operation that answers extension data.

**Tests:** `compliance/events-contract.test.ts › carries on a metadata.changed frame only the extension namespaces the subscriber may read`.

### `events/replay-same-frame`

When a stream replays an event, the server MUST give the subscriber the frame the live stream gave that subscriber, the marks it names included.

**Reason:** the log stores each frame once and answers every subscriber from it when it is sent, so a catch-up discloses nothing a live stream would not.

**Tests:** `compliance/cascade-marks.test.ts › names the item trashed only to a key that may read its type, and says a cascade took the item to any key that reads it`, `› names the item restored only to a key that may read its type`.

### `events/edge-events`

The server MUST send an edge event as `edge.created`, `edge.updated` or `edge.deleted`, with `event_type` naming it and `edge` holding the edge.

**Tests:** `compliance/edge-events.test.ts › SSE delivers edge.created and edge.deleted`, `compliance/events-contract.test.ts › announces edge.updated when an edge's properties change`, `› names the event in event_type on an item frame and on an edge frame`.

### `events/edge-source-type`

The server MUST carry on an edge event `source_type`, the type its source item had when the event was published.

**Reason:** `source_type` decides who is told about the event, and a purge takes the source item before the event is read.

**Tests:** `compliance/edge-events.test.ts › carries the source item's type on every edge frame`.

### `events/purged-with-only-purge`

The server MUST NOT carry `purged_with` on an `edge.deleted` for an edge deleted other than by a purge.

**Tests:** `compliance/cascade-marks.test.ts › names the purged item on each edge its purge took, and on no edge deleted by its own door`.

### `events/job-announced`

When a bulk action transitions an item, the server MUST send `item.state_changed` for it, to a live stream and on a replay.

**Tests:** `sync/replay.test.ts › announces what a bulk-action job changes to a live stream and to a replay`, `compliance/events-contract.test.ts › announces a transition as item.state_changed, single or by bulk action, with item.deleted or item.restored when it crosses the bin`.

## Writes and their events

What a refused write leaves is `items/refusal-writes-nothing`.

### `events/commit-announces`

When a write commits, the server MUST send its event to the streams open at the time.

**Tests:** `sync/post-commit.test.ts › a write that rolls back announces nothing, while one that commits does`.

### `events/rollback-silent`

If a write rolls back, then the server MUST NOT send an event for it to any stream.

**Reason:** an event for a write that never happened tells a client about an item that does not exist.

**Tests:** `sync/post-commit.test.ts › a write that rolls back announces nothing, while one that commits does`.

### `events/rollback-not-logged`

If a write rolls back, then the server MUST NOT log an event for it, so a replay from before it carries none.

**Tests:** `sync/post-commit.test.ts › a write that rolls back leaves no event in the log, so a replay from before it carries none`.

### `events/contention-no-event`

If the server refuses a write with `503 write_contention`, then the server MUST NOT send or log an event for it.

**Reason:** a `5xx` tells the caller nothing was written, so it sends the write again, and an event for the refused write would announce a change that then happens twice.

**Tests:** `compliance/write-contention.test.ts › announces nothing and keeps no item for a write it refused with 503, on the stream open at the time and on a replay`.

### `events/committed-not-failed`

If a change has committed, then the server MUST NOT answer it with a `5xx` status.

**Reason:** a `5xx` tells the caller nothing was written, so it sends the change again. No idempotency key catches it, because an operation that takes one releases it on a `5xx` and the bulk operations take none.

**Tests:** `compliance/write-faults.test.ts › is never answered with a 5xx: a single write whose commit answer is lost answers 201 and is stored once`, `compliance/write-faults.test.ts › is never answered with a 5xx: a page entry whose commit answer is lost is reported created, and the page answers 200`, `compliance/write-faults.test.ts › is never answered with a 5xx: an edge entry whose commit answer is lost is reported created`, `compliance/write-faults.test.ts › is never answered with a 5xx: an atomic page whose commit answer is lost answers 200 and is stored once`.

### `events/sweep-purge-announced`

When a retention job purges an item, the server MUST send `item.purged` for it.

**Reason:** the log's retention and the bin's are set independently, and a device resuming from a cursor inside the log's retention would otherwise keep an item the instance has dropped.

**Tests:** `compliance/event-retention.test.ts › announces item.purged for an item the retention job purges`.

### `events/sweep-purge-edges`

When a retention job purges an item, the server MUST send `edge.deleted` for each edge the item had, with `purged_with` naming the item.

**Tests:** `compliance/event-retention.test.ts › announces edge.deleted for each edge of an item the retention job purges, naming the item`.

### `events/keyed-repeat-silent`

When a request repeats under an `Idempotency-Key` the server kept the answer for, the server MUST NOT send a second event for it, on the create, update, edge create and delete operations.

**Tests:** `sync/idempotency.test.ts › announces nothing for a repeated request under a key, on the create, update, edge create and delete doors`.

### `events/create-announced`

When a write creates an item, the server MUST announce `item.created` for it.

**Tests:** `compliance/events-contract.test.ts › announces item.created for an item POST /items or a POST /items/bulk entry creates`.

### `events/update-announced`

When `PATCH /items/{id}`, a `POST /items` that lands on an item by its natural key, a `POST /items/bulk` entry that lands on an item, or a bulk `update_properties` or `update_occurred_at` action writes an item, the server MUST announce `item.updated` for it, however little the write changes.

**Reason:** a write that changes nothing still ends in a frame, so a client sees the item as the write left it.

**Tests:** `compliance/events-contract.test.ts › announces item.updated once for each write to an item, however little it changes`.

### `events/update-edges-only-announced`

When `PATCH /items/{id}` carries only `edges`, the server MUST announce `item.updated` for the item, carrying the version the item held before the write (`versions/update-edges-only`).

**Tests:** `compliance/events-contract.test.ts › announces item.updated at the version it held for a PATCH that carries only edges`.

### `events/delete-no-state-change`

When `DELETE /items/{id}`, `POST /items/trash` or `POST /items/summaries/{id}/trash` moves an item into the bin, the server MUST NOT announce `item.state_changed` for it.

**Tests:** `compliance/events-contract.test.ts › announces a delete only as item.deleted and a restore only as item.restored`, `compliance/owner-trash.test.ts › announces the owner's trash, restore, purge and emptying of the bin as the item events, and nothing else`.

### `events/restore-no-state-change`

When `POST /items/{id}/restore` or `POST /items/summaries/{id}/restore` brings an item back, the server MUST NOT announce `item.state_changed` for it.

**Tests:** `compliance/events-contract.test.ts › announces a delete only as item.deleted and a restore only as item.restored`, `compliance/owner-trash.test.ts › announces the owner's trash, restore, purge and emptying of the bin as the item events, and nothing else`.

### `events/owner-trash-announced`

When `POST /items/summaries/{id}/trash`, `POST /items/summaries/{id}/restore`, `POST /items/summaries/{id}/purge` or `POST /trash/empty` moves or purges an item, the server MUST announce `item.deleted`, `item.restored` or `item.purged` for it.

**Tests:** `compliance/owner-trash.test.ts › announces the owner's trash, restore, purge and emptying of the bin as the item events, and nothing else`.

### `events/cascade-revoke-announced`

When a cascade moves a `system.*` item to `revoked`, the server MUST announce `item.deleted` for it, with `state` `revoked`.

**Tests:** `compliance/cascade-marks.test.ts › marks no item a cascade revokes rather than trashes`.

### `events/edge-bulk-announced`

When a `POST /edges/bulk` entry creates an edge or writes the edge that holds its triple, the server MUST announce `edge.created` or `edge.updated` for it, however little the write changes.

**Tests:** `compliance/events-contract.test.ts › announces each edge a POST /edges/bulk entry creates or writes, however little it changes`.

### `events/edge-inline-announced`

When the `edges` of `POST /items`, `POST /items/bulk` or `PATCH /items/{id}` create or remove an edge, the server MUST announce `edge.created` or `edge.deleted` for it.

**Tests:** `compliance/events-contract.test.ts › announces each edge the edges of an item write create or remove`, `› announces each edge the edges of a POST /items/bulk entry create or remove`.

### `events/settings-silent`

When a write changes a type, an edge type, a key, the instance's configuration or a webhook subscription, the server MUST NOT send an event for it.

**Reason:** every event names an item or an edge.

**Tests:** `compliance/events-silent-writes.test.ts › sends nothing for a write to a type, an edge type, a key, the configuration or a webhook, and sends the item write after them`.

## Edge events and who is told

An edge event is held to the two permissions `GET /edges/{id}` asks for, `edges/read-id-kind` and `edges/read-id-source`.

### `events/edge-frame-kind`

The server MUST withhold an edge event from a subscriber that may not read the edge's type.

**Tests:** `compliance/edge-events.test.ts › withholds a live edge frame the credential could not read singly`, `› withholds the same frames on a replay from a cursor`.

### `events/edge-frame-source`

The server MUST withhold an edge event from a subscriber that may not read the type the edge's source item had when the event was published.

**Tests:** `compliance/edge-events.test.ts › withholds a live edge frame the credential could not read singly`, `› withholds the same frames on a replay from a cursor`.

### `events/edge-frame-stays-open`

When the server withholds an edge event from a subscriber, the server MUST keep the stream open.

**Tests:** `compliance/edge-events.test.ts › withholds a live edge frame the credential could not read singly`.

### `events/edge-frame-replay`

When a stream replays from a cursor, the server MUST withhold the edge events it withheld on the live stream.

**Tests:** `compliance/edge-events.test.ts › withholds the same frames on a replay from a cursor`.

### `events/edge-frame-published-type`

When a purge has taken an edge's source item, the server MUST withhold the edge's `edge.deleted` from a subscriber that may not read the type the source item had when the event was published.

**Tests:** `compliance/edge-events.test.ts › withholds a purged item's edges from a subscriber that could not read it, live and on a replay`.

## A stream and the source filter

The source filter is `enforcement.source_filter` as it holds for the stream's credential: its own override's if the override names one, and else the instance's (`types/source-filter`). A copy stream is held to `reach/frame-excluded` instead.

### `events/source-filter-item`

Where the source filter names an item's type or a type above it and does not name the item's source, the server MUST withhold the item's events from a stream that is not a copy stream, live and on a replay from a cursor.

**Reason:** a stream frame carries the whole item, so a stream that sent it would hand over an item every listing leaves out.

**Tests:** `compliance/stream-source-filter.test.ts › leaves out of a live stream the items and edges whose source item the filter hides, and nothing else`, `› leaves the same frames out of a replay from a cursor`.

### `events/source-filter-edge`

Where the source filter applies to a stream that is not a copy stream, the server MUST withhold an edge event from it, live and on a replay from a cursor, when the filter leaves out the source item the event carried when it was published, and not when it leaves out only the edge's target item.

**Reason:** an edge listing decides an edge by its source item (`edges/read-source-filter`), and a stream frame is the same disclosure.

**Tests:** `compliance/stream-source-filter.test.ts › leaves out of a live stream the items and edges whose source item the filter hides, and nothing else`, `› leaves the same frames out of a replay from a cursor`.

### `events/source-filter-current`

When the source filter that holds for an open stream's credential changes, the server MUST judge each frame it sends after the change by the filter as changed.

**Tests:** `compliance/stream-source-filter.test.ts › narrows an open stream when the key's own source filter changes`.

### `events/source-filter-copy`

Where the source filter leaves out an item the credential may read, the server MUST still send the item's events on a copy stream, with `listed` `false`.

**Reason:** `reach/frame-excluded` holds the copy stream to every item a device may hold.

**Tests:** `compliance/stream-source-filter.test.ts › still sends an item the filter hides on a copy stream, with listed false`.

## A stream and its credential

### `events/page-judged`

The server MUST judge each frame of a stream by the stream's credential as it stands when the page of the log that holds the frame is read.

**Reason:** authority can widen or narrow while a stream waits, and the credential that reads a page is the one that decides whether its frames are sent. A frame withheld stays withheld, and `stream_live` covers it.

**Tests:** `compliance/stream-prologue-holds.test.ts › sends a frame the credential has come to read by the time its page is read`, `› withholds a frame the credential has come to lose by the time its page is read, and covers it with stream_live`, `› withholds a frame the credential never read, and sends the key's readable frames after it`.

### `events/credential-narrowed`

When `PATCH /keys/{id}` narrows a key that holds a stream open, the server MUST withhold from the stream the events of a type the key may no longer read.

**Tests:** `compliance/stream-credential.test.ts › stops delivering a type the key is narrowed away from`.

### `events/credential-revoked`

When a key that holds a stream open is revoked, the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `credential_ended`.

**Tests:** `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`.

### `events/credential-grant-revoked`

When the grant of an app whose access token holds a stream open is revoked, the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `credential_ended`.

**Tests:** `compliance/stream-credential.test.ts › ends a stream with credential_ended when its app's grant is revoked`.

### `events/credential-token-revoked`

When the access token that holds a stream open is revoked, the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `credential_ended`.

**Tests:** `compliance/stream-credential.test.ts › ends a stream with credential_ended when its access token is revoked`.

### `events/credential-heartbeat`

If a stream's credential no longer stands, then the server MUST end the stream with `credential_ended` within 30 seconds, whether or not any frame is published.

**Reason:** the credential is read again at each heartbeat as well as before each batch, so a quiet stream does not outlive its credential.

**Tests:** `compliance/stream-credential.test.ts › ends a quiet stream with credential_ended within 30 seconds of its key's revocation`.

### `events/heartbeat`

While a stream is open and holds no frame its reader has not taken, the server MUST send a `:ping` comment line every 30 seconds.

**Reason:** a proxy that closes an idle connection sees traffic, and a client that hears nothing for longer knows the connection is gone.

**Tests:** `compliance/stream-credential.test.ts › sends a :ping comment on a quiet stream every 30 seconds`.

### `events/credential-nothing-after`

When a key that holds a stream open is revoked, the server MUST NOT send the stream an event written after the revocation.

**Tests:** `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`.

### `events/credential-expired`

When a key that holds a stream open passes its `expires_at`, the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `credential_ended`.

**Tests:** `compliance/stream-credential.test.ts › ends a stream with credential_ended once its key expires`.

### `events/credential-token-expired`

When the sign-in token that holds a stream open passes its expiry, the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `credential_ended`.

**Tests:** `compliance/stream-credential.test.ts › ends a stream with credential_ended once its access token expires`.

### `events/credential-reconnect`

If a client opens `GET /events` with a key that has been revoked, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/stream-credential.test.ts › names the last event it sent in the cursor of credential_ended, and refuses a reconnect with the revoked key 401`.

## A reader that takes nothing

### `events/reader-stalled`

If a stream's reader takes nothing for a ping interval, 30 seconds, while the server holds a frame for it, then the server MUST close the stream.

**Reason:** a stalled reader would otherwise hold the server's connection and the stream's task without end. The server keeps no copy of what the reader did not take, so the reader reconnects from the last id it took and the log serves the rest.

**Tests:** `compliance/stream-stalled-reader.test.ts › is closed once it has taken nothing for a ping interval, and resumes from the last id it took`.

## How a stream ends

`stream_incomplete` ends a stream that can no longer deliver what it opened with. Everything after the event it names is still in the log, so the recovery is to reconnect from its `cursor`. `credential_ended` is `events/credential-revoked`, `read_failed` is `events/read-failed` and `server_stopping` is `instance/stop-stream-reason`.

### `events/incomplete-cursor`

When the server ends a stream with `stream_incomplete`, the server MUST give `cursor` as the id of the last event the stream sent, or `null` when it sent none.

**Tests:** `compliance/stream-credential.test.ts › names the last event it sent in the cursor of credential_ended, and refuses a reconnect with the revoked key 401`, `compliance/stream-shutdown.test.ts › names the last event the stream sent as the cursor of its closing frame`.

### `events/incomplete-no-id`

The server MUST send `stream_incomplete` without an `id:` line.

**Reason:** the same as `events/cursor-ahead-no-id`: an `id:` would become the cursor a reconnect resumes from.

**Tests:** `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`, `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `events/incomplete-closes`

When the server has sent `stream_incomplete`, the server MUST close the stream.

**Tests:** `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`, `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `events/read-failed`

If the server's read of the log fails when a stream opens or while it replays, or the read of the stream's credential before a page of the log or at a heartbeat fails, then the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `read_failed`.

**Reason:** a stream that cannot read the log or its credential can no longer say what it has not sent, so it ends and the client reconnects from its `cursor`.

**Tests:** `compliance/stream-opening-faults.test.ts › ends with read_failed when the read of the head fails as it opens`, `› ends with read_failed and a null cursor when the first replay page fails`, `› ends with read_failed when the read of its credential before a page of the replay fails`, `› ends with read_failed when the read of its credential before a batch fails`, `› ends with read_failed when the read of its credential at a heartbeat fails`, `compliance/stream-copy-opening-faults.test.ts › ends a copy stream with stream_incomplete, and sends neither stream_cursor nor stream_live, when the read of the head fails`, `› ends a copy stream's replay with read_failed when a read of the log fails`, `› ends a copy stream's replay with read_failed when its credential cannot be read`, `› ends a copy stream with read_failed when the read of its credential before a batch fails`.

## Registering a subscription

An outbound webhook is a subscription: a `url`, the `events` it wants and, optionally, a `type_filter`. The events a subscription may name are `item.created`, `item.updated`, `item.deleted`, `item.restored`, `item.purged`, `item.state_changed`, `metadata.changed`, `edge.created`, `edge.updated` and `edge.deleted`.

### `events/webhook-create`

When a credential holding `webhooks.manage` sends `POST /webhooks` with a `url` and `events` from the vocabulary, the server MUST answer `201` with the subscription, `active` true.

**Tests:** `compliance/webhooks.test.ts › registers a subscription and returns the secret once`.

### `events/webhook-secret-shown`

When the server answers `POST /webhooks` with `201`, the server MUST carry the subscription's `secret` in plaintext.

**Tests:** `compliance/webhooks.test.ts › registers a subscription and returns the secret once`.

### `events/webhook-secret-redacted`

When the server answers a read or an update of a subscription, the server MUST redact its `secret` to `****` followed by its last four characters.

**Reason:** the plaintext is shown once, on creation.

**Tests:** `compliance/webhooks.test.ts › registers a subscription and returns the secret once`, `compliance/webhook-delivery.test.ts › shows subscription configuration with maker identity on reads`.

### `events/webhook-secret-generated`

When `POST /webhooks` names no `secret`, the server MUST generate one of 64 hexadecimal characters.

**Tests:** `compliance/webhooks.test.ts › registers a subscription and returns the secret once`.

### `events/webhook-secret-supplied`

When `POST /webhooks` names a `secret` of at least 32 characters, the server MUST answer it whole on creation.

**Tests:** `compliance/webhook-delivery.test.ts › signs deliveries under a secret the caller supplied, returned whole on creation, at the time of the attempt`, `compliance/webhooks.test.ts › refuses a secret shorter than 32 characters, the empty one included`.

### `events/webhook-secret-short`

If `POST /webhooks` names a `secret` shorter than 32 characters, the empty string included, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhooks.test.ts › refuses a secret shorter than 32 characters, the empty one included`.

### `events/webhook-shape`

The server MUST answer a subscription with the members `id`, `url`, `events`, `type_filter`, `secret`, `active`, `created_at` and `updated_at`, adding `maker` only on list and get responses.

**Reason:** the subscription's position in the event log and its birth are not part of what an owner sees.

**Tests:** `compliance/webhook-delivery.test.ts › shows subscription configuration with maker identity on reads`.

### `events/webhook-list`

When a credential holding `webhooks.manage` sends `GET /webhooks`, the server MUST answer the subscriptions the requesting key registered, or for a signed-in app those any token of its grant registered, with `next_cursor` `null`.

**Tests:** `compliance/webhooks.test.ts › answers a subscription another credential registered as an unknown id on every door`, `compliance/webhook-delivery.test.ts › shows subscription configuration with maker identity on reads`.

### `events/webhook-direct-read`

When private local authority sends `GET /webhooks`, `GET /webhooks/{id}` or `GET /webhooks/{id}/deliveries`, the server MUST admit reads across every maker without creating a credential.

**Tests:** `compliance/webhooks-owner.test.ts › reads every maker through local authority while ordinary keys stay isolated`.

### `events/webhook-not-a-session`

If the owner's browser session sends a request to any `/webhooks` door, then the server MUST answer `401 unauthorized`.

**Reason:** a subscription belongs to the key or app that registered it, and a browser's session is neither. Its sign-in proves the owner is present now, which says nothing about whether the maker may still read what a redelivery would send. The private local socket keeps the owner's direct reads and redelivery.

**Tests:** `compliance/webhooks-owner.test.ts › refuses an owner's browser session on every webhook door with 401`.

### `events/webhook-maker`

When the server lists or gets a subscription, the server MUST include its maker's `kind` (`key` or `app`), `id` (key ID or OAuth client ID) and current `name`, with `null` for a name no longer available.

**Tests:** `compliance/webhooks-owner.test.ts › reads every maker through local authority while ordinary keys stay isolated`.

### `events/webhook-direct-retry`

When private local authority requests redelivery, the server MUST apply the same live subscription, maker and retention checks as a request by the subscription's maker.

**Reason:** local authority can request another attempt, but cannot restore the maker's revoked access or send content the maker can no longer read.

**Tests:** `compliance/webhooks-owner.test.ts › retries a failed delivery through local authority without exposing its frame`.

### `events/webhook-direct-mutations`

When private local authority sends a subscription create, update or delete, the server MUST refuse it with `401 unauthorized`.

**Tests:** `compliance/webhooks-owner.test.ts › reads every maker through local authority while ordinary keys stay isolated`.

### `events/webhook-update`

When `PATCH /webhooks/{id}` names `url`, `events`, `type_filter` or `active`, the server MUST change each in place, so that the next read answers it.

**Tests:** `compliance/webhooks.test.ts › updates the url, events, type filter and active flag in place`.

### `events/webhook-update-undeclared-key`

If `PATCH /webhooks/{id}` carries a top-level body key the operation does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields`.

**Reason:** a misspelled `active` would otherwise be dropped, and a subscription the caller meant to stop would keep sending.

**Tests:** `compliance/undeclared-body-keys.test.ts › refuses %j as undeclared, naming each key, and writes nothing`.

### `events/webhook-delete`

When `DELETE /webhooks/{id}` names a subscription the credential holds, the server MUST remove it, so that every later request for it is answered `404 webhook_not_found`.

**Tests:** `compliance/webhooks.test.ts › deletes a subscription and answers 404 for it afterwards`.

### `events/webhook-unknown`

If an operation that names a subscription is given an id no subscription of the credential holds, then the server MUST answer `404 webhook_not_found`.

**Tests:** `compliance/webhooks.test.ts › answers 404 for an unknown subscription on every door`, `› deletes a subscription and answers 404 for it afterwards`.

### `events/webhook-update-order`

If `PATCH /webhooks/{id}` carries a body the server refuses, then the server MUST answer that refusal whether or not a subscription of the credential holds the id.

**Tests:** `compliance/webhooks.test.ts › refuses an update's body before it looks for the subscription`.

### `events/webhook-events-refused`

If `events` names an event outside the vocabulary, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhooks.test.ts › refuses an event name outside the vocabulary`.

### `events/webhook-events-empty`

If `events` is an empty list, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhooks.test.ts › refuses a body with no url or no events`.

### `events/webhook-wildcard-refused`

If `events` names `*`, then the server MUST answer `400 validation_error` with `details.errors[].path` naming the entry's position.

**Reason:** `*` is not in the vocabulary, and a stored wildcard would be a subscription that could never fire.

**Tests:** `compliance/webhooks.test.ts › refuses a wildcard subscription while a named one on the same event is delivered`.

### `events/webhook-wildcard-update`

If `PATCH /webhooks/{id}` names `*` in `events`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhooks.test.ts › refuses a wildcard on the update door, leaving the stored events alone`.

### `events/webhook-missing-field`

If `POST /webhooks` names no `url` or no `events`, then the server MUST answer `400 missing_required_field` with `details.field` naming the first missing field.

**Tests:** `compliance/webhooks.test.ts › refuses a body with no url or no events`.

### `events/webhook-create-undeclared-key`

If `POST /webhooks` carries a top-level body key the operation does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields`.

**Reason:** a misspelled `type_filter` would otherwise be dropped, and the subscription would send every event of every type.

**Tests:** `compliance/undeclared-body-keys.test.ts › refuses %j as undeclared, naming each key, and writes nothing`.

### `events/webhook-cap`

If a key, or an app's grant, already holds 100 subscriptions and sends `POST /webhooks`, then the server MUST answer `409 conflict` with `details.reason` `webhook_cap` and `details.cap` `100`.

**Reason:** every subscription is an event the server must queue and send, so the number one credential holds is bounded. A caller told the cap can delete one it no longer needs.

**Tests:** `compliance/webhooks-owner.test.ts › refuses the 101st subscription of a key or an app with 409 conflict naming the cap, and accepts one again once one is deleted`.

### `events/webhook-cap-own`

The server MUST count toward the cap of `events/webhook-cap` only the subscriptions the requesting key, or the requesting app's grant, registered.

**Tests:** `compliance/webhooks-owner.test.ts › refuses the 101st subscription of a key or an app with 409 conflict naming the cap, and accepts one again once one is deleted`.

### `events/webhook-cap-frees`

When a key or an app deletes a subscription it registered, the server MUST accept the next `POST /webhooks` from that key or app that the cap alone would have refused.

**Tests:** `compliance/webhooks-owner.test.ts › refuses the 101st subscription of a key or an app with 409 conflict naming the cap, and accepts one again once one is deleted`.

### `events/webhook-refused-keeps`

If `PATCH /webhooks/{id}` is refused, then the server MUST leave the subscription's stored `url`, `events` and `type_filter` as they were.

**Tests:** `compliance/webhooks.test.ts › refuses a wildcard on the update door, leaving the stored events alone`, `› normalizes one item filter and preserves it after refused updates`, `compliance/webhook-addresses.test.ts › refuses to point a subscription at an address that is not public, leaving the stored url`.

### `events/webhook-url-scheme`

If `url` is not `http` or `https`, or carries a user name or password, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhooks.test.ts › refuses a URL that is not http or https, or carries credentials`.

### `events/webhook-filter-trimmed`

When `type_filter` names one item type pattern with spaces around it, the server MUST keep it without them.

**Tests:** `compliance/webhooks.test.ts › normalizes one item filter and preserves it after refused updates`.

### `events/webhook-filter-accepted`

When `type_filter` is a qualified wildcard such as `core.*` or an identifier no type registers, the server MUST accept it.

**Tests:** `compliance/webhooks.test.ts › normalizes one item filter and preserves it after refused updates`, `› refuses a type_filter that is not one item pattern with validation_error naming type_filter, on create and on update`.

### `events/webhook-filter-refused`

If `type_filter` is `*`, a malformed identifier or a comma-separated list, then the server MUST answer `400 validation_error` with `details.errors[].path` naming `type_filter`, on create and on update.

**Tests:** `compliance/webhooks.test.ts › refuses a type_filter that is not one item pattern with validation_error naming type_filter, on create and on update`.

### `events/webhook-filter-blank`

When `PATCH /webhooks/{id}` sets `type_filter` to blank text or `null`, the server MUST read the subscription as having no filter.

**Tests:** `compliance/webhooks.test.ts › normalizes one item filter and preserves it after refused updates`.

### `events/webhook-filter-matches`

When a subscription has a `type_filter`, the server MUST deliver an item event or a `metadata.changed` only where the filter selects the item's type, declared subtypes and dotted children included.

**Tests:** `compliance/webhooks.test.ts › delivers only the events whose item type a type_filter selects, declared subtypes and dotted children included`, `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its events or type_filter no longer select it, and sends one they select at the attempt`.

### `events/webhook-filter-edges`

When a subscription has a `type_filter`, the server MUST NOT hold the edge events it names to that filter.

**Tests:** `compliance/webhook-delivery.test.ts › delivers an edge event under a type_filter that selects neither of its items`.

## Who may use a subscription

### `events/webhook-needs-permission`

If a credential without `webhooks.manage` sends a request to a webhook operation, then the server MUST answer `403 forbidden` with `details.required_scope` `webhooks.manage`, before it checks anything else the request names.

**Tests:** `compliance/webhooks.test.ts › refuses a key without webhooks.manage`.

### `events/webhook-unauthenticated`

If a request to a webhook operation carries neither a credential nor local authority, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `compliance/webhooks.test.ts › refuses every door without a credential`.

### `events/webhook-any-reach`

When a credential holding `webhooks.manage` registers a subscription, the server MUST accept it whatever types the credential may read.

**Tests:** `compliance/webhooks.test.ts › delivers to a credential that reads part of what is stored only that part`.

### `events/webhook-owner-only`

When a key or app request names a subscription that neither the requesting key nor the requesting app's grant registered, the server MUST answer `404 webhook_not_found` on `GET`, `PATCH`, `DELETE` and the delivery log.

**Reason:** to another credential the subscription is an id nobody holds.

**Tests:** `compliance/webhooks.test.ts › answers a subscription another credential registered as an unknown id on every door`.

### `events/webhook-redeliver-owner-only`

When a key or app redelivery names a subscription that neither the requesting key nor the requesting app's grant registered, the server MUST answer `404 webhook_not_found`.

**Tests:** `compliance/webhook-delivery.test.ts › answers a redelivery on a subscription another credential registered 404 webhook_not_found, and accepts the owner's`.

### `events/webhook-revoked-silent`

When the key that registered a subscription is revoked, the server MUST deliver nothing more to it.

**Tests:** `compliance/webhooks.test.ts › stops delivering once the credential that registered it is revoked`.

### `events/webhook-manage-removed`

When the key that registered a subscription no longer holds `webhooks.manage`, the server MUST settle its pending deliveries unsent.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its key no longer holds webhooks.manage`.

### `events/webhook-expired-silent`

When the key that registered a subscription passes its `expires_at`, the server MUST deliver nothing more to it, its pending deliveries included.

**Tests:** `compliance/webhook-owner-standing.test.ts › delivers nothing more once the key that registered the subscription expires`.

### `events/webhook-grant-revoked`

When the grant of an app that registered a subscription is revoked, the server MUST delete the subscription.

**Reason:** an app's subscriptions belong to its grant, and `events/cancel-deleted` then sends none of the subscription's pending deliveries.

**Tests:** `compliance/webhook-owner-standing.test.ts › deletes an app's subscriptions when its grant is revoked`.

## What a delivery is

### `events/delivery-matches`

When an event that fans out is one an active subscription names, and the subscription's `type_filter` and credential admit it, the server MUST deliver it to the subscription's `url`.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`.

### `events/delivery-unmatched`

The server MUST NOT deliver an event the subscription's `events` does not name.

**Tests:** `compliance/webhooks.test.ts › does not deliver an event outside the subscription`, `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its events or type_filter no longer select it, and sends one they select at the attempt`.

### `events/delivery-post-json`

The server MUST send a delivery as an HTTP `POST` whose body is JSON, with `Content-Type` `application/json`.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`.

### `events/delivery-event-type`

The server MUST carry `event_type`, the event's name, in a delivery's body and in its `X-Marfa-Event-Type` header.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`, `compliance/edge-events.test.ts › delivers edge.created and edge.deleted to a webhook with a valid signature`.

### `events/delivery-event-id`

The server MUST carry `event_id` in a delivery's body, as the id of the event in the log written as a canonical decimal string, equal to the `id:` the stream gave it.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`.

### `events/delivery-id`

The server MUST carry `delivery_id` in a delivery's body, equal to the `id` of the delivery's entry in `GET /webhooks/{id}/deliveries` and the same on every attempt.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`, `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`.

### `events/delivery-at`

The server MUST carry `delivered_at` in a delivery's body, as the instant of that attempt.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/delivery-payload`

The server MUST carry in a delivery's body the payload of the stream frame for the event, as the subscription's credential may read it.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`, `› delivers to a credential that reads part of what is stored only that part`, `› delivers only the extension namespaces the credential may read`.

### `events/delivery-signature`

The server MUST carry in a delivery an `X-Marfa-Signature` header of the form `t=<unix seconds>,v1=<hex sha256>`, where `v1` is the HMAC-SHA-256 of `<t>.<raw body>` under the subscription's secret.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`, `compliance/edge-events.test.ts › delivers edge.created and edge.deleted to a webhook with a valid signature`.

### `events/delivery-signature-time`

The server MUST give the `t` of `X-Marfa-Signature` as the time of the attempt.

**Tests:** `compliance/webhook-delivery.test.ts › signs deliveries under a secret the caller supplied, returned whole on creation, at the time of the attempt`, `› leaves a delivery pending after a 500 and retries it with the same ids`.

### `events/delivery-marks`

The server MUST carry in a delivery the cascade marks the stream frame carries, `trashed_by_cascade`, `trashed_with`, `restored_with` and `purged_with` among them.

**Tests:** `compliance/cascade-marks.test.ts › delivers the item.deleted of an item a cascade trashed with its mark, and the item trashed's own without one`, `compliance/webhook-delivery.test.ts › delivers the marks of a stream frame, naming another item only to an owner who may read its type`, `› sends no edge.deleted for an edge a purge took to an owner who may not read the purged item's type, and sends it for a type the owner reads`.

### `events/delivery-marks-named`

When a delivery carries a mark that names another item, the server MUST name it only where the subscription's credential may read that item's type.

**Tests:** `compliance/webhook-delivery.test.ts › delivers the marks of a stream frame, naming another item only to an owner who may read its type`.

## What a subscription's credential may read

### `events/delivery-reach-item`

The server MUST deliver an item event only where the subscription's credential may read the item's type.

**Tests:** `compliance/webhooks.test.ts › delivers to a credential that reads part of what is stored only that part`.

### `events/delivery-reach-edge-kind`

The server MUST NOT deliver an edge event to a subscription whose credential may not read the edge's kind.

**Tests:** `compliance/webhook-delivery.test.ts › delivers an edge event only where the key may read the edge's kind`.

### `events/delivery-reach-edge-source`

The server MUST NOT deliver an edge event to a subscription whose credential may not read the type the edge's source item had when the event was published.

**Reason:** the stream holds the same rule, `events/edge-frame-source`, and a later retype of the source changes nothing about who may be told of the event.

**Tests:** `compliance/webhook-delivery.test.ts › delivers an edge event only where the key may read the type its source had when the event was published`.

### `events/delivery-reach-namespaces`

When the server delivers `metadata.changed`, the server MUST include only the extension namespaces the subscription's credential may read.

**Tests:** `compliance/webhooks.test.ts › delivers only the extension namespaces the credential may read`.

### `events/delivery-edge-purged-source`

When a purge has taken an edge's source item, the server MUST withhold the edge's `edge.deleted` from a webhook whose credential may not read the type the source item had when the event was published.

**Reason:** the stream holds the same rule, `events/edge-frame-published-type`, and a webhook that told its owner what the stream would not would disclose an edge's ends.

**Tests:** `compliance/webhook-delivery.test.ts › sends no edge.deleted for an edge a purge took to an owner who may not read the purged item's type, and sends it for a type the owner reads`.

### `events/delivery-source-filter-item`

Where the `enforcement.source_filter` that holds for a subscription's credential names an item's type or a type above it and does not name the item's source, the server MUST NOT deliver the item's events to the subscription.

**Reason:** the stream holds the same rule, `events/source-filter-item`.

**Tests:** `compliance/webhook-delivery.test.ts › delivers no item or edge event whose source item the filter hides`.

### `events/delivery-source-filter-edge`

Where an `enforcement.source_filter` holds for a subscription's credential, the server MUST withhold an edge event from the subscription when the filter leaves out the source item the event carried when it was published, and not when it leaves out only the edge's target item.

**Reason:** the stream holds the same rule, `events/source-filter-edge`.

**Tests:** `compliance/webhook-delivery.test.ts › delivers no item or edge event whose source item the filter hides`.

### `events/delivery-source-filter-current`

When the `enforcement.source_filter` that holds for a subscription's credential comes to leave out the item of an event whose delivery is pending, the server MUST settle that delivery unsent.

**Reason:** a delivery is decided at each attempt, by the credential as it stands then (`events/delivery-credential-current`).

**Tests:** `compliance/webhook-delivery.test.ts › settles unsent a pending delivery whose source the credential's filter comes to hide, and sends nothing later from that source`.

### `events/delivery-credential-current`

When a credential is narrowed after an event, the server MUST carry in each later attempt of its pending delivery only what the credential may read now.

**Tests:** `compliance/webhook-delivery.test.ts › narrows what a retry carries to the credential as it stands after the event`.

### `events/delivery-narrowed-settles`

When a credential is narrowed away from the type of an event whose delivery is pending, the server MUST settle that delivery unsent.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when the credential is narrowed away from its type`.

## The delivery record

`GET /webhooks/{id}/deliveries` lists a subscription's deliveries. Its paging is the paging every list shares, in `search-and-filters/page-envelope`.

### `events/record-status`

The server MUST answer a delivery's `status` as `pending`, `success`, `dead_letter` or `canceled`.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`, `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› retries a 408 and a 429, and gives up at once on any other 4xx answer`, `› settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`.

### `events/record-status-code`

The server MUST answer a delivery's `status_code` as the HTTP status the receiver answered on the latest attempt whose outcome it recorded, and `null` where that attempt got no answer or no attempt has been recorded.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› records an unreachable receiver and one that does not answer as pending, naming no address`.

### `events/record-attempt`

The server MUST answer a delivery's `attempt` as the number of attempts whose outcome it has recorded.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› waits for the Retry-After a receiver names, and never less than the ordinary wait`.

### `events/record-succeeded`

The server MUST answer a delivery's `succeeded` as `true` for `success` and `false` for every other `status`.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› retries a 408 and a 429, and gives up at once on any other 4xx answer`, `› settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`.

### `events/record-error-http`

When a receiver answers with a status that is neither `2xx` nor `3xx`, the server MUST record `HTTP <status>`, with the status the receiver answered, as the delivery's `error`.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› retries a 408 and a 429, and gives up at once on any other 4xx answer`.

### `events/record-error-unreachable`

When a receiver cannot be reached on an attempt before the last of its cycle, the server MUST record `The receiver could not be reached.` as the delivery's `error` and leave it `pending`.

**Tests:** `compliance/webhook-delivery.test.ts › records an unreachable receiver and one that does not answer as pending, naming no address`.

### `events/record-error-timeout`

When a receiver does not answer in time on an attempt before the last of its cycle, the server MUST record `The receiver did not answer in time.` as the delivery's `error` and leave it `pending`.

**Tests:** `compliance/webhook-delivery.test.ts › records an unreachable receiver and one that does not answer as pending, naming no address`.

### `events/record-error-no-address`

The server MUST NOT name the address or the port it tried in the `error` of a delivery.

**Reason:** a webhook is a way to probe a network, and an error that said where it failed would tell its owner what lies behind the address.

**Tests:** `compliance/webhook-delivery.test.ts › records an unreachable receiver and one that does not answer as pending, naming no address`.

### `events/record-error-cleared`

When an attempt succeeds, the server MUST clear the `error` an earlier attempt recorded.

**Tests:** `compliance/webhook-delivery.test.ts › clears the error a failed attempt recorded when a later attempt succeeds`.

### `events/record-newest-first`

The server MUST list a subscription's deliveries newest first.

**Tests:** `compliance/webhook-delivery.test.ts › lists a subscription's deliveries newest first`.

### `events/record-paged`

When `limit` cuts the list of deliveries short, the server MUST answer a `next_cursor` that, followed, reaches every delivery once.

**Tests:** `compliance/webhooks.test.ts › pages its delivery log by cursor, every delivery once`.

### `events/record-limit-default`

When `GET /webhooks/{id}/deliveries` names no `limit`, the server MUST answer the page that a `limit` of 50 answers.

**Tests:** `compliance/page-limits.test.ts › $door answers its default page where it names no limit`.

### `events/record-limit-bounds`

If `GET /webhooks/{id}/deliveries` names a `limit` that is not a whole number of 1 to 200, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`, `› $door takes its largest page and refuses a limit past it or a fraction`.

## Retries

A delivery is attempted again when its receiver does not take it. The server attempts a pending delivery when its wait ends, with no job to run.

### `events/retry-5xx`

When a receiver answers an attempt before the last of its cycle with a `5xx` status, the server MUST leave the delivery `pending` and attempt it again with the same `delivery_id` and `event_id`.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› clears the error a failed attempt recorded when a later attempt succeeds`.

### `events/retry-408-429`

When a receiver answers an attempt before the last of its cycle with `408` or `429`, the server MUST leave the delivery `pending` and attempt it again.

**Tests:** `compliance/webhook-delivery.test.ts › retries a 408 and a 429, and gives up at once on any other 4xx answer`.

### `events/retry-4xx-gives-up`

When a receiver answers a delivery with a `4xx` status other than `408` and `429`, the server MUST give up at once and record the delivery `dead_letter` at that attempt.

**Tests:** `compliance/webhook-delivery.test.ts › retries a 408 and a 429, and gives up at once on any other 4xx answer`.

### `events/retry-redirect`

When a receiver answers a delivery with a `3xx` status, the server MUST give up at once and record the delivery `dead_letter` with the redirect's status and the `error` `The receiver answered with a redirect, which is not followed.`

**Tests:** `compliance/webhook-delivery.test.ts › gives up on a redirect without following it`.

### `events/redirect-not-followed`

When a receiver answers a delivery with a `3xx` status, the server MUST NOT send the delivery to the address the redirect names.

**Tests:** `compliance/webhook-delivery.test.ts › gives up on a redirect without following it`.

### `events/retry-after-floor`

When a receiver answers a retried attempt with a valid `Retry-After` of at most five minutes, the server MUST wait at least that long before the next attempt.

**Tests:** `compliance/webhook-delivery.test.ts › waits for the Retry-After a receiver names, and never less than the ordinary wait`.

### `events/retry-after-no-shorter`

When a receiver's `Retry-After` is shorter than the ordinary wait for the attempt, the server MUST wait the ordinary wait.

**Tests:** `compliance/webhook-delivery.test.ts › waits for the Retry-After a receiver names, and never less than the ordinary wait`.

### `events/retry-after-cap`

When a receiver's `Retry-After` is longer than five minutes, the server MUST wait the longer of five minutes and the ordinary wait.

**Tests:** `compliance/webhook-retries.test.ts › waits five minutes for a longer Retry-After in seconds, and the ordinary wait where that is longer`, `› reads a Retry-After given as a date against the server's clock, and caps it`.

### `events/retry-schedule`

When a receiver answers every attempt with a retryable failure, the server MUST make eight attempts, with seven waits of 1, 5, 25, 125, 625, 3125 and 15625 seconds between them, and then record the delivery `dead_letter`.

**Tests:** `compliance/webhook-retries.test.ts › makes eight attempts with the seven waits of the schedule, then records dead_letter`.

### `events/retry-when-due`

When a pending delivery's wait ends, the server MUST attempt it without a request or a job run.

**Reason:** a receiver that comes back is sent what it missed at the time the schedule names, not at the next run of a job.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› waits for the Retry-After a receiver names, and never less than the ordinary wait`, `compliance/webhook-retries.test.ts › makes eight attempts with the seven waits of the schedule, then records dead_letter`.

### `events/retry-restart-once`

When the server stops while it schedules deliveries and starts again, the server MUST queue exactly one delivery for each event and each subscription entitled to it.

**Tests:** `compliance/webhook-retries.test.ts › queues each event once for each subscription entitled to it when the server stops while it schedules`.

## Settling a delivery unsent

### `events/cancel-edited`

When a subscription is pointed at another URL or turned off, the server MUST settle its pending deliveries unsent, so that none goes to the old address.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`.

### `events/cancel-unselected`

When `PATCH /webhooks/{id}` sets `events` or `type_filter` so that they no longer select the event of one of the subscription's pending deliveries, the server MUST settle that delivery unsent, with the `error` `The subscription's events or type filter no longer select this event.`, before it answers.

**Reason:** `events/delivery-unmatched` and `events/webhook-filter-matches` hold for a delivery that waits for a retry, so the delivery log shows it `canceled` at once and a receiver is not sent an event the owner has since excluded. A delivery being sent when the change commits ends `canceled` too. A change that still selects the event, or touches neither field, settles nothing, and widening a field again revives nothing already settled. A server also checks the filters it holds at each attempt, so no route to a change leaves a delivery to be sent.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its events or type_filter no longer select it, and sends one they select at the attempt`.

### `events/cancel-deleted`

When a subscription is deleted, the server MUST send none of its pending deliveries.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`.

### `events/cancel-record`

When the server settles a delivery unsent, the server MUST record it `canceled` with `succeeded` false, the reason in `error`, and the `status_code` and `attempt` it had.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`, `› settles a pending delivery unsent when the credential is narrowed away from its type`, `› settles a pending delivery unsent when its key no longer holds webhooks.manage`.

## Redelivery

### `events/redeliver-accepted`

When the credential that owns a subscription sends `POST /webhooks/{id}/deliveries/{delivery_id}/redeliver` for a `dead_letter` delivery, the server MUST answer `202` with that delivery as `pending`, keeping its `id`, `status_code` and `attempt`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/redeliver-current`

When the server redelivers a delivery, the server MUST send it to the subscription's current `url`, signed under its current secret, with the same `event_id` and `delivery_id` and a new `delivered_at`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/redeliver-not-failed`

If a redelivery names a delivery that is `pending`, `success` or `canceled`, then the server MUST answer `409 conflict`.

**Reason:** a delivered or canceled delivery keeps no frame to send again.

**Tests:** `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`.

### `events/redeliver-refused-keeps`

If the server refuses a redelivery, then the server MUST leave the delivery's `status` and `attempt` as they were.

**Tests:** `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`, `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/redeliver-inactive`

If a redelivery names a delivery of a subscription that is not active, then the server MUST answer `409 conflict`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/redeliver-conflict-reason`

When the server answers a redelivery `409 conflict`, the server MUST carry in `details.reason` the first of these that holds: `webhook_inactive` if the subscription is not active, `credential_unavailable` if the credential that registered the subscription no longer holds `webhooks.manage` or is no longer live, `delivery_not_failed` if the delivery is not `dead_letter`, or `delivery_expired` if the delivery is older than the instance's audit retention.

**Reason:** the four refusals need different remedies, and a caller who is told only that the request collides cannot tell a switch to turn on from a delivery that cannot be sent again. A `dead_letter` delivery keeps the event it was queued with, so no fifth refusal is needed for an event the log has since let go.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`, `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`, `compliance/webhook-history.test.ts › refuses to redeliver a dead_letter delivery older than the audit retention`, `compliance/webhooks-owner.test.ts › names a maker that no longer holds webhooks.manage as the reason a local redelivery is refused`.

### `events/redeliver-missing`

If a redelivery names a delivery the subscription does not hold, then the server MUST answer `404 webhook_not_found`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/redeliver-once`

When two redeliveries of one delivery arrive together, the server MUST accept one with `202` and answer the other `409 conflict`.

**Tests:** `compliance/webhook-delivery.test.ts › queues one transition when a redelivery is requested twice at once, and records one audit entry`.

### `events/redeliver-fresh-cycle`

When a receiver answers every attempt of a redelivered delivery with a retryable failure, the server MUST make eight attempts after the redelivery before it records the delivery `dead_letter` again.

**Tests:** `compliance/webhook-history.test.ts › starts a fresh cycle of attempts on redelivery`.

### `events/redeliver-audit`

When the server accepts a redelivery, the server MUST record a `webhook.delivery.redeliver` entry with `resource_type` `webhook_delivery`, the delivery's id as `resource_id` and the subscription's id as `details.webhook_id`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`.

### `events/redeliver-refused-no-audit`

If the server refuses or duplicates a redelivery, then the server MUST NOT record a `webhook.delivery.redeliver` entry for it.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed delivery to the current address with stable identity`, `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`, `› queues one transition when a redelivery is requested twice at once, and records one audit entry`.

### `events/redeliver-audit-fails`

If the server cannot record a redelivery's audit entry, then the server MUST leave the failed delivery unchanged.

**Tests:** `compliance/write-faults.test.ts › leaves the failed delivery unchanged, queues nothing and records nothing, and a retry is accepted`.

### `events/history-dead-letter-kept`

While a `dead_letter` delivery is within the effective audit retention, measured from its original `created_at`, the server MUST keep the frame and address it needs to be redelivered.

**Reason:** the effective retention is the `audit_retention_days` setting in `/config` where it is set, and a delivery's history follows it.

**Tests:** `compliance/webhook-history.test.ts › keeps a dead_letter delivery within the audit retention redeliverable`.

### `events/history-pending-kept`

While a delivery is `pending`, the server MUST keep its frame and address whatever its age.

**Tests:** `compliance/webhook-history.test.ts › keeps a pending delivery whatever its age`.

### `events/history-clock-kept`

When a delivery is redelivered, the server MUST keep measuring its retention from its original `created_at`.

**Tests:** `compliance/webhook-history.test.ts › measures a redelivered delivery's retention from its original created_at`.

### `events/history-deleted`

When the `audit-cleanup` job runs, the server MUST remove from `GET /webhooks/{id}/deliveries` each delivery that is not `pending` and is older than the effective audit retention, measured from its original `created_at`.

**Tests:** `compliance/webhook-history.test.ts › deletes a delivery's history past the audit retention`.

### `events/redeliver-expired`

If a redelivery names a `dead_letter` delivery older than the effective audit retention, then the server MUST answer `409 conflict`.

**Tests:** `compliance/webhook-history.test.ts › refuses to redeliver a dead_letter delivery older than the audit retention`.

## Where a webhook may send

These rules hold where the instance does not allow private addresses, which is the default. An operator whose receivers run on a private network allows them with `MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true`, and the run's own server sets it because every other fixture's receiver is on loopback. The address fixtures boot a server of their own that does not.

### `events/address-private`

Where the instance does not allow private addresses, if `POST /webhooks` names a `url` whose host is an address that is not public, including loopback, private, link-local, unique-local, carrier-grade NAT, unspecified, multicast, documentation, benchmarking, discard-only, dummy, segment-routing, local-use translation, 6to4 or Teredo addresses, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhook-addresses.test.ts › refuses a subscription naming a loopback, private or link-local address`, `› refuses a subscription naming a unique-local, carrier-grade NAT, unspecified or multicast address`.

### `events/address-name-refused`

Where the instance does not allow private addresses, if `POST /webhooks` names a `url` whose host is a name, and the server's lookup of the name finishes and finds any address that is not public, then the server MUST answer `400 validation_error`.

**Reason:** a subscription the server would refuse to deliver to at every attempt is better refused when it is registered than found later in the delivery log. Any address, not every address, because a delivery to a name with one public and one non-public address is refused as well. A receiver reached by a name on a Tailscale or home network resolves to a carrier-grade NAT or private address, so this is the refusal such a person meets first. A lookup that does not finish is `events/address-name-unresolved`, and the check at each attempt (`events/address-name-unsent`) still has the final say.

**Tests:** `compliance/webhook-addresses.test.ts › refuses a subscription whose host name resolves to an address that is not public, naming the setting`.

### `events/address-refusal-setting`

Where the instance does not allow private addresses, if the server answers `400 validation_error` to a `url` for an address that is not public, then the server MUST name `MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES` in the error's `message`.

**Reason:** the caller reading the refusal is often the person who runs the instance, and the setting is the one thing that changes the answer.

**Tests:** `compliance/webhook-addresses.test.ts › refuses a subscription naming a loopback, private or link-local address`, `› refuses a subscription whose host name resolves to an address that is not public, naming the setting`.

### `events/address-name-unresolved`

Where the instance does not allow private addresses, if `POST /webhooks` names a `url` whose host is a name that does not resolve, or whose lookup cannot start or finish within the registration limit of 3 seconds, then the server MUST answer `201`.

**Reason:** the receiver may not exist yet, and a lookup that fails or stalls at registration says nothing about the one that delivery makes. A fixed limit of four concurrent webhook name lookups includes timed-out lookups until their blocking threads finish, because those threads share a pool with storage and file reading. This deliberately restores a concurrency bound independently of how many times an attempt resolves its name. The check at each attempt (`events/address-name-unsent`) still has the final say, and the attempt records `The receiver could not be reached.` if it still fails.

**Tests:** `compliance/webhook-addresses.test.ts › accepts a name that does not resolve, which delivery looks up again`.

### `events/address-ipv6-global`

Where the instance does not allow private addresses, the server MUST treat a native IPv6 address as public only if it lies in `2000::/3` and its most specific entry in the IANA IPv6 Special-Purpose Address Registry, if any, marks it globally reachable.

**Reason:** the global unicast allocation contains special-purpose ranges, including both documentation blocks (`2001:db8::/32` and `3fff::/20`) and benchmarking (`2001:2::/48`). The `2001::/23` protocol allocation has globally reachable exceptions. 6to4 (`2002::/16`) and Teredo (`2001::/32`) are refused outright because an embedded IPv4 check alone does not establish the tunnel's route. The local-use NAT64 allocation (`64:ff9b:1::/48`) is not globally reachable regardless of its embedded address.

**Tests:** `compliance/webhook-addresses.test.ts › refuses non-global IPv6 and accepts global addresses and public IPv4 translations`, `› refuses special-purpose IPv6 %s at registration`, `› refuses special-purpose IPv6 at every delivery`.

### `events/address-mapped`

Where the instance does not allow private addresses, the server MUST judge an IPv4 address written in IPv4-compatible, IPv4-mapped or well-known NAT64 (`64:ff9b::/96`) form as the IPv4 address it carries.

**Tests:** `compliance/webhook-addresses.test.ts › refuses a subscription naming a loopback, private or link-local address`.

### `events/address-update`

Where the instance does not allow private addresses, if `PATCH /webhooks/{id}` names a `url` whose host is an address that is not public, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhook-addresses.test.ts › refuses to point a subscription at an address that is not public, leaving the stored url`.

### `events/address-name-update`

Where the instance does not allow private addresses, if `PATCH /webhooks/{id}` names a `url` whose host is a name, and the server's lookup of the name finishes and finds any address that is not public, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhook-addresses.test.ts › refuses to point a subscription at an address that is not public, leaving the stored url`.

### `events/address-name-unsent`

Where the instance does not allow private addresses, if a subscription's `url` names a host that resolves, at the attempt, to any address that is not public, then the server MUST NOT contact it.

**Reason:** a name that resolved to a public address at registration can resolve to a private one later.

**Tests:** `compliance/webhook-addresses.test.ts › sends nothing to a name that resolves to loopback, records why, and gives up at once`.

### `events/address-name-recorded`

Where the instance does not allow private addresses, if a subscription's `url` names a host that resolves to any address that is not public, then the server MUST record `The receiver's address is not public.` as the delivery's `error`.

**Tests:** `compliance/webhook-addresses.test.ts › sends nothing to a name that resolves to loopback, records why, and gives up at once`.

### `events/address-name-dead-letter`

Where the instance does not allow private addresses, if a subscription's `url` names a host that resolves, at the attempt, to any address that is not public, then the server MUST record the delivery `dead_letter` at that attempt.

**Reason:** the refusal is the instance's own rule, not the receiver's answer, so a later attempt would meet it again and the delivery would show `pending` for hours while it did. A redelivery sends it again once the name or the setting has changed.

**Tests:** `compliance/webhook-addresses.test.ts › sends nothing to a name that resolves to loopback, records why, and gives up at once`.

### `events/address-resolved-once`

Where the instance does not allow private addresses, the server MUST connect to the address it checked and not resolve the name again.

**Reason:** a second resolution could move the connection to an address that is not public.

**Tests:** `compliance/webhook-resolution.test.ts › connects to the address it checked and does not resolve the name again`.

## When delivery starts

### `events/webhook-position-created`

When the server creates its database, the server MUST establish the webhook scheduling position at zero before any event can commit.

**Tests:** `compliance/webhook-schedule-gap.test.ts › starts scheduling after a fresh control-only instance writes its first event`.

### `events/webhook-starts-after-creation`

When a subscription is registered, the server MUST NOT deliver an event written before it.

**Reason:** a subscription receives no earlier events merely because scheduling lagged.

**Tests:** `compliance/webhook-delivery.test.ts › sends a subscription no event written before it was registered`.

### `events/schedule-fails-visibly`

If the log's position for scheduling webhooks is ahead of the log, missing, behind the oldest event the log retains, or crosses a missing retained event, then the server MUST report an unhandled fault and queue no delivery for any event past the position.

**Reason:** a gap the server cannot account for would otherwise skip events that fan out without saying so. A report of an unhandled fault is its log line `Unhandled error`, its error webhook notification and its exception in error tracking, as `errors/client-closed-request` describes for a request. Once the position can be accounted for, the server queues what lies past it.

**Tests:** `compliance/webhook-schedule-gap.test.ts › reports a place the log cannot account for as an unhandled fault, and queues nothing past it`.

### `events/webhook-bulk-backlog`

When an ordinary write follows a bulk write of 50,000 items with fan-out disabled on an otherwise idle server using the default housekeeping cadence, with one eligible webhook subscription, no other pending fan-out work and a promptly responsive receiver, the server MUST deliver that ordinary write's event to that receiver within five seconds.

**Reason:** events that do not fan out must not consume successive scheduling runs before an event that does fan out can be reached; their payloads are not inspected by webhook scheduling because they cannot create deliveries.

**Tests:** `compliance/webhook-bulk-backlog.test.ts › delivers the next fan-out within ordinary latency after 50,000 bulk items`.

## Real conditions

### `events/receiver-isolation`

While other subscriptions have receivers that do not answer, the server MUST start a healthy subscription's due delivery without waiting for those attempts to finish whenever the limits of `events/delivery-maker-share`, `events/delivery-maker-free`, `events/delivery-maker-headroom` and `events/delivery-maker-isolation` permit its attempt to start.

**Reason:** one attempt per subscription allows each subscription a turn without sharing a slow receiver's wait. Those limits hold a delivery back only for its maker's share of the 64 attempts the server runs at once and for that total, so a healthy subscription whose maker is within its share waits only while 64 attempts are in flight.

**Tests:** `compliance/webhook-delivery.test.ts › delivers promptly while eight other subscriptions never answer`.

### `events/delivery-maker-share`

While a subscription of another maker has a delivery due, the server MUST NOT start a delivery attempt for a maker that already has 8 or more attempts in flight.

**Reason:** a maker's receivers that answer slowly or never would otherwise take every slot the server has for attempts and delay every other maker's deliveries by the time an attempt takes to end. Attempts already in flight finish; the rule limits only what starts.

**Tests:** `compliance/webhook-delivery.test.ts › starts no ninth attempt of one maker while another maker's delivery is due`.

### `events/delivery-maker-free`

While no subscription of another maker has a delivery due, the server MUST start a due delivery of a maker that already has 8 or more attempts in flight whenever fewer than 56 attempts are in flight.

**Reason:** the share of `events/delivery-maker-share` protects a maker from the others and does not hold a maker back when no other maker waits.

**Tests:** `compliance/webhook-delivery.test.ts › lets a maker no other maker waits behind hold more than eight attempts in flight`.

### `events/delivery-maker-headroom`

While a maker has 8 or more delivery attempts in flight, the server MUST NOT start a further attempt for that maker whenever 56 or more attempts are in flight.

**Reason:** a maker alone holds at most 56 of the 64 attempts. The 8 attempts left over serve the first 8 attempts of the makers whose deliveries fall due later, in total and not for each maker. Attempts already in flight finish.

**Tests:** `compliance/webhook-delivery.test.ts › starts a later maker's delivery at once while one maker holds every attempt it may`.

### `events/delivery-maker-isolation`

While the subscriptions of one maker have receivers that do not answer, the server MUST start a due delivery of another maker's subscription without waiting for those attempts to finish whenever that other maker has fewer than 8 attempts in flight and fewer than 64 attempts are in flight.

**Reason:** the 8 attempts that the one maker leaves free are shared by every later maker. Once they are in flight, a delivery of a further maker starts when an attempt ends.

**Tests:** `compliance/webhook-delivery.test.ts › delivers promptly to a second maker while one maker's subscriptions never answer`, `compliance/webhook-delivery.test.ts › starts a later maker's delivery at once while one maker holds every attempt it may`, `compliance/webhook-delivery.test.ts › starts a third maker's delivery only when an attempt ends once two makers hold every attempt`.

## The audit log

`GET /audit` lists what the server recorded about the writes the events above announce, and about the exports it accepts.

Each entry names what it records in `action`. The table gives the `action` of each write the audit log records for items, edges, types, sources, keys, settings, webhooks, connectors, exports and tables, and of each job the server runs on itself, with the `kind` that `events/audit-kind` sorts it under. The actions of a sign-in, of an OAuth client and of the owner's account (its profile, its passkeys and its setup code) are not in it, and `events/audit-kind` sorts them by their first part.

| Action                       | Written when                                                                    | Kind           |
| ---------------------------- | ------------------------------------------------------------------------------- | -------------- |
| `item.create`                | A write creates an item.                                                        | `data`         |
| `item.update`                | A write changes an item.                                                        | `data`         |
| `item.tag`                   | A tag operation adds tags to an item.                                           | `data`         |
| `item.untag`                 | A tag operation removes a tag from an item.                                     | `data`         |
| `item.metadata.replace`      | A tag operation replaces the tags of an item.                                   | `data`         |
| `extension.set`              | A write sets an extension namespace of an item.                                 | `data`         |
| `extension.delete`           | A write deletes an extension namespace of an item.                              | `data`         |
| `item.transition`            | A transition moves an item to another state.                                    | `data`         |
| `item.delete`                | A delete moves an item to the bin.                                              | `data`         |
| `items.trash`                | A request moves items to the bin by their IDs.                                  | `data`         |
| `item.restore`               | A restore takes an item out of the bin.                                         | `data`         |
| `item.purge`                 | A purge destroys an item.                                                       | `data`         |
| `items.bulk`                 | A write of `POST /items/bulk` commits an entry or an atomic page.               | `data`         |
| `items.tombstones`           | A request settles the tombstones of a source's items.                           | `data`         |
| `edge.create`                | A write creates an edge.                                                        | `data`         |
| `edge.update`                | A write changes an edge.                                                        | `data`         |
| `edge.delete`                | A write deletes an edge.                                                        | `data`         |
| `edges.bulk`                 | A write of `POST /edges/bulk` commits an entry or an atomic page.               | `data`         |
| `rows.write`                 | A batch changes the rows of a table.                                            | `data`         |
| `rows.undo`                  | An undo puts back the rows a batch changed.                                     | `data`         |
| `type.register`              | A write registers a type.                                                       | `data`         |
| `type.replace`               | A write replaces a type.                                                        | `data`         |
| `type.delete`                | A write deletes a type.                                                         | `data`         |
| `type.icon.set`              | The owner sets the icon of a type.                                              | `data`         |
| `type.icon.clear`            | The owner clears the icon of a type.                                            | `data`         |
| `edge_type.register`         | A write registers an edge type.                                                 | `data`         |
| `edge_type.update`           | A write changes an edge type.                                                   | `data`         |
| `edge_type.delete`           | A write deletes an edge type.                                                   | `data`         |
| `source.update`              | A write changes a source.                                                       | `data`         |
| `export.run`                 | The server accepts an export.                                                   | `data`         |
| `restore_archive`            | The owner restores an archive.                                                  | `data`         |
| `blob.upload`                | A caller uploads a blob.                                                        | `data`         |
| `mcp.file_fetch`             | An MCP tool fetches a file from an address.                                     | `data`         |
| `items.bulk_action`          | A bulk action is queued.                                                        | `data`         |
| `items.bulk_action.chunk`    | A bulk action commits a chunk.                                                  | `data`         |
| `items.bulk_action.cancel`   | A queued bulk action is cancelled.                                              | `data`         |
| `key.create`                 | A key is created.                                                               | `access`       |
| `key.update`                 | A key is changed.                                                               | `access`       |
| `key.revoke`                 | A key is revoked.                                                               | `access`       |
| `owner.claimed`              | The owner claims the instance.                                                  | `access`       |
| `config.update`              | A write changes the instance's configuration.                                   | `settings`     |
| `webhook.create`             | A webhook is created.                                                           | `settings`     |
| `webhook.update`             | A webhook is changed.                                                           | `settings`     |
| `webhook.delete`             | A webhook is deleted.                                                           | `settings`     |
| `webhook.delivery.redeliver` | A failed delivery is queued again.                                              | `settings`     |
| `connector.register`         | A connector is registered.                                                      | `settings`     |
| `connector.delete`           | A connector is deleted.                                                         | `settings`     |
| `connector_state.delete`     | A connector's state is deleted.                                                 | `settings`     |
| `inbound_endpoint.create`    | An inbound endpoint is created.                                                 | `settings`     |
| `inbound_endpoint.retire`    | An inbound endpoint is retired.                                                 | `settings`     |
| `items.trash_purged`         | The trash retention job purges items that stayed in the bin past the retention. | `housekeeping` |
| `items.feed_expired`         | The feed expiry job moves expired feed items to the bin.                        | `housekeeping` |
| `item.versions_thinned`      | The version thinning job removes versions of an item.                           | `housekeeping` |
| `item.enrich`                | The enrichment sweep writes what it read from a file to an item.                | `housekeeping` |
| `keys.purged`                | The credential clean-up removes keys revoked long ago.                          | `housekeeping` |
| `blob.purge`                 | The blob orphan sweep purges a blob no item holds.                              | `housekeeping` |
| `blob.copy_struck`           | The server strikes a copy of a blob that a store lost or damaged.               | `housekeeping` |
| `blob.copy_dropped`          | A caller with `blobs.manage` drops a blob's copy from a store.                  | `housekeeping` |
| `blob.copy_replicated`       | The server places a copy of a blob in another store.                            | `housekeeping` |
| `auth.grants.purged`         | The credential clean-up removes grants withdrawn long ago.                      | `housekeeping` |
| `auth.grant.retired`         | The credential clean-up retires a grant left idle.                              | `housekeeping` |
| `auth.clients.purged`        | The credential clean-up removes idle OAuth clients that registered themselves.  | `housekeeping` |

### `events/audit-action-names`

When the server records an audit entry for a write or a job in the table above, the server MUST give the entry the `action` the table names for it.

**Reason:** a client filters `GET /audit` by `action` (`events/audit-filter`), and a second server that names an action otherwise answers a different log.

**Tests:** `compliance/audit.test.ts › records a write with the acting key, the resource and the action`, `› filters by action and resource type with an excluded control`, `› records export.run before the export's stream begins, and none for an export it refuses`, `compliance/audit-actions.test.ts › names each write of an item with the action the table gives it`, `› names a transition and a bulk write with the action the table gives it`, `› names each write of an edge and of an edge type with the action the table gives it`, `› names each write of a type with the action the table gives it`, `› names the writes of a key and of a webhook with the action the table gives it`, `› names the writes of a connector and of an upload with the action the table gives it`, `› names an export with the action the table gives it`, `compliance/type-icons.test.ts › records the owner's icon change in the audit log`, `compliance/audit-jobs.test.ts › records the enqueue and each committed chunk of a job, and nothing for a dry run`, `› records the cancellation of a queued job, and none for a cancel that changes nothing`.

### `events/audit-records-write`

When a credential's write commits, other than a connector's heartbeat, run report, hold, hold release, state write or agreement write, a folder-copy status report (`PUT /folders/{id}/status`), or an inbound delivery's receipt or handled mark, the server MUST record an entry at `GET /audit` naming the credential as `key_id` (`owner:<session ID>` for an owner browser session, `local:process` for the private local process), the `action`, the `resource_type`, the `resource_id` and the `details`.

**Tests:** `compliance/audit.test.ts › records a write with the acting key, the resource and the action`, `compliance/edge-events.test.ts › audit log records edge mutations with edge_id in resource_id`.

### `events/audit-server-writes`

When the server records an audit entry for a write of its own, with no credential behind it, the server MUST give the entry `key_id` `null`.

**Tests:** `compliance/audit-server-writes.test.ts › records the server's own writes with no key`.

### `events/audit-readable`

When the server answers a write with success, the server MUST already list the write's entry at `GET /audit`.

**Tests:** `compliance/audit.test.ts › records a write with the acting key, the resource and the action`, `› exposes each committed best-effort entry immediately with one operation context`.

### `events/audit-insert-fails`

If the server cannot record a write's audit entry, then the server MUST roll the write and its events back.

**Reason:** a change nobody can account for is worse than a refused one.

**Tests:** `compliance/write-faults.test.ts › is rolled back with its events, answers 500, and leaves the write after it to land`, `compliance/write-faults.test.ts › rolls back an entry of a page under atomic: false and reports it errored, while the entries around it land`.

### `events/audit-no-secrets`

The server MUST NOT put a credential value, a password, a verification identifier, an authorization code, a private signing key or a session cookie value in an audit entry's `details`.

**Tests:** `compliance/audit.test.ts › keeps every credential value out of the entries a key's and a webhook's writes leave`.

### `events/audit-atomic-page`

When an atomic bulk page commits, the server MUST record one `items.bulk` entry for the page rather than one for each of its entries.

**Tests:** `compliance/audit.test.ts › records one summary entry for an atomic bulk page, and none for a page that rolled back`.

### `events/audit-atomic-counts`

When the server records an atomic bulk page, the server MUST give the entry's `details` the page's `total`, `created`, `updated`, `skipped` and `errored` counts.

**Tests:** `compliance/audit.test.ts › records one summary entry for an atomic bulk page, and none for a page that rolled back`.

### `events/audit-atomic-rolled-back`

If an atomic bulk page rolls back, then the server MUST NOT record an entry for it.

**Tests:** `compliance/audit.test.ts › records one summary entry for an atomic bulk page, and none for a page that rolled back`.

### `events/audit-best-effort-entry`

When a best-effort bulk page commits an entry, the server MUST record an entry whose `details` carry the `operation_id` all the page's entries share and the entry's `index` in the request.

**Tests:** `compliance/audit.test.ts › exposes each committed best-effort entry immediately with one operation context`, `› records no entry for a best-effort entry that was skipped or refused`.

### `events/audit-best-effort-none`

When a best-effort bulk entry is skipped or refused, the server MUST NOT record an entry for it.

**Tests:** `compliance/audit.test.ts › records no entry for a best-effort entry that was skipped or refused`, `› exposes each committed best-effort entry immediately with one operation context`.

### `events/audit-best-effort-kept`

When a later entry of a best-effort page is refused, the server MUST keep the audit entries of the earlier entries it committed.

**Tests:** `compliance/audit.test.ts › exposes each committed best-effort entry immediately with one operation context`.

### `events/audit-job-enqueue`

When a bulk action is queued, the server MUST record an `items.bulk_action` entry with `details` naming the `sub_action`, the `matched` count and the `job_id`.

**Tests:** `compliance/audit-jobs.test.ts › records the enqueue and each committed chunk of a job, and nothing for a dry run`.

### `events/audit-job-dry-run`

When a bulk action runs with `dry_run`, the server MUST NOT record an entry for it.

**Tests:** `compliance/audit-jobs.test.ts › records the enqueue and each committed chunk of a job, and nothing for a dry run`.

### `events/audit-job-chunk`

When a bulk-action job commits a chunk of items, the server MUST record an `items.bulk_action.chunk` entry for it, whose chunks together walk the matched items from the first to the last once.

**Tests:** `compliance/audit-jobs.test.ts › records the enqueue and each committed chunk of a job, and nothing for a dry run`.

### `events/audit-job-cancel`

When a cancel of a queued bulk-action job changes its status, the server MUST record an `items.bulk_action.cancel` entry for it.

**Tests:** `compliance/audit-jobs.test.ts › records the cancellation of a queued job, and none for a cancel that changes nothing`.

### `events/audit-job-cancel-noop`

When a cancellation of a bulk-action job changes nothing, the server MUST NOT record an entry for it.

**Tests:** `compliance/audit-jobs.test.ts › records the cancellation of a queued job, and none for a cancel that changes nothing`.

### `events/audit-housekeeping-run`

When a caller authorized by `instance.maintain` or local authority runs a housekeeping job with `POST /housekeeping/{name}/run`, the server MUST NOT record an audit entry for the request.

**Tests:** `compliance/audit-jobs.test.ts › is not written to by POST /housekeeping/{name}/run, which runs a job the manager named`.

### `events/audit-export`

When the server accepts an export, the server MUST record an `export.run` entry with `resource_type` `export` and `details.format` before it begins the response's stream.

**Reason:** an export is a bulk extraction of the instance, so the record exists whether or not the stream that follows completes.

**Tests:** `compliance/audit.test.ts › records export.run before the export's stream begins, and none for an export it refuses`.

### `events/audit-export-refused`

If the server refuses an export, then the server MUST NOT record an `export.run` entry for it.

**Reason:** the entry represents an extraction attempt that was accepted.

**Tests:** `compliance/audit.test.ts › records export.run before the export's stream begins, and none for an export it refuses`.

### `events/audit-export-contention`

If the server cannot record an export's `export.run` entry because the write lock is held, then the server MUST answer `503 write_contention` before it begins the stream.

**Tests:** `compliance/write-contention.test.ts › refuses an export with 503 before its stream starts, and records nothing of it`.

### `events/audit-filter`

The server MUST filter `GET /audit` by `action`, `resource_type` and `resource_id`.

**Tests:** `compliance/audit.test.ts › filters by action and resource type with an excluded control`, `› records a write with the acting key, the resource and the action`.

### `events/audit-kind`

The server MUST filter `GET /audit` by `kind`, which sorts every entry into one of `access`, `data`, `settings` or `housekeeping` from its `action`, as the table of audit actions gives, and by the part of the `action` before its first period for an action the table does not list: `access` for `auth`, `owner`, `key`, `keys`, `instance`, `profile` and `folder`, `settings` for `config`, `webhook`, `connector`, `connector_state` and `inbound_endpoint`, and `data` for the rest, so that each entry is of exactly one kind.

**Reason:** `kind` lets a reader ask for one area of activity at a time. `access` holds sign-ins, accounts, keys, folders and the owner's profile; `settings` holds configuration, webhooks and connectors; `housekeeping` holds what Marfa does on its own; `data` holds the rest.

**Tests:** `compliance/audit.test.ts › sorts entries by kind, each into exactly one`.

### `events/audit-kind-invalid`

If `kind` is not one of `access`, `data`, `settings` or `housekeeping`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/audit.test.ts › refuses a kind it does not sort by`.

### `events/audit-search`

The server MUST filter `GET /audit` by `q` to the entries that hold every word of `q`, in any order and ignoring ASCII case, in their action, resource type, resource ID, key ID, client address or details.

**Tests:** `compliance/audit.test.ts › searches by every word, ignoring case and order`.

### `events/audit-bounds`

The server MUST bound `GET /audit` by `created_after` and `created_before`, both exclusive of an entry's own instant.

**Tests:** `compliance/audit.test.ts › bounds by created_after and created_before, both exclusive`.

### `events/audit-bound-precision`

The server MUST read a bound written at any precision as the instant it names.

**Tests:** `compliance/audit.test.ts › reads a bound at any precision, and refuses one that is not an instant`.

### `events/audit-bound-invalid`

If `created_after` or `created_before` is not an instant, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/audit.test.ts › reads a bound at any precision, and refuses one that is not an instant`.

### `events/audit-paged`

When `limit` cuts the audit listing short, the server MUST answer a `next_cursor` that, followed, reaches every entry once.

**Tests:** `compliance/audit.test.ts › paginates with a cursor and delivers every entry once`.

### `events/audit-limit-default`

When `GET /audit` names no `limit`, the server MUST answer the page that a `limit` of 50 answers.

**Tests:** `compliance/page-limits.test.ts › $door answers its default page where it names no limit`.

### `events/audit-limit-bounds`

If `GET /audit` names a `limit` that is not a whole number of 1 to 200, then the server MUST answer `400 validation_error` naming `limit`.

**Tests:** `compliance/page-limits.test.ts › $door refuses a limit of 0, a negative and a non-number, naming limit`, `› $door takes its largest page and refuses a limit past it or a fraction`.

### `events/audit-newest-first`

The server MUST list audit entries newest first.

**Tests:** `compliance/audit.test.ts › lists newest first`.

### `events/audit-needs-read`

If a credential without `audit.read` sends `GET /audit`, then the server MUST answer `403 forbidden`, before it checks the query.

**Tests:** `compliance/audit.test.ts › refuses a key without audit.read`, `› lists newest first`.

### `events/audit-undeclared-key`

If `GET /audit` names a query key the operation does not declare, then the server MUST answer `400 validation_error` with the key in `details.unknown_parameters`.

**Reason:** an undeclared bound answered with the whole trail would read exactly like a time range that matched every entry.

**Tests:** `compliance/audit.test.ts › refuses an undeclared bound rather than answering the whole trail`.

### `events/audit-unauthenticated`

If `GET /audit` carries no credential, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/audit.test.ts › refuses a request with no credential`.

### `events/audit-actor-snapshot`

When the server records an action by an authenticated sign-in, the server MUST retain the canonical sign-in ID, kind and readable name as the entry's `actor`, independently of later sign-in renaming or removal.

**Tests:** `compliance/audit.test.ts › records a write with the acting key, the resource and the action`.

### `events/audit-server-actor`

When the server records work performed without a request, the server MUST record the actor as `{ "kind": "server", "id": "server", "name": "Marfa" }`.

**Tests:** `compliance/audit-server-writes.test.ts › records the server's own writes with no key`.

### `events/audit-unknown-actor`

When a request has no authenticated sign-in, the server MUST record its actor as `null` rather than attribute it to a sign-in or to server-initiated work.

**Tests:** `compliance/credential-audit.test.ts › is in the audit log when the refusal of a failed sign-in answers`.
