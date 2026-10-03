# The instance

What one deployment says about itself. The credential chapters state what a key may reach and the registry chapters state what the data plane holds; this one states the fact that is true of the deployment rather than of anything inside it.

## Identity

1. An instance holds an `instance_id`, a UUIDv7. It is shown at the root route without a credential, at `GET /config`, and in the `manifest.json` of a `format=archive` export, and the three are the same value. `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`, `› describes itself at the root`.
2. The identity is not configuration and no door sets it. `PUT /config` takes it back as read, so a body taken from `GET /config` round trips, and refuses one naming a different instance with `400 validation_error` and `details.errors[0].path` of `instance_id`, leaving the configuration untouched. A `PUT` that omits it still answers with it, and the wholesale clear does not remove it. `compliance/schema-enforcement.test.ts › takes a body back as read, and refuses one addressed elsewhere`, `› PUT replaces the configuration wholesale and GET reads it back`.

## What it advertises

3. The root's `features` array names a surface this deployment serves, and every entry has a route: a request at the door each one names is answered by something other than `404 not_found`, which is what the server gives a path it does not serve. Entries are lower_snake_case. `compliance/instance.test.ts › serves a route for every feature it advertises`, `› names every advertised feature in one convention`.

**That the value is minted once and survives a restart is not stated here, because nothing over HTTP can see it.** Both halves — a mint that answers the same value to every caller of a fresh database, and a value that a reopen of the same database returns — are properties of the server's own storage, asserted in `packages/server/src/storage/instance-id.test.ts`. A fixture run against an already-booted server reads whatever that server holds and cannot tell a durable id from one minted at the start of the run.

What the identity is _not_ — never a prefix on an identifier, never a permission or a permission root, never a column on an item — is a decision about vocabulary rather than an observable behavior, so it is stated in `GLOSSARY.md` and carries no statement here.

## The contract

4. **The root and the document carry one contract version**: the root answers it as `contract`, which is 0 until the first public release, and the document's `info.version` is the same number. It is not the build, which the root answers as `version`. `compliance/instance.test.ts › carries one contract version at the root and in its document`, `› describes itself at the root`.

5. **Every answer the application gives carries the contract version** as `X-Marfa-Contract`, the same number the root answers as `contract`: a read, a refusal, a request with no credential and a path the server does not serve alike, so a client checks the answer it is about to read. A request the HTTP layer refuses before the application sees it, such as one with a malformed host, is answered without it. `compliance/instance.test.ts › sends its contract version on every answer, a refusal included`.

**Every version inside Marfa stays at 0 until the first public release**: the contract, every shipped type schema, the device's local store and the archive format alike. Nothing here says how one moves before then, because none does.

## Backing up

An owner backs up an instance by backing up the machine it runs on. The data directory is the one thing the instance keeps: the database file, the log beside it that holds writes not yet moved into the file, and the folder of blob files. The settings `API_KEY_SALT` and `MARFA_AUTH_SECRET` are not in it, and a restored instance needs the first (statement 10).

6. When the server starts on an image of its data directory taken at any one instant, it SHALL open the database and answer every write it had acknowledged before that instant, and it SHALL serve every blob such a write names.

   Reason: a volume snapshot, an APFS snapshot (so Time Machine) and a host's disk snapshot each take an image at one instant, and a crash leaves one.

   Tests: `compliance/backup-restore.test.ts › answers every write the instance had acknowledged before the copy began, and every blob they name`. The server's own suite holds the database half under a stopped writer and a killed one, in `packages/server/src/storage/sqlite/backup-copy.test.ts`.

7. When the server stops on `SIGTERM` or `SIGINT`, it SHALL move every write it has acknowledged into the database file, so that the file alone holds them.

   Reason: an owner who stops the instance and copies the data directory must not lose the writes the log still held. A replicator that holds the log can refuse the move, and the next start applies the log as it always does.

   Tests: `packages/server/src/storage/sqlite/backup-copy.test.ts › leaves a stopped instance's database in one file, which restores whole without a log beside it`.

8. When an upload is acknowledged, the server SHALL have made the blob's bytes and its name in the disk store durable.

   Reason: an image of the disk at any instant then never holds a row that names a blob whose file is missing or empty.

   Tests: `packages/server/src/storage/blob-durability.test.ts`.

9. While a reader holds a transaction on the database, the server SHALL keep the log it holds for that reader's snapshot, so a copy that reads the database file, then the log, then the blobs, restores whole when it begins after the reader's transaction does and ends before it ends.

   Reason: a copy that reads the files one after another with no such reader can take the database file before a checkpoint and the log after it, and so holds neither the writes between them nor a consistent database. The reader is what makes that copy safe. The blobs are read after the database so that every blob a copied row names is in the copy.

   Tests: `packages/server/src/storage/sqlite/backup-copy.test.ts › restores a copy that reads the files one after another while a read transaction is held, with every write acknowledged before it`, and its witness `› restores a copy that reads the files one after another across a checkpoint to a database that is not whole`.

10. When the server starts on a data directory with an `API_KEY_SALT` other than the one the directory's keys were minted under, it SHALL refuse every one of those keys with `401 unauthorized`.

    Reason: the database holds a hash of each key, made with the salt, and the salt is a setting outside the data directory. A restore without it has every row and no key that opens one.

    Tests: `compliance/backup-restore.test.ts › refuses a key it holds when started with a different API_KEY_SALT`.

