# Errors

What every refusal looks like, and the refusals no other chapter owns. A refusal that belongs to one operation is stated with that operation, under its code. This chapter states the envelope, the closed set of codes, the headers a refusal carries, the answers to a request that is not read as JSON, to a path no operation serves, to a write that meets contention, to a volume with no room, to a fault and to an `Idempotency-Key` that cannot be served, what a refusal names of a missing grant or of an item in the bin, the limits a stream and a housekeeping job meet, a type whose parent chain cannot be resolved, and what the server reports of a failed database statement. The `409` envelopes of a stale write are `versions.md`'s, and the answer to a read view that has changed is `read-views.md`'s.

## The envelope

### `errors/envelope`

When the server refuses a request other than `HEAD`, the server MUST answer a JSON body whose `error` object carries `code` and `message`, both strings, unless the answer is the page of `errors/html-page` or is under `/auth/*` in the sign-in library's own shape, in plain text or as an HTML page.

**Reason:** a client reads every refusal of the server's own from one shape, whichever operation answered it.

**Tests:** `compliance/instance.test.ts › answers 404 not_found in the standard envelope for a path it does not serve`, `compliance/unmatched-paths.test.ts › answers a GET to a path no door serves 404 not_found in the envelope, to a caller with a credential and to one without`, `compliance/internal-error.test.ts › answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone`.

### `errors/details-object`

When the server carries `details` in the `error` object of a refusal, the server MUST give `details` as an object.

**Tests:** `compliance/write-refusal-details.test.ts › answers 404 with details.trashed to a key that may read the type, and nothing to one that may not`, `compliance/stream-capacity.test.ts › answers 503 stream_capacity_exhausted to the viewer past the cap, on either stream, and admits one again once a viewer leaves`.

### `errors/status-absent`

The server MUST NOT carry a `status` member in the `error` object of a refusal other than `409 version_conflict` and `409 ancestor_unavailable`.

**Tests:** `compliance/instance.test.ts › answers 404 not_found in the standard envelope for a path it does not serve`, `compliance/unmatched-paths.test.ts › answers a GET to a path no door serves 404 not_found in the envelope, to a caller with a credential and to one without`, `compliance/internal-error.test.ts › answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone`.

### `errors/status-version-envelope`

When the server answers `409 version_conflict` or `409 ancestor_unavailable`, the server MUST carry `409` as `error.status`.

**Reason:** `versions.md` states the rest of each envelope. The member is the one thing that sets these two answers apart from every other refusal.

**Tests:** `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `› a version no client ever read answers ancestor_unavailable`, `› answers an edges-only stale write with the envelope minus its merge half`, `› answers an update that carries only edges or names the row's own type version_conflict with no ancestor, whichever version it names`, `compliance/error-codes.test.ts › rejects a stale write whose base version is retained`, `› rejects an update naming a version that never existed`, `correctness/edges/edges-crud.test.ts › refuses a stale edge update, under current and not under edge`, `compliance/edge-refusals.test.ts › answers a stale edge update with the edge as it stands and none of ancestor, conflicting_fields or merge_policy`, `compliance/purge-preconditions.test.ts › refuses a stale version with version_conflict, and the row survives`.

### `errors/code-closed`

The server MUST give the `code` of every refusal it answers in the envelope as one of the codes in the table at the end of this chapter, in lowercase snake case.

**Reason:** a client branches on the code, so a code outside the table is one no client was told of. The answers under `/auth/*` that are in the sign-in library's own shapes use its own codes, and a page there refuses in plain text.

**Tests:** `compliance/error-codes.test.ts › answers every refusal across the published operations with a code from the table`.

### `errors/html-page`

If a request's `Accept` header names `text/html` and does not name `application/json` before it, then the server MUST answer a refusal it would give in the envelope with an HTML page of the refusal's status in place of the JSON body, other than a `409 version_conflict`, a `409 ancestor_unavailable` or an answer replayed for an `Idempotency-Key`.

**Reason:** a person who follows a stale link is not handed a JSON body shown as raw text. A program that sends no such header is answered in the envelope.

**Tests:** `compliance/refusal-headers.test.ts › rides a page a browser is sent in place of the body, for a request that prefers HTML`.

## The headers of an answer

### `errors/code-header`

When the server answers a refusal in the envelope, the server MUST carry the body's `error.code` in the `X-Error-Code` header.

**Reason:** a client or a proxy reads the refusal without parsing the body.

**Tests:** `compliance/refusal-headers.test.ts › repeats the body's code on a refusal of each status 400, 401, 403, 404, 409, 413 and 422`, `› repeats the body's code on a 429 and on a 503, which a server booted for them answers`, `compliance/metadata-routes.test.ts › answers 404 for an unknown item on every metadata door`, `compliance/unmatched-paths.test.ts › answers a GET to a path no door serves 404 not_found in the envelope, to a caller with a credential and to one without`, `compliance/internal-error.test.ts › answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone`.

### `errors/html-page-code-header`

When the server answers a refusal with the page of `errors/html-page`, the server MUST carry the refusal's code in the `X-Error-Code` header.

**Tests:** `compliance/refusal-headers.test.ts › rides a page a browser is sent in place of the body, for a request that prefers HTML`.

### `errors/request-id`

The server MUST carry an `X-Request-ID` header on every answer to `POST /auth/oauth2/register` and to a path outside `/auth/` and `/.well-known/`, a refusal included.

**Reason:** it is the value a caller quotes to find its request in the server's log.

**Tests:** `compliance/refusal-headers.test.ts › is on the answer to every published door, served or refused, to a caller with a credential and to one without`.

### `errors/request-id-echo`

When a request to `POST /auth/oauth2/register` or to a path outside `/auth/` and `/.well-known/` carries an `X-Request-ID` of 1 to 128 letters, digits, underscores and hyphens, the server MUST answer with that value in `X-Request-ID`, whether it serves the request or refuses it.

