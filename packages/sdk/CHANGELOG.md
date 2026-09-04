# @withmarfa/sdk

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
