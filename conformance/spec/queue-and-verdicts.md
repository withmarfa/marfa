# The queue and its verdicts

A device does not write to the server directly. It writes to its working copy, queues the write, and drains the queue when it can. The server's answer to each queued write gives the write one of six verdicts: `accepted`, `merged`, `conflicted`, `refused`, `blocked` or `dead`.

`device.md` states the working copy the queue writes into, and the answers the scripted server gives that the real server cannot be made to give; `device/fidelity.test.ts` holds every scripted answer the real server can also give to the real one. The server behavior a verdict is read from is in `versions.md`, `items.md`, `edges.md` and `errors.md`. The command runs each drain in a process of its own, so a fixture that drains more than once drains across a restart of the device.

## The queue

A device queues a write before it sends it, and the queue outlives the process that made it.

### `queue-and-verdicts/queue-survives-restart`

When the process that queued a write ends before the write is answered, a device MUST report the same write, with the same id and idempotency key, to the next process that opens the store.

**Reason:** a write a caller was told was queued, and that went with the process, would be lost with nothing to say so.

**Tests:** `device/queue.test.ts › keeps the queue across a restart`.

### `queue-and-verdicts/queue-sends-in-order`

When a drain sends more than one queued write, a device MUST send them in the order they were queued.

**Reason:** a write held for a write ahead of it is not sent in that drain, so a later write that waits on nothing goes before it.

**Tests:** `device/queue.test.ts › sends queued writes in the order they were queued`, `› drains in order on reconnect`.

### `queue-and-verdicts/queue-while-offline`

While the server cannot be reached, a device MUST queue a write a caller asks for, as it does while the server can be reached.

**Tests:** `device/queue.test.ts › queues writes while the server is unreachable`.

### `queue-and-verdicts/queue-before-hydration`

A device MUST report its queue from a store that has never been hydrated.

**Reason:** the queue is a record of what a caller asked for, not a view on the copy, and the moment a caller most needs it is the moment the server cannot be reached.

**Tests:** `device/queue.test.ts › reports an empty queue on a store that has never been written to`.

### `queue-and-verdicts/unanswered-no-verdict`

A device MUST report a write that no drain has sent, held or settled, or whose last attempt met an environmental failure, with no verdict.

**Reason:** no verdict is the absence of one, not a seventh verdict; an environmental failure adds no refusal to the write's count (`queue-and-verdicts/environmental-uncounted`).

**Tests:** `device/queue.test.ts › queues writes while the server is unreachable`, `device/classification.test.ts › retries an environmental failure past the ceiling without counting it`.

### `queue-and-verdicts/kinds-closed`

A device MUST queue each write as exactly one of these kinds: `create_item`, `update_item`, `delete_item`, `restore_item`, `transition_item`, `create_edge`, `update_edge`, `delete_edge`, `replace_metadata`, `merge_metadata`, `add_tag`, `remove_tag`, `write_extension`, `delete_extension` and `upload_blob`.

**Reason:** a purge is sent at once or refused, never queued (`device/purge-unqueued` and `device/purge-at-once`), and a bulk operation is the server's way of doing many things in one request, not a write a device holds.

**Tests:** `device/queue.test.ts › holds one kind per write, from the closed set`.

### `queue-and-verdicts/sidecars-own-writes`

A device MUST queue an edge write, a tag write, a metadata write and an extension write each as a write of its own, answered with a verdict of its own.

**Reason:** none of them is part of an item's properties, so none of them collides with an edit to those properties: a title changed on one device and a tag added on another both land.

**Tests:** `device/queue.test.ts › queues an edge, a tag and an extension as writes of their own`, `› reads the answer its own door gives, not an item's`.

### `queue-and-verdicts/create-tags-own-writes`

When a caller creates an item naming tags, a device MUST queue one `add_tag` write for each tag, each depending on the create.

**Tests:** `device/queue.test.ts › queues an edge, a tag and an extension as writes of their own`.

### `queue-and-verdicts/create-body-no-tags`

When a drain sends a create whose caller named tags, a device MUST send the create's body without `tags`.

**Reason:** a create carrying its tags would be answered with one verdict for the item and its tags, and a device could not say which of them landed.

**Tests:** `device/queue.test.ts › queues an edge, a tag and an extension as writes of their own`.

### `queue-and-verdicts/door-answer-read`

When the server answers a write with the success its own operation gives, whether a row, an edge, the tags or extensions it changed, `{"ok": true}` or the hash of the bytes an upload sent, a device MUST give the write a verdict without counting a refusal against it.

**Reason:** a tag, a metadata write, an extension, an edge or a delete read against an item's shape would be counted as an answer the device cannot read, sent again, and made `dead` at the ceiling, although the server took it.

**Tests:** `device/queue.test.ts › reads the answer its own door gives, not an item's`, `› queues an upload and sends its bytes when it drains`.

### `queue-and-verdicts/whole-values-sent`

When a drain sends an update, a device MUST send each property the update names with the whole value its caller gave.

**Reason:** a device does not merge inside a property, and it does not assume the server will: whether a body is ever merged line by line is not settled.

**Tests:** `device/verdicts.test.ts › answers about whole fields, never about part of one`.

### `queue-and-verdicts/local-read-shows-write`

While a write is unanswered, a device MUST answer a local read and a local search with the row as the write leaves it.

**Tests:** `device/queue.test.ts › shows an unanswered local write to a local read`.

## Idempotency keys

A queued write carries an idempotency key, so the server answers a repeat of it from its record instead of writing it twice (`items/idempotency-replay`).

### `queue-and-verdicts/key-minted-at-queue`

When a caller queues a write, a device MUST give it an idempotency key at once and report the key in the queue.

**Reason:** a key minted for each send would let a retry of a write whose answer was lost write it twice.

**Tests:** `device/queue.test.ts › keeps the queue across a restart`, `› retries under the key it was queued with, and is answered from the record rather than written twice`.

### `queue-and-verdicts/key-kept-on-retry`

When a drain sends a write again that it sent before, a device MUST send it under the idempotency key it carried, unless a caller released it in between.

**Reason:** an attempt whose answer the device never read may have taken effect, and only the same key lets the server answer the next attempt from its record. A release mints a fresh key (`queue-and-verdicts/release-fresh-key`).

**Tests:** `device/queue.test.ts › retries under the key it was queued with, and is answered from the record rather than written twice`, `device/contract.test.ts › ends a drain on an answer from another contract, and sends the write again under its key`, `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`, `device/versioned-deletes-live.test.ts › replays a lost delete answer without deleting a restored newer item`.

### `queue-and-verdicts/sent-write-unchanged`

A device MUST NOT change the body, the version or the idempotency key of a write once it has sent the write, short of a release.

**Reason:** a server that answers the key from its record would refuse a changed body as the key reused, and a delete moved onto a later version after its first attempt could remove a row the person never saw.

**Tests:** `device/queue.test.ts › never changes the body of an edit that went out unanswered when a write ahead of it lands`, `device/versioned-deletes-live.test.ts › replays a lost delete answer without deleting a restored newer item`.

### `queue-and-verdicts/replayed-reported`

When the server answers a write with `Idempotency-Replayed: true`, or with `acknowledged: true` in its body, a device MUST report the write's verdict as replayed.

**Reason:** a caller can then tell a write that landed now from one that had already landed.

**Tests:** `device/queue.test.ts › retries under the key it was queued with, and is answered from the record rather than written twice`, `› sends an edit of its own create on the version that create made where the server answers a repeat of it`.

## The version a write carries

An update names the version it was made against, and a delete names the version it removes, so the server can tell whether the row has moved since (`versions.md`).

### `queue-and-verdicts/update-needs-version`

If a caller queues an update that names no version, then a device MUST refuse it, queueing and sending nothing.

**Reason:** the server refuses an update that names no version (`versions/update-version-missing` and `edges/update-version-required`), so a device that sent one would learn only later that it could never land.

**Tests:** `device/queue.test.ts › refuses an update queued with no version`.

### `queue-and-verdicts/update-version-held`

If a caller queues an update naming a version other than the one the copy holds, and does not say it was read, then a device MUST refuse it `invalid`, queueing nothing.

**Reason:** nothing then tells a version read from a guess. An update said to be read follows `queue-and-verdicts/as-read-sent-on-read`.

**Tests:** `device/queue.test.ts › sends an edit on the earlier version it says it read, where the copy has caught up since`, `› refuses an update on a version the copy does not hold, queueing nothing`.

### `queue-and-verdicts/create-version-sent`

When a drain sends a create whose caller named a version, a device MUST send that version in the create's body.

**Reason:** a create carrying a version is conditional on it where its natural key resolves a live row (`versions/create-stale-merges`).

**Tests:** `device/queue.test.ts › sends a create with the version it was based on`.

### `queue-and-verdicts/create-no-version`

When a drain sends a create whose caller named no version, a device MUST send the create with no `version`.

**Reason:** the server assigns every version, so a version the device supplied would be one it made up.

**Tests:** `device/queue.test.ts › sends a create with the version it was based on`.

### `queue-and-verdicts/delete-sends-version`

When a drain sends a delete, a device MUST send as its `version` the version of the row the copy held when the delete was queued, or the version a later answer moved it onto under `queue-and-verdicts/delete-follows-answer`.

**Reason:** the server refuses a delete whose version the row has left (`items/delete-version`), so a delete never removes content its person never saw.

**Tests:** `device/versioned-deletes-live.test.ts › guards a queued delete through %s`, `› replays a lost delete answer without deleting a restored newer item`.

### `queue-and-verdicts/delete-follows-answer`

When this device's earlier write of a row is answered `accepted` or `merged` with the row at a version past that of a later unsent delete of the row, holding the content the delete read or being the first answer to this device's own create, a device MUST send the delete on the version of that answer.

**Reason:** the content the delete was made against is then exactly what the row holds. The content compared is the properties, type, tier, source, natural key, time and schema version; a first answer to this device's own create confirms the fields the server fills in, which the delete takes from it.

**Tests:** `device/versioned-deletes-live.test.ts › guards a queued delete through %s`.

### `queue-and-verdicts/delete-unseen-content-kept`

When an answer to an earlier write of a row carries content its later unsent delete did not read, a device MUST leave the delete on the version it carried.

**Reason:** the server then refuses the delete, and content another device wrote is not put in the bin by a person who never saw it.

**Tests:** `device/versioned-deletes-live.test.ts › guards a queued delete through %s`.

### `queue-and-verdicts/delete-unconfirmed-refused`

If a delete comes to be sent with no version the server confirmed, then a device MUST refuse it without sending it.

**Reason:** a delete of this device's own create that the server answered as a repeat holds only the placeholder version a local create carries, which no server mints.

**Tests:** `device/queue.test.ts › refuses unsent a delete whose version no answer confirmed`.

### `queue-and-verdicts/merge-null-leaves`

Where the copy's catalog holds an item's type, when a caller queues an update that merges and carries a null for a property the type does not require, a device MUST leave that property as the copy holds it.

**Reason:** the server leaves such a property untouched (`items/update-null-merge`), so a copy that cleared it would show what the server never holds.

**Tests:** `device/null-properties-live.test.ts › leaves a property a merging null names, as the server does`, `device/versioned-deletes-live.test.ts › guards a queued delete through %s`.

### `queue-and-verdicts/replace-null-clears`

When a caller queues an update based on the version the copy holds that sends its properties whole and carries a null for a property, a device MUST show that property cleared.

**Reason:** the server takes a null under properties sent whole as a property left out (`items/update-null-replace`).

**Tests:** `device/versioned-deletes-live.test.ts › guards a queued delete through %s`.

### `queue-and-verdicts/update-sends-nulls`

When a drain sends an update that carries a null, a device MUST send the null as its caller gave it.

**Reason:** the server judges the value, so the queued request keeps what the caller gave rather than what the copy shows.

**Tests:** `device/queue.test.ts › sends a null an update carries as its caller gave it`.

### `queue-and-verdicts/update-asks-auto`

When a drain sends an update of an item, a device MUST send it with `conflict=auto`.

**Reason:** a device resolves nothing itself (`device/conflict-blocked`); the flag asks the server to resolve in the same write rather than refuse.

**Tests:** `device/queue.test.ts › sends every update with the server asked to resolve`.

## Writes that wait for other writes

A write depends on the create of the row or edge it names, and follows the write queued ahead of it to the same row or edge. A drain does not send a write while either holds it.

### `queue-and-verdicts/depends-on-create`

When a caller queues a write to a row whose create from this device has no verdict, is `blocked` or `dead`, or was refused onto a row its natural key names that no read has found yet, a device MUST name that create in the write's `depends_on`.

**Reason:** the server holds no such row yet. A write sent past a blocked create is refused `item_not_found`, after which the copy forgets the row the write was queued against.

**Tests:** `device/queue.test.ts › holds a write whose create has not been answered`, `› holds a write made to a refused create's row until a read finds the row its natural key names`, `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/edge-depends-on-ends`

When a caller queues an edge create, a device MUST name in its `depends_on` the create from this device of each of its ends that has no verdict, is `blocked` or `dead`, or was refused onto a row its natural key names that no read has found yet.

**Tests:** `device/queue.test.ts › waits for the creates of both ends of an edge it creates`, `› holds a write made to a refused create's row until a read finds the row its natural key names`, `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/edge-write-depends-on`

When a caller queues an update or a delete of an edge whose create from this device has no verdict, or is `blocked` or `dead`, a device MUST name that create in the write's `depends_on`.

**Tests:** `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/held-for-dependency`

While a write names in `depends_on` a write that has no verdict or is `blocked`, or a create refused onto a row its natural key names that no read has found yet, a device MUST NOT send it in a drain.

**Tests:** `device/queue.test.ts › waits for the creates of both ends of an edge it creates`, `› goes on with the queue while a refused create's natural-key target cannot be read`, `› holds a write made to a refused create's row until a read finds the row its natural key names`.