**Tests:** `compliance/refusal-headers.test.ts › is the caller's own, on a served answer and on a refusal, when the caller sent one of 1 to 128 letters, digits, underscores and hyphens`, `› answers a body that is not JSON with a 415 that carries X-Request-ID and no X-Error-Code, where Marfa's own doors carry both`.

### `errors/request-id-replaced`

If a request to `POST /auth/oauth2/register` or to a path outside `/auth/` and `/.well-known/` carries an `X-Request-ID` of more than 128 characters, or one with a character other than a letter, digit, underscore or hyphen, then the server MUST answer with an `X-Request-ID` of its own, of 1 to 128 letters, digits, underscores and hyphens.

**Tests:** `compliance/refusal-headers.test.ts › is one of the server's own, not the caller's, when the caller sent more than 128 characters or one outside letters, digits, underscore and hyphen`.

### `errors/request-id-fresh`

When a request to `POST /auth/oauth2/register` or to a path outside `/auth/` and `/.well-known/` carries no `X-Request-ID`, the server MUST answer with an `X-Request-ID` that differs from the one it gave every other request that sent none.

**Tests:** `compliance/refusal-headers.test.ts › is a different one of the server's own for each request that sent none`.

### `errors/request-id-replay`

When the server replays an answer for an `Idempotency-Key`, the server MUST carry the `X-Request-ID` of the retry and not that of the first request.

**Tests:** `compliance/refusal-headers.test.ts › is the retry's own on an answer replayed for an Idempotency-Key`.

## A body that is not read as JSON

### `errors/body-invalid-json`

If a request to an operation other than `POST /auth/oauth2/register` that takes a JSON body sends a body that is not valid JSON under a JSON `Content-Type`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/adversarial.test.ts › malformed JSON body returns 400 validation_error`.

### `errors/body-empty`

If a request to an operation other than `POST /auth/oauth2/register` that takes a JSON body sends an empty body under a JSON `Content-Type`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/adversarial.test.ts › empty body POST returns 400 validation_error`.

### `errors/body-not-object`

If a request to an operation other than `POST /auth/oauth2/register` that takes a JSON object sends a JSON array in its place, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/adversarial.test.ts › array instead of object returns 400 validation_error`.

### `errors/json-content-type`

When a request to an operation other than `POST /auth/oauth2/register` that takes a JSON body is not sent with a JSON `Content-Type`, because the header is missing or names another type, with a body or without one, the server MUST answer `400 validation_error`.

**Reason:** a body that is not read as JSON would reach the operation as an empty object, and an operation whose schema accepts `{}` would run a write the caller never sent, such as replacing an extension namespace's data with `{}`. A client that forgets the header is told, instead of losing data or learning nothing.

**Tests:** `compliance/json-body-doors.test.ts › refuses a body that is missing or not sent as JSON with 400 validation_error on every such door`.

### `errors/json-content-type-nothing`

If a request to an operation other than `POST /auth/oauth2/register` that takes a JSON body is not sent with a JSON `Content-Type`, then the server MUST NOT perform the operation's write.

**Tests:** `compliance/json-body-doors.test.ts › changes nothing on these doors when the body is not sent as JSON`.

### `errors/json-content-type-spelling`

When a request to an operation other than `POST /auth/oauth2/register` that takes a JSON body is sent with a `Content-Type` of `application/json` or `application/<name>+json`, in any case and with or without parameters, the server MUST read the body as JSON.

**Tests:** `compliance/json-body-doors.test.ts › still reads a body sent as JSON, whatever the case or parameters of its type`, `› writes each of these doors when the body is sent as JSON`.

### `errors/json-order`

When a request to an operation other than `POST /auth/oauth2/register` that takes a JSON body meets more than one of these refusals, the server MUST give the first in this order: no credential, `401 unauthorized`; a standing permission the operation checks before it reads the body, `403 forbidden`; a body not sent as JSON, `400 validation_error`; the grant the stored item's type asks for, `403 type_not_permitted`.

**Reason:** a caller that may not use the operation learns that first, whatever it sent. The grant on an item's type is checked against the stored item after the body is read, so a key without it is answered `400` for a body that is not JSON, which tells it nothing about the item.

**Tests:** `compliance/json-body-doors.test.ts › answers 401 on every JSON door to a request with no credential, whatever body it sent, where a credential reaches the body's refusal`, `› answers 403 forbidden to a key lacking the standing permission a door checks, where a key holding it is answered 400 for the same body`, `› answers 403 forbidden on the operator's own door to a key that is not the operator key, where the operator key is answered 400`, `› answers 400 to a key that holds no grant on an item's type, since that grant is checked after the body, and 403 once the body is JSON`.

## Registration, which the sign-in library answers

### `errors/register-415`

When `POST /auth/oauth2/register` carries a body under a `Content-Type` other than `application/json`, in any case and with or without parameters, the server MUST answer `415` with a body of `message` and a `code` of `UNSUPPORTED_MEDIA_TYPE`, and no `error` member.

**Reason:** registration takes JSON but belongs to the sign-in library, which refuses a body that is not JSON in its own shape and not with `errors/json-content-type`.

**Tests:** `compliance/json-body-doors.test.ts › leaves a registration that is not sent as JSON to the sign-in library, which answers 415 in its own shape`, `compliance/declared-refusals.test.ts › is refused 415 in the shape the document declares for a body that is not JSON`.

### `errors/register-bearer-401`

When `POST /auth/oauth2/register` sends, as JSON, a registration the server accepts from a caller with no credential, and carries an `Authorization` bearer the sign-in library does not accept, an API key included, the server MUST answer `401` with a body whose `error` is `invalid_token`.

**Reason:** registration takes no credential, so a bearer it is sent is read as an initial access token.