## Health

`GET /health` answers without a credential (`keys-and-oauth.md` 17). It names four components, `database`, `database_write`, `disk` and `blob_storage`, each with a `status` of `ok`, `degraded` or `down`, and an overall `status` that is `down` when any component is, otherwise `degraded` when any is, otherwise `ok`.

11. When any component is `down`, the server SHALL answer `GET /health` with `503`. In every other case it SHALL answer `200`, whether the overall `status` is `ok` or `degraded`.

    Reason: a container's health check and a deploy gate read the status code, an instance whose database, disk or blob folder refuses is not serving, and a `degraded` instance still is.

    Tests: `compliance/instance.test.ts › answers /health without a credential and names its components`. A `down` component cannot be produced against a server the referee booted, so the server's own suite drives each: `packages/server/src/routes/health.test.ts › GET /health failing status`, and with the real app and database, `packages/server/src/routes/health.app.test.ts`.

12. The server SHALL probe each component, within two seconds, as follows: `database` reads a row; `database_write` commits one write; `blob_storage` asks the disk store for a blob; `disk` measures the bytes available on whichever of the database's volume and the disk store's volume has the least. A probe the database or disk refused is `down`. A probe that gave no answer within two seconds is `degraded`. A `disk` below 1 MiB available is `down`, below 64 MiB is `degraded`, and one whose space could not be read is `degraded`, never `down`.

    Reason: a refusal is known and a silence is not. A database that reads can still refuse every write, because the volume is read-only or full, and only a committed write shows it.

    Tests: `packages/server/src/routes/health.test.ts › GET /health failing status`.

13. The server SHALL commit the write of `database_write` at most once every ten seconds, and answer every call in between with the outcome of the last.

    Reason: the door takes no credential, so what a caller can make the server do through it stays small.

    Tests: `packages/server/src/routes/health.test.ts › the probes the app mounts`.

14. The server SHALL include the text of a component's error in the answer only when the request carries the operator key. A request with no credential, a key that is not the operator key or a key the instance does not hold gets the same answer without it, and gets it whether or not the database can look the key up.

    Reason: the text is the database's or the operating system's own and carries paths and driver detail.

    Tests: `packages/server/src/routes/health.test.ts › GET /health error text`; `packages/server/src/routes/health.app.test.ts › answers 503 with the database down, and tells only the operator key why`; `compliance/instance.test.ts › answers /health to a request that names a key the instance does not hold as it does to one that names none`.

## Upgrading

Until the first public release nothing upgrades a database in place (`search-and-filters.md` 27). An owner who runs a build over a database another build wrote is told so before anything is changed.

15. When the server starts on a database whose schema differs from its own, or that still holds a registry or a setting this build does not read, it SHALL refuse to start, SHALL change nothing in the file, and SHALL say in its message that the way forward is to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse an archive that build did not write.

    Reason: an index over a missing column fails with a driver error after the file's header has been rewritten, and a missing column fails nowhere until a request meets it, so the refusal is made before either. The message does not promise a restore the contract does not.

    Tests: `packages/server/src/storage/sqlite/schema-mismatch-refusal.test.ts`; `packages/server/src/storage/sqlite/retired-registry-refusal.test.ts › names the way forward, and says the restore it names can refuse`.

16. When the server refuses a database under statement 15, it SHALL exit with status 78, and SHALL exit with status 1 when it stops for any other failure to start.

    Reason: what supervises the process tells a stop that starting again will not mend from one that it may.

    Tests: `packages/server/src/refused-database-exit.test.ts`; `ci/entrypoint.test.ts` holds the container's entrypoint to the same number.

## Stopping

An instance is stopped by `SIGTERM` or `SIGINT`, and a container runtime follows `SIGTERM` with `SIGKILL` after ten seconds by default.

17. When the server is stopped, it SHALL end every event stream it has open with a terminal `stream_incomplete` frame whose `reason` is `server_stopping` and whose `cursor` is the last event the stream sent, with no `id:`, and then close the stream.

    Reason: a stream never ends of its own accord, so the server's close would wait on it until the bound ran out and the stop would end as a failure, and a client cut off with no closing frame cannot tell a stop from a fault. Every event after the cursor is still in the log, so the client's recovery is the same as for any other `stream_incomplete`: connect again from it.

    Tests: `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`. The server's own suite holds the cursor, the copy stream and a stream that opens after the stop has begun: `packages/server/src/routes/events-shutdown.test.ts`, and with a real process and a keep-alive client, `packages/server/src/shutdown-stream.test.ts`.

18. When the server is stopped, it SHALL wait for the bulk action and the housekeeping runs in flight, the webhook deliveries among them, before it closes its storage, and SHALL exit with status 0 when the server and the storage have closed, within eight seconds of the signal at the most.

    Reason: a run cut off mid-write leaves its record unwritten, and a stop that the runtime kills is read as a crash. A run that outlives its wait is resumed at the next start and does not make the stop a failure.

    Tests: `packages/server/src/shutdown.test.ts`; `packages/server/src/shutdown-stream.test.ts › sends the stream its closing frame and ends it, and exits 0 within the grace`.