### `queue-and-verdicts/held-reason`

When a drain comes to a write whose `follows` names a write the drain held, or sent without an answer, in that pass, or whose first write in `depends_on` not answered `accepted`, `merged` or `conflicted` has no verdict, is `blocked`, is missing from the queue, or is a create refused onto a row its natural key names that no read has found yet, a device MUST give it the verdict `blocked` with the reason `awaiting_dependency`.

**Tests:** `device/queue.test.ts › holds a write whose create has not been answered`, `› holds an edit behind one that went out unanswered, and sends it on that answer`, `› sends a delete of a row only once the edits of it ahead are answered`.

### `queue-and-verdicts/binding-shows-waiting`

Where an app reads the queue through a binding, a device MUST present a write blocked `awaiting_dependency` as waiting, with no verdict.

**Reason:** nothing outside the queue has to change for such a write to go, and an app showing each verdict would show an ordinary wait as a stop.

**Tests:** waiting on #1890.

### `queue-and-verdicts/held-released-same-pass`

When the last write a held write depends on is answered `accepted`, `merged` or `conflicted` in a drain, a device MUST send the held write in that drain, the write it follows allowing.

**Reason:** a held write is released by the write it waits for being answered, and by nothing a caller does.

**Tests:** `device/classification.test.ts › releases a held write when its dependency is answered`.

### `queue-and-verdicts/dependency-refused`

When a drain that has not ended and has confirmed the server's instance comes to a write that the write it follows does not hold, and the first write in its `depends_on` not answered `accepted`, `merged` or `conflicted` is `refused` or `dead` and is not a create refused onto a row its natural key names that no read has found yet, a device MUST give it the verdict `refused` without sending it, with a reason naming the kind of the write it waited for and that write's verdict.

**Reason:** nothing that depended on a row the server never took is sent.

**Tests:** `device/verdicts.test.ts › refuses the writes that were waiting on a create the server refused`, `device/classification.test.ts › counts the writes it settled without sending apart from those the server answered`, `device/waiting-projections.test.ts › shows an unsent dependent edit as soon as its dead create is released`.

### `queue-and-verdicts/follows-write-ahead`

When a caller queues a write to a row or an edge, a device MUST name in the write's `follows` the latest earlier write to that row or edge that has no verdict, or is `refused`, `blocked` or `dead`.

**Reason:** a refused write counts, because one the drain refused without sending can still be released.

**Tests:** `device/queue.test.ts › names in follows the write ahead that was refused, and none that was accepted`, `› sends a delete of a row only once the edits of it ahead are answered`, `› holds an edit behind one the server failed to answer, even one queued while that was blocked`, `› sends an edge edit behind a blocked or refused one as it stands`.

### `queue-and-verdicts/held-behind-ahead`

While the write a write follows has no verdict, or is `blocked` with the reason `awaiting_dependency` or `credential_refused`, a device MUST NOT send the later write.

**Reason:** sent beside an edit that had no answer, an edit would go on the version both were queued against, and a body sent under its key is never moved afterwards; a delete would put the row in the bin before the edits ahead of it reached it. A credential refusal can hide the answer to a write the server already committed, so the write behind it keeps its body unsent until that answer arrives.

**Tests:** `device/queue.test.ts › holds an edit behind one that went out unanswered, and sends it on that answer`, `› holds an edit behind one the server failed to answer, even one queued while that was blocked`, `› sends a delete of a row only once the edits of it ahead are answered`, `› holds a second metadata replace, and a restore, behind the write of the row ahead that had no answer`, `› holds an edit behind a dead one released and sent again without an answer`, `device/grant-recovery.test.ts › holds a later edit while an earlier receipt lacks a grant after catch-up to %s`, `device/edge-replay.test.ts › keeps an edge receipt safe with grant blocked $grantBlocked and catch-up version $caughtUpVersion`, `device/folders-placement.test.ts › holds a file's second move behind its first, which had no answer, though the bytes between them are refused`, `› holds a file's move behind an edit of its bytes that waits on their upload`, `› holds a file's move behind an edit of its bytes that cannot be opened for now`, `device/classification.test.ts › holds a write behind a create blocked with another for a source its key does not claim`.

### `queue-and-verdicts/answer-frees-follower`

When the write a write follows is answered `accepted`, `merged`, `conflicted` or `refused`, is `blocked` for a reason other than `awaiting_dependency` or `credential_refused`, or is `dead`, a device MUST NOT hold the later write for it.

**Reason:** `follows` orders writes and decides nothing else: an edit behind a refused or blocked edit of the same edge still goes, and the server judges it.

**Tests:** `device/queue.test.ts › sends an edge edit behind a blocked or refused one as it stands`, `› sends an edge edit queued behind two blocked ones, which hold nothing`, `› holds an edit behind one the server answered unreadably, and sends it as it stands once that one is dead`.

### `queue-and-verdicts/keyed-create-follows-row`

When a caller queues a create carrying the natural key of a row the copy holds under another id, a device MUST name in the create's `follows` the latest write to that row that has no verdict, or is `refused`, `blocked` or `dead`.

**Reason:** the server lands such a create on that row (`items/natural-key-upsert`), so it is a write to the row.

**Tests:** `device/queue.test.ts › orders a create carrying the natural key of a row the copy holds behind that row's edit still waiting`.

### `queue-and-verdicts/row-write-follows-keyed`

When a caller queues a write to a row the copy holds after a create carrying that row's natural key that has no verdict, or is `refused`, `blocked` or `dead`, and no write to the row was queued after that create, a device MUST name that create in the write's `follows`.

**Tests:** `device/queue.test.ts › holds an edit of a row behind a create carrying its natural key that had no answer`.

### `queue-and-verdicts/landed-writes-follow`

When a create's answer moves the writes waiting on it onto a row the copy holds, a device MUST order them behind that row's own writes still waiting, in the order all of them were queued.

**Tests:** `device/queue.test.ts › orders the writes a create moves onto a row behind that row's own writes still waiting`, `› orders a tag a refused create moves onto a row behind that row's own edit still waiting`.

### `queue-and-verdicts/queue-names-what-holds`

A device MUST report in the queue each write's `depends_on` and `follows`.

**Tests:** `device/queue.test.ts › sends a delete of a row only once the edits of it ahead are answered`, `› says in words which writes hold a queued write`.

### `queue-and-verdicts/depends-on-kept`

When a write a queued write depends on is answered, a device MUST keep it in the queued write's `depends_on`, unless the answer is a refused create's that moves the queued write onto the row its natural key names.

**Reason:** the queue records what a write waited for, which a release of a write refused for its dependency reads.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

### `queue-and-verdicts/command-queued-holds`

When the command queues a write that depends on others and prints it as text, the command MUST print how many writes it depends on after `waiting on`.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

### `queue-and-verdicts/command-queued-after`

When the command queues a write that follows another and prints it as text, the command MUST print the write it follows after `after`.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

### `queue-and-verdicts/command-queue-waiting`

When the command prints the queue as text and exactly one of the writes a write depends on has no verdict, is `blocked`, or is a create refused onto a row its natural key names that no read has found yet, the command MUST name that write after `waiting on`.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`, `› holds a write made to a refused create's row until a read finds the row its natural key names`.

### `queue-and-verdicts/command-queue-not-waiting`

When the command prints the queue as text and every write a write depends on is answered `accepted`, `merged`, `conflicted` or `refused`, or is `dead`, and none is a create refused onto a row that no read has found yet, the command MUST NOT print `waiting on` for it.

**Reason:** a dependency with such a verdict no longer holds the write, though `depends_on` still names it.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

### `queue-and-verdicts/command-queue-after`

When the command prints the queue as text, the command MUST name after `after` the write each write follows.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

## What a drain reports

A drain is one pass over the queue. Its report says what became of each write the pass came to, in counts and in an entry for each write it settled or sent.

### `queue-and-verdicts/report-sent-write`

When a drain sends a write, a device MUST report an entry for it in `verdicts` with its id, its kind, its verdict or none, the refusals counted against it, and the row it names in `item_id`, which for an edge write is the edge's source.

**Tests:** `device/queue.test.ts › reports a verdict for every write it sent`, `› names the edge in the verdict of an edge write`, `device/classification.test.ts › retries an environmental failure past the ceiling without counting it`.

### `queue-and-verdicts/report-edge-id`

When a drain reports an entry for an edge write, a device MUST name the edge in its `edge_id`.

**Tests:** `device/queue.test.ts › names the edge in the verdict of an edge write`.

### `queue-and-verdicts/report-unsent-verdicts`

When a drain gives a write a verdict without sending it, other than a write it holds or a refused credential parks, a device MUST report an entry for that write in `verdicts`.

**Reason:** a write refused for a write it waited for, or settled by another write's answer, is one a caller has to hear of as much as one the server answered.

**Tests:** `device/verdicts.test.ts › refuses the writes that were waiting on a create the server refused`, `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/report-held-unlisted`

When a drain holds a write, a device MUST NOT report an entry for it in `verdicts`.

**Tests:** `device/grant-recovery.test.ts › holds a later edit while an earlier receipt lacks a grant after catch-up to %s`, `device/edge-replay.test.ts › keeps an edge receipt safe with grant blocked $grantBlocked and catch-up version $caughtUpVersion`.

### `queue-and-verdicts/report-agrees-with-queue`

When a drain ends, a device MUST report in the queue the same verdict for each write as the drain reported, other than a write a refused credential parked later in the pass.

**Tests:** `device/queue.test.ts › reports a verdict for every write it sent`.

### `queue-and-verdicts/count-answered`

A device MUST count in a drain's `answered` each write the drain sent that had an answer the device did not take as an environmental failure, whatever the answer.

**Reason:** a write that went out and met no answer is never counted as answered: a report that counted it would read the same whether the server took it or could not be reached, so an app could not tell offline from saved.

**Tests:** `device/classification.test.ts › counts only the writes the server answered, and says why the rest were not delivered`, `› ends the pass at a read the server cannot answer, sending nothing after it`, `device/queue.test.ts › reports a verdict for every write it sent`.

### `queue-and-verdicts/count-held`

A device MUST count in a drain's `held` each write the drain held for a write it depends on or follows.

**Tests:** `device/queue.test.ts › holds a write whose create has not been answered`, `device/grant-recovery.test.ts › holds a later edit while an earlier receipt lacks a grant after catch-up to %s`.

### `queue-and-verdicts/count-undelivered`

A device MUST count in a drain's `undelivered` the write an environmental failure met without a verdict, each write the pass came to after a write or a read met an environmental failure, each write from the one at which the drain failed to confirm the server's instance, and an upload whose bytes could not be opened, but a write it held.

**Tests:** `device/classification.test.ts › ends the pass at the first write the server cannot take, leaving the rest untried and uncounted`, `› counts only the writes the server answered, and says why the rest were not delivered`, `device/queue.test.ts › sends nothing while the server cannot say which instance it is`, `› leaves an upload whose held bytes cannot be opened unanswered, and says why`.

### `queue-and-verdicts/count-unsent`

A device MUST count in a drain's `unsent` each write the drain gave a verdict without sending it, other than a write it held or a refused credential parked.

**Tests:** `device/classification.test.ts › counts the writes it settled without sending apart from those the server answered`, `device/queue.test.ts › refuses an upload whose bytes are no longer held`, `device/folders-placement.test.ts › folder rebase accounts for writes refused in its later pass`.

### `queue-and-verdicts/count-unmade`

A device MUST count in a drain's `unmade` each write whose request the device could not make.

**Tests:** `device/folders-placement.test.ts › folder rebase accounts for every unmade request`.

### `queue-and-verdicts/counts-account-for-pass`

A device MUST count each write a drain comes to in exactly one of `answered`, `held`, `undelivered`, `unsent` and `unmade`, but a write that a refused credential parks.

**Reason:** the writes a refused credential parks are counted in the sentence `stopped` gives (`queue-and-verdicts/credential-stop-said`).

**Tests:** `device/classification.test.ts › counts the writes it settled without sending apart from those the server answered`, `› ends the pass at the first write the server cannot take, leaving the rest untried and uncounted`.

### `queue-and-verdicts/report-unavailable`

When a drain ends early because of an environmental failure, or cannot confirm the server's instance, a device MUST say why in the report's `unavailable`.

**Tests:** `device/classification.test.ts › ends the pass at the first write the server cannot take, leaving the rest untried and uncounted`, `device/queue.test.ts › queues writes while the server is unreachable`.

### `queue-and-verdicts/report-retry-after`

When the server answers a write in a drain with `Retry-After`, or answers a read the drain makes `429` with `Retry-After`, a device MUST report in `retry_after_seconds` the longest such wait of the pass, and no more than 300 seconds.

**Reason:** a caller draining in a loop would otherwise ask again at once, and a wait without a bound would let one answer park a client for good.

**Tests:** `device/classification.test.ts › retries a 5xx and a 429 without counting them`, `› passes on the wait a read reconciling a refusal was asked for (contract %s)`, `device/queue.test.ts › reads the row a create landed on again after a failure that clears on its own`, `device/classification.test.ts › passes on at most 300 seconds of the wait a write was asked for`.

## The command's drain

What the command prints and exits with for a drain.

### `queue-and-verdicts/command-drain-report`

When a drain ends with a report and the command prints JSON, the command MUST print the whole report on standard output and nothing on standard error but the warning of `device/command-cleartext-warning`.

**Tests:** `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`, `› preserves answered writes before an interrupted later write`.

### `queue-and-verdicts/command-exit-stopped`

When a drain stops because a refused credential parked the queue, the command MUST exit 5.

**Tests:** `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`.

### `queue-and-verdicts/command-exit-undelivered`

When a drain that a refused credential did not stop reports `unavailable` or a write `undelivered`, the command MUST exit 3.