**Tests:** `compliance/declared-refusals.test.ts › is refused 401 invalid_token in the RFC's shape, and registers with no credential`.

### `errors/register-415-headers`

When the sign-in library answers `POST /auth/oauth2/register` with `415`, the server MUST NOT carry `X-Error-Code` on the answer.

**Reason:** the answer is the library's own and is not the envelope, where a refusal of the server's own carries the header.

**Tests:** `compliance/refusal-headers.test.ts › answers a body that is not JSON with a 415 that carries X-Request-ID and no X-Error-Code, where Marfa's own doors carry both`.

## An `Idempotency-Key` that cannot be served

### `errors/idem-reused-json`

If a credential repeats an `Idempotency-Key` whose first answer the server kept, with a request that differs from the first only in whether its body is sent with a JSON `Content-Type`, then the server MUST answer `422 idempotency_key_reused`.

**Reason:** the first request was refused by `errors/json-content-type` or read as JSON, so the two are different requests, and replaying a refusal would tell the caller to do what it just did.

**Tests:** `compliance/json-body-doors.test.ts › answers 422 idempotency_key_reused to a retry sent as JSON after a first request that was not, and writes nothing`, `› answers 422 idempotency_key_reused to a retry not sent as JSON after a first request that was, and replays nothing`.

### `errors/idem-json-spelling`

When a credential repeats an `Idempotency-Key` whose first answer the server kept, with a request that differs from the first only in how it spells the JSON `Content-Type`, the server MUST replay the first answer.

**Reason:** two spellings of one type, such as with and without `charset=utf-8`, are the same request.

**Tests:** `compliance/json-body-doors.test.ts › replays to a retry that spells the JSON type another way`.

### `errors/idem-in-flight`

When a credential repeats, under one `Idempotency-Key`, a request whose first sending claimed the key less than 60 seconds earlier and has not been answered, the server MUST answer `409 idempotency_key_in_flight`.

**Reason:** the claim is what stops two arrivals of one key both writing, so the one that did not take it is told to ask again. The status is `409` because something else did get there first.

**Tests:** `compliance/idempotency-refusals.test.ts › answers 409 idempotency_key_in_flight and writes nothing, until the claim is past its lease`.

### `errors/idem-in-flight-nothing`

When the server answers `409 idempotency_key_in_flight`, the server MUST NOT run the write.

**Tests:** `compliance/idempotency-refusals.test.ts › answers 409 idempotency_key_in_flight and writes nothing, until the claim is past its lease`.

### `errors/idem-lease`

If the first request under an `Idempotency-Key` ended without recording an answer, then the server MUST run the write for a retry of the same request once the claim is older than 60 seconds.

**Reason:** a writer that dies between claiming and answering leaves a claim nothing completes, and without a lease the one failure the key exists for would refuse its retry for good.

**Tests:** `compliance/idempotency-refusals.test.ts › answers 409 idempotency_key_in_flight and writes nothing, until the claim is past its lease`.

### `errors/idem-not-retained`

When a credential repeats, under one `Idempotency-Key`, a request whose first answer was larger than 1,048,576 bytes, and `items/replay-reauthorized` would let it replay that answer, the server MUST answer `422 idempotency_result_not_retained`.

**Reason:** a record keeps the first answer's status and drops its body above that size, because the alternative is a record of unbounded size per key or a second write. The status is `422` and not `409` because nothing got there first.

**Tests:** `compliance/idempotency-refusals.test.ts › answers 422 idempotency_result_not_retained, naming the first status, and writes nothing again`, `› replays an answer within the bound, so the refusal belongs to the size`.

### `errors/idem-not-retained-status`

When the server answers `422 idempotency_result_not_retained`, the server MUST carry the status the first answer carried in `details.original_status`.

**Reason:** the repeat learns what the first attempt returned and that it was not repeated.

**Tests:** `compliance/idempotency-refusals.test.ts › answers 422 idempotency_result_not_retained, naming the first status, and writes nothing again`.

### `errors/idem-not-retained-nothing`

When the server answers `422 idempotency_result_not_retained`, the server MUST NOT run the write again.

**Tests:** `compliance/idempotency-refusals.test.ts › answers 422 idempotency_result_not_retained, naming the first status, and writes nothing again`.

## A path or method no operation serves

### `errors/unmatched-path`

When a request other than `OPTIONS` names a path no operation serves, and is neither a `GET` or `POST` under `/auth/`, which the sign-in library answers, nor a `GET` that carries `X-Marfa-Read-View`, the server MUST answer `404 not_found`, to a caller with a credential and to one without.

**Tests:** `compliance/unmatched-paths.test.ts › answers a GET to a path no door serves 404 not_found in the envelope, to a caller with a credential and to one without`, `› answers a method other than GET to a path no door serves 404 not_found even when it carries X-Marfa-Read-View`, `compliance/instance.test.ts › answers 404 not_found in the standard envelope for a path it does not serve`.

### `errors/unmatched-method`

When a request other than `OPTIONS` names a method no operation serves on a path that another method serves, and is not a `GET` or `POST` under `/auth/`, which the sign-in library answers, the server MUST answer `404 not_found` and not `405`.

**Tests:** `compliance/unmatched-paths.test.ts › answers a method no door serves on a path another method serves 404 not_found, not 405`.

### `errors/unmatched-read-view`

When a `GET` that names a path no operation serves carries `X-Marfa-Read-View`, the server MUST answer `400 validation_error`, whether or not the request carries a credential.

**Reason:** the header is refused where no conditional read exists, before the credential is asked for. It is the first step of `read-views/conditional-order`.

**Tests:** `compliance/unmatched-paths.test.ts › answers a GET to a path no door serves 400 validation_error when it carries X-Marfa-Read-View, to a caller with a credential and to one without`.

## Contention on the write lock

### `errors/contention`

