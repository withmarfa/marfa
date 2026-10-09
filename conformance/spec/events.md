# Events

`GET /events` is a server-sent event stream of every mutation, resumable by cursor, and outbound webhooks deliver the same events to a URL. The audit log, which records the writes the events announce, closes the chapter.

Every rule about a stream is about the plain stream unless it says otherwise. The copy stream, `GET /events?edges=all&copy=1`, is `read-views/copy-bootstrap` and the rules after it in `read-views.md`. What a stream does when the server stops is `instance/stop-ends-streams` and the rules after it. The answer to a viewer past the instance's cap is `errors/stream-capacity`.

## Event types

Every event and stream frame the server sends is a row of the table below, which is written from the server's own event names and so cannot differ from them. An event is also the `event:` of its frame.

<!-- event-types-table:start -->

| Event                | Sent to              | When it is sent                                                                                 |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `item.created`       | Streams and webhooks | An item is created.                                                                             |
| `item.updated`       | Streams and webhooks | An item is updated.                                                                             |
| `item.deleted`       | Streams and webhooks | An item is moved to the bin.                                                                    |
| `item.restored`      | Streams and webhooks | An item in the bin is restored.                                                                 |
| `item.purged`        | Streams and webhooks | A trashed item is destroyed.                                                                    |
| `item.state_changed` | Streams and webhooks | An item moves to another lifecycle state.                                                       |
| `metadata.changed`   | Streams and webhooks | An item's tags or extensions change.                                                            |
| `edge.created`       | Streams and webhooks | An edge is created.                                                                             |
| `edge.updated`       | Streams and webhooks | An edge's properties change.                                                                    |
| `edge.deleted`       | Streams and webhooks | An edge is deleted.                                                                             |
| `stream_cursor`      | Streams              | First on every stream: where the log stood when the stream opened.                              |
| `stream_live`        | Streams              | Once the catch-up is over: everything up to its cursor has been sent, and what follows is live. |
| `stream_incomplete`  | Streams              | Last, when the stream can no longer deliver what it opened with.                                |
| `catchup_too_old`    | Streams              | Last, when the log no longer holds the events after the `Last-Event-ID` the client sent.        |
| `cursor_ahead`       | Streams              | Last, when the `Last-Event-ID` the client sent is past the latest event in the log.             |
| `read_view_changed`  | Streams              | Last on a copy stream, when its read view changes.                                              |

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

When one `GET /events` request meets more than one refusal, the server MUST answer the first of these: no usable credential, `401`; a credential whose type map reaches no type, `403`; `X-Marfa-Read-View`, `400`; a query key the operation does not declare and that does not start with an underscore, `400`; `type`, `400` or `403`; `edges`, `400`; `Last-Event-ID`, `400`; and a viewer past the instance's cap, `503`.

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

When a stream has sent the replay and the live frames held while it ran, the server MUST send `stream_live` before any frame after them.

**Reason:** `stream_live` is how a client learns it has caught up, and a frame the filter or the credential withheld means the last frame it was sent may be well behind the head.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-no-id`

The server MUST send `stream_live` without an `id:` line.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-cursor`

Where the server announced a head, the server MUST give the `cursor` of `stream_live` as a string at or past that head.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-skips-covered`

When a client resumes from the `cursor` of `stream_live`, the server MUST NOT send it what the replay covered, the events the filter or the credential withheld included.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-resumes-later`

When a client resumes from the `cursor` of `stream_live`, the server MUST send it every event written after the marker.

**Tests:** `sync/stream-contract.test.ts › marks the end of the replay with a cursor a filtered reader can resume from`.

### `events/stream-live-unknown-head`

If the server cannot read the log's head within its budget, and before `stream_live` the stream has neither read an event in a replay nor sent one, then the server MUST send `stream_live` with `cursor` `null`.

**Tests:** waiting on #1444.

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

**Tests:** waiting on #1444.

### `events/retention-prefix`

When the server retires events from the log, the server MUST retire an event only together with every event before it.

**Reason:** a hole in the middle of the log would let a cursor look valid while the events after it were gone.