**Tests:** `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`, `› preserves answered writes before an interrupted later write`, `› exits 3 for a pass the server could not finish that left nothing undelivered`, `› exits 3 for a write left undelivered by a pass the server finished`.

### `queue-and-verdicts/command-exit-done`

When a drain reports neither `stopped`, nor `unavailable`, nor a write `undelivered`, the command MUST exit 0, whatever verdicts the drain reached.

**Tests:** `device/cli-outcomes.test.ts › reports completed refusals separately and keeps exit zero`.

### `queue-and-verdicts/command-refused-count`

When a drain refuses writes and the command prints its report as text, the command MUST print how many it refused as `refused <n> write(s)`.

**Tests:** `device/cli-outcomes.test.ts › reports completed refusals separately and keeps exit zero`.

## The six verdicts

Every write the server answers, and every write a drain settles without sending, carries one verdict from a closed set. What a device does not do on meeting one is `device/conflict-blocked`.

### `queue-and-verdicts/verdicts-six`

A device MUST give every write it settles exactly one of the verdicts `accepted`, `merged`, `conflicted`, `refused`, `blocked` and `dead`, and no other.

**Reason:** an answer a device cannot classify is a defect in the device, not a seventh verdict.

**Tests:** `device/verdicts.test.ts › answers every write with one of the six verdicts`.

### `queue-and-verdicts/success-no-resolution`

When the server answers a write `2xx` with a body the device reads as its operation's answer and no `conflict_resolution`, a device MUST give it the verdict `accepted`, but where `device/upload-answer-hash` or `queue-and-verdicts/trashed-ack-refused` says otherwise.

**Reason:** the three verdicts a success can carry are told apart by what the answer reports about resolving, never by comparing the row that came back with the row sent: every answer carries fields the server stamps.

**Tests:** `device/verdicts.test.ts › tells the three successful verdicts apart by the resolution the answer carries`, `› accepted: adopts the row the server returned`.

### `queue-and-verdicts/success-merged`

When the server answers a write `2xx` with a `conflict_resolution` that names no `conflicted_copy_id`, a device MUST give it the verdict `merged` and report the properties the resolution names in `merged_fields`.

**Tests:** `device/verdicts.test.ts › tells the three successful verdicts apart by the resolution the answer carries`, `› merged: adopts the row a resolution returned`.

### `queue-and-verdicts/success-conflicted`

When the server answers a write `2xx` with a `conflict_resolution` that names a `conflicted_copy_id`, a device MUST give it the verdict `conflicted` and report that id in the drain and in the queue as `conflicted_copy_id`.

**Reason:** the answer is the only place the copy set aside is named, and without it the losing edit exists and nothing reaches it.

**Tests:** `device/verdicts.test.ts › tells the three successful verdicts apart by the resolution the answer carries`, `› conflicted: names the sibling the server wrote`.

### `queue-and-verdicts/upsert-repeat-accepted`

When the server answers a create as a natural-key upsert onto a row it holds, or as a repeat it answers from its record, with no `conflict_resolution`, a device MUST give it the verdict `accepted`, but where `queue-and-verdicts/trashed-ack-refused` says otherwise.

**Reason:** the server took the write. What the row now holds is read again (`queue-and-verdicts/success-read-again`), since the answer does not prove the key may still read the row.

**Tests:** `device/verdicts.test.ts › accepted: takes an upsert and a replayed repeat as accepted`, `› accepted: takes %s as accepted`.

### `queue-and-verdicts/success-not-resent`

When a write is answered `accepted`, `merged` or `conflicted`, a device MUST NOT send it again.

**Tests:** `device/verdicts.test.ts › sends nothing again for a write answered accepted, merged or conflicted`.

### `queue-and-verdicts/success-read-again`

When the server answers a write to a row or an edge `2xx`, a device MUST read that row or edge again and hold what the read returns, with the writes still waiting laid over it, rather than the row or edge the answer carried.

**Reason:** a receipt settles the write, not what the key may read now (`device/read-back-keeps-verdict`).

**Tests:** `device/verdicts.test.ts › holds the row a fresh read returns where it differs from the row the answer carried`, `device/queue.test.ts › holds the edge a fresh read returns where it differs from the edge the answer carried`, `› keeps the later row a catch-up brought over an older answer replayed after it`, `› keeps the later edge a catch-up brought over an older edge answer replayed after it`.

### `queue-and-verdicts/success-read-fails`

If the read after a `2xx` meets an environmental failure, then a device MUST keep the write's verdict as recorded, counting no refusal against it.

**Reason:** the verdict is recorded before the read, so a read that fails, or a process that ends before the read, never sends the write a second time.

**Tests:** `device/verdicts.test.ts › keeps an accepted write accepted, counts nothing and reads it again at the next drain when the read after it fails`.

### `queue-and-verdicts/owed-read-first`

When a drain starts after the read that follows a write's answer has failed, a device MUST make that read again before it sends any write.

**Reason:** a write sent before it would be based on a copy that still shows what the earlier answer settled, and a retried read never sends the settled write again.

**Tests:** `device/verdicts.test.ts › keeps an accepted write accepted, counts nothing and reads it again at the next drain when the read after it fails`, `device/classification.test.ts › ends the pass at a read the server cannot answer, sending nothing after it`.

### `queue-and-verdicts/later-row-kept`

When a read after an answer returns a row or an edge older than the one the copy holds, by version or, at the same version, by when it was stamped, a device MUST keep the one the copy holds.

**Reason:** a catch-up can bring a later version before the answer to a repeat arrives, and adopting the older one would take the copy back under the writes since and base the next edit on a version the row has left.

**Tests:** `device/queue.test.ts › keeps the later row a catch-up brought where the read after an answer returns an older one`, `› keeps the later edge a catch-up brought where the read after an edge answer returns an older one`, `device/verdicts.test.ts › refused: keeps the row the copy holds where the read-back answers an older one`.

### `queue-and-verdicts/sibling-from-stream`

When a write is answered `conflicted`, a device MUST NOT hold the copy the server set aside until an event, a read or a hydration brings it.

**Reason:** the answer carries only the row written to, so a caller reads the copy set aside once the working copy has caught up past its event.

**Tests:** `device/verdicts.test.ts › conflicted: the sibling reaches the copy with a later event, not with the answer`.

### `queue-and-verdicts/sibling-link-held`

When the working copy holds a copy the server set aside, a device MUST hold its `derived-from` edge to its original (`versions/copy-link`), whether or not it holds the original, from a catch-up and from a hydration, and after the store is opened again.

**Reason:** an app finds the original from the copy, and the copies from the original, by reading edges from either end (`device/edges-to` and `device/edges-whole-either-end`), after a restart as before it.

**Tests:** `device/verdicts.test.ts › holds the link with the sibling after the verdict's catch-up, and after the store is reopened`, `› holds the link a catch-up brings where the copy does not hold the original`, `› holds the link a hydration reads with the sibling, where the copy does not hold the original`.

### `queue-and-verdicts/refused-contract`

When the server answers a write with a `4xx` naming its contract, other than `408`, `425`, `429` and the answers `queue-and-verdicts/credential-blocks-queue`, `queue-and-verdicts/grant-blocks`, `queue-and-verdicts/unclaimed-source-blocks`, `queue-and-verdicts/key-spent-blocks`, `queue-and-verdicts/ancestor-blocks`, `queue-and-verdicts/conflict-blocks` and `queue-and-verdicts/in-flight-counted` name, a device MUST give it the verdict `refused` on the first such answer, with the server's code as its reason, or `unknown` where the answer names none.

**Reason:** the same request sent again is the same request: a device that retried it would spend the ceiling on identical refusals.

**Tests:** `device/classification.test.ts › refuses a contract failure on the first answer`, `› refuses on the first answer a %i %s that names the contract`, `device/verdicts.test.ts › refused: carries the server's code and is not sent again`.

### `queue-and-verdicts/refused-not-resent`

When a write is `refused`, a device MUST NOT send it again unless a caller releases it.

**Reason:** only a write the drain refused without sending can be released (`queue-and-verdicts/release-sent-refused`).

**Tests:** `device/verdicts.test.ts › refused: carries the server's code and is not sent again`, `device/classification.test.ts › refuses a contract failure on the first answer`.

### `queue-and-verdicts/refused-envelope-kept`

When the server refuses a write, a device MUST keep its answer whole in the queue as the write's `answer`.

**Tests:** `device/verdicts.test.ts › refused: carries the server's code and is not sent again`.

### `queue-and-verdicts/refused-read-again`

When the server refuses a write to a row or an edge, a device MUST hold what a fresh read of that row or edge returns once the refusal is recorded, where the copy's slice or a pin takes it, with the writes still waiting laid over it.

**Reason:** a refused write produces no event, so a copy that kept the edit would answer a change that never happened on every later read.

**Tests:** `device/verdicts.test.ts › refused: preserves the local row until a fresh read succeeds at the next drain`, `device/queue.test.ts › keeps a waiting write through the reconcile of a refused one`.

### `queue-and-verdicts/refused-read-fails`

If the read after a refusal meets an environmental failure, then a device MUST keep the row as the copy showed it and the refusal as recorded.

**Reason:** the refusal is recorded before the read, so a read that fails never sends the write again, and the copy changes only on a read the server answered (`device/read-back-keeps-verdict`).

**Tests:** `device/verdicts.test.ts › refused: preserves the local row until a fresh read succeeds at the next drain`.

### `queue-and-verdicts/refused-row-absent`

When the read after a refusal is answered `403`, `404` or `400 invalid_id`, a device MUST let go of the row or edge, where nothing wrote it in the copy while the read was out.

**Reason:** the server holds no such row, as a create the server refused leaves it.

**Tests:** `device/verdicts.test.ts › refused: takes a read-back answered 400 invalid_id as the server holding no such row`, `› refused: lets the row go where the read-back is answered %s`.

### `queue-and-verdicts/absent-read-keeps-written`

When a read after an answer or a refusal finds no row or edge, and something wrote that row or edge in the copy while the read was out, a device MUST keep the row or edge as it was written.

**Reason:** what was written while the read was out is later than the read, so letting it go would take the copy back under a change already applied.

**Tests:** waiting on #1890.

### `queue-and-verdicts/refusal-parts`

When a device reports a refusal, whether the server refused a write or blocked it `credential_refused` with an answer, a device MUST read into it the server's `code` and `message`, each entry of `details.errors` naming a `field` with its `message`, and the missing grant in `details.grant` as a `kind`, a `name` and a `level`.

**Reason:** read once, by the device, so every app does not decode the server's text its own way to say which property was wrong.

**Tests:** `device/verdicts.test.ts › refused: reads the server's code, message, fields and missing grant into the refusal`, `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`.

### `queue-and-verdicts/refusal-in-bin`

When the server's refusal of a write carries `details.trashed` true, a device MUST report the refusal with `trashed` true.

**Reason:** an app can then offer to restore the row with the edit, which a `404` naming no bin cannot offer.

**Tests:** `device/verdicts.test.ts › refused: says when the row a write named is in the bin`, `device/versioned-deletes-live.test.ts › keeps the text and binned-row reason of an edit refused after another delete`.

### `queue-and-verdicts/refusal-same-in-queue`

A device MUST report a refusal in the queue as the drain reported it.

**Tests:** `device/verdicts.test.ts › refused: reads the server's code, message, fields and missing grant into the refusal`.

### `queue-and-verdicts/refusal-part-absent`

When the server's envelope does not carry a part of a refusal that `queue-and-verdicts/refusal-parts` names, or carries it in another shape, a device MUST report that part as absent.

**Reason:** an app reads a part it is given, and never one guessed from a shape the contract does not name.

**Tests:** `device/verdicts.test.ts › refused: reads the server's code, message, fields and missing grant into the refusal`, `device/grant-recovery.test.ts › keeps a permanent fence terminal when its details are %j`.

### `queue-and-verdicts/refusal-drain-made`

When a drain refuses a write without sending it, a device MUST report the refusal with its reason and with no code, message, fields, bin or grant.

**Reason:** the server said nothing about the write, so only the drain's reason is known.

**Tests:** `device/verdicts.test.ts › refuses the writes that were waiting on a create the server refused`.

### `queue-and-verdicts/blocked-reasons-five`

A device MUST give a `blocked` write exactly one of the reasons `credential_refused`, `key_spent`, `ancestor_unavailable`, `conflict_unresolved` and `awaiting_dependency`, and no other.

**Tests:** `device/classification.test.ts › reports one of the five blocked reasons and no other`.

### `queue-and-verdicts/blocked-not-counted`

When a write is blocked, a device MUST count no refusal against it.

**Reason:** a block is not a failure: counted, a write would die waiting for a person.

**Tests:** `device/verdicts.test.ts › blocked: is passed over by a drain and reported with its reason`, `device/classification.test.ts › blocks the whole queue on a refused credential, and stops the drain`, `› blocks a spent key on the first refusal rather than spending the ceiling`.

### `queue-and-verdicts/blocked-passed-over`

While a write is blocked `key_spent`, `ancestor_unavailable` or `conflict_unresolved`, a device MUST NOT send it in a drain.

**Reason:** each clears only when a caller releases or withdraws the write, since the same request is refused the same way however often it is sent.

**Tests:** `device/verdicts.test.ts › blocked: is passed over by a drain and reported with its reason`, `device/classification.test.ts › sends nothing in a later drain for a write blocked conflict_unresolved or key_spent`.

### `queue-and-verdicts/blocked-retried-itself`

When a drain starts, a device MUST take every write blocked `credential_refused` or `awaiting_dependency` back to no verdict, so the drain sends it again where nothing else holds it.

**Reason:** each clears without a release, once the credential is replaced, the grant or the claim restored, or the write waited for answered.

**Tests:** `device/queue.test.ts › holds an edit behind one the server failed to answer, even one queued while that was blocked`, `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`, `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/blocked-keeps-row`

When a write is blocked, a device MUST keep it laid over the row or edge it names, without reading that row or edge again.