If a write cannot get the store's write lock within the instance's busy budget, then the server MUST answer `503 write_contention`.

**Reason:** a device retries a `5xx` without counting it against the write (`queue-and-verdicts/environmental-uncounted`), and contention is the case that retry exists for. A `500` would name the wrong cause, and a `409` would stop a write that the next attempt would land. The budget is the instance's `SQLITE_BUSY_BUDGET_MS`.

**Tests:** `compliance/write-contention.test.ts › answers 503 write_contention, never 500`.

### `errors/contention-declared`

The server MUST declare `503 write_contention` in its OpenAPI document on every operation that takes a credential and on `POST /auth/oauth2/register`.

**Reason:** a client generated from the document then knows the refusal it must retry.

**Tests:** `compliance/declared-refusals.test.ts › is declared 503 write_contention on every operation that takes a credential, and on registration`.

### `errors/contention-budget`

When the server answers `503 write_contention`, the server MUST carry the busy budget it spent, in milliseconds, in `details.budget_ms`.

**Tests:** `compliance/write-contention.test.ts › names the budget it spent, so the setting is observable`.

### `errors/contention-wait`

When a write meets a write lock that is released inside the instance's busy budget, the server MUST land the write.

**Tests:** `compliance/write-contention.test.ts › waits out a briefly held lock on the default budget`.

### `errors/contention-read`

If a credentialed read is the first request a key makes in an hour and the write that records the key's use cannot get the write lock within the busy budget, then the server MUST answer the read `503 write_contention`.

**Reason:** the server records a key's first use in each hour before the operation runs, so every operation a key sends can meet the lock.

**Tests:** `compliance/write-contention.test.ts › refuses a read too, because the credential gate stamps a key's first use`.

### `errors/contention-stamp-retry`

If the server refuses a request `503 write_contention` at the write that records a key's use, then the server MUST set the key's `last_used_at` on the next request of that key that it serves.

**Tests:** `compliance/write-contention.test.ts › refuses a read too, because the credential gate stamps a key's first use`.

### `errors/contention-stamp-once`

When the server has set a key's `last_used_at` in an hour and has not restarted since, the server MUST serve the key's later reads in that hour while another writer holds the write lock.

**Reason:** only a completed record of a key's use spares the next request that write.

**Tests:** `compliance/write-contention.test.ts › refuses a read too, because the credential gate stamps a key's first use`.

### `errors/contention-housekeeping`

If `POST /housekeeping/{name}/run` cannot get the write lock within the busy budget, then the server MUST answer `503 write_contention`.

**Tests:** `compliance/write-contention.test.ts › refuses a housekeeping run, which writes outside a request's transaction`.

### `errors/contention-registration`

If `POST /auth/oauth2/register` cannot get the write lock within the busy budget, then the server MUST answer `503 write_contention` in the envelope.

**Reason:** registration takes no credential and the sign-in library serves it, but it writes.

**Tests:** `compliance/write-contention.test.ts › refuses a client registration, which the sign-in library writes`.

### `errors/contention-bulk-page`

If a `POST /items/bulk` or `POST /edges/bulk` page meets the write lock before any of its entries has committed or may have committed, then the server MUST answer the page `503 write_contention`, whatever its `atomic` says.

**Reason:** nothing was written and the next attempt would land, and a `200` that carried the refusal would tell a device there is nothing to retry.

**Tests:** `compliance/write-contention.test.ts › refuses a non-atomic bulk page rather than reporting it entry by entry`.

### `errors/contention-bulk-entry`

If a `POST /items/bulk` or `POST /edges/bulk` page under `atomic: false` meets the write lock at an entry after an earlier entry has committed or may have committed, then the server MUST report that entry `errored` with the code `write_contention`, in a `200` answer.

**Reason:** a `5xx` would say nothing was written of entries that were, and the caller would send the page again and write them twice.

**Tests:** waiting on #1444.

## A volume with no room

An instance keeps a reserve of free space on the volume that holds its disk store, set by `MARFA_DISK_RESERVE_BYTES`. `blobs.md` states the uploads and restores that are held to it.

### `errors/storage-full`

If a write meets a volume with no room left for it, then the server MUST answer `507 insufficient_storage`.

**Reason:** a `500` names no cause, so a full disk reads as a fault in the server. A device retries a `5xx` without counting it against the write (`queue-and-verdicts/environmental-uncounted`) and keeps the write queued, which is what a write that only freed space can land needs. A `503` would read as a busy instance that a retry a moment later clears, and only someone freeing space does.

**Tests:** waiting on #1444.

### `errors/storage-full-unknown`

If a volume turns away the commit of a write, then the server MUST carry `write_outcome` of `unknown` in the `details` of the `507 insufficient_storage` it answers.

**Reason:** a commit that fails may have landed before it failed, so the answer cannot promise that nothing was kept.

**Tests:** waiting on #1444.

### `errors/storage-full-declared`

The server MUST declare `507 insufficient_storage` in its OpenAPI document on every operation that takes a credential.

**Reason:** a client generated from the document then knows the refusal it must not treat as a fault in its request.

**Tests:** `compliance/declared-refusals.test.ts › is declared 507 insufficient_storage on every operation that takes a credential`.

### `errors/storage-reserve-details`

When the server answers `507 insufficient_storage` because a body would take the volume below the reserve, the server MUST carry the reserve in `details.reserve_bytes` and the free space it found in `details.available_bytes`, both in bytes.

**Tests:** `compliance/disk-reserve.test.ts › refuses an upload 507 insufficient_storage, naming the reserve and the room, and stores nothing`.

## What a refusal names of a missing grant

### `errors/grant-type`

When the server answers `403 type_not_permitted` because a key holds no grant, or too low a grant, on a type at the level the operation asks, the server MUST carry `details.grant` with a `kind` of `type` and a `name` that is the type's identifier.

