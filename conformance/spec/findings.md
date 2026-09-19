# Findings

Where the server contradicts its own OpenAPI document, where its document describes something a caller cannot observe, or where it contradicts the device half of this specification. Each entry names the operation, what the document says, what the server does, and the fixture that shows it. The fixtures assert what the server does; nothing here is fixed on the suite's side, and nothing is a proposal. This file is the channel to the server's maintainers. One entry carries no fixture, and says why: asserting it would end the run.

## 1. `nullable: true` inside a 3.1 document

The document declares `openapi: "3.1.0"` and marks nullable positions with `nullable: true`, a 3.0 keyword that a 2020-12 schema reader ignores. Where a position also carries a type, a strict reader rejects the `null` the server sends. The suite's validator widens every such position to a null-admitting type before checking a body, which is the one place it reads the document more charitably than written. Shown by every fixture that calls `expectMatchesSchema`, for example `compliance/key-management.test.ts › lists keys and includes a newly created key`, where `POST /keys` declares `last_used_at` as `{ type: string, nullable: true }` and sends `null`.

## 2. `POST /admin/platform-types/{id}/remove`: 409 where the document declares 404

The document declares 404 for an identifier no platform row carries. The server answers 409 `conflict` with the same refusal it gives a type the build still ships. `compliance/platform-types.test.ts › answers 409 for an identifier no platform row carries`.

## 3. `POST /auth/oauth2/register`: the 400 has no declared content and is not the envelope

The document declares the 400 with no content schema. The server answers an RFC 7591 error object, `{ "error": "invalid_redirect_uri", "error_description": "..." }`, not the `{ "error": { "code", "message" } }` envelope every other door uses. `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`.

## 4. `GET /events`: the 400 and 401 have no declared content

The document declares both statuses with no content schema. The server answers the standard envelope, `validation_error` for a refused filter and `unauthorized` for a missing credential. `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`, `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

## 5. `POST /admin/restore-archive` is served and unpublished

The route is stripped from the document as an internal operation, yet it is the only way an archive produced by `GET /export?format=archive` comes back, and it is covered here as an operator maintenance door. A caller reading the document cannot find it. `compliance/admin-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `compliance/export-roundtrip.test.ts › reconstructs items with their ids, tags, and extensions`.

## 6. `GET /` advertises `inbound-webhooks` and serves no inbound door

The `features` array at the root names `inbound-webhooks`, and `POST /webhooks/inbound/{id}` answers `404 not_found` with or without a credential: the door left with the connector runtime and the advertisement did not. `compliance/instance.test.ts › advertises inbound-webhooks at the root while serving no inbound door`; `› describes itself at the root` asserts the rest of the feature list.

## 7. `DELETE /items/bulk-actions/jobs/{id}`: the queued transition is unobservable

The document says a queued job flips to `cancelled` immediately and an in-progress one flips between chunks. The worker takes a job as soon as it is queued and finishes before a second request can reach the door, so no caller over the wire can observe either transition. `compliance/bulk.test.ts › DELETE on a terminal job answers 200 with its final state unchanged`.

## 8. `GET /blobs/{hash}/url` refuses every hash on the filesystem backend

With the filesystem blob backend the door answers `400 validation_error` with one message, "Presigned URLs are not available with the current blob backend", for a known, an unknown and a malformed hash alike: the backend check runs before the hash is looked at. The document describes the 400 as "invalid blob hash or presigned URLs not available", which is consistent, but the 404 it declares is unreachable on this backend. `correctness/blob-correctness.test.ts › answers 400 for a presigned URL on the filesystem backend`.

## 9. Statuses the fixtures observe that the document does not declare

Every entry is a status a fixture asserts on an operation whose served document lists no such response.