**Tests:** `device/classification.test.ts › withdraws a write blocked ancestor_unavailable or conflict_unresolved, and puts the row back as the server holds it`.

### `queue-and-verdicts/ceiling-five`

When a fifth refusal is counted against a write, a device MUST give it the verdict `dead`.

**Reason:** the ceiling is a number this contract fixes, not configuration.

**Tests:** `device/classification.test.ts › reaches the ceiling on the fifth refusal`, `device/verdicts.test.ts › dead: is terminal once the ceiling is reached`.

### `queue-and-verdicts/dead-not-resent`

While a write is `dead`, a device MUST NOT send it in a drain.

**Tests:** `device/verdicts.test.ts › dead: is terminal once the ceiling is reached`, `device/classification.test.ts › reaches the ceiling on the fifth refusal`.

### `queue-and-verdicts/dead-no-reason`

A device MUST report a `dead` write with no reason.

**Tests:** `device/classification.test.ts › releases by reason the rows blocked for it, and never a dead one`, `› reports a write the store failed to record at the ceiling dead, with no reason`.

### `queue-and-verdicts/count-refusals-only`

A device MUST count against a write only the failures `queue-and-verdicts/counted-failures`, `queue-and-verdicts/in-flight-counted` and `queue-and-verdicts/store-failure-counted` name, never an attempt that met an environmental failure.

**Reason:** a device that could not ask has not been refused, so a week offline does not exhaust the ceiling.

**Tests:** `device/classification.test.ts › counts refusals rather than attempts, so a long outage does not exhaust the ceiling`, `› retries an environmental failure past the ceiling without counting it`.

## Which failures retry

The split is the whole of the classification, and it is closed. A device that retries the wrong class either loops on a refusal it will always get or strands a good write behind a network that came back.

### `queue-and-verdicts/environmental-uncounted`

When a write meets a dropped connection, a read that timed out, a `5xx`, a `408`, a `425` or a `429`, a device MUST leave it unanswered and uncounted for the next drain.

**Reason:** each is a statement about the environment rather than about the write, and clears without anybody doing anything; counted, it would strand a valid write behind an outage and then need a person to release it.

**Tests:** `device/classification.test.ts › retries an environmental failure past the ceiling without counting it`, `› retries a 5xx and a 429 without counting them`, `› retries a %i without counting it`, `› retries a write the server never answers, without counting it`, `› ends the pass at the first write the server cannot take, leaving the rest untried and uncounted`.

### `queue-and-verdicts/unnamed-refusal-environmental`

When the server's answer to a write is not a success and names no contract, whatever its status, a device MUST take it as an environmental failure, a `401` among them.

**Reason:** a refusal naming no contract comes from something in front of the server, a proxy, a tunnel or an access gateway, and says nothing of the write or the key (`device/unnamed-environmental` and `device/unnamed-not-server-word`). Refused on its word, a write the server never saw would end for good; counted, a proxy restarting under a watch that drains each second would make every queued write `dead` within seconds.

**Tests:** `device/contract.test.ts › takes a refusal that names no contract as the network's, ending the pass uncounted`.

### `queue-and-verdicts/unnamed-refusal-said`

When a drain ends at an answer naming no contract, a device MUST say in `unavailable` that the answer named no contract.

**Reason:** a refusal repeating so while the server otherwise answers is one losing the contract header on the way.

**Tests:** `device/contract.test.ts › takes a refusal that names no contract as the network's, ending the pass uncounted`.

### `queue-and-verdicts/environmental-ends-pass`

When a write meets an environmental failure, a device MUST send no write after it in that drain.

**Reason:** gone on to the next write, a drain against a server that cannot be reached would wait out a connection timeout for every write in the queue, and a server that asked for a wait would be asked again at once by every write behind the one it answered.

**Tests:** `device/classification.test.ts › ends the pass at the first write the server cannot take, leaving the rest untried and uncounted`, `device/contract.test.ts › takes a refusal that names no contract as the network's, ending the pass uncounted`.

### `queue-and-verdicts/read-failure-ends-pass`

When a read a drain makes after an answer meets an environmental failure, a device MUST send no write after it in that drain.

**Reason:** the read a refusal is reconciled against, made again from an earlier drain or made in this one, and the read of the row a create landed on, are asked of the same server as the writes.

**Tests:** `device/classification.test.ts › ends the pass at a read the server cannot answer, sending nothing after it`.

### `queue-and-verdicts/counted-failures`

When a write is answered `2xx` with a body the device cannot read as its operation's answer, or its request cannot be made, a device MUST count one refusal against it and leave it with no verdict until the ceiling.

**Reason:** each is a failure a further attempt might clear and nothing clears on its own, and this is the class the ceiling exists for: without it `dead` is a verdict nothing reaches.

**Tests:** `device/classification.test.ts › retries an answer it cannot read, and counts it`, `› counts a write whose answer the copy cannot take, and goes on to the next`, `› counts a write whose request cannot be made, and makes it dead at the ceiling`.

### `queue-and-verdicts/in-flight-counted`

When the server answers a write `409 idempotency_key_in_flight`, a device MUST count a refusal against the write rather than block or refuse it.

**Reason:** the status alone does not decide: this `409` is neither of the two that block, and the server finishing with the key clears it.

**Tests:** `device/classification.test.ts › retries a key the server reports in flight, and counts it`.

### `queue-and-verdicts/counted-goes-on`

When a drain counts a refusal against a write, a device MUST go on to the writes behind it in the same drain.

**Reason:** ended there, the write would be retried uncounted for good, and every write behind it would wait on it.

**Tests:** `device/classification.test.ts › counts a write whose answer the copy cannot take, and goes on to the next`, `› counts a write whose answer the store failed to record, and goes on to the next`.

### `queue-and-verdicts/store-failure-counted`

If the store fails, other than by filling, as a device takes the answer to a write that has no verdict, then a device MUST count a refusal against the write and leave it with no verdict until the ceiling.

**Reason:** a further attempt may clear it and nothing clears it on its own; ended there instead, the write would be retried uncounted for good, and every write behind it would wait on it.

**Tests:** `device/classification.test.ts › counts a write whose answer the store failed to record, and goes on to the next`.

### `queue-and-verdicts/store-full-ends-drain`

If the store is full as a device takes the answer to a write, before the write has a verdict, then a device MUST end the drain `storage_full`, leaving the write with no verdict and no refusal counted.

**Reason:** a full store says nothing of the write and clears once there is room, when the write goes again under its key.

**Tests:** `device/classification.test.ts › ends the drain storage_full when the store fills as it takes an answer, counting nothing`.

## Refusals that park a write

### `queue-and-verdicts/credential-blocks-queue`

When the server answers a write `401` naming its contract, a device MUST block that write and every other write with no verdict `credential_refused`.

**Reason:** it is the one refusal that looks environmental and is not: it clears only when a person replaces the credential, and every queued write carries the same credential.

**Tests:** `device/classification.test.ts › blocks the whole queue on a refused credential, and stops the drain`.

### `queue-and-verdicts/credential-stops-drain`

When the server answers a write `401` naming its contract, a device MUST send no write after it in that drain.

**Reason:** the drain stops rather than spend a request on every write in a queue none of which can succeed.

**Tests:** `device/classification.test.ts › blocks the whole queue on a refused credential, and stops the drain`.

### `queue-and-verdicts/credential-stop-said`

When a refused credential parks the queue in a drain, a device MUST say so in the report's `stopped`.

**Tests:** `device/classification.test.ts › blocks the whole queue on a refused credential, and stops the drain`, `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`.

### `queue-and-verdicts/grant-blocks`

When the server refuses a write `403` naming in `details.grant` a missing grant with a `kind` of `type`, `edge_type` or `extension`, a `name`, and a `level` of `read` or `write`, a device MUST block that write `credential_refused`.

**Reason:** restoring the grant lets the write land without a release, and a person sees the content waiting rather than refused.

**Tests:** `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`, `› keeps a grant-blocked create and its edit until the grant returns`, `device/grant-recovery-live.test.ts › sends a real %s after its key's grant is restored`.

### `queue-and-verdicts/grant-malformed-refused`

When the server refuses a write `403` naming its contract, other than as `queue-and-verdicts/unclaimed-source-blocks` says, with a `details.grant` that is missing, lacks a part, or names a `kind` or `level` outside those `queue-and-verdicts/grant-blocks` names, a device MUST refuse it.

**Reason:** a permanent fence carrying no missing grant stays shut whatever grant is restored.

**Tests:** `device/grant-recovery.test.ts › keeps a permanent fence terminal when its details are %j`.

### `queue-and-verdicts/grant-block-goes-on`

When a write is blocked for a missing grant, a device MUST go on in that drain to the writes behind it that do not wait for it.

**Tests:** `device/grant-recovery.test.ts › sends an unrelated write behind a grant-blocked one in the same drain`.

### `queue-and-verdicts/grant-block-keeps`

While a write is blocked for a missing grant, a device MUST keep its content in the queue and laid over the row the copy shows, and keep the writes waiting on it.

**Tests:** `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`, `› keeps a grant-blocked create and its edit until the grant returns`, `device/grant-recovery-live.test.ts › keeps a folder's edit and create and sends both when its grant returns`.

### `queue-and-verdicts/grant-retry-same-key`

When a drain sends again a write it blocked for a missing grant, a device MUST send it under the idempotency key it was refused under.

**Reason:** a refusal of a replay may follow a write that already committed, so the device neither assumes it was unwritten nor mints another key.

**Tests:** `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`, `› holds a later edit while an earlier receipt lacks a grant after catch-up to %s`.

### `queue-and-verdicts/key-spent-blocks`

When the server answers a write `422 idempotency_key_reused`, a device MUST block it `key_spent` on that first answer.

**Reason:** the key has been answered for another body, so it is the key that is spent, not the write; sending the same key again cannot clear it.

**Tests:** `device/classification.test.ts › blocks a spent key on the first refusal rather than spending the ceiling`.

### `queue-and-verdicts/ancestor-blocks`

When the server answers a write `409 ancestor_unavailable`, a device MUST block it `ancestor_unavailable`, unless it is a create carrying a natural key whose answer names another row.

**Reason:** the server no longer holds the version the write names, so the same write is refused identically however often it is sent. A create carrying a natural key is `queue-and-verdicts/landed-refused`.

**Tests:** `device/classification.test.ts › blocks a write whose base version the server no longer holds`.

### `queue-and-verdicts/conflict-blocks`

When the server answers a write `409 version_conflict`, a device MUST block it `conflict_unresolved`, unless it is a create carrying a natural key whose answer names another row.

**Reason:** the server resolves a colliding update in the same write (`versions/auto-resolved`) but for one that also moves the type (`versions/auto-type-move`), and refuses a delete of a row that has moved; a device cannot resolve it itself and the same request is refused the same way. A delete blocked so keeps the newer row intact.

**Tests:** `device/classification.test.ts › blocks a conflict the server declined to resolve`, `device/verdicts.test.ts › reports a conflict rather than resolving it`, `device/versioned-deletes-live.test.ts › guards a queued delete through %s`, `device/queue.test.ts › blocks a move that collides with a write it did not read, keeping it`.

## A renewal a drain meets

A token from a sign-in is renewed when the server answers a write `401` under it. These rules say what a drain does when that renewal fails.

### `queue-and-verdicts/renewal-environmental`

If renewing the credential after a write's `401` meets an environmental failure, then a device MUST take the write's answer as that environmental failure.

**Reason:** a token endpoint that cannot be reached for now says nothing of the write or the key, so the write waits, uncounted, for the next drain (`queue-and-verdicts/environmental-uncounted`).

**Tests:** `device/cli-outcomes.test.ts › takes a renewal the network stopped as an environmental failure, counting nothing`.

### `queue-and-verdicts/renewal-ends-drain`

If renewing the credential after a write's `401` fails other than by an environmental failure or a `401`, then a device MUST end the drain with that failure as its error.

**Reason:** the person is signed out, or the credential cannot be read or renewed, and no write behind it could go under the same credential either. A renewal refused `401` leaves the write's own `401`, which `queue-and-verdicts/credential-blocks-queue` takes.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

### `queue-and-verdicts/renewal-keeps-answers`

When a failed renewal ends a drain, a device MUST keep the verdict of every write the drain answered before it.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

### `queue-and-verdicts/renewal-write-untouched`

When a failed renewal ends a drain, a device MUST leave the write whose `401` started the renewal with no verdict, no refusal counted, and the body and idempotency key it had.

**Reason:** the server refused the credential, not the write, so nothing is known of the write that a verdict could say.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

### `queue-and-verdicts/command-renewal-error`

When a failed renewal ends a drain, the command MUST print the failure as its error on standard error and nothing on standard output.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

### `queue-and-verdicts/command-renewal-signed-out`

When a drain ends because renewing the credential finds the person signed out, the command MUST report `signed_out` with `server` null and exit 5.

**Reason:** the error says the sign-in on this machine has ended, which is not a server's answer to the write.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

## A source the credential's key does not claim

### `queue-and-verdicts/unclaimed-source-blocks`

When the server refuses a create `403 forbidden` with `details` holding `source` alone, naming the source the create sent, a device MUST block the create `credential_refused`.

**Reason:** the refusal is the server's for a source the key does not claim (`items/source-unclaimed`); one naming more, such as the type and the list a source allow-list refuses for (`types/source-allowlist`), is refused as any other `403`.

**Tests:** `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/unclaimed-blocks-others`

When a create is blocked for an unclaimed source, a device MUST block with it every create with no verdict that names the same source.

**Reason:** each carries the same credential and would be refused the same way, one request each.

**Tests:** `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/unclaimed-goes-on`

When a create is blocked for an unclaimed source, a device MUST go on in that drain to the writes that do not wait for it and name no source or another.