**Reason:** a client holding a write that the refusal stopped can tell a narrowed key from a write that will never land, and send it again once the grant is back. A folder operation names `system.folder`.

**Tests:** `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`, `› names the level read where the key may not read the type, on a list, its counts and an export`.

### `errors/grant-edge-type`

When the server answers `403 edge_permission_denied`, the server MUST carry `details.grant` with a `kind` of `edge_type` and a `name` that is the edge type's identifier.

**Tests:** `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`, `› names the edge type and the level the key lacks beside the grant, on every door that writes an edge`.

### `errors/grant-extension`

When the server answers `403 forbidden` to an extension operation because a key holds no grant, or too low a grant, on the namespace at the level the operation asks, the server MUST carry `details.grant` with a `kind` of `extension` and a `name` that is the namespace.

**Tests:** `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`.

### `errors/grant-level`

When the server carries `details.grant`, the server MUST give its `level` as the level the operation asked for, `read` or `write`.

**Tests:** `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`, `› names the level read where the key may not read the type, on a list, its counts and an export`.

### `errors/edge-denied-details`

When the server answers `403 edge_permission_denied`, the server MUST carry `details.edge_type`, naming the edge type, and `details.required`, naming the level the key lacks.

**Tests:** `compliance/write-refusal-details.test.ts › names the edge type and the level the key lacks beside the grant, on every door that writes an edge`.

### `errors/grant-bulk-entry`

When a `POST /items/bulk` or `POST /edges/bulk` page under `atomic: false` reports an entry `errored` for a grant the key lacks, the server MUST carry `details.grant` in the entry's `error.details`.

**Tests:** `compliance/write-refusal-details.test.ts › names the grant on a bulk page, inside the rollback or on the entry`.

### `errors/grant-bulk-rollback`

When a `POST /items/bulk` or `POST /edges/bulk` page under `atomic: true` is rolled back for a grant the key lacks, the server MUST carry `details.grant` in `error.details.details` of the `bulk_atomic_rollback`.

**Tests:** `compliance/write-refusal-details.test.ts › names the grant on a bulk page, inside the rollback or on the entry`.

### `errors/grant-absent`

If a `403` is not caused by a grant that the key could be given, such as the reserved `system.*` fence, a key whose type map reaches no type, a reserved extension namespace or a blob upload by a key whose map grants write on no type, or is the refusal of a natural key that resolves an item of a type the key may not read (`items/natural-key-unreadable`), then the server MUST NOT carry `details.grant`.

**Reason:** where no grant could let the request through, a grant named would send the client to ask for one that cannot be had. Where the natural key resolves an item the key may not read, a grant named would disclose the item's type.

**Tests:** `compliance/write-refusal-details.test.ts › names no grant where no grant would open the door`, `compliance/claimed-sources.test.ts › tells a key its natural key is taken, and nothing of a row it may not read`.

## An item in the bin, or no item at all

### `errors/bin-trashed`

When `PATCH /items/{id}`, `DELETE /items/{id}`, `PUT` or `PATCH /items/{id}/metadata`, `POST /items/{id}/tags`, `DELETE /items/{id}/tags/{tag}`, or `PUT` or `DELETE /items/{id}/extensions/{namespace}` names an item in the bin and the key may read the item's type, the server MUST carry `details` of exactly `{ "trashed": true }` in the `404 item_not_found`.

**Reason:** a client holding a write to the item can tell an item someone deleted from one that never existed. `items/write-in-bin` states the refusal itself.

**Tests:** `compliance/write-refusal-details.test.ts › answers 404 with details.trashed to a key that may read the type, and nothing to one that may not`, `› answers a delete of an extension namespace on an item in the bin 404 with details.trashed, and nothing to a key that may not read the type`.

### `errors/bin-unreadable`

If a key may not read the type of an item in the bin, then the server MUST answer a write that names the item by its id `404 item_not_found` with no `details`.

**Reason:** the answer says nothing of whether the item exists or what type it is.

**Tests:** `compliance/write-refusal-details.test.ts › answers 404 with details.trashed to a key that may read the type, and nothing to one that may not`, `› answers a delete of an extension namespace on an item in the bin 404 with details.trashed, and nothing to a key that may not read the type`.

### `errors/bin-read`

When `GET /items/{id}`, `GET /items/{id}/metadata`, `GET /items/{id}/versions`, `GET /items/{id}/extensions` or `GET /items/{id}/extensions/{namespace}` names an item in the bin, the server MUST answer `404 item_not_found` with no `details`.

**Reason:** these reads answer an item in the bin as they answer one that does not exist.

**Tests:** `compliance/write-refusal-details.test.ts › answers 404 with details.trashed to a key that may read the type, and nothing to one that may not`.

### `errors/item-missing-bare`

When the server answers `404 item_not_found` for an id that no item holds, the server MUST carry no `details`.

**Tests:** `compliance/metadata-routes.test.ts › answers 404 for an unknown item on every metadata door`.

## A fault

### `errors/internal-error`

If a request meets a fault for which the server holds no refusal, then the server MUST answer `500 internal_error`.

**Reason:** a fault is not the caller's to act on. What a caller can do is read what it changed before it repeats a write.

**Tests:** `compliance/internal-error.test.ts › answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone`.

### `errors/internal-error-body`

When the server answers `500 internal_error`, the server MUST send exactly the body `{"error":{"code":"internal_error","message":"Internal server error"}}`.

**Reason:** a caller cannot act on a table name, a query or a stack, and the instance's internals are not the caller's to learn.

**Tests:** `compliance/internal-error.test.ts › answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone`, `› answers an atomic page 500 internal_error in the envelope, with no entry to name`.

### `errors/internal-error-entry`

