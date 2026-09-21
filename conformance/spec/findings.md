# Findings

Where the server contradicts its own OpenAPI document, where its document describes something a caller cannot observe, where it contradicts the device half of this specification, or where two doors that answer the same question answer it differently. Each entry names the operation, what the document says, what the server does, and the fixture that shows it. The fixtures assert what the server does; nothing here is fixed on the suite's side, and nothing is a proposal. This file is the channel to the server's maintainers. Two entries carry no fixture, and each says why.

**An entry goes when the behavior it recorded changes, never because the contract softened.** Once the server answers as the document says, or the document says what the server does, the entry has nothing left to record, and the fixtures that asserted the old answer assert the new one.

## 1. `nullable: true` inside a 3.1 document

The document declares `openapi: "3.1.0"` and marks nullable positions with `nullable: true`, a 3.0 keyword that a 2020-12 schema reader ignores. Where a position also carries a type, a strict reader rejects the `null` the server sends. The suite's validator widens every such position to a null-admitting type before checking a body, which is the one place it reads the document more charitably than written. Shown by every fixture that calls `expectMatchesSchema`, for example `compliance/key-management.test.ts › lists keys and includes a newly created key`, where `POST /keys` declares `last_used_at` as `{ type: string, nullable: true }` and sends `null`.

## 2. `DELETE /admin/platform-types/{id}`: 409 where the document declares 404

The document declares 404 for an identifier no platform row carries. The server answers 409 `conflict` with the same refusal it gives a type the build still ships. `compliance/platform-types.test.ts › answers 409 for an identifier no platform row carries`.

## 3. `POST /auth/oauth2/register`: the 400 has no declared content and is not the envelope

The document declares the 400 with no content schema. The server answers an RFC 7591 error object, `{ "error": "invalid_redirect_uri", "error_description": "..." }`, not the `{ "error": { "code", "message" } }` envelope every other door uses. `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`.

## 4. `GET /events`: the 400 and 401 have no declared content