**Tests:** `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

### `queue-and-verdicts/unclaimed-keeps-row`

When a create is blocked for an unclaimed source, a device MUST keep the row the create shows and every write waiting on it.

**Reason:** refused instead, the row would be forgotten, and a claim granted afterwards would send nothing.

**Tests:** `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`, `› keeps a create blocked for its source, and the writes queued on it before the drain`.

### `queue-and-verdicts/unclaimed-reported`

When a drain blocks a create for an unclaimed source, a device MUST name the source in the report's `unclaimed_sources`.

**Reason:** `credential_refused` alone reads as a key that no longer works.

**Tests:** `device/classification.test.ts › blocks a create naming a source its key does not claim, and sends it once the key does`.

## Releasing, withdrawing and discarding

A caller can release a write that has stopped, withdraw one that can never be sent, and discard one the server refused, and clear the writes that are done with.

### `queue-and-verdicts/release-stopped`

When a caller releases a write that is `blocked` or `dead`, a device MUST take it back to no verdict so the next drain sends it.

**Tests:** `device/classification.test.ts › sends a released row again under a fresh key`, `› releases by reason the rows blocked for it, and never a dead one`.

### `queue-and-verdicts/release-fresh-key`

When a caller releases a write, a device MUST give it a fresh idempotency key.

**Reason:** sent again under the spent key, the write would be answered from the server's record, which is the answer that stopped it.

**Tests:** `device/classification.test.ts › sends a released row again under a fresh key`.

### `queue-and-verdicts/release-resets-count`

When a caller releases a write, a device MUST clear the refusals counted against it.

**Reason:** kept, the next counted failure of a released `dead` write would make it `dead` again at once.

**Tests:** `device/classification.test.ts › sends a released row again under a fresh key`, `› releases by reason the rows blocked for it, and never a dead one`.

### `queue-and-verdicts/release-by-reason`

When a caller releases by a blocked reason, a device MUST release every write blocked for that reason and no other.

**Reason:** a reason names blocked writes only, so a release by reason never takes a `dead` write, which carries no reason and is released by its id.

**Tests:** `device/classification.test.ts › releases by reason the rows blocked for it, and never a dead one`.

### `queue-and-verdicts/release-unsent-refused`

When a caller releases a write the drain refused without sending it, other than one refused because a write it waited for was withdrawn, a device MUST take it back to no verdict so the next drain sends it.

**Tests:** `device/waiting-projections.test.ts › shows an unsent dependent edit as soon as its dead create is released`.

### `queue-and-verdicts/release-takes-dependants`

When a caller releases a write, a device MUST release with it every write the drain refused without sending because that write was refused or dead.

**Reason:** no caller would know to release them.

**Tests:** `device/waiting-projections.test.ts › shows an unsent dependent edit as soon as its dead create is released`.

### `queue-and-verdicts/release-sent-refused`

If a caller releases a write the server refused, then a device MUST answer that nothing was released and keep the write `refused`, whatever the write depends on.

**Reason:** what separates the two refusals is whether the write was sent, which a caller cannot read in the queue, so a caller releases and is told whether it took.

**Tests:** `device/classification.test.ts › will not release a write the server itself refused, dependency or not`.

### `queue-and-verdicts/release-lays-over`

When a caller releases writes, a device MUST lay each of them back over the copy before the release returns.

**Tests:** `device/waiting-projections.test.ts › shows an unsent dependent edit as soon as its dead create is released`, `› keeps a %s edit visible after a newer server row arrives`.

### `queue-and-verdicts/withdraw-two-reasons`

When a caller withdraws a write that is not `blocked` `ancestor_unavailable` or `conflict_unresolved`, a device MUST answer that nothing was withdrawn, changing nothing.

**Reason:** an unanswered write may yet land, a write blocked for another reason clears on its own or is released, a `dead` write is released, and an answered write has been written.

**Tests:** `device/classification.test.ts › will not withdraw a write that may yet land or be released`.

### `queue-and-verdicts/withdraw-unknown`

If a caller withdraws an id the queue does not hold, then a device MUST refuse it `not_found`.

**Tests:** `device/classification.test.ts › will not withdraw a write that may yet land or be released`.

### `queue-and-verdicts/withdraw-takes-out`

When a caller withdraws a write blocked `ancestor_unavailable` or `conflict_unresolved`, a device MUST take it out of the queue.

**Reason:** sent again under any key such a write is refused the same way, while it stays laid over its row and the copy goes on showing what the server will never take.

**Tests:** `device/classification.test.ts › withdraws a write blocked ancestor_unavailable or conflict_unresolved, and puts the row back as the server holds it`.

### `queue-and-verdicts/withdraw-puts-back`

When a caller withdraws a write, a device MUST hold the row or edge it names as a fresh read of the server returns it, where the read finds it and the copy's slice or a pin takes it, with the writes still waiting laid over it.

**Tests:** `device/classification.test.ts › withdraws a write blocked ancestor_unavailable or conflict_unresolved, and puts the row back as the server holds it`, `› lays a write still waiting back over the row a withdraw puts back`.

### `queue-and-verdicts/withdraw-read-first`

If a withdraw cannot read the server, then a device MUST refuse the withdraw and leave the queue and the copy as they were.

**Reason:** the read comes before anything changes.

**Tests:** `device/classification.test.ts › changes nothing when it cannot read the row back`.

### `queue-and-verdicts/withdraw-refuses-held`

When a caller withdraws a create, a device MUST refuse without sending every write that has no verdict or is `blocked` and waits for it, and every such write that waits for one of those in turn, with the reason `the <kind> it waits for was withdrawn`.

**Reason:** the row each names will never exist on the server.

**Tests:** `device/classification.test.ts › refuses unsent the writes held for a withdrawn create, and never releases them`.

### `queue-and-verdicts/withdrawn-never-released`

If a caller releases a write refused because a write it waited for was withdrawn, then a device MUST answer that nothing was released.

**Reason:** released, it would wait on a write the queue no longer holds.

**Tests:** `device/classification.test.ts › refuses unsent the writes held for a withdrawn create, and never releases them`.

### `queue-and-verdicts/withdraw-keeps-caught-up`

When a catch-up brings a row while a withdraw's read of it is out, a device MUST keep the row the catch-up brought, with the writes still waiting laid over it.

**Reason:** the row a catch-up brought is later than the read, and put back over it the read would take the copy back under a change whose event is already behind the cursor.

**Tests:** waiting on #1890.

### `queue-and-verdicts/clear-answered`

When a caller clears the answered writes, a device MUST take out of the queue each write that was answered `accepted`, `merged` or `conflicted`, or that the server refused carrying no content, and that no unanswered, `blocked`, `dead` or unsent `refused` write depends on, other than a write whose read after its answer has failed or, for a create refused onto a row its natural key names, has not yet found that row.

**Tests:** `device/queue.test.ts › keeps a refused write's body through a clearing, until it is discarded by id`, `device/classification.test.ts › clears with the answered rows those only a withdrawn write was keeping, but for one carrying content`.

### `queue-and-verdicts/clear-keeps-content`

When a caller clears the answered writes, a device MUST keep every `refused` write that carried content: an item's create or edit, a metadata write, an extension written, and an edge's create or edit.

**Reason:** cleared with the answered writes, the words of an edit the server refused because another device deleted the row would be gone with nothing saying so.

**Tests:** `device/queue.test.ts › keeps a refused write's body through a clearing, until it is discarded by id`, `device/versioned-deletes-live.test.ts › keeps the text and binned-row reason of an edit refused after another delete`, `device/classification.test.ts › clears with the answered rows those only a withdrawn write was keeping, but for one carrying content`.

### `queue-and-verdicts/clear-keeps-releasable`

When a caller clears the answered writes, a device MUST keep every write that is `blocked` or `dead`, or that the drain refused without sending and a release can still send.

**Tests:** `device/classification.test.ts › clears with the answered rows those only a withdrawn write was keeping, but for one carrying content`.

### `queue-and-verdicts/clear-withdrawn-leftovers`

When a caller clears the answered writes, a device MUST take out of the queue each write carrying no content that the drain refused without sending and that depends on a write the queue no longer holds, where no write still waiting depends on it.

**Tests:** `device/classification.test.ts › clears with the answered rows those only a withdrawn write was keeping, but for one carrying content`.

### `queue-and-verdicts/queue-shows-body`

A device MUST report in the queue the body each write carries, as it was or will be sent.

**Reason:** a refused write's content can then be read back and made again.

**Tests:** `device/queue.test.ts › keeps a refused write's body through a clearing, until it is discarded by id`, `device/grant-recovery.test.ts › keeps an edit blocked for $kind $level until its grant returns`.

### `queue-and-verdicts/discard-refused`

When a caller discards a `refused` write that no unsent write with no verdict, or `blocked`, depends on, other than one whose read after its answer has failed or, for a create refused onto a row its natural key names, has not yet found that row, a device MUST take it out of the queue, changing nothing in the copy.

**Reason:** the refusal already put the copy back.

**Tests:** `device/queue.test.ts › keeps a refused write's body through a clearing, until it is discarded by id`, `device/verdicts.test.ts › refused: takes a read-back answered 400 invalid_id as the server holding no such row`.

### `queue-and-verdicts/discard-only-refused`

If a caller discards a write that is not `refused`, then a device MUST answer that nothing was discarded and keep the write.

**Tests:** `device/queue.test.ts › keeps a refused write's body through a clearing, until it is discarded by id`.

### `queue-and-verdicts/discard-waited-kept`

If a caller discards a `refused` write that an unsent write with no verdict, or `blocked`, depends on, then a device MUST answer that nothing was discarded and keep the write.

**Reason:** discarded, it would leave that write waiting on a write the queue no longer holds.

**Tests:** `device/queue.test.ts › keeps a refused write a write still waiting depends on through a discard`.

## Offline, reconnect and hydrating again

### `queue-and-verdicts/rehydration-keeps-queue`

When a copy is hydrated again, a device MUST keep every queued write, with its id and idempotency key.

**Reason:** a copy that expires, whether its cursor aged out, its server was restored behind it or another instance answers at its origin, is cleared and pulled again (`device/expire-aged-cursor`, `device/expire-log-behind` and `device/instance-marker`), and a queue cleared with it would drop writes a caller was told were queued.

**Tests:** `device/queue.test.ts › keeps the queue through a re-hydration`, `device/catch-up.test.ts › hydrates again when the server's log ends behind its cursor, keeping the queue`.

### `queue-and-verdicts/other-instance-sends-nothing`

When a drain finds another instance at the copy's origin, a device MUST send no queued write and keep the queue for a hydration from that instance.

**Tests:** `device/queue.test.ts › sends nothing to another instance at the same address, keeping the queue`.

### `queue-and-verdicts/unconfirmed-sends-nothing`

While a drain cannot confirm which instance the server is, a device MUST send no queued write, leaving each unanswered and uncounted.

**Reason:** a restart is when another instance appears at an address (`device/instance-drain-expires`).

**Tests:** `device/queue.test.ts › sends nothing while the server cannot say which instance it is`, `› queues writes while the server is unreachable`.

## Writes laid over the copy

A write waits until it is answered, and a `blocked` or `dead` write is waiting still, because a release sends it again. A local read goes on answering each waiting write until its own verdict settles the row.

### `queue-and-verdicts/waiting-over-answer`

When a device takes a row or an edge from the answer to a write, or from the read after it, a device MUST lay every write still waiting to that row or edge back over it.

**Reason:** a copy that took the answer to a create over the edit queued after it would show the edit as undone while the queue still sends it, and a tag or a delete answered later would never come back, because their answers carry no row to take.

**Tests:** `device/queue.test.ts › keeps the writes it has not had answered through the answer to an earlier one`, `› keeps a waiting edge edit through the answer to the edge's create`, `› keeps a waiting write through the reconcile of a refused one`.

### `queue-and-verdicts/waiting-over-event`

When a device applies an event to a row or an edge, by a catch-up or on a held stream, a device MUST lay every write still waiting to that row or edge back over it.

**Tests:** `device/catch-up.test.ts › applies an event beneath a write it has not had answered`, `› applies an edge event beneath an edge edit it has not had answered`, `› applies an event beneath a blocked write, which a release sends again`, `› applies an event on a held stream beneath a write it has not had answered`, `› applies an edge event on a held stream beneath an edge edit it has not had answered`.

### `queue-and-verdicts/dead-over-event`

When a later row or edge from the server comes beneath a `dead` write, a device MUST keep the write laid over it.

**Tests:** `device/waiting-projections.test.ts › keeps a %s edit visible after a newer server row arrives`, `› keeps a dead edge edit over a newer edge event`, `› keeps a dead edge create over an existing server edge`, `device/waiting-projections-live.test.ts › keeps a dead %s visible over real later changes and on release`.

### `queue-and-verdicts/waiting-over-hydration`

When a copy is hydrated again, a device MUST lay every write still waiting back over the rows and edges the hydration pulled.

**Tests:** `device/queue.test.ts › keeps the writes it has not had answered through a re-hydration`, `› keeps a blocked write through a re-hydration`.

### `queue-and-verdicts/rehydrated-own-create`

When a copy is hydrated again, a device MUST hold again the row or edge of each of its own creates still waiting, unless it is an edge of a type the slice does not hold whole whose source the copy no longer holds.

**Tests:** `device/queue.test.ts › keeps the writes it has not had answered through a re-hydration`, `› keeps a blocked write through a re-hydration`, `device/waiting-projections.test.ts › keeps a dead create visible through hydration`.

### `queue-and-verdicts/rehydrated-create-time`

When a hydration holds again a row of this device's own create still waiting that names no `occurred_at`, a device MUST give it the time the create was queued as its `created_at`.

**Tests:** `device/queue.test.ts › keeps the writes it has not had answered through a re-hydration`.

### `queue-and-verdicts/waiting-edge-outside-slice`