If a fault for which the server holds no refusal meets an entry of a `POST /items/bulk` or `POST /edges/bulk` page under `atomic: false` after an earlier entry has committed or may have committed, then the server MUST report that entry `errored` with an `error` of exactly `{ "code": "internal_error", "message": "The entry could not be written, and nothing of it was" }`.

**Reason:** the page answers `200` for the entries that landed, and the entry's `error` names nothing of what failed, as `errors/internal-error-body` names nothing.

**Tests:** `compliance/internal-error.test.ts › is reported on that entry as internal_error with the entry's own message and no details, while the entries around it land`, `› is reported the same way on an entry of an edge page`.

### `errors/internal-error-atomic`

If a fault for which the server holds no refusal meets an entry of a `POST /items/bulk` or `POST /edges/bulk` page under `atomic: true`, then the server MUST answer the page `500 internal_error`.

**Reason:** the fault is not a verdict on the entry, so the page is not answered `bulk_atomic_rollback`, which names an entry and its refusal.

**Tests:** `compliance/internal-error.test.ts › answers an atomic page 500 internal_error in the envelope, with no entry to name`, `› is reported the same way on an entry of an edge page`.

### `errors/internal-error-unknown`

If the server cannot confirm whether an entry of a `POST /items/bulk` or `POST /edges/bulk` page under `atomic: false` committed, then the server MUST give the entry reported `errored` the code `internal_error`.

**Reason:** `items/bulk-outcome-unknown` and `edges/bulk-outcome-unknown` state the rest of the entry's answer, which the caller reads to reconcile that entry before it retries it.

**Tests:** waiting on #1444.

## The limits of a stream and of a job

### `errors/stream-capacity`

Where an instance sets a cap on live viewers, if a `GET /events` request, plain or copy, would pass the cap, then the server MUST answer `503 stream_capacity_exhausted`.

**Reason:** a viewer holds a connection for as long as it reads, so a cap is the one way an instance bounds them.

**Tests:** `compliance/stream-capacity.test.ts › answers 503 stream_capacity_exhausted to the viewer past the cap, on either stream, and admits one again once a viewer leaves`, `compliance/declared-refusals.test.ts › refuses a viewer past the cap 503`.

### `errors/stream-capacity-reason`

When the server answers `503 stream_capacity_exhausted`, the server MUST carry `viewer_cap` in `details.reason`.

**Tests:** `compliance/stream-capacity.test.ts › answers 503 stream_capacity_exhausted to the viewer past the cap, on either stream, and admits one again once a viewer leaves`.

### `errors/stream-capacity-frees`

Where an instance sets a cap on live viewers, when a viewer leaves, the server MUST admit a `GET /events` request again.

**Reason:** a slot frees as streams end, so the refusal is one to ask again after.

**Tests:** `compliance/stream-capacity.test.ts › answers 503 stream_capacity_exhausted to the viewer past the cap, on either stream, and admits one again once a viewer leaves`.

### `errors/job-running`

If `POST /housekeeping/{name}/run` names a job that is in the middle of a run that has not outlived its deadline, whether the scheduler or an earlier request started it, then the server MUST answer `409 housekeeping_job_running`.

**Reason:** a job never overlaps itself, and a run the scheduler started on its own is a run like one asked for. A caller who gets the refusal asks again when the run has ended. `housekeeping/deadline-frees-job` states a run past its deadline.

**Tests:** `compliance/housekeeping-job-running.test.ts › answers 409 housekeeping_job_running, and runs once the earlier run has ended`.

### `errors/job-running-no-run`

When the server answers `409 housekeeping_job_running`, the server MUST NOT start a second run of the job.

**Tests:** `compliance/housekeeping-job-running.test.ts › answers 409 housekeeping_job_running, and runs once the earlier run has ended`.

## A type whose parent chain cannot be resolved

### `errors/type-chain`

When a request resolves a type whose stored parent chain is circular or longer than 100 types, the server MUST answer `409 type_chain_unresolvable` with `details.type_id` naming that type.

**Reason:** the caller did nothing wrong, and every operation that writes a type refuses such a chain, so meeting one means the registry already held it.

**Tests:** `compliance/type-chain-unresolvable.test.ts › answers 409 type_chain_unresolvable naming the type, and is corrected by PUT /types/{id}`.

### `errors/type-chain-correctable`

While a type's stored parent chain is unresolvable, the server MUST accept `PUT /types/{id}` for the type with a corrected schema.

**Reason:** that operation reads the stored schema without walking the chain, so a `500` there would leave nothing to correct it with.

**Tests:** `compliance/type-chain-unresolvable.test.ts › answers 409 type_chain_unresolvable naming the type, and is corrected by PUT /types/{id}`.

## What a report of a failed database statement carries

### `errors/report-log`

When the server logs an unhandled fault in which a database statement failed, the server MUST carry in the fault's log line `Database operation failed` and the SQLite result code the statement failed with.

**Reason:** the code is what an operator needs to tell one fault from another, such as a full disk from a violated constraint, and everything else the database was given or said can be content.

**Tests:** `compliance/fault-reports.test.ts › is logged as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-log-values`

When the server logs an unhandled fault in which a database statement failed, the server MUST NOT carry the statement, the driver's own message or any value the statement was bound to anywhere in its log.

**Reason:** the values of a failed write are what was being written, its properties, tags and hashes, the statement's text and the driver's message can quote them, and a log is read by people and services that the instance's data does not otherwise reach.

**Tests:** `compliance/fault-reports.test.ts › is logged as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-webhook`

When the server sends the error webhook a notification of an unhandled fault in which a database statement failed, the server MUST carry in the notification `Database operation failed` and the SQLite result code the statement failed with.

**Tests:** `compliance/fault-reports.test.ts › is sent to the error webhook as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-webhook-values`

When the server sends the error webhook a notification of an unhandled fault in which a database statement failed, the server MUST NOT carry the statement, the driver's own message or any value the statement was bound to in the notification.