**Tests:** `compliance/event-retention.test.ts › retires the oldest events together, never leaving a hole`.

### `events/retention-keeps-newest`

The server MUST NOT retire the newest event the log holds.

**Reason:** the oldest retained id is then always there for a reader to check a cursor against.

**Tests:** `compliance/event-retention.test.ts › keeps the newest event however old it is`.

## Order and exactly once

### `events/ids-ascending`

The server MUST send the event frames of one stream in ascending id order, edge frames among item frames, except for the live copy that `events/unreadable-row-live-copy` sends.

**Tests:** `sync/resume.test.ts › a reader that closes at the head and resumes from its last id misses nothing and repeats nothing`, `› a purge's edge.deleted frames carry lower ids than its item.purged frame, live and replayed`.

### `events/purge-edges-before-row`

When a purge announces the edges it took and the item, the server MUST give each `edge.deleted` a lower id than the `item.purged`, on the live stream and on a replay.

**Reason:** a purge announces the row's edges before the row.

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

When a stream has sent or replayed events up to an id, the server MUST NOT send it an event at or below that id again.

**Reason:** an archive restore announces its events after it commits, by which time a stream opened since may have replayed them from the log.

**Tests:** waiting on #1444.

### `events/unreadable-row-not-replayed`

If the log holds an event the server can no longer read, then the server MUST NOT replay it.

**Tests:** `compliance/stream-unreadable-rows.test.ts › does not replay an event it cannot read`.

### `events/unreadable-row-live-copy`

If the log holds an event the server can no longer read, then the server MUST send a subscriber connected when it was published its live copy after the replay, behind higher ids.

**Reason:** the live copy is the one carrier the event has left. It is the one place ids are not ascending.

**Tests:** waiting on #1444.

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

**Tests:** `sync/identity.test.ts › keeps the id a client mints for an item, on the row and on the event`, `sync/post-commit.test.ts › a write that rolls back announces nothing, while one that commits does`, `compliance/cascade-marks.test.ts › marks a row a cascade trashed with the row named, and no row trashed on its own`, `compliance/events-contract.test.ts › announces item.restored when a trashed item comes back`, `› announces item.state_changed on a lifecycle transition`, `sync/deletions.test.ts › announces a purge, so a client offline across it learns the row is gone`, `compliance/events-contract.test.ts › names the event in event_type on an item frame and on an edge frame`.

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

**Tests:** `compliance/cascade-marks.test.ts › names the row trashed only to a key that may read its type, and says a cascade took the row to any key that reads it`, `› names the row restored only to a key that may read its type`.

### `events/edge-events`

The server MUST send an edge event as `edge.created`, `edge.updated` or `edge.deleted`, with `event_type` naming it and `edge` holding the edge.

**Tests:** `compliance/edge-events.test.ts › SSE delivers edge.created and edge.deleted`, `compliance/events-contract.test.ts › announces edge.updated when an edge's properties change`, `› names the event in event_type on an item frame and on an edge frame`.

### `events/edge-source-type`

The server MUST carry on an edge event `source_type`, the type its source item had when the event was published.

**Reason:** `source_type` decides who is told about the event, and a purge takes the source row before the event is read.

**Tests:** `compliance/edge-events.test.ts › carries the source item's type on every edge frame`.

### `events/purged-with-only-purge`

The server MUST NOT carry `purged_with` on an `edge.deleted` for an edge deleted other than by a purge.

**Tests:** `compliance/cascade-marks.test.ts › names the purged item on each edge its purge took, and on no edge deleted by its own door`.

### `events/job-announced`

When a bulk action transitions an item, the server MUST send `item.state_changed` for it, to a live stream and on a replay.

**Tests:** `sync/replay.test.ts › announces what a bulk-action job changes to a live stream and to a replay`.

## Writes and their events

What a refused write leaves is `items/refusal-writes-nothing`.

### `events/commit-announces`

When a write commits, the server MUST send its event to the streams open at the time.

**Tests:** `sync/post-commit.test.ts › a write that rolls back announces nothing, while one that commits does`.

### `events/rollback-silent`