- `POST /types` declares `201 401 403 409 429`. The server answers `400` for a malformed identifier (`invalid_type`), a body without `fields` (`missing_required_field`), a field shadowing a first-class item field (`property_shadows_field`), a merge policy naming an unknown field or strategy, and a child changing an inherited field (`inheritance_violation`); and `422 compatible_with_violation`. `compliance/types.test.ts › rejects type registration with invalid type identifier`, `› rejects type registration without fields`, `› rejects type registration whose property name shadows a first-class Item field`, `› POST /types rejects a merge_policy referencing an unknown field`, `compliance/type-inheritance.test.ts › rejects a child type that changes an inherited field shape (inheritance_violation)`, `› rejects compatible_with target that does not exist`.
- `PUT /types/{id}` declares `200 401 404 429`; the server answers `422 version_bump_mismatch`. `compliance/type-versioning.test.ts › rejects no-op resubmission with version_bump_mismatch`.
- `GET /items/{id}` declares `200 401 404 429`; the server answers `400 invalid_id` and `403 type_not_permitted`. `compliance/error-codes.test.ts › rejects request with malformed ID`, `compliance/type-permissions.test.ts › a key without reach on the item's type is refused its edges and backrefs`.
- `DELETE /items/{id}` declares `200 400 401 409 429`; the server answers `403 type_not_permitted` and `404 item_not_found`. `compliance/type-permissions.test.ts › read-only scoped key cannot DELETE items of that type`, `correctness/tombstones.test.ts › deleted item is hidden from default queries`.
- `DELETE /items/{id}/purge` declares `200 400 401 403 429`; the server answers `404 item_not_found` for a purged row. `correctness/tombstones.test.ts › purges a trashed item, after which every read answers 404`.
- `POST /items/{id}/restore` declares `409` for a live row; the server answers `400 invalid_transition`. `correctness/tombstones.test.ts › restoring a non-deleted item returns error`.
- `POST /items/{id}/transition` declares `409`; once a row is trashed every further transition answers `404 item_not_found`, so the 409 is unreachable. `compliance/custom-type-lifecycle.test.ts › active -> archived -> active -> trashed -> (invalid) archived`.
- `POST /items` declares `200 201 400 401 403 409 429`; the server answers `413 request_too_large` and `422 idempotency_key_reused`. `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`, `sync/idempotency.test.ts › refuses a key that names a different request rather than serving it`.
- `POST /items/bulk` and `POST /edges/bulk` declare `403`; a type-denied or edge-denied entry arrives as `400 bulk_atomic_rollback` with the inner code in `details.code`, and no top-level 403 is reachable. `compliance/bulk.test.ts › gates bulk writes per item type, and on nothing else`, `compliance/edges-bulk.test.ts › gates bulk edges per type and edge permission, and on nothing else`.
- `POST /edges`, `PATCH /edges/{id}` and `DELETE /edges/{id}` declare no `403`; the server answers `403 edge_permission_denied`. `compliance/edge-permissions.test.ts › dual-gate: source-type write + edge-type write required`, `› trashed source: PATCH/DELETE edge still gated on source type`.
- `GET /keys` declares `200 401 429`; the server answers `403 forbidden`. `compliance/key-management.test.ts › list keys requires space.keys`.
- `POST /keys` declares `201 400 401 403 429`; the server answers `409 conflict` for a `source` already in use. `compliance/key-management.test.ts › refuses a second key claiming a source already in use`.
- `POST /items/{id}/promote`, `GET /items/{id}/reconcile`, `GET /edge-types`, `POST /edge-types`, `DELETE /edge-types/{id}`, `GET /edges/{id}`, `PATCH /edges/{id}` and `DELETE /edges/{id}` declare no `401`; each answers `401 unauthorized` to a bare request. `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`, `compliance/promote-reconcile.test.ts › refuses both doors without a credential`.

## 10. On some doors the body check or the row lookup runs before the credential check

A bare request to `PATCH /edges/{id}` or `POST /edge-types` with a malformed body answers `400`, and one to `DELETE /items/{id}/tags/{tag}` naming an unknown item answers `404 item_not_found`; the same doors answer `401` once the body is well-formed and the row exists, so no write lands, but an unauthenticated caller can learn whether an item id exists. The same ordering holds for the body checks on `PATCH /items/{id}`, `POST /items/{id}/transition`, `POST /items/{id}/tags`, the bulk doors, `GET /search` and `GET /occurrences`. `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them` sends real rows and well-formed bodies for this reason.