**Reason:** a webhook's receiver is a service the instance's data does not otherwise reach.

**Tests:** `compliance/fault-reports.test.ts › is sent to the error webhook as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-telemetry`

When the server sends a telemetry collector the log record of an unhandled fault in which a database statement failed, the server MUST carry in it `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the statement was bound to.

**Tests:** `compliance/fault-reports.test.ts › is carried by the log record sent to the telemetry collector as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-span`

When the server records on a request's span the exception of an unhandled fault in which a database statement failed, the server MUST carry in the exception event `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the statement was bound to.

**Tests:** `compliance/fault-reports.test.ts › is carried by the exception event on the request's span as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-tracking`

When the server sends error tracking the exception of an unhandled fault in which a database statement failed, the server MUST carry in it `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the statement was bound to.

**Tests:** `compliance/fault-reports.test.ts › is sent to error tracking as a database failure with its SQLite code, and none of the statement, the driver's message or the values`.

### `errors/report-stream-warning`

When an event stream logs a warning because a database statement failed while it read the head of the log, a catch-up or the credential, the server MUST carry in the warning `Database operation failed` and the SQLite result code, and none of the statement or any value taken from the credential.

**Tests:** `compliance/fault-reports.test.ts › names a database failure with its SQLite code and none of the statement or the credential's values, for the head of the log, a catch-up and the credential`.

### `errors/report-response-began`

When the server logs a fault in which a database statement failed and that ended a response body after the response began, the server MUST carry in its log `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the statement was bound to.

**Tests:** waiting on #1444.

### `errors/report-background`

When the server logs a fault in which a database statement failed in work no request was waiting on, the server MUST carry in its log `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the statement was bound to.

**Tests:** waiting on #1444.

### `errors/report-health`

While the write probe of `GET /health` fails on a database statement, when the operator key sends `GET /health`, the server MUST give the `database_write` component an `error` that carries `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the probe write was bound to.

**Reason:** the answer has room for one line, and the code is the part its reader needs.

**Tests:** `compliance/failed-statement-reports.test.ts › names a database failure with its SQLite code, and none of the statement, the driver's message or the values the probe write was bound to`.

### `errors/report-housekeeping`