If a write rolls back, then the server MUST NOT send an event for it to any stream.

**Reason:** an event for a write that never happened tells a client about a row that does not exist.

**Tests:** `sync/post-commit.test.ts › a write that rolls back announces nothing, while one that commits does`.

### `events/rollback-not-logged`

If a write rolls back, then the server MUST NOT log an event for it, so a replay from before it carries none.

**Tests:** `sync/post-commit.test.ts › a write that rolls back leaves no event in the log, so a replay from before it carries none`.

### `events/contention-no-event`

If the server refuses a write with `503 write_contention`, then the server MUST NOT send or log an event for it.

**Reason:** a `5xx` tells the caller nothing was written, so it sends the write again, and an event for the refused write would announce a change that then happens twice.

**Tests:** `compliance/write-contention.test.ts › announces nothing and keeps no row for a write it refused with 503, on the stream open at the time and on a replay`.

### `events/committed-not-failed`

If a change has committed, then the server MUST NOT answer it with a `5xx` status.

**Reason:** a `5xx` tells the caller nothing was written, so it sends the change again. No idempotency key catches it, because an operation that takes one releases it on a `5xx` and the bulk operations take none.

**Tests:** waiting on #1444.

### `events/sweep-purge-announced`

When a retention job purges an item, the server MUST send `item.purged` for it.

**Reason:** the log's retention and the bin's are set independently, and a device resuming from a cursor inside the log's retention would otherwise keep a row the instance has dropped.

**Tests:** `compliance/event-retention.test.ts › announces item.purged for an item the retention job purges`.

### `events/sweep-purge-edges`

When a retention job purges an item, the server MUST send `edge.deleted` for each edge the item had, with `purged_with` naming the item.

**Tests:** `compliance/event-retention.test.ts › announces edge.deleted for each edge of an item the retention job purges, naming the item`.

### `events/keyed-repeat-silent`

When a request repeats under an `Idempotency-Key` the server kept the answer for, the server MUST NOT send a second event for it, on the create, update, edge create and delete operations.

**Tests:** `sync/idempotency.test.ts › announces nothing for a repeated request under a key, on the create, update, edge create and delete doors`.

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

### `events/edge-frame-no-source-type`

If an edge event carries no `source_type`, then the server MUST NOT send it to any subscriber or webhook.

**Reason:** a source the server cannot classify cannot be shown readable.

**Tests:** waiting on #1444.

## A stream and its credential

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

**Tests:** waiting on #1444.

### `events/credential-reconnect`

If a client opens `GET /events` with a key that has been revoked, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/stream-credential.test.ts › names the last event it sent in the cursor of credential_ended, and refuses a reconnect with the revoked key 401`.

## A reader that falls behind

### `events/reader-behind`

When a reader leaves 4 MiB or more of frames unread and a further live frame arrives, the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `reader_behind`.

**Reason:** a stalled reader would otherwise hold the server's memory. The reader reconnects from the frame's `cursor` and the replay serves the rest.

**Tests:** `compliance/stream-reader-behind.test.ts › is ended with reader_behind once it falls past the bound, and resumes from its cursor`.

### `events/reader-behind-resumes`

When a client resumes from the `cursor` of a `reader_behind` frame, the server MUST send it every event after that cursor.

**Tests:** `compliance/stream-reader-behind.test.ts › is ended with reader_behind once it falls past the bound, and resumes from its cursor`.

## How a stream ends

`stream_incomplete` ends a stream that can no longer deliver what it opened with. Everything after the event it names is still in the log, so the recovery is to reconnect from its `cursor`. `credential_ended` is `events/credential-revoked`, `reader_behind` is `events/reader-behind` and `server_stopping` is `instance/stop-stream-reason`.

### `events/incomplete-cursor`

When the server ends a stream with `stream_incomplete`, the server MUST give `cursor` as the id of the last event the stream sent, or `null` when it sent none.

**Tests:** `compliance/stream-credential.test.ts › names the last event it sent in the cursor of credential_ended, and refuses a reconnect with the revoked key 401`, `compliance/stream-reader-behind.test.ts › is ended with reader_behind once it falls past the bound, and resumes from its cursor`, `compliance/stream-shutdown.test.ts › names the last event the stream sent as the cursor of its closing frame`.

### `events/incomplete-no-id`

The server MUST send `stream_incomplete` without an `id:` line.

**Reason:** the same as `events/cursor-ahead-no-id`: an `id:` would become the cursor a reconnect resumes from.

**Tests:** `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`, `compliance/stream-reader-behind.test.ts › is ended with reader_behind once it falls past the bound, and resumes from its cursor`, `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `events/incomplete-closes`

