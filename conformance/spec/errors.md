# Errors

## The envelope

1. A refused request answers with a JSON body of the shape `{ "error": { "code", "message" } }`, `message` a string, with an optional `details` object, and no `status` field inside `error`, except in the version envelopes below. `compliance/instance.test.ts › answers 404 not_found in the standard envelope for a path it does not serve`, `compliance/error-codes.test.ts › rejects item without type`, `compliance/adversarial.test.ts › malformed JSON body returns 400 validation_error`.
2. `code` is lowercase snake case drawn from the server's closed vocabulary; the fixtures assert exact codes, never alternatives. Every citation in this file names the code it asserts.
3. A body that is not JSON, an empty body, and a JSON array where an object is expected all answer `400 validation_error`. `compliance/adversarial.test.ts › malformed JSON body returns 400 validation_error`, `› empty body POST returns 400 validation_error`, `› array instead of object returns 400 validation_error`.
4. An unmatched path answers `404 not_found` in the same envelope. `compliance/instance.test.ts › answers 404 not_found in the standard envelope for a path it does not serve`.
5. The OAuth doors answer their own shapes: an RFC 7591 error object at registration and `invalid_request` at the token door; neither is the envelope, and neither is in the table below. Registration takes no credential, and one that carries an `Authorization` bearer the sign-in library does not accept, an API key among them, is read as an initial access token and refused `401` with the RFC 6750 object `{ "error": "invalid_token" }`, which the document declares. A registration whose body is not sent as `application/json` is refused `415` with the sign-in library's own `{ "message", "code": "UNSUPPORTED_MEDIA_TYPE" }`, which the document declares too. `compliance/oauth.test.ts › refuses an unparseable redirect URI with an RFC 7591 error object`, `› refuses a token request with no proof of the client`, `compliance/declared-refusals.test.ts › is refused 401 invalid_token in the RFC's shape, and registers with no credential`, `› is refused 415 in the shape the document declares for a body that is not JSON`.

## The version envelopes

6. A stale write whose base version is retained answers `409` with `error.code = "version_conflict"`, `error.status = 409`, `current` (the live version and properties), `ancestor` (the base version and its snapshot), `conflicting_fields` in ascending order, and the type's resolved `merge_policy`. Each snapshot carries the row's `tier`, `occurred_at` and `source_id` beside its properties, because the version check covers those three and `conflicting_fields` can name one: a caller told that `tier` collided and shown neither side's value has been named a reason it cannot act on. `correctness/item-versioning.test.ts › a stale write answers version_conflict with a three-way envelope`, `› refuses a stale write that collides on tier, occurred_at or source_id`, `compliance/error-codes.test.ts › rejects a stale write whose base version is retained`, `correctness/merge-policy.test.ts › keep-both and LWW arrive in one 409, and the resolution reads back`.
7. A write naming a version no snapshot exists for, whether never issued (0, 999) or thinned away, or whose snapshot is of a type the credential may not read (`versions/ancestor-unreadable`), answers `409` with `error.code = "ancestor_unavailable"`, `error.status = 409`, `current` and `requested_version`, and no `ancestor`, `conflicting_fields` or `merge_policy`. `correctness/item-versioning.test.ts › a version no client ever read answers ancestor_unavailable`, `compliance/error-codes.test.ts › rejects an update naming a version that never existed`.
8. A stale `PATCH /items/{id}` carrying nothing to merge — a write naming a version and edges, and no properties, tier, `occurred_at` or `source_id` — answers `409` with `error.code = "version_conflict"`, `error.status = 409` and `current`, and no `ancestor`, `conflicting_fields` or `merge_policy`: there is no ancestor to compare against and no field that could have collided. A write naming none of those five and no `retype` is refused `400 validation_error` before the version is read. `correctness/item-versioning.test.ts › answers an edges-only stale write with the envelope minus its merge half`. **`DELETE /items/{id}` naming a stale `version` answers the same shape**, trashing nothing, as `POST /items/{id}/purge` does; a delete naming none trashes the row as it stands. `compliance/write-refusal-details.test.ts › refuses a stale one as a stale write carrying nothing to merge, and trashes nothing`, `› deletes unconditionally where no version is named`.
9. A stale `PATCH /edges/{id}` answers the same shape, with `current` the whole edge as the server now holds it. An edge has no per-version history and no merge policy, so there is no ancestor and no field list to give; the key is `current` rather than `edge` so a client reads `current.version` off every single-write refusal carrying this code, whichever door it came from; the bulk doors report it per entry inside their own envelope instead. `correctness/edges/edges-crud.test.ts › refuses a stale edge update, under current and not under edge`.

10. Contention on the database's write lock answers `503 write_contention`, never `500`. A write that meets the lock is retried on the event loop until the instance's busy budget is spent, and only then refused; the refusal carries the budget in `details.budget_ms`. `503` and not `409`, because a conforming device retries a `5xx` without counting it against the write (`queue-and-verdicts.md` 17) while a `409` blocks that write outright (22, 23) — and contention is exactly the case the retry exists for, so a `409` would strand a write that the next attempt would have landed. The budget is `SQLITE_BUSY_BUDGET_MS`, five seconds by default, and the refusal carries it. A bulk page that meets it before any entry has committed does not fold it into a per-entry `errored` outcome as it folds a verdict on an entry: nothing was written and the page answers `503` whatever `atomic` says, because a `200` carrying the refusal would tell a device there is nothing to retry. **A best-effort page that meets it after earlier entries committed** reports that entry `errored` with `write_contention`, having written nothing of it, and answers `200` with the rest, as it does any definitively rolled-back failure of the server's own there (an unexpected one is `internal_error`): a `5xx` would say nothing was written of entries that were, and the caller would send the page again and write them twice, with no idempotency key to stop it, since the bulk doors take none. If an entry's commit outcome remains unknown, the server MUST instead retain a partial `200` answer with that entry's `error.details.write_outcome` set to `unknown`, even before another entry has a confirmed commit. The entry may have been written; callers MUST reconcile its state before retrying that entry and MUST NOT replay the page. After an unknown outcome, a later definite failure MUST remain a per-entry failure. The server's own suites inject definite failures and lost commit acknowledgements on both bulk doors (`routes/committed-write-answer.test.ts` and `routes/bulk-uncertain-outcome.test.ts`). A read can meet the lock too: the credential gate records a key's first use in each hour before the door runs, so every credentialed door declares the refusal. A refused API-key use stamp is retried on the next request; only a successful stamp starts the hourly debounce. Client registration declares it too: it takes no credential, but it is a write, and it is refused the same way although the sign-in library serves it. `compliance/write-contention.test.ts › answers 503 write_contention, never 500`, `› refuses a read too, because the credential gate stamps a key's first use`, `› waits out a briefly held lock on the default budget`, `› refuses a non-atomic bulk page rather than reporting it entry by entry`, `› names the budget it spent, so the setting is observable`, `› refuses a housekeeping run, which writes outside a request's transaction`, `› refuses a client registration, which the sign-in library writes`.

## What a refused write says

11. **A `403` caused by a grant the key lacks names the grant** in `details.grant`: `{ "kind", "name", "level" }`, `kind` one of `type`, `edge_type` and `extension`, `name` the type or edge type's identifier or the extension namespace, and `level` the level the key lacks, `read` or `write`, which is the level the door asked for. It rides on `403 type_not_permitted` for a type the key does not hold or holds for reading only, a folder door's `system.folder` included, on `403 edge_permission_denied`, beside the `details.edge_type` and `details.required` that code already carries, and on the `403 forbidden` an extension door answers a key without reach on the namespace. A client holding a write such a refusal stopped can tell a narrowed key from a write that will never land, and send it again once the grant is back. A refusal for any other reason names none: the reserved `system.*` fence, which no grant opens; a key whose type map reaches no type; a natural key resolving a row the key may not read, which must not name the row's type; a reserved extension namespace; a blob upload by a key whose map grants write on no type, which no one grant would open. On `POST /items/bulk` and `POST /edges/bulk` the grant rides where the entry's refusal does: in `error.details.grant` on an entry reported `errored`, and in `error.details.details.grant` on the `bulk_atomic_rollback` an atomic page answers. A row the key may not read is still answered `404`, and names nothing. `compliance/write-refusal-details.test.ts › names the type, edge type or extension namespace and the level the key lacks`, `› names no grant where no grant would open the door`, `› names the grant on a bulk page, inside the rollback or on the entry`.
12. **A write to an item in the bin answers `404 item_not_found` with `details: { "trashed": true }`** to a key that may read the item's type, on `PATCH /items/{id}`, `DELETE /items/{id}`, the metadata and tag write doors and the extension write doors, so a client holding a write to it can tell an item someone deleted from one that never existed. To a key that may not read the type, and on every read door, an item in the bin answers as a missing one, with no `details`. `compliance/write-refusal-details.test.ts › answers 404 with details.trashed to a key that may read the type, and nothing to one that may not`.

13. When a request to a door that takes a JSON body is not sent with a JSON `Content-Type`, because the header is missing or names another type, with a body or without one, the server SHALL answer `400 validation_error` and SHALL change nothing.

    Reason: a body that is not read as JSON would reach the door as an empty object, and a door whose schema accepts `{}` would run a write the caller never sent, such as replacing an extension namespace's data with `{}`. A client that forgets the header is told, instead of losing data or learning nothing. The refusal is the one statement 3 gives a body that is not valid JSON.

    Tests: `compliance/json-body-doors.test.ts › refuses a body that is missing or not sent as JSON with 400 validation_error on every such door`, `› changes nothing on these doors when the body is not sent as JSON`, `› still reads a body sent as JSON, whatever the case or parameters of its type`.

14. The server SHALL NOT apply statement 13 to `POST /blobs`, `POST /restore`, an inbound webhook address (`inbound-webhooks.md`) or `POST /auth/oauth2/register`.

    Reason: the first three take bodies that are not JSON: a blob's bytes, an archive, and whatever a sender posts. Registration takes JSON but belongs to the sign-in library, which answers a request that is not JSON in its own shape (statement 5).

    Tests: the server's own suite, `packages/server/src/routes/json-body-door-census.test.ts › are all classified`, `› name every unpublished write door`.

15. When a request to a door that takes a JSON body has no credential, or lacks a standing permission the door checks before it reads the body, the server SHALL answer `401` or `403` before it applies statement 13.

    Reason: a caller who may not use the door learns that first, whatever it sent. A grant on an item's type is checked against the stored item after the body is read, so a credential without it is answered `400` for a body that is not JSON; that tells it nothing about the item.

    Tests: the server's own suite, `packages/server/src/routes/json-body-door-census.test.ts › still asks for the credential first`, `› still asks for the permission before the body`.

16. If a request reuses an `Idempotency-Key` whose first request differed only in whether its body was sent with a JSON `Content-Type`, then the server SHALL answer `422 idempotency_key_reused`.

    Reason: the first request was refused by statement 13 or read as JSON, so the two are different requests, and replaying a refusal would tell the caller to do what it just did. Two spellings of a JSON type, such as with and without `charset=utf-8`, are the same request and replay.

    Tests: the server's own suite, `packages/server/src/middleware/idempotency.test.ts › distinguishes a body sent as JSON from the same text sent as another type`, `› replays to a retry that spells the JSON type another way`.

## Refusals of the server's own state

17. When a request repeats an `Idempotency-Key` whose first request has been claimed and not yet answered, the server SHALL answer `409 idempotency_key_in_flight` and SHALL NOT run the write.

    Reason: the claim is what stops two arrivals of one key both writing, so the one that did not take it is told to ask again rather than let through. The status is `409` because something else did get there first, which a client branching on `409` expects it to mean.

    Tests: `compliance/idempotency-refusals.test.ts › answers 409 idempotency_key_in_flight and writes nothing, until the claim is past its lease`. The server's own suite stages the claim exactly, `packages/server/src/middleware/idempotency.test.ts`.

18. If the first request under an `Idempotency-Key` ended without recording an answer, then the server SHALL let a retry take the key over once the claim is older than the lease the server gives a request, and SHALL run the write for it.

    Reason: a writer that dies between claiming and answering leaves a claim nothing completes, and without a lease the one failure the key exists for would refuse its retry for good.

    Tests: `compliance/idempotency-refusals.test.ts › answers 409 idempotency_key_in_flight and writes nothing, until the claim is past its lease`.

19. When a request repeats an `Idempotency-Key` whose first answer was larger than 1,048,576 bytes, the server SHALL answer `422 idempotency_result_not_retained` with `details.original_status` the status the first answer carried, and SHALL NOT run the write again.

    Reason: a record keeps the first answer's status and drops its body above that bound, because the alternative is a record of unbounded size per key or a second write. The repeat learns what the first attempt returned and that it was not repeated. The status is `422` and not `409` because nothing got there first.

    Tests: `compliance/idempotency-refusals.test.ts › answers 422 idempotency_result_not_retained, naming the first status, and writes nothing again`, `› replays an answer within the bound, so the refusal belongs to the size`.

20. If a request meets a fault for which the server holds no refusal, then the server SHALL answer `500 internal_error` in the envelope with the message `Internal server error` and no `details`, and SHALL send nothing of what failed.

    Reason: a caller cannot act on a table name, a query or a stack, and the instance's internals are not the caller's to learn. What a caller can do is read what it changed before it repeats a write.

    Tests: `compliance/internal-error.test.ts › answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone`.

21. The server SHALL NOT answer `409 duplicate_source`.

    Reason: a create naming a natural key a row holds is an upsert onto that row, including two sent together (`items/natural-key-upsert` and `items/natural-key-concurrent`), so no door has a collision to report. The storage layer raises the code for a second row under one natural key, and the archive restore reads it as a row it already holds and counts it among its `duplicates`. A bulk entry under `create_only` that names such a key is skipped with the reason `duplicate_source`, which is a reason and not a code.

    Tests: `correctness/dedup.test.ts › duplicate (source, source_id) upserts onto the existing item (natural-key upsert)`, `› lands concurrent creates of one natural key on one row`, `compliance/restore-archive.test.ts › round-trips: archive export then restore accepts the same payload`, `compliance/bulk.test.ts › create_only skips a repeated (source, source_id) as duplicate_source`.

22. Where an instance sets a cap on live viewers, when a `GET /events` request, plain or copy, would pass it, the server SHALL answer `503 stream_capacity_exhausted` with `details.reason` `viewer_cap`, and SHALL admit a viewer again once one has left.

    Reason: a viewer holds a connection for as long as it reads, so a cap is the one way an instance bounds them. A slot frees as streams end, so the refusal is one to ask again after.

    Tests: `compliance/stream-capacity.test.ts › answers 503 stream_capacity_exhausted to the viewer past the cap, on either stream, and admits one again once a viewer leaves`.

23. If a run of a housekeeping job is asked for while that job is in the middle of a run, then the server SHALL answer `409 housekeeping_job_running` and SHALL NOT start a second run, unless that run has outlived its deadline and been given up on (`housekeeping/deadline-frees-job`).

    Reason: a job never overlaps itself, and the run the scheduler started on its own is a run like one asked for. A caller who gets the refusal asks again when the run has ended.

    Tests: `compliance/housekeeping-job-running.test.ts › answers 409 housekeeping_job_running, and runs once the earlier run has ended`.

24. If a type's stored parent chain is circular or deeper than the server will follow, then a request that resolves the type SHALL be answered `409 type_chain_unresolvable` with `details.type_id`, and `PUT /types/{id}` SHALL still accept a corrected schema for it.

    Reason: the caller did nothing wrong, and every door that writes a type refuses such a chain, so meeting one means the registry already held it. It is coded so the type can be corrected: that door reads the stored schema without walking the chain, so a `500` there would leave nothing to fix it with.

    Tests: `compliance/type-chain-unresolvable.test.ts › answers 409 type_chain_unresolvable naming the type, and is corrected by PUT /types/{id}`.

25. When the server reports a fault of its own that no refusal names, whether the fault ended a request, ended a response body after the response began, or failed work no request was waiting on, the server SHALL NOT carry in the report any value that a failed database statement was bound to, on any sink it writes to: its log, its own printing of a failed response body, the telemetry it exports, the exception it sends to error tracking, and the notification it sends to the error webhook.

    Reason: the values of a failed write are what was being written, its properties, tags and hashes, and each of those destinations is read by people and services the instance's data does not otherwise reach. A report is read from the instance's own sinks and not over HTTP, so the server's own suite asserts it rather than the referee.

    Tests: `packages/server/src/error-reports.test.ts`, `packages/server/src/error-text-census.test.ts`.

26. When the server reports an unhandled fault in which a database statement failed, the server SHALL carry both the statement, with placeholders where its values were, and the driver's own reason for the failure in the fault's log line, the telemetry record of that line, the exception it sends to error tracking and, for a request, the notification it sends to the error webhook and the exception event on the request's span, except a reason that repeats a value the statement was bound to, which the report withholds.

    Reason: the statement and the driver's reason are what an operator needs to find the fault, such as a full disk or a violated constraint. A driver sometimes quotes a token of the text it was given, such as a malformed search query, in any script and at any length, and that token is the value 25 keeps out.

    Tests: `packages/server/src/error-reports.test.ts`, `packages/server/src/error-text.test.ts`.

27. When the server reports a failed database statement anywhere else, in a housekeeping job's record, the health answer, a bulk action's messages or a warning about an event stream, the server SHALL carry the statement or the driver's reason, and SHALL NOT carry a value the statement was bound to.

    Reason: those reports have room for one line, so each keeps the part its reader needs, and the rule of 25 holds for all of them.

    Tests: `packages/server/src/error-text.test.ts`, `packages/server/src/housekeeping/scheduler.test.ts`, `packages/server/src/routes/health.test.ts`.

## Codes

Every code the server can answer is a row of the table below, which is written from the server's own code table and so cannot differ from it.

<!-- errors-table:start -->

| Code                              | Status              | Meaning                                                                                                                                                           |
| --------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bulk_atomic_rollback`            | The inner refusal's | An atomic bulk page failed on one entry, so nothing was written. `details` names the entry and the refusal.                                                       |
| `bulk_cap_exceeded`               | 400                 | A bulk action matched more items than its `max_items` allows.                                                                                                     |
| `bulk_confirmation_required`      | 400                 | A destructive bulk action was sent without its confirmation literal.                                                                                              |
| `edge_constraint_violation`       | 400                 | An edge write breaks a constraint of its edge type or of the link graph, such as cardinality, endpoint types or a duplicate.                                      |
| `edge_cycle`                      | 400                 | An edge would close a cycle: a self-loop on any edge type, or a loop on an edge type that must stay acyclic.                                                      |
| `inheritance_violation`           | 400                 | A type changes the shape of a field it inherits, or a parent gains a field that a child declares with another shape.                                              |
| `invalid_client`                  | 400                 | The device sign-in page names a client that no longer exists.                                                                                                     |
| `invalid_id`                      | 400                 | An item, edge or folder id is not a well-formed identifier.                                                                                                       |
| `invalid_properties`              | 400                 | An item's properties break the schema of its type.                                                                                                                |
| `invalid_schema`                  | 400                 | A type or edge type carries a schema the server cannot accept.                                                                                                    |
| `invalid_transition`              | 400                 | The move is not one the current state of the item or folder allows.                                                                                               |
| `missing_required_field`          | 400                 | A field the operation requires is absent. `details.field` names it.                                                                                               |
| `property_shadows_field`          | 400                 | A type declares a field with the name of a first-class item field.                                                                                                |
| `unknown_type`                    | 400                 | A well-formed type identifier names a type nobody registered.                                                                                                     |
| `validation_error`                | 400                 | The request is malformed or breaks a rule that no other code names, such as a bad body, parameter, cursor or limit.                                               |
| `unauthorized`                    | 401                 | The request carries no credential the server accepts: none, an unknown or revoked one, or an expired or altered link.                                             |
| `core_type_immutable`             | 403                 | The type ships with the platform, so it cannot be replaced or deleted.                                                                                            |
| `edge_permission_denied`          | 403                 | The credential lacks the edge-type permission the operation needs.                                                                                                |
| `forbidden`                       | 403                 | The credential is valid but lacks a standing permission, reach or origin the operation needs.                                                                     |
| `type_not_permitted`              | 403                 | The credential holds no grant on the type at the level the operation asks for.                                                                                    |
| `api_key_not_found`               | 404                 | No key the caller can reach has this id, or the key was already revoked.                                                                                          |
| `blob_location_not_found`         | 404                 | The named store holds no copy of the blob, or is not attached.                                                                                                    |
| `blob_not_found`                  | 404                 | No blob the caller may read has this hash, or no attached store holds its bytes.                                                                                  |
| `bulk_job_not_found`              | 404                 | No bulk action job the caller can see has this id.                                                                                                                |
| `connector_not_found`             | 404                 | No connector registration the credential may read has this id.                                                                                                    |
| `delivery_not_found`              | 404                 | The connector's registration has no delivery with this id.                                                                                                        |
| `edge_not_found`                  | 404                 | No edge the caller may read has this id.                                                                                                                          |
| `edge_type_not_found`             | 404                 | No edge type is registered under this identifier.                                                                                                                 |
| `endpoint_not_found`              | 404                 | The connector's registration has no endpoint with this id.                                                                                                        |
| `housekeeping_job_not_found`      | 404                 | The instance runs no housekeeping job of this name, or has switched it off.                                                                                       |
| `item_not_found`                  | 404                 | No item the caller may read has this id: it does not exist, is in the bin, or is of a type the caller may not read.                                               |
| `not_found`                       | 404                 | The request names a path or address the server does not serve.                                                                                                    |
| `oauth_grant_not_found`           | 404                 | No app grant has this id.                                                                                                                                         |
| `owner_not_found`                 | 404                 | The instance has no owner yet.                                                                                                                                    |
| `type_not_found`                  | 404                 | No registered type has this identifier.                                                                                                                           |
| `webhook_not_found`               | 404                 | No webhook subscription this credential registered has this id.                                                                                                   |
| `request_timeout`                 | 408                 | A request body did not finish arriving before the door's deadline.                                                                                                |
| `ancestor_unavailable`            | 409                 | The write names a version that has no snapshot the caller may merge against.                                                                                      |
| `conflict`                        | 409                 | The request collides with the current state in a way that no other code names.                                                                                    |
| `connector_held`                  | 409                 | Another process holds the connector's registration until `details.expires_at`.                                                                                    |
| `copies_below_minimum`            | 409                 | Dropping the copy would leave fewer live copies than the instance's minimum.                                                                                      |
| `edge_type_in_use`                | 409                 | Edges of the edge type still exist, and the delete did not ask to force.                                                                                          |
| `housekeeping_job_running`        | 409                 | The housekeeping job is in the middle of a run.                                                                                                                   |
| `id_reused`                       | 409                 | A caller-minted id already names a different item or edge. `details.differs` says what differs.                                                                   |
| `idempotency_key_in_flight`       | 409                 | An `Idempotency-Key` names a request that is still being served.                                                                                                  |
| `link_taken`                      | 409                 | A write would give an item a link that another item of its type holds.                                                                                            |
| `owner_exists`                    | 409                 | The instance already has an owner.                                                                                                                                |
| `read_view_changed`               | 409                 | A conditional copy read or copy stream carries a proof for a read view that has since changed. Rebuild the working copy.                                          |
| `source_id_conflict`              | 409                 | A change to `source_id` names a natural key that another item already holds under the same source.                                                                |
| `type_already_exists`             | 409                 | A type is already registered under this identifier.                                                                                                               |
| `type_chain_unresolvable`         | 409                 | The stored parent chain of a type is circular or too deep to resolve. `PUT /types/{id}` still accepts a corrected schema.                                         |
| `type_has_subtypes`               | 409                 | Another type declares this type as its parent. Forcing the delete does not override this.                                                                         |
| `type_in_use`                     | 409                 | Items of the type still exist, the bin included, and the delete did not ask to force.                                                                             |
| `type_mismatch`                   | 409                 | The request declares a type other than the type of the item it resolved.                                                                                          |
| `version_conflict`                | 409                 | The write names a version that is no longer the current one. The answer carries the current state.                                                                |
| `request_too_large`               | 413                 | The request body is over the cap for its door.                                                                                                                    |
| `range_not_satisfiable`           | 416                 | A `Range` request asks for bytes the blob does not have. `Content-Range` names its size.                                                                          |
| `compatible_with_violation`       | 422                 | A `compatible_with` declaration names a target that does not exist, or leaves out a field the target requires.                                                    |
| `idempotency_key_reused`          | 422                 | An `Idempotency-Key` is sent with a different request than the one it first named.                                                                                |
| `idempotency_result_not_retained` | 422                 | An `Idempotency-Key` repeats a request whose first answer was too large to keep. `details.original_status` is the status it carried.                              |
| `rate_limited`                    | 429                 | The credential, or an inbound endpoint, is past its request cap for the current window.                                                                           |
| `internal_error`                  | 500                 | A fault that nothing else names a refusal for. The answer says nothing of what failed.                                                                            |
| `inbound_unavailable`             | 503                 | An inbound endpoint cannot take a delivery now, because its connector's backlog is full or the instance holds as many bodies in flight as it allows. Retry later. |
| `stream_capacity_exhausted`       | 503                 | The instance is serving as many live event streams as it allows. `details.reason` is `viewer_cap`.                                                                |
| `write_contention`                | 503                 | A write could not get the store's write lock within the busy budget. Retry it unchanged.                                                                          |

<!-- errors-table:end -->

**A conditional working-copy read whose view changed answers `409 read_view_changed` before the ordinary resource refusal.** Its body is exactly `{"error":{"code":"read_view_changed","message":"The read view changed. Rebuild the working copy."}}`, without `details`, a resource identity or a read-view certificate. A copy stream not yet started uses the same envelope; one already started uses the no-id terminal in `read-views/terminal-frame`. Malformed copy grammar is `400 validation_error`, and generic validation, authentication and server failures carry no copy certificate. `compliance/read-views.test.ts › refuses stale HTTP and resume proofs before resource lookup after retype or read narrowing`, `› rejects every alternate copy grammar before starting a stream`, `› certifies matching resource absence without certifying generic validation or authentication failures`.