The document declares both statuses with no content schema. The server answers the standard envelope, `validation_error` for a refused filter and `unauthorized` for a missing credential. `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`, `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

## 5. `POST /admin/restore-archive` is served and unpublished

The route is stripped from the document as an internal operation, yet it is the only way an archive produced by `GET /export?format=archive` comes back, and it is covered here as an operator maintenance door. A caller reading the document cannot find it. `compliance/admin-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`.

## 6. `DELETE /items/bulk-actions/jobs/{id}`: the queued transition is unobservable

The document says a queued job flips to `canceled` immediately and an in-progress one flips between chunks. The worker takes a job as soon as it is queued and finishes before a second request can reach the door, so no caller over the wire can observe either transition. `compliance/bulk.test.ts › DELETE on a terminal job answers 200 with its final state unchanged`.

## 7. Statuses the fixtures observe that the document does not declare

Every entry is a status a fixture asserts on an operation whose served document lists no such response.

- `POST /types` declares `201 401 403 409 429`. The server answers `400` for a malformed identifier (`validation_error`), a body without `fields` (`missing_required_field`), a field shadowing a first-class item field (`property_shadows_field`), a merge policy naming an unknown field or strategy, and a child changing an inherited field (`inheritance_violation`); and `422 compatible_with_violation`. `compliance/types.test.ts › rejects type registration with invalid type identifier`, `› rejects type registration without fields`, `› rejects type registration whose property name shadows a first-class Item field`, `› POST /types rejects a merge_policy referencing an unknown field`, `compliance/type-inheritance.test.ts › rejects a child type that changes an inherited field shape (inheritance_violation)`, `› rejects compatible_with target that does not exist`.
- `PUT /types/{id}` declares `200 401 403 404 429`; the server answers `422 version_bump_mismatch`. `compliance/type-versioning.test.ts › rejects no-op resubmission with version_bump_mismatch`.
- `GET /items/{id}` declares `200 401 404 429`; the server answers `400 invalid_id` and `403 type_not_permitted`. `compliance/error-codes.test.ts › rejects request with malformed ID`, `compliance/type-permissions.test.ts › a key without reach on the item's type is refused its edges and backrefs`.
- `DELETE /items/{id}` declares `200 400 401 429`; the server answers `403 type_not_permitted` and `404 item_not_found`. `compliance/type-permissions.test.ts › read-only scoped key cannot DELETE items of that type`, `correctness/tombstones.test.ts › deleted item is hidden from default queries`.
- `DELETE /items/{id}/purge` declares `200 400 401 403 429`; the server answers `404 item_not_found` for a purged row. `correctness/tombstones.test.ts › purges a trashed item, after which every read answers 404`.
- `POST /items/{id}/restore` declares `200 401 404 429`; the server answers `400 invalid_transition` for a live row. `correctness/tombstones.test.ts › restoring a non-deleted item returns error`.
- `POST /items` declares `200 201 400 401 403 409 429`; the server answers `413 request_too_large` and `422 idempotency_key_reused`. `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`, `sync/idempotency.test.ts › refuses a key that names a different request rather than serving it`.
- `POST /items/bulk` and `POST /edges/bulk` declare `403`; a type-denied or edge-denied entry arrives as `400 bulk_atomic_rollback` with the inner code in `details.code`, and no top-level 403 is reachable. `compliance/bulk.test.ts › gates bulk writes per item type, and on nothing else`, `compliance/edges-bulk.test.ts › gates bulk edges per type and edge permission, and on nothing else`.
- `POST /edges`, `PATCH /edges/{id}` and `DELETE /edges/{id}` declare no `403`; the server answers `403 edge_permission_denied` on the edge-type half of the gate and `403 type_not_permitted` on the source-type half. `compliance/edge-permissions.test.ts › dual-gate: source-type write + edge-type write required`, `› trashed source: PATCH/DELETE edge still gated on source type`.
- `GET /keys` declares `200 401 429`; the server answers `403 forbidden`. `compliance/key-management.test.ts › list keys requires keys.mint`.
- `POST /keys` declares `201 400 401 403 429`; the server answers `409 conflict` for a `source` already in use. `compliance/key-management.test.ts › refuses a second key claiming a source already in use`.
- `POST /items/{id}/promote`, `GET /items/{id}/reconcile`, `GET /edge-types`, `POST /edge-types`, `DELETE /edge-types/{id}`, `GET /edges/{id}`, `PATCH /edges/{id}` and `DELETE /edges/{id}` declare no `401`; each answers `401 unauthorized` to a bare request. `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `compliance/promote-reconcile.test.ts › refuses both doors without a credential`.

## 8. The natural key is scoped by the credential, so two devices cannot share one

`folders.md` 10 requires that the same file on two separately enrolled machines is one item. The natural key is `(source, source_id)` (`items.md` 5), `source` is stamped from the credential and a value in the body is ignored (`items.md` 4), and a second key naming a `source` already in use is refused `409 conflict` (`keys-and-oauth.md` 7). Two devices with their own keys therefore cannot present the same natural key, and the same file becomes two items on the same server with nothing recording that they are the same file.

Nothing here is a contradiction of the OpenAPI document; it is the server contradicting the device half of the contract. The recommended fix is to let a folder, or any caller writing on behalf of one, name the `source` its rows are keyed by, bounded by what the credential is allowed to claim, so that the key identifies the folder rather than the credential. Until then a folder carries the item id in the file as its own identity record (`folders.md` 11), which binds a second device only for files that already have one.

Out of milestone one, which has one folder and one keyed process.

## 9. Contention on one row answers `500`, which a device reads as a fault

Several writers patching one edge at the same time are serialized by the driver, not queued: the store opens each write with `BEGIN IMMEDIATE` and a second one meets `SQLITE_BUSY` rather than waiting. The refusal surfaces as `500 internal_error`.

Measured on this build: eight concurrent `PATCH /edges/{id}` naming one version answered one `200` and seven `500 internal_error`, and not one `409 version_conflict` — the version gate is never reached, because contention refuses first.

Contention is not a fault. `device.md` says the server answers a `5xx` "only for a fault, and a fault it can be made to have is a defect rather than a fixture", and `queue-and-verdicts.md` has a device treat a `5xx` as retryable, so the current answer is at least honest about being retryable and dishonest about why. A `409` or a `503` would let a caller tell a contended row from a broken server.

No fixture asserts it. One did, indirectly, until `version` became required on an update: it fired eight concurrent patches to prove the row lock never loses an accepted write, and the version gate now refuses seven of them before the lock is reached, so the case was removed rather than renamed into a claim it could no longer support. `packages/server/src/routes/edges-merge-rather-than-replace.test.ts` carries the reasoning and names the fixture that would reach the lock again: writers that each read the edge and then patch with what they read, rather than several sharing one version.

## 10. `DELETE /edge-types/{id}` removes a registration out from under its edges

The door looks at the core edge-type list and at whether the row exists, and at nothing else. Edges of the type are neither counted nor cascaded: the call answers `200`, the registration goes, and every edge of it stays, each still naming an edge type the instance no longer holds and `GET /edges/{id}` still serving it.

Its sibling `DELETE /types/{id}` asks the question and refuses, `409 type_in_use`, unless `?force=true` is passed to orphan the rows deliberately. So the registry has two doors that disagree about whether a definition may be removed while rows depend on it, and only one of them offers the caller the choice.

The published description claimed the refusal — "the request fails while any edges of this type still exist, so delete or migrate them first" — and has been corrected to say what happens instead. Implementing the refusal is a behavior change and is the server's to make; the entry goes when it does. `compliance/edge-types.test.ts › deletes an edge type while edges of it exist, and leaves them naming it`.