When the server has sent `stream_incomplete`, the server MUST close the stream.

**Tests:** `compliance/stream-credential.test.ts › ends with credential_ended when the key is revoked, and sends nothing after`, `compliance/stream-reader-behind.test.ts › is ended with reader_behind once it falls past the bound, and resumes from its cursor`, `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `events/replay-failed`

If the server's read of the log's head fails when a stream opens, a read of the log fails while the stream replays, or the read of the stream's credential before a page of the replay fails, then the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `replay_failed`.

**Tests:** waiting on #1444.

### `events/live-delivery-failed`

If the read of a stream's credential at a heartbeat or before a batch of live frames fails, or the server cannot go on receiving the frames published for the stream, then the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `live_delivery_failed`.

**Tests:** waiting on #1444.

### `events/backlog-overflow`

If more than 500 live frames a stream would send are waiting before it sends `stream_live`, and either no replay is reading or one of them is a row the replay cannot read from the log, then the server MUST end the stream with a terminal `stream_incomplete` frame whose `reason` is `backlog_overflow`.

**Reason:** the frames a stream holds while it opens are bounded. A replay takes over held frames it can read again from the log, but an unreadable row's live copy is the one carrier its event has.

**Tests:** waiting on #1444.

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

**Tests:** `compliance/webhooks.test.ts › registers a subscription and returns the secret once`, `compliance/webhook-delivery.test.ts › shows a subscription as its id, url, events, type_filter, secret, active flag and two timestamps, and no more`.

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

The server MUST answer a subscription with exactly the members `id`, `url`, `events`, `type_filter`, `secret`, `active`, `created_at` and `updated_at`.

**Reason:** the subscription's position in the event log and its birth are not part of what an owner sees.

**Tests:** `compliance/webhook-delivery.test.ts › shows a subscription as its id, url, events, type_filter, secret, active flag and two timestamps, and no more`.

### `events/webhook-list`

When a credential holding `webhooks.manage` sends `GET /webhooks`, the server MUST answer the subscriptions the requesting key registered, or for a signed-in app those any token of its grant registered, with `next_cursor` `null`.

**Tests:** `compliance/webhooks.test.ts › answers a subscription another credential registered as an unknown id on every door`, `compliance/webhook-delivery.test.ts › shows a subscription as its id, url, events, type_filter, secret, active flag and two timestamps, and no more`.

### `events/webhook-update`

When `PATCH /webhooks/{id}` names `url`, `events`, `type_filter` or `active`, the server MUST change each in place, so that the next read answers it.

**Tests:** `compliance/webhooks.test.ts › updates the url, events, type filter and active flag in place`.

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

**Tests:** `compliance/webhooks.test.ts › delivers only the events whose item type a type_filter selects, declared subtypes and dotted children included`.

### `events/webhook-filter-edges`

When a subscription has a `type_filter`, the server MUST NOT hold the edge events it names to that filter.

**Tests:** `compliance/webhook-delivery.test.ts › delivers an edge event under a type_filter that selects neither of its items`.

## Who may use a subscription

### `events/webhook-needs-permission`

If a credential without `webhooks.manage` sends a request to a webhook operation, then the server MUST answer `403 forbidden` with `details.required_scope` `webhooks.manage`, before it checks anything else the request names.

**Tests:** `compliance/webhooks.test.ts › refuses a key without webhooks.manage`.

### `events/webhook-unauthenticated`

If a request to a webhook operation carries no credential, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `compliance/webhooks.test.ts › refuses every door without a credential`.

### `events/webhook-any-reach`

When a credential holding `webhooks.manage` registers a subscription, the server MUST accept it whatever types the credential may read.

**Tests:** `compliance/webhooks.test.ts › delivers to a credential that reads part of what is stored only that part`.

### `events/webhook-owner-only`

When a request names a subscription that neither the requesting key nor the requesting app's grant registered, the server MUST answer `404 webhook_not_found` on `GET`, `PATCH`, `DELETE` and the delivery log.

**Reason:** to another credential the subscription is an id nobody holds.

**Tests:** `compliance/webhooks.test.ts › answers a subscription another credential registered as an unknown id on every door`.

### `events/webhook-redeliver-owner-only`

When a redelivery names a subscription that neither the requesting key nor the requesting app's grant registered, the server MUST answer `404 webhook_not_found`.

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

**Tests:** `compliance/webhooks.test.ts › does not deliver an event outside the subscription`.

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

The server MUST carry `delivery_id` in a delivery's body, equal to the `id` of the delivery's row in `GET /webhooks/{id}/deliveries` and the same on every attempt.

**Tests:** `compliance/webhooks.test.ts › delivers a matching event to the URL with a verifiable signature`, `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`.

### `events/delivery-at`

The server MUST carry `delivered_at` in a delivery's body, as the instant of that attempt.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

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

**Tests:** `compliance/cascade-marks.test.ts › delivers the item.deleted of a row a cascade trashed with its mark, and the row trashed's own without one`, `compliance/webhook-delivery.test.ts › delivers the marks of a stream frame, naming another row only to an owner who may read its type`, `› sends no edge.deleted for an edge a purge took to an owner who may not read the purged item's type, and sends it for a type the owner reads`.

### `events/delivery-marks-named`

When a delivery carries a mark that names another row, the server MUST name it only where the subscription's credential may read that row's type.

**Tests:** `compliance/webhook-delivery.test.ts › delivers the marks of a stream frame, naming another row only to an owner who may read its type`.

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

## Retries

A delivery is attempted again when its receiver does not take it. A caller with `instance.maintain`, or direct owner or local authority, can run `webhook-poll` at once (`housekeeping/run-now`), which attempts every delivery whose wait has ended.

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

**Tests:** waiting on #1444.

### `events/retry-schedule`

When a receiver answers every attempt with a retryable failure, the server MUST make eight attempts, with seven waits of 1, 5, 25, 125, 625, 3125 and 15625 seconds between them, and then record the delivery `dead_letter`.

**Tests:** waiting on #1444.

### `events/retry-poll-run`

When a caller authorized by `instance.maintain` or direct owner or local authority runs `webhook-poll`, the server MUST attempt each pending delivery whose wait has ended.

**Tests:** `compliance/webhook-delivery.test.ts › leaves a delivery pending after a 500 and retries it with the same ids`, `› waits for the Retry-After a receiver names, and never less than the ordinary wait`.

### `events/retry-restart-once`

When the server stops while it schedules deliveries and starts again, the server MUST queue exactly one delivery for each event and each subscription entitled to it.

**Tests:** waiting on #1444.

## Settling a delivery unsent

### `events/cancel-edited`

When a subscription is pointed at another URL or turned off, the server MUST settle its pending deliveries unsent, so that none goes to the old address.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`.