When a hydration leaves the copy without the source of an edge create still waiting, of a type the slice does not hold whole, a device MUST NOT hold the edge again, nor its answer.

**Reason:** the copy never holds an edge whose source it does not hold (`device/edge-source-left-unheld`).

**Tests:** `device/queue.test.ts › holds no waiting edge whose source a re-hydration left outside the slice, nor its answer`.

## The version a later write is sent on

An edit is queued against the version the copy holds, and an edit waiting in the queue is laid over the copy without moving that version, so edits made one after another before a drain are all based on the version the first was. Sent as they stand, the server would merge each against the one before as though another device had written it. These rules move an unsent edit onto the answer to the write ahead of it where that answer is exactly what the edit was made against, and nowhere else.

### `queue-and-verdicts/own-create-edit-on-answer`

When this device's create of a row or an edge is answered, a device MUST send each later unsent edit of it based on version 0 on the version the answer names, but where `queue-and-verdicts/create-merged-over` or `queue-and-verdicts/create-repeat-edit-on-one` says otherwise.

**Reason:** a row or edge of this device's own unanswered create is at version 0, which the server never mints (`versions/create-claim-none`), so sent as it stands the edit names a snapshot no server holds and is blocked `ancestor_unavailable`.

**Tests:** `device/queue.test.ts › sends an edit of its own unanswered create based on the version that create was answered with`, `› sends an edit of its own unanswered edge based on the version that edge was answered with`, `› rebases the edits of its own unanswered create onto each answer in turn`, `› moves the copy onto the row a create lands on, with every write waiting on it`.

### `queue-and-verdicts/create-merged-over`

When a create carrying a version above 0 is answered more than one version past it, and not as a repeat, a device MUST send each later unsent edit of the row based on version 0 on the version the create carried, unless the answer holds, for every property the edit changed, what the copy held when the edit was made.

**Reason:** the server merged the create over another device's write (`versions/create-stale-merges`), which an edit made from the copy never read; on the version the create read, the server merges or conflicts on the edit as the type's policy says.

**Tests:** `device/queue.test.ts › sends an edit of its own create on the version the create was based on where the server applied it over another device's write`.

### `queue-and-verdicts/create-merged-over-apart`

When a create carrying a version above 0 is answered more than one version past it, and not as a repeat, with an answer holding, for every property a later unsent edit based on version 0 changed, what the copy held when the edit was made, a device MUST send that edit on the version of the answer.

**Reason:** there it changes what the person changed, and the other device's write stands.

**Tests:** `device/queue.test.ts › sends an edit of its own create on the answer where the server applied it over another device's write that left what the edit changed alone`.

### `queue-and-verdicts/create-repeat-edit-on-one`

When the server answers this device's create of a row or an edge as a repeat it had already taken, a device MUST send each later unsent edit of it based on version 0 on version 1.

**Reason:** a repeat is answered with the row or edge as it stands, whoever has written it since (`items/create-repeat` and `edges/id-repeat`); version 1 is the one that create made, and the server merges an item's edit against it, or refuses an edge's edit as stale wherever the edge has moved on.

**Tests:** `device/queue.test.ts › sends an edit of its own create on the version that create made where the server answers a repeat of it`.

### `queue-and-verdicts/edit-on-answer`

When this device's edit of a row is answered `accepted` or `merged` at version N, a device MUST send each later unsent edit of the row based on an earlier version than N on N, where N holds, for every property the later edit changed, what the copy held when the later edit was made.

**Reason:** the row at N is then exactly what the later edit was made against: the version it read with the earlier edit laid over it. The version is the one the earlier edit was answered with, not the one the server holds when the later edit goes, so a change another device makes between the two sends is merged or conflicted as N says.

**Tests:** `device/queue.test.ts › sends a second edit of a row on the version the first was answered with`, `› rebases a chain of three edits one answer at a time`, `› sends an edit on the answer to one merged over another device's write where that write left what it carries alone`, `› sends an edit on the answer to one the server answered merged, where the collision left what it carries alone`, `› sends each of three edits on the answer ahead of it, the first merged over another device's write`, `› sends an edit made after a catch-up on the version the edit ahead of it was answered with`, `› leaves a change another device makes between two edits for the server to merge or conflict`, `› sends the edit made after one said to be read on that one's answer`, `device/folders-placement.test.ts › sends a file edited twice before a push as two edits, not a conflict with itself`, `› keeps a line spent where a pull writes the file over the edit that spent it`.

### `queue-and-verdicts/edit-not-on-unheld-answer`

When an answer to an earlier edit of a row at version N does not hold, for a property that a later unsent edit based on an earlier version than N changed, what the copy held when the later edit was made, a device MUST NOT send the later edit on N.

**Reason:** the earlier edit was applied over another device's write that touched what the later edit changed (`versions/merge-stale`), and sent on N the later edit would be taken over content this device never read.

**Tests:** `device/queue.test.ts › sends an edit on its own base where the edit ahead of it was applied over another device's write`, `› sends an edit on its own base where another device touched only the later of the two properties it changed`.

### `queue-and-verdicts/edit-drops-unchanged`

When a device sends an unsent edit that merges its properties on a version other than the one it was queued on, a device MUST drop from the edit each property it carries at the value it read.

**Reason:** a property carried at the value read is no change of the person's, so a move never asserts it over another device's write.

**Tests:** `device/queue.test.ts › drops from a moved edit a property it carries at the value it read`.

### `queue-and-verdicts/edge-edit-on-answer`

When this device's edit of an edge is answered `accepted` or `merged` at version N, a device MUST send each later unsent edit of the edge based on N − 1 on N.

**Reason:** an edge is never merged, so its answer is the edit applied to the version it named.

**Tests:** `device/queue.test.ts › sends a second edit of an edge on the version the first was answered with`, `› holds an edit behind one that went out unanswered, and sends it on that answer`.

### `queue-and-verdicts/edit-on-answer-kept`

When an earlier edit of a row or an edge is answered `accepted` or `merged` at the version a later unsent edit is already based on, and for a row that version holds what the later edit read, a device MUST leave the later edit on that version.

**Reason:** a catch-up can already have brought the version the answer confirms, and the later edit read its values there.

**Tests:** `device/edge-replay.test.ts › keeps an edge receipt safe with grant blocked $grantBlocked and catch-up version $caughtUpVersion`, `device/grant-recovery.test.ts › holds a later edit while an earlier receipt lacks a grant after catch-up to %s`, `device/edge-replay-live.test.ts › sends an edge edit after catching up an earlier write whose real answer was lost`.

### `queue-and-verdicts/edit-not-onto-older`

When an earlier edit of a row or an edge is answered at a version older than the one a later unsent edit is based on, a device MUST NOT send the later edit on the answer's version.

**Reason:** an answer at an older version does not make a newer edit safe to send over what came since.

**Tests:** `device/queue.test.ts › never moves an edit made on the version a catch-up brought back onto an older answer`, `device/edge-replay.test.ts › keeps an edge receipt safe with grant blocked $grantBlocked and catch-up version $caughtUpVersion`.

### `queue-and-verdicts/edit-not-on-unlanded`

When an earlier edit of a row or an edge is answered `conflicted` or `refused`, is blocked for a reason other than `credential_refused`, or is `dead`, a device MUST NOT send a later unsent edit on a version that answer names.

**Reason:** a `conflicted` edit left the server's value on the row where it collided, a refused or blocked one did not land, and a `dead` one is not known to have; sent on such a version, a later edit would be taken over content this device never read.

**Tests:** `device/queue.test.ts › sends the edit behind a conflicted one on its own base, not the version the conflict came back with`, `› sends the edit behind a refused or blocked one on its own base`, `› holds an edit behind one the server answered unreadably, and sends it as it stands once that one is dead`.

### `queue-and-verdicts/edit-back-to-base`

When an earlier edit of a row or an edge is answered, blocked for a reason other than `credential_refused`, or made `dead`, and a later unsent edit that carries a property the earlier one carries is based on a later version than the earlier one and is not sent on the answer, a device MUST send the later edit on the earlier edit's version.

**Reason:** the later edit was made, for every property the earlier one carries, against that edit's value laid over the copy, not the server's, so on its own base the server would take the earlier value it carries as newer than the row's and apply it without a word; on the earlier base the server merges or conflicts on it.

**Tests:** `device/queue.test.ts › sends an edit made after a catch-up back onto the base of the edit it was made against where that one conflicted`, `device/edge-replay.test.ts › keeps an edge receipt safe with grant blocked $grantBlocked and catch-up version $caughtUpVersion`, `device/grant-recovery.test.ts › holds a later edit while an earlier receipt lacks a grant after catch-up to %s`.

### `queue-and-verdicts/edit-apart-as-stands`

When an earlier edit of a row is answered `conflicted` or `refused`, blocked for a reason other than `credential_refused`, or made `dead`, a device MUST NOT move the version of a later unsent edit of the row that carries no property the earlier one carries.

**Reason:** such an edit read the server's value of everything it carries, so its own base is what it was made against.

**Tests:** `device/queue.test.ts › sends an edit made after a catch-up that shares no property with a conflicted one ahead of it on its own base`, `› sends the edit behind a refused or blocked one on its own base`.

## An edit made against an earlier read

An editor holding a row while the copy takes in another device's write has what its person read, not what the copy has caught up to. Based on the version the copy holds, its save would carry every value it read as current, and the server would apply them over that write without a word (`versions/update-step`).

### `queue-and-verdicts/as-read-sent-on-read`

When a caller queues an update said to be read at a version above 0 and earlier than the one the copy holds, a device MUST send it on the version it was read at, but where `queue-and-verdicts/edit-back-to-base` sends it on an earlier one.

**Reason:** the server then merges it against that version (`versions/merge-stale`): a property only this edit changed lands, one only the other write changed stands, and one both changed goes as its merge policy says.

**Tests:** `device/queue.test.ts › sends an edit on the earlier version it says it read, where the copy has caught up since`, `› keeps both where another device changed the property an edit said it read`, `device/folders-placement.test.ts › bases a stale file's edit on the version written in it`.

### `queue-and-verdicts/as-read-bounds`

If a caller queues an update said to be read at version 0 while the copy holds a later version, or at a version later than the one the copy holds, then a device MUST refuse it `invalid`, queueing nothing.

**Reason:** no server mints 0 (`versions/create-claim-none`), and a version the copy has not reached was not read.

**Tests:** `device/queue.test.ts › sends an edit on the earlier version it says it read, where the copy has caught up since`.

### `queue-and-verdicts/as-read-held-ordinary`

When a caller queues an update said to be read at the version the copy holds, a device MUST queue and move it as it does any update.

**Tests:** `device/queue.test.ts › moves an edit said to be read on the version the copy holds onto the answer ahead of it, as any edit`.

### `queue-and-verdicts/as-read-laid-whole`

While an update said to be read at an earlier version waits, a device MUST lay its properties over the row as a merge without moving the version the copy holds.

**Reason:** the copy does not hold the version it was read at, so the edit records nothing it was made against, and a value it carries unchanged since the read shows over what came in meanwhile.

**Tests:** `device/queue.test.ts › sends an edit on the earlier version it says it read, where the copy has caught up since`, `› keeps a whole edit's clear showing through a catch-up, and lays one said to be read earlier over as a merge`.

### `queue-and-verdicts/as-read-never-moved`

When the write ahead of an update said to be read at an earlier version is answered, a device MUST NOT send that update on the answer's version.

**Reason:** moved, it would be taken as made against content it never read.

**Tests:** `device/queue.test.ts › never moves an edit said to be read onto the answer to an edit ahead of it`.

## An edit that sends its properties whole

### `queue-and-verdicts/whole-sent-replace`

When a caller queues an update that sends its properties whole, a device MUST send it with `properties_mode` `replace` (`items/update-replace`).

**Tests:** `device/queue.test.ts › sends an edit's properties whole, and shows what it cleared`, `device/folders-frontmatter.test.ts › clears a property whose line was taken out of a versioned file`, `device/fidelity.test.ts › holds the scripted folder door's whole-properties edits, moves and lifecycle to the server's`.

### `queue-and-verdicts/whole-shows-clear`

While an update that sends its properties whole, queued on the version the copy held, waits, a device MUST show the row with each property the update changed set as it sets it, each property it leaves out that it read cleared, and every other property as the row holds it.

**Reason:** a property another device added since the edit was made stays showing through a catch-up.

**Tests:** `device/queue.test.ts › sends an edit's properties whole, and shows what it cleared`, `› keeps a whole edit's clear showing through a catch-up, and lays one said to be read earlier over as a merge`.

### `queue-and-verdicts/whole-moved-onto-answer`

When a device moves an update that sends its properties whole onto the answer to an edit ahead of it, a device MUST send the answer's properties with the update's changes laid over them, and take that answer as what the update was made against for any later move.

**Reason:** a property dropped from a whole edit is one it clears, so a second move keeps what the first answer landed.

**Tests:** `device/queue.test.ts › moves a whole edit onto each answer ahead of it, keeping what each landed`, `device/folders-placement.test.ts › sends a file saved twice as two edits where another machine retitled the note meanwhile`, `device/folders-frontmatter.test.ts › keeps every save of three scanned before one drain`.

## An edit that moves a row

### `queue-and-verdicts/move-sent-as-retype`

When a caller queues an update naming another type or another tier than the row shows, a device MUST send `type` with `retype: true`, and `tier`, in the same body as its properties and the version it is based on (`items/retype` and `items/update-tier`).

**Reason:** a `type` sent without `retype` is a check the server refuses on a mismatch rather than a move.

**Tests:** `device/queue.test.ts › sends a retype and a tier change as an edit`, `device/fidelity.test.ts › matches a retype and a tier move sent as one update`.

### `queue-and-verdicts/move-same-not-sent`

When a caller queues an update naming the type or the tier the row already shows, a device MUST send neither that `type` nor that `tier`.