When a run of a housekeeping job fails on a database statement, the server MUST record `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values it was bound to, as the run's `error` and as the job's `last_error` in the listing.

**Reason:** the record has room for one line, and the code is the part its reader needs.

**Tests:** `compliance/failed-statement-reports.test.ts › records a database failure with its SQLite code and none of the statement, the driver's message or the values, in the run's answer and in the list`.

### `errors/report-bulk-action`

When a database statement fails for an item that a `POST /items/bulk-actions` job writes, the server MUST give that item's entry in the job's `result.errors` a `message` that carries `Database operation failed` and the SQLite result code, and none of the statement, the driver's own message or the values the statement was bound to.

**Reason:** the job's messages have room for one line, and the code is the part each reader needs.

**Tests:** `compliance/failed-statement-reports.test.ts › names a database failure with its SQLite code in each entry's error, and none of the statement, the driver's message or the values its write was bound to`.

## Codes

Every code the server can answer is a row of the table below, which is written from the server's own code table and so cannot differ from it.

<!-- errors-table:start -->

| Code                              | Status              | Meaning                                                                                                                                                                                        |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bulk_atomic_rollback`            | The inner refusal's | An atomic bulk page failed on one entry, so nothing was written. `details` names the entry and the refusal.                                                                                    |
| `bulk_cap_exceeded`               | 400                 | A bulk action matched more items than its `max_items` allows.                                                                                                                                  |
| `bulk_confirmation_required`      | 400                 | A destructive bulk action was sent without its confirmation literal.                                                                                                                           |
| `edge_constraint_violation`       | 400                 | An edge write breaks a constraint of its edge type or of the link graph, such as cardinality, endpoint types or a duplicate.                                                                   |
| `edge_cycle`                      | 400                 | An edge would close a cycle: a self-loop on any edge type, or a loop on an edge type that must stay acyclic.                                                                                   |
| `inheritance_violation`           | 400                 | A type changes the shape of a field it inherits, or a parent gains a field that a child declares with another shape.                                                                           |
| `invalid_client`                  | 400                 | The device sign-in page names a client that is not registered.                                                                                                                                 |
| `invalid_id`                      | 400                 | An item, edge or folder id is not a well-formed identifier.                                                                                                                                    |
| `invalid_properties`              | 400                 | An item's properties break the schema of its type.                                                                                                                                             |
| `invalid_schema`                  | 400                 | A type or edge type carries a schema the server cannot accept.                                                                                                                                 |
| `invalid_transition`              | 400                 | The move is not one the current state of the item or folder allows.                                                                                                                            |
| `missing_required_field`          | 400                 | A field the operation requires is absent. `details.field` names it.                                                                                                                            |
| `property_shadows_field`          | 400                 | A type declares a field with the name of a first-class item field.                                                                                                                             |
| `unknown_type`                    | 400                 | A well-formed type identifier names a type nobody registered.                                                                                                                                  |
| `validation_error`                | 400                 | The request is malformed or breaks a rule that no other code names, such as a bad body, parameter, cursor or limit.                                                                            |
| `unauthorized`                    | 401                 | The request carries no credential the server accepts: none, an unknown or revoked one, or an expired or altered link.                                                                          |
| `core_type_immutable`             | 403                 | The type ships with the platform, so it cannot be replaced or deleted.                                                                                                                         |
| `edge_permission_denied`          | 403                 | The credential lacks the edge-type permission the operation needs.                                                                                                                             |
| `forbidden`                       | 403                 | The credential is valid but lacks a standing permission, reach or origin the operation needs.                                                                                                  |
| `type_not_permitted`              | 403                 | The credential holds no grant on the type at the level the operation asks for.                                                                                                                 |
| `api_key_not_found`               | 404                 | No key the caller can reach has this id, or the key was already revoked.                                                                                                                       |
| `blob_location_not_found`         | 404                 | The named store holds no copy of the blob, or is not attached.                                                                                                                                 |
| `blob_not_found`                  | 404                 | No blob the caller may read has this hash, or no attached store holds its bytes.                                                                                                               |
| `bulk_job_not_found`              | 404                 | No bulk action job the caller can see has this id.                                                                                                                                             |
| `connector_not_found`             | 404                 | No connector registration the credential may read has this id.                                                                                                                                 |
| `delivery_not_found`              | 404                 | The connector's registration has no delivery with this id.                                                                                                                                     |
| `edge_not_found`                  | 404                 | No edge the caller may read has this id.                                                                                                                                                       |
| `edge_type_not_found`             | 404                 | No edge type is registered under this identifier.                                                                                                                                              |
| `endpoint_not_found`              | 404                 | The connector's registration has no endpoint with this id.                                                                                                                                     |
| `housekeeping_job_not_found`      | 404                 | The instance runs no housekeeping job of this name, or has switched it off.                                                                                                                    |
| `item_not_found`                  | 404                 | No item the caller may read has this id: it does not exist, is in the bin, or is of a type the caller may not read.                                                                            |
| `not_found`                       | 404                 | The request names a path or address the server does not serve.                                                                                                                                 |
| `oauth_grant_not_found`           | 404                 | No app grant has this id.                                                                                                                                                                      |
| `owner_not_found`                 | 404                 | The instance has no owner yet.                                                                                                                                                                 |
| `type_not_found`                  | 404                 | No registered type has this identifier.                                                                                                                                                        |
| `webhook_not_found`               | 404                 | No webhook subscription this credential registered has this id.                                                                                                                                |
| `request_timeout`                 | 408                 | An inbound webhook delivery did not finish arriving before its deadline.                                                                                                                       |
| `ancestor_unavailable`            | 409                 | The write names a version that has no snapshot the caller may merge against.                                                                                                                   |
| `conflict`                        | 409                 | The request collides with the current state in a way that no other code names.                                                                                                                 |
| `connector_held`                  | 409                 | Another process holds the connector's registration until `details.expires_at`.                                                                                                                 |
| `copies_below_minimum`            | 409                 | Dropping the copy would leave fewer live copies than the instance's minimum.                                                                                                                   |
| `edge_type_in_use`                | 409                 | Edges of the edge type still exist, and the delete did not ask to force.                                                                                                                       |
| `housekeeping_job_running`        | 409                 | The housekeeping job is in the middle of a run.                                                                                                                                                |
| `id_reused`                       | 409                 | A caller-minted id already names a different item or edge.                                                                                                                                     |
| `idempotency_key_in_flight`       | 409                 | An `Idempotency-Key` is held by another request, or kept changing hands. Retry.                                                                                                                |
| `link_taken`                      | 409                 | A write would give an item a link that another item of its type holds.                                                                                                                         |
| `owner_exists`                    | 409                 | The instance already has an owner.                                                                                                                                                             |
| `read_view_changed`               | 409                 | A conditional copy read or copy stream carries a proof for a read view that has since changed. Rebuild the working copy.                                                                       |
| `source_id_conflict`              | 409                 | A change to `source_id` names a natural key that another item already holds under the same source.                                                                                             |
| `type_already_exists`             | 409                 | A type is already registered under this identifier.                                                                                                                                            |
| `type_chain_unresolvable`         | 409                 | The stored parent chain of a type is circular or too deep to resolve. `PUT /types/{id}` still accepts a corrected schema.                                                                      |
| `type_has_subtypes`               | 409                 | Another type declares this type as its parent. Forcing the delete does not override this.                                                                                                      |
| `type_in_use`                     | 409                 | Items of the type still exist, the bin included, and the delete did not ask to force.                                                                                                          |
| `type_mismatch`                   | 409                 | The request declares a type other than the type of the item it resolved.                                                                                                                       |
| `version_conflict`                | 409                 | The write names a version that is no longer the current one. The answer carries the current state.                                                                                             |
| `request_too_large`               | 413                 | The request body is over the cap for its operation.                                                                                                                                            |
| `range_not_satisfiable`           | 416                 | A `Range` request asks for bytes the blob does not have. `Content-Range` names its size.                                                                                                       |
| `compatible_with_violation`       | 422                 | A `compatible_with` declaration names a target that does not exist, or leaves out a field the target requires.                                                                                 |
| `idempotency_key_reused`          | 422                 | An `Idempotency-Key` is sent with a different request than the one it first named.                                                                                                             |
| `idempotency_result_not_retained` | 422                 | An `Idempotency-Key` repeats a request whose first answer was too large to keep. `details.original_status` is the status it carried.                                                           |
| `rate_limited`                    | 429                 | The credential, or an inbound endpoint, is past its request cap for the current window.                                                                                                        |
| `internal_error`                  | 500                 | A fault that nothing else names a refusal for. The answer says nothing of what failed.                                                                                                         |
| `inbound_unavailable`             | 503                 | An inbound endpoint cannot take a delivery now, because its connector's backlog is full or the instance holds as many bodies in flight as it allows. Retry later.                              |
| `stream_capacity_exhausted`       | 503                 | The instance is serving as many live event streams as it allows. `details.reason` is `viewer_cap`.                                                                                             |
| `write_contention`                | 503                 | A write could not get the store's write lock within the busy budget. Retry it unchanged.                                                                                                       |
| `insufficient_storage`            | 507                 | The volume the instance writes to has no room for the request, or the request would leave less free than the instance's reserve. Nothing was kept unless `details.write_outcome` is `unknown`. |

<!-- errors-table:end -->