### `events/cancel-deleted`

When a subscription is deleted, the server MUST send none of its pending deliveries.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`.

### `events/cancel-record`

When the server settles a delivery unsent, the server MUST record it `canceled` with `succeeded` false, the reason in `error`, and the `status_code` and `attempt` it had.

**Tests:** `compliance/webhook-delivery.test.ts › settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer`, `› settles a pending delivery unsent when the credential is narrowed away from its type`, `› settles a pending delivery unsent when its key no longer holds webhooks.manage`.

## Redelivery

### `events/redeliver-accepted`

When the credential that owns a subscription sends `POST /webhooks/{id}/deliveries/{delivery_id}/redeliver` for a `dead_letter` delivery, the server MUST answer `202` with that delivery as `pending`, keeping its `id`, `status_code` and `attempt`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

### `events/redeliver-current`

When the server redelivers a delivery, the server MUST send it to the subscription's current `url`, signed under its current secret, with the same `event_id` and `delivery_id` and a new `delivered_at`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

### `events/redeliver-not-failed`

If a redelivery names a delivery that is `pending`, `success` or `canceled`, then the server MUST answer `409 conflict`.

**Reason:** a delivered or canceled delivery keeps no frame to send again.

**Tests:** `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`.

### `events/redeliver-refused-keeps`

If the server refuses a redelivery, then the server MUST leave the delivery's `status` and `attempt` as they were.

**Tests:** `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`, `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

