# @withmarfa/sdk

## 5.0.0

### `@withmarfa/sdk/replica` is removed

The in-memory mirror is gone: the subpath, its exports-map entry and its build
entry. Nothing is aliased and there is no shim. An import of
`@withmarfa/sdk/replica` now fails to resolve, which is the intended way to find
out.

**It holds items and never the metadata sidecar, and that is what decides it.**
Tags and favorites do not live on the item, so a `metadata.changed` frame passes
the mirror's filter on the strength of the item it carries, and only that item is
written: `event.metadata` is dropped on the floor, and no row the mirror holds
ever had a tag on it to begin with. A surface that filters by tag cannot be
backed by the mirror at all, and a table view over it renders an empty tag
column, which is an answer rather than an absence. No amount of work in the consumer closes that;
it would need a second, non-mirror source beside it, at which point the mirror
is not the reactive layer.

It was also measured behind one real screen in a web client, against the pattern
that client already used — a server-backed query cache kept honest by the change
stream — and it lost the claim it existed to make. On a first frame with data
already held it was about 2.5 times slower, in its best available form: one
collection per type for the session's lifetime, with filtering and ordering
inside the live query rather than over its result. Neither arm goes to the
network on that measurement, and neither moves when latency is emulated, so what
separates them is the cost of materializing a live query rather than a round
trip. Its cold start grows with the size of the type, which is structural: it
reads the whole type at 200 rows per request and commits nothing until the walk
finishes, where a paged read answers from the first page.

**It won one measurement.** After a bulk write upstream it made no requests where
the query arm made hundreds, because it applies each change frame to what it
holds. Those hundreds are a defect in that client's invalidation strategy, filed
against it and owned there — a reason to fix one cache, not to publish a second
reactive system. Applying frames without re-reading also means treating the
change stream as a source of truth. That is a design position rather than a
defect, and it is not the one taken here: the stream is an invalidation signal,
and a client re-reads after a gap. The mirror handled the terminal
`catchup_too_old` frame correctly and discarded everything to re-read, so this is
a disagreement about what a stream is for, not a bug it had.

**Nothing consumed it.** No repository in the organization imported the subpath at
any point.

### What to use instead

An ordinary query cache over `client.items.*`, invalidated by
`client.events.subscribe`. That is what every client here already did:

```ts
const subscription = client.events.subscribe({
  type: "core.note",
  onEvent: () => {
    // Mark stale and let the cache re-read. The frame is the signal that
    // something changed, not the new value.
    queryClient.invalidateQueries({ queryKey: ["items", "core.note"] });
  },
  // A gap has been reported; the held data may be wrong in ways no frame
  // will describe, so discard rather than resume.
  onCatchupTooOld: () => {
    queryClient.invalidateQueries({ queryKey: ["items"] });
  },
});
```

Writes stay optimistic the same way they were, through the cache's own
`onMutate`/rollback rather than through the mirror, and carry `expectedVersion`
and a conflict strategy exactly as a direct `client.items.update` does.

If you want a local copy that survives a restart, queues writes made with no
network and holds its own type registry, that is `@withmarfa/sdk/local` — a
different thing, and the one the design keeps.

### Unchanged

`@tanstack/db` stays an optional peer at `>=0.6.17 <0.9.0`. The local engine's
projection binds the same shape the replica did, so the floor did not move.

## 4.0.0

### Conflict resolution moved to the server

`auto` no longer resolves anything in the kit. It sends `conflict=auto` on the
update and reads the outcome, so the merge happens once, on the server, inside
the transaction that performs the write.

**`last_writer_wins` changed direction, and this is the migration note that
matters.** A conflicting `last_writer_wins` field now takes the value in the
write being resolved. It previously took the value already on the server,
which is first-writer-wins under a name saying the opposite — and under that
direction the losing value went nowhere at all: no sibling, nothing reported,
and a `200` returned, so the author was told their edit had landed when it had
been dropped. The new direction loses strictly less, but it is a different
answer for the same conflict, so re-check any code that depended on the old
one. `callback` lets you pin the old direction explicitly.

Data already written is unaffected. The old resolution ran entirely in the
kit, so no server ever applied a direction to a stored row.

### A thinned base version throws a different error

A write whose base version's snapshot has been thinned away now refuses with
`ancestor_unavailable` and the kit throws the new `AncestorUnavailableError`
rather than `ConflictError`. **An app catching `ConflictError` stops handling
that case**, so catch both, or catch `MarfaError` and branch on `code`.

It carries `current` and `requestedVersion`. There is no ancestor and no field
list, because there genuinely is none: nothing can be shown _not_ to have
collided. Re-read and re-apply rather than resolving it.

### `UpdateOptions.type` removed

It existed only to save a type lookup before the kit created a sibling itself.
Nothing creates one in the kit now. Delete the option; the server knows the
type of the row it is resolving.

### Added

- `AncestorUnavailableError`, exported from the package root.
- The resolved-update response carries a `conflict_resolution` block naming
  the fields that collided, the strategy applied to each, and the sibling.
  `conflictAutoMerged` now reads `conflictedCopyId` from it — the only place
  the sibling is reported, since no route says what a write created.

### Retrying

Send an `Idempotency-Key` on any update you might retry. The sibling's id is
derived from it, so a write that executes twice writes one sibling rather than
two. Without a key the server cannot tell a retry from a second edit.