**Reason:** the drain reads a type or a tier sent in an edit as a move, and lets the row go where its answer is outside the slice.

**Tests:** `device/queue.test.ts › sends no retype naming the type the row already has`, `› sends no tier naming the tier the row already has, and keeps a row held outside the slice`, `› sends neither a retype nor a tier where the edit names neither`.

### `queue-and-verdicts/move-unknown-type`

If a caller queues an update moving a row to a type the copy's catalog does not hold, then a device MUST refuse it `unknown_type`, queueing nothing.

**Tests:** `device/queue.test.ts › refuses a retype to a type the catalog does not hold, before queueing it`.

### `queue-and-verdicts/move-shown-waiting`

While an update moving a row to another type or tier waits, a device MUST show the row at that type and tier over whatever puts the server's row back, a catch-up or the answer to an edit ahead of it.

**Tests:** `device/queue.test.ts › sends a retype and a tier change as an edit`, `› keeps showing a waiting move over the row a catch-up brings`, `› keeps showing a move queued behind an edit once that edit is answered`, `› blocks a move that collides with a write it did not read, keeping it`.

### `queue-and-verdicts/move-answer-held`

When a move is answered, or refused and read back, a device MUST hold the row as the server's answer or read gives it.

**Tests:** `device/queue.test.ts › holds a row moved within the slice to its answer`, `› holds a refused move to the row the server reads back`.

### `queue-and-verdicts/move-out-lets-go`

When the read after an answer or a refusal returns a row outside the copy's slice, a device MUST let the row go, with the edges it draws but those of a type the slice holds whole, unless the row is pinned or a write to it still waits.

**Reason:** the copy lets the row go as a catch-up would on the same row (`device/catch-up-leaves-slice`); an attachment's file item, held outside the slice, is pinned when it is made, so an edit of it keeps it.

**Tests:** `device/queue.test.ts › lets a row go once its retype out of the slice is answered`, `› keeps a pinned row its own answered move takes out of the slice`, `› keeps a pinned row outside the slice when its refused move is read back`, `› keeps the edges of a type held whole on a row its answered move lets go`, `› keeps the edges of a type held whole on a row its refused move, read back, lets go`, `› keeps a row held outside the slice when an edit to it is answered`, `› sends no tier naming the tier the row already has, and keeps a row held outside the slice`.

### `queue-and-verdicts/move-out-stays-out`

When a move ahead has let a row go, a device MUST NOT hold the row again for the answer to, or the refusal of, an edit behind the move.

**Tests:** `device/queue.test.ts › does not put back a row a move answered ahead let go, when an edit behind it is refused`, `› does not put back a row a move answered ahead let go, when an edit behind it is answered`.

## A create that lands on a row the server holds

A create carrying a natural key, a `source` with a `source_id`, lands on the row the key resolves where the server holds one (`items/natural-key-upsert`), whose id is not the one the device minted.

### `queue-and-verdicts/keyed-create-no-id`

When a drain sends a create carrying a natural key whose caller named no id, a device MUST send it without the id the device minted.

**Reason:** the server refuses a body `id` that is not the row the key resolves, so a minted id sent with a key another device's create already landed under is a create refused on every device but the first.

**Tests:** `device/queue.test.ts › sends a create carrying a natural key without the id it minted, and holds the row the answer names`.

### `queue-and-verdicts/plain-create-sends-id`

When a drain sends a create carrying no natural key, a device MUST send it with the id the row has in the copy.

**Reason:** the server keeps an id a create names (`items/create-client-id`), so the row keeps one id before the answer and after it.

**Tests:** `device/queue.test.ts › sends a create carrying a natural key without the id it minted, and holds the row the answer names`, `› sends queued writes in the order they were queued`.

### `queue-and-verdicts/landed-accepted-moves`

When a create is answered with a row under another id than the one it was queued under, a device MUST move the copy onto that row once a fresh read of it succeeds: the row under the minted id goes, and every unsent write that named it names the answered row instead.

**Reason:** left alone, each would address an id the server never held, and the copy would hold one item twice.

**Tests:** `device/queue.test.ts › sends a create carrying a natural key without the id it minted, and holds the row the answer names`, `› moves the copy onto the row a create lands on, with every write waiting on it`, `device/verdicts.test.ts › accepted: takes an upsert and a replayed repeat as accepted`.

### `queue-and-verdicts/landed-not-on-catch-up`

While the read that follows a create's answer naming another row has not succeeded, a device MUST keep the row under the minted id and every write that names it, whatever a catch-up brings.

**Reason:** only that read says the key may read the row now; a catch-up that brought the row says nothing of the writes still naming the minted id.

**Tests:** `device/queue.test.ts › moves the copy onto the row a create was answered with only at the read after it, though a catch-up brought that row first`.

### `queue-and-verdicts/landed-reported-row`

When a create's answer moves the copy onto another row, a device MUST report the create's entry with that row in `item_id`.

**Tests:** `device/queue.test.ts › sends a create carrying a natural key without the id it minted, and holds the row the answer names`, `› refuses a create whose natural key names a row, and moves the copy onto that row`.

### `queue-and-verdicts/landed-refused`

When the server refuses a create carrying a natural key `409 version_conflict` or `409 ancestor_unavailable` with `current.id` naming another row than the create's own, a device MUST give it the verdict `refused` with the server's code as its reason.

**Reason:** the envelope names the row the key resolved (`versions/create-names-row`), which exists, and the same create sent again meets the same refusal, so there is nothing for a release to send. A blocked create would leave the copy holding one item twice, and an edit of the minted row refused `item_not_found`.

**Tests:** `device/queue.test.ts › refuses a create whose natural key names a row, and moves the copy onto that row`, `› adopts the fresh certified row after a create is refused with version_conflict`.

### `queue-and-verdicts/landed-refused-moves`

When a create carrying a natural key is refused naming another row, a device MUST move the copy onto that row once a fresh read of it succeeds, as `queue-and-verdicts/landed-accepted-moves` says.

**Tests:** `device/queue.test.ts › refuses a create whose natural key names a row, and moves the copy onto that row`, `› adopts the fresh certified row after a create is refused with version_conflict`.

### `queue-and-verdicts/landed-adds-follow`

When a create carrying a natural key is refused naming another row and a fresh read of that row succeeds, a device MUST send onto that row each write waiting on the create that only adds to it: a tag added, an edge made to or from it, and an edge's end moved to it.

**Tests:** `device/queue.test.ts › refuses the writes behind a landed create that would take from the row, and sends those that add`, `› refuses a create whose natural key names a row, and moves the copy onto that row`, `› holds a write made to a refused create's row until a read finds the row its natural key names`, `device/edge-move.test.ts › holds a move onto its own create refused onto a row no read has found yet, and sends it naming that row once found`.

### `queue-and-verdicts/landed-takes-refused`

When a create carrying a natural key is refused naming another row and a fresh read of that row succeeds, a device MUST refuse without sending each write waiting on the create that replaces, removes or moves the row's state: an update, a delete, a restore or a transition, a metadata write, a tag removed, and an extension written or deleted.

**Reason:** each was made against the row this device created; sent to the server's row it would do to another device's item, one this device never read, what was meant for this one.

**Tests:** `device/queue.test.ts › refuses the writes behind a landed create that would take from the row, and sends those that add`, `› refuses a create whose natural key names a row, and moves the copy onto that row`, `› holds a write made to a refused create's row until a read finds the row its natural key names`.

### `queue-and-verdicts/landed-ancestor-read`

When a create carrying a natural key is refused `409 ancestor_unavailable` naming another row, a device MUST hold that row as a read of it by id returns it, so a write made from it next is based on that version.

**Reason:** the version the create read, if any, is one the server no longer holds, which is as good as never read: a write made from the row next replaces content this device never read as the last writer, and nothing here protects that content. Kept as the base instead, a thinned version would have every edit of the row refused the same way.

**Tests:** `device/queue.test.ts › refuses a create whose natural key names a row, and moves the copy onto that row`, `› holds the row a read returns after a create refused ancestor_unavailable, not the row the envelope named`.

### `queue-and-verdicts/landed-target-unreadable`

When the read of the row a refused create's natural key names finds no row the key reads, a device MUST keep the refusal, the row under the minted id and the writes waiting on the create as they are, reading the row again at each later drain.

**Reason:** whether what waits on the create goes to that row or is refused is not known until a read finds the row.

**Tests:** `device/queue.test.ts › preserves a refused create while its natural-key target cannot be read`, `› goes on with the queue while a refused create's natural-key target cannot be read`, `› holds a write made to a refused create's row until a read finds the row its natural key names`.

### `queue-and-verdicts/landed-absent-goes-on`

When the read of the row a refused create's natural key names finds no row the key reads, a device MUST go on to the writes that do not wait on the create, in that drain and in every later one.

**Reason:** a row in the bin, or one the key no longer reads, may never be found again, and the rest of the queue does not wait on it.

**Tests:** `device/queue.test.ts › goes on with the queue while a refused create's natural-key target cannot be read`.

### `queue-and-verdicts/landed-read-retried`

If the read of the row a create landed on meets an environmental failure, then a device MUST keep the create's verdict and refusal count as recorded and read the row again at the next drain without sending the create again.

**Tests:** `device/queue.test.ts › reads the row a create landed on again after a failure that clears on its own`.

### `queue-and-verdicts/landed-read-401-expires`

If the server answers the read of the row a create landed on `401` naming its contract, then a device MUST expire the copy, keeping the create's verdict and every other queued write as they were.

**Tests:** `device/queue.test.ts › expires the copy without changing a settled receipt when the landed read loses its credential`.

### `queue-and-verdicts/landed-waiting-laid-over`

When the copy moves onto the row a refused create's natural key names, a device MUST lay each write still waiting that moved with it over that row.

**Tests:** `device/queue.test.ts › holds a write still waiting behind a landed create on the row it landed on`.

### `queue-and-verdicts/landed-pin-moves`

When the copy moves onto the row a refused create's natural key names, a device MUST move the pin the create's row held onto that row.

**Reason:** the pin follows the row a create of a row the slice does not take is answered with (`device/pin-holds`), and a refusal naming the row is that answer; left on the minted id, it would hold nothing and the landed row would go at its next event.

**Tests:** `device/queue.test.ts › moves the pin of a create the slice does not hold onto the row a refusal names its natural key under`.

### `queue-and-verdicts/trashed-ack-refused`

When the server answers a create carrying a natural key `2xx` with `acknowledged: true` and the row it names in the bin, a device MUST give it the verdict `refused` with the reason `trashed`.

**Reason:** the server writes nothing for such a create (`items/natural-key-trashed` and `versions/create-trashed-version`). Taken as `accepted`, the copy would move onto a row in the bin and take what the create carried as written, dropped with nothing saying so. A keyed create names no id of its own, so such an answer is never a repeat of this device's earlier create.

**Tests:** `device/queue.test.ts › refuses a create whose natural key names a row somebody trashed, and forgets its row`.

### `queue-and-verdicts/trashed-ack-forgets`

When a create is refused `trashed`, a device MUST let go of the row the create was queued as once the read after the refusal finds no such row on the server.

**Tests:** `device/queue.test.ts › refuses a create whose natural key names a row somebody trashed, and forgets its row`.

### `queue-and-verdicts/trashed-ack-in-bin`

When a create is refused `trashed`, a device MUST report the refusal as about a row in the bin.

**Reason:** an app can then offer to restore the row, as it can for an edit refused for a row in the bin (`queue-and-verdicts/refusal-in-bin`).

**Tests:** `device/queue.test.ts › refuses a create whose natural key names a row somebody trashed, and forgets its row`.

## The tier of a create

### `queue-and-verdicts/create-slice-tier`

When a caller creates an item naming no tier, and its natural key names neither a row the copy holds from the server nor this device's own create still waiting, a device MUST send and show the create at the tier the copy's slice holds, `library` for a slice of both tiers.

**Reason:** left out, the server gives the create its credential's `default_tier` (`items/tier-new`), which need not be the slice's, and the copy would show the row at one tier and get it back at another. In a slice of both, `library` is the tier a create naming none takes on the server.

**Tests:** `device/queue.test.ts › sends a create naming no tier with the tier the slice holds`, `› sends a create naming no tier from a slice of both tiers at the library, and one naming the feed at the feed`, `device/slice-tiers-live.test.ts › creates offline at each tier in a slice of both, and the server holds each where it was shown`.

### `queue-and-verdicts/create-named-tier`

When a caller creates an item naming a tier, a device MUST send and show the create at that tier.

**Tests:** `device/queue.test.ts › sends a create naming no tier from a slice of both tiers at the library, and one naming the feed at the feed`, `device/slice-tiers-live.test.ts › creates offline at each tier in a slice of both, and the server holds each where it was shown`.

### `queue-and-verdicts/keyed-create-keeps-tier`

When a caller creates an item naming no tier whose natural key names a row the copy holds from the server, a device MUST send the create with no `tier`, and show it at that row's tier.

**Reason:** the server leaves the tier of a row a key resolves as it stands (`items/tier-upsert`), so a row a person moved to the feed stays there through the next re-save, where a tier sent would move it back.

**Tests:** `device/queue.test.ts › sends no tier with a create whose natural key names a row the copy holds, and shows it at that row's tier`, `device/slice-tiers-live.test.ts › re-saves a feed row by its natural key in a slice of both without moving it`.

### `queue-and-verdicts/keyed-create-own-tier`

When a caller creates an item naming no tier whose natural key names this device's own create still waiting, a device MUST send and show the create at that create's tier.

**Reason:** if the create ahead is refused, this one makes the row, and left out its tier would be the credential's default.

**Tests:** `device/queue.test.ts › sends a create naming no tier whose natural key names its own create still waiting at that create's tier`.

### `queue-and-verdicts/create-outside-pinned`

When a caller creates an item the copy's slice does not take, by its type or its tier, a device MUST pin it when it is queued.