### `events/redeliver-inactive`

If a redelivery names a delivery of a subscription that is not active, then the server MUST answer `409 conflict`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

### `events/redeliver-missing`

If a redelivery names a delivery the subscription does not hold, then the server MUST answer `404 webhook_not_found`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

### `events/redeliver-once`

When two redeliveries of one delivery arrive together, the server MUST accept one with `202` and answer the other `409 conflict`.

**Tests:** `compliance/webhook-delivery.test.ts › queues one transition when a redelivery is requested twice at once, and records one audit entry`.

### `events/redeliver-fresh-cycle`

When a receiver answers every attempt of a redelivered delivery with a retryable failure, the server MUST make eight attempts after the redelivery before it records the delivery `dead_letter` again.

**Tests:** `compliance/webhook-history.test.ts › starts a fresh cycle of attempts on redelivery`.

### `events/redeliver-audit`

When the server accepts a redelivery, the server MUST record a `webhook.delivery.redeliver` entry with `resource_type` `webhook_delivery`, the delivery's id as `resource_id` and the subscription's id as `details.webhook_id`.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`.

### `events/redeliver-refused-no-audit`

If the server refuses or duplicates a redelivery, then the server MUST NOT record a `webhook.delivery.redeliver` entry for it.

**Tests:** `compliance/webhooks.test.ts › redelivers a retained failed row to the current address with stable identity`, `compliance/webhook-delivery.test.ts › refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted`, `› queues one transition when a redelivery is requested twice at once, and records one audit entry`.

### `events/redeliver-audit-fails`

If the server cannot record a redelivery's audit entry, then the server MUST leave the failed delivery unchanged.

**Tests:** waiting on #1444.

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

Where the instance does not allow private addresses, if `POST /webhooks` names a `url` whose host is an address that is not public, such as loopback, private, link-local, unique-local, carrier-grade NAT, unspecified or multicast, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhook-addresses.test.ts › refuses a subscription naming a loopback, private or link-local address`, `› refuses a subscription naming a unique-local, carrier-grade NAT, unspecified or multicast address`.

### `events/address-mapped`

Where the instance does not allow private addresses, the server MUST judge an IPv4 address written as IPv6 as the IPv4 address it carries.

**Tests:** `compliance/webhook-addresses.test.ts › refuses a subscription naming a loopback, private or link-local address`.

### `events/address-update`

Where the instance does not allow private addresses, if `PATCH /webhooks/{id}` names a `url` whose host is an address that is not public, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/webhook-addresses.test.ts › refuses to point a subscription at an address that is not public, leaving the stored url`.

### `events/address-name-unsent`

Where the instance does not allow private addresses, if a subscription's `url` names a host that resolves, at the attempt, to any address that is not public, then the server MUST NOT contact it.

**Reason:** a name that resolved to a public address at registration can resolve to a private one later.

**Tests:** `compliance/webhook-addresses.test.ts › sends nothing to a name that resolves to loopback, and records why`.

### `events/address-name-recorded`

Where the instance does not allow private addresses, if a subscription's `url` names a host that resolves to any address that is not public, then the server MUST record `The receiver's address is not public.` as the delivery's `error`.

**Tests:** `compliance/webhook-addresses.test.ts › sends nothing to a name that resolves to loopback, and records why`.

### `events/address-resolved-once`

Where the instance does not allow private addresses, the server MUST connect to the address it checked and not resolve the name again.

**Reason:** a second resolution could move the connection to an address that is not public.

