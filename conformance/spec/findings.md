# Findings

Where the server contradicts its own OpenAPI document, where its document describes something a caller cannot observe, where it contradicts the device half of this specification, or where two doors that answer the same question answer it differently. Each entry names the operation, what the document says, what the server does, and the fixture that shows it. The fixtures assert what the server does; nothing here is fixed on the suite's side, and nothing is a proposal. This file is the channel to the server's maintainers. One entry carries no fixture, and says why.

**An entry goes when the behavior it recorded changes, never because the contract softened.** Once the server answers as the document says, or the document says what the server does, the entry has nothing left to record, and the fixtures that asserted the old answer assert the new one.

## 1. `POST /auth/oauth2/register`: the 400 has no declared content and is not the envelope

The document declares the 400 with no content schema. The server answers an RFC 7591 error object, `{ "error": "invalid_redirect_uri", "error_description": "..." }`, not the `{ "error": { "code", "message" } }` envelope every other door uses. `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`.

## 2. `GET /events`: the 400 and 401 have no declared content

The document declares both statuses with no content schema. The server answers the standard envelope, `validation_error` for a refused filter and `unauthorized` for a missing credential. `compliance/events-contract.test.ts › refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types`, `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

## 3. Statuses the fixtures observe that the document does not declare

Every entry is a status a fixture asserts on an operation whose served document lists no such response.

- `POST /types` declares `201 401 403 409 429`. The server answers `400` for a malformed identifier (`validation_error`), a body without `fields` (`missing_required_field`), a field shadowing a first-class item field (`property_shadows_field`), a merge policy naming an unknown field or strategy, and a child changing an inherited field (`inheritance_violation`); and `422 compatible_with_violation`. `compliance/types.test.ts › rejects type registration with invalid type identifier`, `› rejects type registration without fields`, `› rejects type registration whose property name shadows a first-class Item field`, `› POST /types rejects a merge_policy referencing an unknown field`, `compliance/type-inheritance.test.ts › rejects a child type that changes an inherited field shape (inheritance_violation)`, `› rejects compatible_with target that does not exist`.
- `PUT /types/{id}` declares `200 401 403 404 429`; the server answers `422 version_bump_mismatch`. `compliance/type-versioning.test.ts › rejects no-op resubmission with version_bump_mismatch`.
- `GET /items/{id}` declares `200 401 404 429`; the server answers `400 invalid_id` and `403 type_not_permitted`. `compliance/error-codes.test.ts › rejects request with malformed ID`, `compliance/type-permissions.test.ts › a key without reach on the item's type is refused its edges and backrefs`.
- `DELETE /items/{id}` declares `200 400 401 429`; the server answers `403 type_not_permitted` and `404 item_not_found`. `compliance/type-permissions.test.ts › read-only scoped key cannot DELETE items of that type`, `correctness/tombstones.test.ts › deleted item is hidden from default queries`.
- `DELETE /items/{id}/purge` declares `200 400 401 403 429`; the server answers `404 item_not_found` for a purged row. `correctness/tombstones.test.ts › purges a trashed item, after which every read answers 404`.
- `POST /items/{id}/restore` declares `200 401 404 429`; the server answers `400 invalid_transition` for a live row. `correctness/tombstones.test.ts › restoring a non-deleted item returns error`.
- `POST /items` declares `200 201 400 401 403 409 429`; the server answers `413 request_too_large` and `422 idempotency_key_reused`. `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`, `sync/idempotency.test.ts › refuses a key that names a different request rather than serving it`.
- `POST /edges`, `PATCH /edges/{id}` and `DELETE /edges/{id}` declare no `403`; the server answers `403 edge_permission_denied` on the edge-type half of the gate and `403 type_not_permitted` on the source-type half. `compliance/edge-permissions.test.ts › dual-gate: source-type write + edge-type write required`, `› trashed source: PATCH/DELETE edge still gated on source type`.
- `GET /keys` declares `200 401 429`; the server answers `403 forbidden`. `compliance/key-management.test.ts › list keys requires keys.mint`.
- `POST /keys` declares `201 400 401 403 429`; the server answers `409 conflict` for a `source` already in use. `compliance/key-management.test.ts › refuses a second key claiming a source already in use`.
- `GET /edge-types`, `POST /edge-types`, `DELETE /edge-types/{id}`, `GET /edges/{id}`, `PATCH /edges/{id}` and `DELETE /edges/{id}` declare no `401`; each answers `401 unauthorized` to a bare request. `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

## 4. The natural key is scoped by the credential, so two devices cannot share one

`folders.md` 10 requires that the same file on two separately enrolled machines is one item. The natural key is `(source, source_id)` (`items.md` 5), `source` is stamped from the credential and a value in the body is ignored (`items.md` 4), and a second key naming a `source` already in use is refused `409 conflict` (`keys-and-oauth.md` 7). Two devices with their own keys therefore cannot present the same natural key, and the same file becomes two items on the same server with nothing recording that they are the same file.

Nothing here is a contradiction of the OpenAPI document; it is the server contradicting the device half of the contract. The recommended fix is to let a folder, or any caller writing on behalf of one, name the `source` its rows are keyed by, bounded by what the credential is allowed to claim, so that the key identifies the folder rather than the credential. Until then a folder carries the item id in the file as its own identity record (`folders.md` 11), which binds a second device only for files that already have one.

Out of milestone one, which has one folder and one keyed process.