**Reason:** the copy then holds what it shows through the answer and the event that follow, an attachment's file item of a type outside the slice among them; the pin follows the row as `device/pin-holds` says. A create the copy showed and then let go at its own event reads as saved and then lost.

**Tests:** `device/queue.test.ts › holds a create the slice does not hold through its answer and its event`, `› sends a create naming no tier from a slice of both tiers at the library, and one naming the feed at the feed`, `› pins a create of a type the slice does not take when it is queued`.

## Drains that overlap

### `queue-and-verdicts/second-process-no-drain`

If a process asks for a drain of a store that another process holds open as its writer, then a device MUST refuse the drain with `reading_handle`, sending nothing.

**Reason:** a second process opening the store is a reading handle (`device/reader-not-writer`). So no write is sent twice by two drains at once, and each drain reports only the writes it had answered.

**Tests:** `device/queue.test.ts › refuses a drain from a second process while one runs, and sends each write once`.

### `queue-and-verdicts/drains-in-one-process`

When a drain is asked for in a process while another runs on the same store, a device MUST wait for that one to end and then send only what is still unanswered.

**Reason:** two drains at once, an app's after a write and its timer's, would each send every unanswered write: the server answers the repeats from its record, so the data comes out right, but every write costs a request per drain and every drain reports writes another sent.

**Tests:** waiting on #1890.

## Local checks of an item's properties

A device checks an item write against the type catalog the copy holds before it changes the copy or the queue, so a row shown as queued never holds a value the type it holds already proves invalid. Permissions, strict mode, uniqueness and recurrence remain the server's to judge, and a type the copy does not hold is `device/unknown-type-write`.

### `queue-and-verdicts/check-refuses-invalid`

If a caller queues an item create or update that leaves out a property its type requires, or carries a value a field of its type refuses, as the held catalog declares the type, then a device MUST refuse it in the `validation` class with the server's code `invalid_properties` and a message naming the property, changing neither the copy nor the queue and sending nothing.

**Tests:** `device/property-validation.test.ts › refuses missing and invalid fields atomically and accepts their boundary neighbours`, `device/property-validation-live.test.ts › matches a real server's field decisions and keeps queued writes across a catalog change`, `device/property-validation.test.ts › judges current merge, replace, retype and version zero while leaving stale results to the server`.

### `queue-and-verdicts/check-as-server`

When a device judges a property value against a field of the held catalog, a device MUST judge the field's kind, enum membership, length in UTF-16 code units, array length, a NUL in a bounded string, and the `url`, `email`, `date`, `datetime` and `thumbnail` rules as the server does (`types.md`).

**Tests:** `device/property-validation-live.test.ts › matches a real server's field decisions and keeps queued writes across a catalog change`, `device/property-validation.test.ts › refuses missing and invalid fields atomically and accepts their boundary neighbours`.

### `queue-and-verdicts/check-inherited-nearest`

When a device judges a property its type inherits, a device MUST judge it as the nearest type in the chain that declares it declares it.

**Reason:** a subtype may redeclare an inherited field required (`types.md`), and a grandchild that declares nothing of its own takes that.

**Tests:** `device/property-validation.test.ts › judges an inherited field as the nearest type in the chain declares it`.

### `queue-and-verdicts/check-accepts`

When a device judges an item write against the held catalog, a device MUST accept a null for a field its type does not require, a property its type does not declare, a string under an annotation-only format, and an array element of any value.

**Reason:** the server's field validator accepts each of them; strict mode on the server can still refuse an undeclared property.

**Tests:** `device/property-validation.test.ts › refuses missing and invalid fields atomically and accepts their boundary neighbours`.

### `queue-and-verdicts/check-current-result`

When an update names the version the copy holds, of a row other than this device's own unanswered create carrying a natural key, a device MUST judge the properties its merge, replace or retype leaves on the row against the type it leaves the row at.

**Tests:** `device/property-validation.test.ts › judges current merge, replace, retype and version zero while leaving stale results to the server`.

### `queue-and-verdicts/check-stale-supplied`

When an update names an earlier version than the copy holds, or names version 0 of this device's own unanswered create carrying a natural key, a device MUST judge only the values it carries, requiring no field.

**Reason:** only the server holds the version a stale edit was made against and the row an unseen natural key resolves, so only the server can judge what the write leaves.

**Tests:** `device/property-validation.test.ts › judges current merge, replace, retype and version zero while leaving stale results to the server`, `› keeps repeated creates and edits to an unanswered keyed placeholder unresolved`.

### `queue-and-verdicts/check-create-whole`

When a caller queues a create carrying no natural key, a device MUST judge every property of the new row, requiring each field its type requires.

**Tests:** `device/property-validation.test.ts › refuses missing and invalid fields atomically and accepts their boundary neighbours`.

### `queue-and-verdicts/check-known-upsert`

When a caller queues a create whose natural key names a row the copy holds from the server, of the same type, with no version or the version the copy holds, a device MUST judge that row's properties with the create's laid over them.

**Tests:** `device/property-validation.test.ts › checks known upserts and supplied values on unresolved or stale targets`, `› judges a known upsert by the row it leaves, and a stale or other-type one by what it supplies`.

### `queue-and-verdicts/check-unknown-target`

When a caller queues a create carrying a natural key that does not name a row of the same type the copy holds from the server, at the version the create carries if it carries one, a device MUST judge only the values it carries, requiring no field.

**Reason:** a row the copy has not seen may hold every field the create leaves out.

**Tests:** `device/property-validation.test.ts › checks known upserts and supplied values on unresolved or stale targets`, `› keeps repeated creates and edits to an unanswered keyed placeholder unresolved`, `› judges a known upsert by the row it leaves, and a stale or other-type one by what it supplies`.

### `queue-and-verdicts/catalog-change-kept`

When the catalog changes after a write is queued, a device MUST keep the write, unjudged again, for the server's verdict.

**Reason:** it was admitted against the catalog held when it was queued. A refusal keeps its content and its typed field details (`queue-and-verdicts/clear-keeps-content` and `queue-and-verdicts/refusal-parts`).

**Tests:** `device/property-validation.test.ts › keeps a queued write and its typed server refusal after the server catalog changes`, `device/property-validation-live.test.ts › matches a real server's field decisions and keeps queued writes across a catalog change`.

## A null a create carries

### `queue-and-verdicts/create-null-optional`

When a create carries a null for a field its type declares and does not require, or for `attachments` or `links`, a device MUST hold the new row without that field.

**Reason:** the server makes the row without it (`items/create-null-optional`), and a copy showing the null would show a field the server never holds.

**Tests:** `device/null-properties-live.test.ts › leaves out a create's null on a declared optional field, as the server does`.

### `queue-and-verdicts/create-null-undeclared`

When a create carrying no natural key carries a null for a property its type does not declare, a device MUST hold the new row with that property set to null.

**Reason:** the server holds such a null as a value.

**Tests:** `device/null-properties-live.test.ts › leaves out a create's null on a declared optional field, as the server does`.

## A placement a folder gives way from

### `queue-and-verdicts/folder-gives-way`

When a folder gives way to another machine's placement of a file (`folders/placement-give-way-queue`), a device MUST take out of the queue every write to that `in-folder` edge that is not `accepted`, a create refused as a duplicate among them, without a caller's withdraw or discard.

**Reason:** the refused create carries only a path the folder chose, from the item's title or where its file sat; the item and the file both stay, and the pull moves the file to the placement the server holds. Kept until discarded, the create would leave a refusal to discard for nearly every item two machines both pulled.

**Tests:** `device/folders-placement.test.ts › follows the placement another Mac made first, and leaves no refusal behind`, `› follows another Mac's move of the same file, giving its own way`.

## A restore of a row the copy does not hold

### `queue-and-verdicts/restore-by-id`

When a caller restores a row the copy does not hold, a device MUST queue the restore by the row's id.

**Reason:** a row read from the bin (`device/bin-unheld`) is not held, and nor is one the slice never took, yet the person restoring it is restoring a row the server holds. Queued, the restore waits out a network as any write does and goes after a restart.

**Tests:** `device/bin-live.test.ts › restores a row read from the bin that the copy does not hold`.

### `queue-and-verdicts/restore-not-entered`

When a caller restores a row the copy does not hold, a device MUST NOT enter the row on the restore alone.

**Reason:** a row entered before the answer would be one the copy holds no read of, and a refusal would leave nothing to put it back to. The row enters as any row does, by the read after the answer or its `item.restored` event where the slice or a pin takes it.

**Tests:** `device/bin-live.test.ts › restores a row read from the bin that the copy does not hold`.

### `queue-and-verdicts/restore-once`

If a caller restores a row the copy does not hold while a restore of it already waits, then a device MUST refuse it `invalid`, queueing nothing.

**Reason:** the bin goes on listing the row until the restore is answered, so a person can ask twice, and the second restore would come back a refusal for a row that was restored.

**Tests:** `device/bin-live.test.ts › restores a row read from the bin that the copy does not hold`.

## An edit that moves an edge's end

### `queue-and-verdicts/edge-move-one-update`

When a caller edits an edge naming a new source or a new target, a device MUST queue the move as one `update_edge` write carrying the end it moves, the properties the edit names and the version the copy holds, never a delete and a create.

**Reason:** the server moves one end of an edge in one write, judged without the edge being moved (`edges/move-target`, `edges/move-source` and `edges/move-cardinality`). A delete and a create are two writes with two verdicts: offline, the delete can be accepted and the create refused, and the end that stays is left with no edge, a child with no parent.

**Tests:** `device/edge-move.test.ts › sends a move as one update of the edge, on the version the copy holds`, `device/edge-move-live.test.ts › re-parents a note offline in one write a real server takes, never leaving it without a parent`.

### `queue-and-verdicts/edge-move-held-end`

When a caller edits an edge naming an end as the copy holds it, a device MUST leave that end out of the update.

**Reason:** the server judges a named end against the edge it holds, which a move still waiting ahead may not leave where the copy shows it: sent, it would ask again for a move the server may refuse, or read as a move of both ends.

**Tests:** `device/edge-move.test.ts › refuses a move the server refuses whatever its rows hold, queueing nothing`.

### `queue-and-verdicts/edge-move-shown`

While a move of an edge waits, a device MUST show the edge at its new end, read from either end, over whatever puts the server's edge back, a catch-up or the answer to a write ahead of it.

**Reason:** a local read would otherwise show the old parent still drawing a child the person has moved.

**Tests:** `device/edge-move.test.ts › shows a waiting move at its new end from both ends, over the answer to the edit ahead of it`, `device/edge-move-live.test.ts › re-parents a note offline in one write a real server takes, never leaving it without a parent`, `device/catch-up.test.ts › lays its own waiting move of an edge's target over the server's change to the edge`, `› keeps an edge whose source moved outside the slice while a move of its own waits`.

### `queue-and-verdicts/edge-move-refused-back`

When the server refuses a move of an edge, a device MUST hold the edge where the server holds it.

**Tests:** `device/edge-move-live.test.ts › puts the edge back at its old parent when the server refuses the move for a cycle`.

### `queue-and-verdicts/edge-source-move-expires`

When the server takes a move of an edge's source, a device MUST expire the copy once the move's verdict is recorded.

**Reason:** a move of a source changes the server's read view (`read-views/view-moves-edge-source`), so the next hydration holds the edge where the server does.

**Tests:** `device/edge-move-live.test.ts › re-parents a note offline in one write a real server takes, never leaving it without a parent`, `› holds a move onto its own unanswered create, and sends it naming the row the create landed on`.

### `queue-and-verdicts/edge-move-waits-new-end`

When a caller moves an edge's end to a row of this device's own create that has no verdict, is `blocked` or `dead`, or was refused onto a row its natural key names that no read has found yet, a device MUST name that create in the move's `depends_on`.

**Reason:** the server holds no such row and would refuse the move `404 item_not_found`; a refused create refuses the move with it, and the edge stays at its old end.

**Tests:** `device/edge-move-live.test.ts › holds a move onto its own unanswered create, and sends it naming the row the create landed on`, `device/edge-move.test.ts › holds a move onto its own create refused onto a row no read has found yet, and sends it naming that row once found`.

### `queue-and-verdicts/edge-move-names-landed`

When the create a waiting move names as its new end is answered with another row, or is refused onto another row its natural key names that a read then finds, a device MUST send the move naming that row.

**Reason:** a create carrying a natural key lands on the row its key resolves, whose id is not the one the device minted, and a move still naming the minted id would be refused for a row the server never made.

**Tests:** `device/edge-move-live.test.ts › holds a move onto its own unanswered create, and sends it naming the row the create landed on`, `device/edge-move.test.ts › holds a move onto its own create refused onto a row no read has found yet, and sends it naming that row once found`.

### `queue-and-verdicts/edge-move-always-refused`

If an edge edit moves both ends, or moves an end of a type whose end that stays may hold more than one edge of it where the held catalog names that type, then a device MUST refuse it in the `validation` class carrying the server's code `validation_error`, queueing nothing.

**Reason:** the server refuses either body `400 validation_error` whatever its rows hold (`edges/move-many` and `edges/move-both-ends`). A refusal that turns on rows, a second edge at the new end, a cycle through other edges, or a new end the server does not hold, is left to the server, since the copy may not hold the rows that decide it.

**Tests:** `device/edge-move.test.ts › refuses a move the server refuses whatever its rows hold, queueing nothing`.

### `queue-and-verdicts/edge-self-loop`

If an edge create or an edge move would leave the edge running from a row to itself, then a device MUST refuse it in the `validation` class carrying the server's code `edge_cycle`, queueing nothing.

**Reason:** the server refuses a self-loop `400 edge_cycle` on every edge type, because one edge closes it (`edges/cycle-self-loop` and `edges/move-cycle-self`).

**Tests:** `device/edge-move.test.ts › refuses a move the server refuses whatever its rows hold, queueing nothing`.