## 11. `POST /webhooks` accepts `events: ["*"]` and never delivers to it

The document lists `*` in the webhook event vocabulary and the door answers `201` storing it, but dispatch matches an event name against the stored list literally, so a wildcard subscription receives nothing and records no delivery while a named subscription on the same event does. `compliance/webhooks.test.ts › accepts a wildcard subscription, which then matches nothing`.

## 12. Self-loops are refused as `edge_constraint_violation`, not `edge_cycle`

The vocabulary has `edge_cycle` for an edge that would close a cycle, and the server uses it for a direct or deep cycle; an edge whose source and target are the same item is refused `edge_constraint_violation` with the message "Edge source and target must be different items". `correctness/edges/edges-cycle.test.ts › self-loop rejected: A→A on parent-of`, `› supersedes direct cycle: A→B then B→A rejected`.

## 13. `POST /admin/restore-archive` ends the process on a body that is not gzip

A request bearing the operator key with a body the gzip reader cannot parse kills the server: the archive reader attaches an error handler to the tar extractor and none to the decompressor, so `Z_DATA_ERROR: incorrect header check` arrives as an unhandled `error` event on the stream and the process exits. Every other request in flight dies with it, and the instance is gone until something restarts it. The door is unpublished, so no declared response is contradicted; what is contradicted is that a refusal is a refusal.

No fixture asserts this, and that is deliberate: a fixture that provokes it would take the rest of the run down with the server and the gate would report the crash as dozens of unrelated failures. Reproduced by hand against a locally booted server, September 2026, with the operator key, posting fifteen bytes of text as `application/gzip`.

## 14. The natural key is scoped by the credential, so two devices cannot share one

`folders.md` 10 requires that the same file on two separately enrolled machines is one item. The natural key is `(source, source_id)` (`items.md` 5), `source` is stamped from the credential and a value in the body is ignored (`items.md` 4), and a second key naming a `source` already in use is refused `409 conflict` (`keys-and-oauth.md` 7). Two devices with their own keys therefore cannot present the same natural key, and the same file becomes two items on the same server with nothing recording that they are the same file.

Nothing here is a contradiction of the OpenAPI document; it is the server contradicting the device half of the contract. The recommended fix is to let a folder, or any caller writing on behalf of one, name the `source` its rows are keyed by, bounded by what the credential is allowed to claim, so that the key identifies the folder rather than the credential. Until then a folder carries the item id in the file as its own identity record (`folders.md` 11), which binds a second device only for files that already have one.

Out of milestone one, which has one folder and one keyed process.

## 15. Contention on one row answers `500`, which a device reads as a fault

Several writers patching one edge at the same time are serialized by the driver, not queued: the store opens each write with `BEGIN IMMEDIATE` and a second one meets `SQLITE_BUSY` rather than waiting. The refusal surfaces as `500 internal_error`.

Measured on this build: eight concurrent `PATCH /edges/{id}` naming one version answered one `200` and seven `500 internal_error`, and not one `409 version_conflict` — the version gate is never reached, because contention refuses first.

Contention is not a fault. `device.md` says the server answers a `5xx` "only for a fault, and a fault it can be made to have is a defect rather than a fixture", and `queue-and-verdicts.md` has a device treat a `5xx` as retryable, so the current answer is at least honest about being retryable and dishonest about why. A `409` or a `503` would let a caller tell a contended row from a broken server.

No fixture asserts it. One did, indirectly, until `version` became required on an update: it fired eight concurrent patches to prove the row lock never loses an accepted write, and the version gate now refuses seven of them before the lock is reached, so the case was removed rather than renamed into a claim it could no longer support. `packages/server/src/routes/edges-merge-rather-than-replace.test.ts` carries the reasoning and names the fixture that would reach the lock again: writers that each read the edge and then patch with what they read, rather than several sharing one version.
