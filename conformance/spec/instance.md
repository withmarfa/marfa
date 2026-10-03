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