**Tests:** waiting on #1444.

## When delivery starts

### `events/webhook-starts-after-creation`

When a subscription is registered, the server MUST NOT deliver an event written before it.

**Reason:** a subscription receives no earlier events merely because scheduling lagged.

**Tests:** `compliance/webhook-delivery.test.ts › sends a subscription no event written before it was registered`.

### `events/schedule-fails-visibly`

If the log's position for scheduling webhooks is ahead of the log, missing on a log that holds events, or behind the oldest event the log retains, then the server MUST end each run of `webhook-schedule` with `last_outcome` `error`.

**Reason:** a gap the scheduler cannot account for would otherwise skip events that fan out without saying so.

**Tests:** `compliance/webhook-schedule-gap.test.ts › ends a webhook-schedule run with error when its log position cannot be accounted for`.

## The audit log

`GET /audit` lists what the server recorded about the writes the events above announce, and about the exports it accepts.

### `events/audit-records-write`

When a credential's write commits, other than a connector's heartbeat, run report, hold, hold release, state write or agreement write, or an inbound delivery's receipt or handled mark, the server MUST record an entry at `GET /audit` naming the credential as `key_id`, the `action`, the `resource_type`, the `resource_id` and the `details`.

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

**Tests:** waiting on #1444.

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

When a bulk-action job commits a chunk of rows, the server MUST record an `items.bulk_action.chunk` entry for it, whose chunks together walk the matched rows from the first to the last once.

**Tests:** `compliance/audit-jobs.test.ts › records the enqueue and each committed chunk of a job, and nothing for a dry run`.

### `events/audit-job-cancel`

When a cancel of a queued bulk-action job changes its status, the server MUST record an `items.bulk_action.cancel` entry for it.

**Tests:** `compliance/audit-jobs.test.ts › records the cancellation of a queued job, and none for a cancel that changes nothing`.

### `events/audit-job-cancel-noop`

When a cancellation of a bulk-action job changes nothing, the server MUST NOT record an entry for it.

**Tests:** `compliance/audit-jobs.test.ts › records the cancellation of a queued job, and none for a cancel that changes nothing`.

### `events/audit-housekeeping-run`

When a caller authorized by `instance.maintain` or direct owner or local authority runs a housekeeping job with `POST /housekeeping/{name}/run`, the server MUST NOT record an audit entry for the request.

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

### `events/audit-bounds`

The server MUST bound `GET /audit` by `created_after` and `created_before`, both exclusive of a row's own instant.

**Tests:** `compliance/audit.test.ts › bounds by created_after and created_before, both exclusive`.

### `events/audit-bound-precision`

The server MUST read a bound written at any precision as the instant it names.

**Tests:** `compliance/audit.test.ts › reads a bound at any precision, and refuses one that is not an instant`.

### `events/audit-bound-invalid`

If `created_after` or `created_before` is not an instant, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/audit.test.ts › reads a bound at any precision, and refuses one that is not an instant`.

### `events/audit-paged`

When `limit` cuts the audit listing short, the server MUST answer a `next_cursor` that, followed, reaches every row once.

**Tests:** `compliance/audit.test.ts › paginates with a cursor and delivers every row once`.

### `events/audit-newest-first`

The server MUST list audit entries newest first.

**Tests:** `compliance/audit.test.ts › lists newest first`.

### `events/audit-needs-read`

If a credential without `audit.read` sends `GET /audit`, then the server MUST answer `403 forbidden`, before it checks the query.

**Tests:** `compliance/audit.test.ts › refuses a key without audit.read`, `› lists newest first`.

### `events/audit-undeclared-key`

If `GET /audit` names a query key the operation does not declare, then the server MUST answer `400 validation_error` with the key in `details.unknown_parameters`.

**Reason:** an undeclared bound answered with the whole trail would read exactly like a time range that matched every row.

**Tests:** `compliance/audit.test.ts › refuses an undeclared bound rather than answering the whole trail`.

### `events/audit-unauthenticated`

If `GET /audit` carries no credential, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/audit.test.ts › refuses a request with no credential`.
