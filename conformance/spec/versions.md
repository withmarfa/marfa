# Versions

Every item carries a `version` that starts at 1 and moves with each write, and the server keeps snapshots of earlier properties for three-way merges.

## Versioning

1. A created item has `version: 1`. `correctness/item-versioning.test.ts › version starts at 1 on creation`, `correctness/persistence.test.ts › item is retrievable by ID after creation`.
2. An update advances the version by one and the response carries the new version. `correctness/item-versioning.test.ts › version increments on update`.
3. Every update writes a snapshot of the properties before it; `GET /items/{id}/versions` lists snapshots with `item_id`, `version` and `properties`, oldest first, and an item never updated has none. `correctness/item-versioning.test.ts › updating an item creates a version snapshot`, `› multiple updates create multiple versions`, `› every update writes a snapshot, with or without force_snapshot`, `› version history for item with no updates is empty`, `› versions have correct item_id reference`.
4. `force_snapshot: true` on an update is accepted and changes nothing observable: three rapid updates leave three snapshots with it and without it. `correctness/item-versioning.test.ts › multiple updates create multiple versions`, `› every update writes a snapshot, with or without force_snapshot`.
5. An unknown item's history answers `404 item_not_found`; a malformed id answers `400 invalid_id`. `correctness/item-versioning.test.ts › answers 404 for an unknown item's history and 400 for a malformed id`.

## Concurrency

Statements 6 to 9 are about the update door, which requires the version. Statement 10 is the create door, which does not: a create has no version to have read, and one sent there is a precondition on the single path that overwrites.

6. A `PATCH /items/{id}` with no `version` is refused `400 missing_required_field`. An update names the version it is based on, or it is a blind overwrite of whatever arrived since, which the contract does not offer. `correctness/item-versioning.test.ts › an update naming no version is refused`.
7. A `PATCH` naming the current version succeeds and advances it. `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope` (the first write), `compliance/error-codes.test.ts › rejects a stale write whose base version is retained` (the first write).
8. A `PATCH` naming a retained earlier version whose changes collide with changes made since answers `409 version_conflict` with `current`, `ancestor`, `conflicting_fields` in ascending order, and the type's resolved `merge_policy`; `ancestor.version` is the version the caller named. `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `compliance/error-codes.test.ts › rejects a stale write whose base version is retained`, `correctness/merge-policy.test.ts › keep-both and LWW arrive in one 409, and the resolution reads back`.
9. A `PATCH` naming a version for which no snapshot exists, including 0 and a number never issued, answers `409 ancestor_unavailable` with `current` and `requested_version` and no ancestor, and is never merged automatically. `correctness/item-versioning.test.ts › a version no client ever read answers ancestor_unavailable`, `compliance/error-codes.test.ts › rejects an update naming a version that never existed`.
10. A `POST /items` whose `(source, source_id)` resolves a live row may carry a `version`, and then that upsert is conditional and answers the update door's envelopes: `409 version_conflict` for a stale value, `409 ancestor_unavailable` for one no snapshot covers. Without a `version` the upsert stays unconditional, because a caller creating a row it has never read has no version to name. A repeated `id`, and a natural key resolving a trashed row, are acknowledged rather than written, so neither has a precondition to fail. `sync/idempotency.test.ts › a create naming a stale version on an existing row is refused`.
11. A stale write whose changed fields do not collide with the fields changed since is merged: only the caller's genuine changes are applied over the current row. `correctness/merge-policy.test.ts › non-conflicting writes from two clients both apply (different fields)`.

## Merge policy

12. `GET /types/{id}` returns the type's resolved `merge_policy`, inheritance already walked: `fields` naming per-field strategies and a `default`. For `core.note`, `body` and `notes` are `keep_both_copies` and everything else falls to `last_writer_wins`. `compliance/types.test.ts › GET /types/core.note returns the artifact-declared merge_policy`, `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`.
13. A colliding write sent with `?conflict=auto` is resolved by the server in one transaction: a `last_writer_wins` field takes the later writer; a `keep_both_copies` field keeps the server's value on the original and writes the losing value to a sibling item of the same type tagged `conflicted-copy`, attributed to the writer's `source`. `sync/conflict.test.ts › keeps both copies in one write where the type says to`.
14. The same stale write without `?conflict=auto` is refused `409 version_conflict`. `sync/conflict.test.ts › keeps both copies in one write where the type says to` (the control before the resolved write).
15. The resolution the suite performs client-side from the envelope lands the same way: keep-both fields spawn a `conflicted-copy` sibling and last-writer-wins fields take the later writer, per field, through the policy default and through a child type's override. `correctness/merge-policy.test.ts`.

## Edges

16. An edge is created at `version: 1`; an edge `PATCH` naming a stale version is refused, one naming the current version is accepted, and one naming no version is refused `400 missing_required_field` exactly as an item's is. `correctness/edges/edges-crud.test.ts`, `sync/edge-version.test.ts › refuses an update naming a stale version and accepts the current one`, `› refuses an update naming no version`.
