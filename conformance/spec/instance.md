# The instance

What one deployment says about itself, and what happens to it as an owner runs it: the identity it answers to, the features and contract version it advertises, backing up, health, upgrading, stopping, the pages it renders, the configuration operations and the settings that stop it from starting. The credential chapters state what a key may reach and the registry chapters state what the data plane holds.

`GET /` answers one of two things. The description is the JSON object with `name`, `version`, `instance_id`, `contract` and `features`, and with `release` when the build is a numbered release. A page is the HTML a browser is given instead.

## Needs attention

### `instance/attention-authority`

When the owner or a private local command sends `GET /attention`, the server MUST return an unpaginated `data` array of concerns, each with `kind`, `reference`, `title`, `description`, and a local console `href`.

**Tests:** `cli/attention.test.ts › shares owner HTTP and private-socket attention, keeps known concerns, and refuses keys`.

### `instance/attention-credentials`

When a key or delegated credential sends `GET /attention`, the server MUST answer `403 forbidden`.

**Reason:** the aggregate includes the owner's folder and key inventories, which management permissions alone do not grant.

**Tests:** `cli/attention.test.ts › shares owner HTTP and private-socket attention, keeps known concerns, and refuses keys`.

### `instance/attention-concerns`

When `GET /attention` completes its checks, the server MUST include degraded or down health components, housekeeping jobs whose last run failed, connectors whose last run failed or that report problems or have said nothing for more than 24 hours, current folder reports with problems, paused removals or first sync waiting, and live keys expiring within the next seven days inclusive.

**Reason:** connector silence follows the latest registration, heartbeat, or received run; folder totals exclude historical sign-ins and do not claim that a copy is online.

**Tests:** `cli/attention.test.ts › shares owner HTTP and private-socket attention, keeps known concerns, and refuses keys`.

### `instance/attention-unavailable`

If a check fails or does not answer within its bounded deadline, then the server MUST answer `GET /attention` with known concerns and an `unavailable` item identifying the check whose state is unknown.

**Tests:** `cli/attention.test.ts › shares owner HTTP and private-socket attention, keeps known concerns, and refuses keys`.

### `instance/attention-empty`

When every attention check completes without finding a concern, the server MUST return an empty `data` array from `GET /attention`.

**Tests:** `cli/attention.test.ts › shares owner HTTP and private-socket attention, keeps known concerns, and refuses keys`.

## Background work

### `instance/background-request-authority`

When a request starts or wakes background work, the server MUST evaluate that work's authorization independently of the request's authority.

**Reason:** housekeeping runs as server-owned work, even if the requesting key is revoked after the run is admitted; a bulk-action job rechecks its stored credential under `items/job-credential-lost` and can still record its failure.

**Tests:** `compliance/background-authority.test.ts › background jobs after the requesting key is revoked`.

## Identity

### `instance/id-at-root`

When `GET /` is answered with the description, the server MUST give it an `instance_id` that is a UUIDv7.

**Tests:** `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`, `› describes itself at the root`, `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/id-at-config`

When a key holding `config.manage` sends `GET /config`, the server MUST answer an `instance_id` equal to the one the root answers.

**Tests:** `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`, `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/id-in-archive`

When a credential that may export sends `GET /export?format=archive`, the server MUST write into the archive's `manifest.json` an `instance_id` equal to the one the root answers.

**Reason:** the manifest is a file nothing echoes back, so an export that wrote another name, or none, would go unnoticed at every other operation.

**Tests:** `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`.

### `instance/id-same-every-answer`

The server MUST answer every request for the description with the same `instance_id`.

**Tests:** `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/id-kept-on-restart`

When the server starts again on the database it stopped on, the server MUST answer the `instance_id` it answered before it stopped.

**Reason:** the identity is how a caller pointed at an address tells this instance from another that answers the same shape, so a new one at each start would make every instance look new.

**Tests:** `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/id-per-instance`

When the server starts on a new database, the server MUST answer an `instance_id` that no other instance answers.

**Tests:** `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/id-unchanged-by-put`

When the server answers `PUT /config`, the server MUST go on answering at the root the `instance_id` it answered before, whether it accepted the body or refused it.

**Reason:** the identity is not configuration and no operation sets it.

**Tests:** `compliance/instance-config.test.ts › leaves the identity the root answers as it was after any PUT, refused ones included`.

## A write that names an instance

A client that keeps a copy of one instance names that instance in `X-Marfa-Instance-Id` on what it sends, so a write that reaches another instance at the same address is refused where it lands. In this section a write is a `POST`, `PUT`, `PATCH` or `DELETE` to an operation outside `/auth`, `POST /items/bulk-get` and `POST /items/lookup` among them. An inbound webhook address is served ahead of any credential and is not one.

### `instance/write-names-own`

When a write names in `X-Marfa-Instance-Id` the instance's own `instance_id`, the server MUST answer it as it answers the same write without the header.

**Tests:** `compliance/instance-header.test.ts › takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it`, `› keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`, `› refuses another instance on POST /items/bulk-get and POST /items/lookup`.

### `instance/write-names-other`

If a write names in `X-Marfa-Instance-Id` a UUIDv7 other than the instance's own `instance_id`, then the server MUST answer `409 instance_changed`.

**Reason:** another instance at the address the client knew holds none of the rows its copy was built from, so a write sent there would land on rows the client never read.

**Tests:** `compliance/instance-header.test.ts › takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it`, `› refuses another instance on every write operation the document publishes outside /auth`.

### `instance/write-names-other-unwritten`

When the server answers a write `409 instance_changed`, the server MUST leave unchanged everything the write would have changed.

**Tests:** `compliance/instance-header.test.ts › takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it`, `› keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`.

### `instance/write-instance-optional`

The server MUST NOT refuse a write for naming no `X-Marfa-Instance-Id`.

**Reason:** a caller that holds no copy, such as a connector, a script or an inbound sender, has no instance to name.

**Tests:** `compliance/instance-header.test.ts › takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it`.

### `instance/write-instance-malformed`

If a write names an `X-Marfa-Instance-Id` that is empty, repeated, or not one lowercase UUIDv7, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/instance-header.test.ts › refuses an empty, repeated, uppercase or malformed instance id 400 validation_error`, `› answers 401, or 400 to a body nested too deep, before it judges the header, and judges it before the write's own refusals`.

### `instance/write-instance-order`

When a write names `X-Marfa-Instance-Id` and meets more than one of the answers this section gives it, the server MUST give the first in this order: no valid credential on an operation that requires one, `401`, or `400` before it to a body nested more than 64 levels or holding text that is not well-formed UTF-16; a header that is not one lowercase UUIDv7, `400`; another instance's id, `409 instance_changed`; then the answers it gives the same write without the header, a body nested more than 64 levels, a body holding text that is not well-formed UTF-16 and an answer recorded under its `Idempotency-Key` among them.

**Reason:** a write sent to another instance is refused for that alone, so the refusal says nothing about the body, the rows it names or the credential's reach there.

**Tests:** `compliance/instance-header.test.ts › answers 401, or 400 to a body nested too deep, before it judges the header, and judges it before the write's own refusals`, `› keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`.

### `instance/write-instance-not-recorded`

When the server answers a write that carries an `Idempotency-Key` `409 instance_changed`, the server MUST answer the same write sent again under that key, naming the instance's own id, as a first attempt.

**Reason:** a client that meets the refusal rebuilds its copy from the instance now at the address and sends its queue again under the same keys.

**Tests:** `compliance/instance-header.test.ts › keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`.

### `instance/write-instance-replay`

When a write repeats an `Idempotency-Key` and its body, naming the instance's own id in `X-Marfa-Instance-Id` or naming none, the server MUST replay the first answer, whichever of the two the first attempt sent.

**Tests:** `compliance/instance-header.test.ts › keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`.

### `instance/write-instance-every-door`

The server MUST judge `X-Marfa-Instance-Id` on every write.

**Tests:** `compliance/instance-header.test.ts › refuses another instance on every write operation the document publishes outside /auth`, `› refuses another instance on POST /items/bulk-get and POST /items/lookup`.

### `instance/write-instance-ignored`

When a `GET`, a request to an operation under `/auth` or a delivery to an inbound webhook address names `X-Marfa-Instance-Id`, the server MUST answer it as it answers the same request without the header.

**Reason:** a read of a copy is held to the instance by its read view (`read-views/conditional-certified`), and the sign-in operations and inbound senders hold no copy.

**Tests:** `compliance/instance-header.test.ts › answers a GET, a request under /auth and an inbound delivery as it answers one without the header`.

## What it advertises

### `instance/root-no-credential`

When a request that carries no credential sends `GET /`, the server MUST answer `200`.

**Reason:** the identity is read by a caller that holds no key yet.

**Tests:** `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`, `› answers a browser at the root with a page and a program with the JSON`.

### `instance/root-fields`

When `GET /` is answered with the description, the server MUST give it `name`, `version`, `instance_id`, `contract` and `features`.

**Tests:** `compliance/instance.test.ts › describes itself at the root`.

### `instance/root-name`

When `GET /` is answered with the description, the server MUST answer `name` as the configured display name, or `Marfa` when no name is configured.

**Tests:** `compliance/instance.test.ts › describes itself at the root`, `› answers a browser at the root with a page and a program with the JSON`, `compliance/instance-config.test.ts › sets, trims, persists and clears the name without changing identity`.

### `instance/root-version`

When `GET /` is answered with the description, the server MUST answer `version` as a string other than the contract version.

**Reason:** `version` is the build, which moves on a deploy, and the contract version does not.

**Tests:** `compliance/instance.test.ts › describes itself at the root`, `› carries one contract version at the root and in its document`.

### `instance/root-release`

Where the server runs a build made as a numbered release, the server MUST answer `GET /` with `release` as that release's version, three dot-separated whole numbers.

**Reason:** `version` names the build and stays what it was, so that a deployment can be traced to its commit. A person who is upgrading names a release, and reads it here. The fixtures boot a checkout, which is not a release, so they hold only the form of the number; `scripts/check-image.sh` boots a built release image and holds the field to the release it was made as.

**Tests:** `compliance/instance.test.ts › names a release only as the version a tag carries`.

### `instance/root-release-absent`

When `GET /` is answered with the description for a build that is not a numbered release, the server MUST NOT give it `release`.

**Reason:** a placeholder would read as a release that no tag carries.

**Tests:** `compliance/instance.test.ts › names no release for a build made from a checkout`.

### `instance/features-array`

When `GET /` is answered with the description, the server MUST answer `features` as an array of strings, each named once.

**Tests:** `compliance/instance.test.ts › advertises its features as an array of strings, each named once`.

### `instance/features-served`

When `GET /` lists a feature in `features`, the server MUST answer a request at some path of that feature with something other than `404 not_found`.

**Reason:** `404 not_found` is what the server gives a path it does not serve, so a feature advertised without a route would answer it.

**Tests:** `compliance/instance.test.ts › serves a route for every feature it advertises`.

### `instance/features-snake-case`

The server MUST write each entry in `features` in lower_snake_case: a lowercase letter first, then lowercase letters and digits, with words joined by single underscores.

**Tests:** `compliance/instance.test.ts › names every advertised feature in one convention`.

## The contract version

### `instance/contract-integer`

When `GET /` is answered with the description, the server MUST answer `contract` as the integer 0.

**Reason:** every version inside Marfa stays at 0 until the first public release.

**Tests:** `compliance/instance.test.ts › carries one contract version at the root and in its document`, `› describes itself at the root`.

### `instance/contract-document`

When `GET /openapi.json` is answered, the server MUST answer `info.version` as the text of the number the root answers as `contract`.

**Tests:** `compliance/instance.test.ts › carries one contract version at the root and in its document`.

### `instance/archive-version`

When a credential that may export sends `GET /export?format=archive`, the server MUST write the archive's `manifest.json` with a `version` of 0.

**Reason:** an archive is read only by the build that wrote it, and the format stays at version 0 until the first public release (`search-and-filters/restore-version`).

**Tests:** `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`.

### `instance/contract-header`

The server MUST send `X-Marfa-Contract`, with the number the root answers as `contract`, on every answer to a request whose request line, headers and `Host` it can parse, whether it is a read, a refusal, a page, a stream, a download, a request the rate limiter refuses or a preflight.

**Reason:** a client checks the answer it is about to read against the contract it was built for, so the header cannot be missing on the answers a layer in front of the routes shapes. A request the server cannot parse is refused by the HTTP layer before anything that knows the contract sees it.

**Tests:** `compliance/instance.test.ts › sends its contract version on every answer, a refusal included`, `› sends its contract version on every kind of answer, not only a JSON body`, `compliance/contract-header.test.ts › sends its contract version on a request the limiter refuses`, `› sends its contract version on a preflight from an origin the instance allows`.

## The reference's groups

### `instance/document-groups`

When `GET /openapi.json` is answered, the server MUST give each operation in `paths` exactly one tag, and declare in `tags` only tags that an operation carries.

**Tests:** `compliance/instance.test.ts › declares no tag that no operation carries, and no operation without one`, `› lists every operation once, under its own tag, in each tag's x-operation-order`.

### `instance/document-operation-order`

When `GET /openapi.json` is answered, the server MUST write on each tag an `x-operation-order` that lists each operation carrying the tag once, by its `operationId` or, for a request Marfa sends, by its name in `webhooks`, in the order a developer meets them: create or register, get, list, update, replace, delete, then the group's other actions.

**Reason:** the order interleaves paths, so `paths` alone cannot carry it, and a reader of the document needs the order from the server.

**Tests:** `compliance/instance.test.ts › lists every operation once, under its own tag, in each tag's x-operation-order`.

### `instance/document-paths-order`

When `GET /openapi.json` is answered, the server MUST write `paths` in the order of each path's earliest operation in the tags' `x-operation-order` lists.

**Tests:** `compliance/instance.test.ts › lists every operation once, under its own tag, in each tag's x-operation-order`.

## Backing up

An owner backs up an instance by backing up the machine it runs on. The data directory is the one thing the instance keeps: the database file, the log beside it that holds the writes not yet moved into the file, and the folder of blob files. The setting `API_KEY_SALT` is not in it. In the image `deploy/Dockerfile` builds, with `S3_BUCKET` set, Litestream also streams the database to the bucket, and a volume that holds no database is first restored from it.

### `instance/replica-under-prefix`

Where the server runs in the image `deploy/Dockerfile` builds with `S3_BUCKET` set, the server MUST keep its database replica under `<S3_PREFIX>/db/` in that bucket, with `S3_PREFIX` read as the settings table says.

**Reason:** everything an instance puts in the bucket is then under its own prefix, its blobs and its database, so one bucket can carry several instances.

**Tests:** `backup/replica-paths.test.ts › streams the database under the default prefix's db when S3_PREFIX is unset, and a fresh volume restores it`, `› keeps the replicas of two instances on one bucket apart, and each fresh volume restores only its own`, `› reads a prefix with a slash at either end as the same prefix, for the replica and for the server`, `backup/older-database.test.ts › starts an older database under a new prefix that holds no replica, replicates its writes there, and leaves the old replica unchanged`.

### `instance/replica-restores-own`

Where the server runs in the image `deploy/Dockerfile` builds with `S3_BUCKET` set, when it starts on a volume that holds no database, the server MUST start on the database last replicated under its own `<S3_PREFIX>/db/`, or on a new database when nothing is there.

**Tests:** `backup/replica-paths.test.ts › streams the database under the default prefix's db when S3_PREFIX is unset, and a fresh volume restores it`, `› keeps the replicas of two instances on one bucket apart, and each fresh volume restores only its own`, `› reads a prefix with a slash at either end as the same prefix, for the replica and for the server`, `backup/older-database.test.ts › restores the replica onto a volume whose database was deleted after it replicated another prefix further, and replicates its writes`.

### `instance/replica-not-older`

Where the server runs in the image `deploy/Dockerfile` builds with `S3_BUCKET` set and `MARFA_REPLACE_NEWER_REPLICA` not true, if it starts on a volume that already holds a database while its own `<S3_PREFIX>/db/` holds a replica, and Litestream's record on the volume is missing, or the `marfa.db-replica` file beside the database names another endpoint, bucket or prefix than that replica's or cannot be read, or the record ends before that replica's newest transaction, or the write-ahead log beside the database neither continues from the log position after the record's newest transaction nor has moved on to the log's next generation while the database file does not hold every page of that transaction, then the server MUST leave that replica unchanged.

**Reason:** such a database may be older than the replica. Replicating it would make it the replica's newest state, and the writes after it would remain only in the replica's history, which expires. Transaction numbers count within one replica's history, so a record is compared only with the replica the entrypoint names beside it when it starts replicating. A record with no such file, from a volume an earlier image replicated, is taken to be of the current replica, so that the volume still starts; a record of another replica is therefore not caught on that volume's first start. The log is read before the database file, so an older database file put in place beside the volume's own `marfa.db-wal`, which still continues from the recorded position, passes; `deploy/README.md` says to delete that log before restoring a copy. It also says how to start an older database under a new prefix, or to replace the replica on purpose.

**Tests:** `backup/older-database.test.ts › refuses a volume copied before the replica's newest transaction, and leaves the bucket unchanged`, `› refuses an older database copied without Litestream's record, and leaves the bucket unchanged`, `› refuses an older database put in place of the one the volume replicated, and leaves the bucket unchanged`, `› refuses an older copy that replicated under another prefix until its record passed this replica, and leaves the bucket unchanged`.

### `instance/replica-other-prefix`

Where two instances run in the image `deploy/Dockerfile` builds with the same `S3_BUCKET` and `S3_PREFIX` values that differ as the settings table reads them, the server MUST NOT read or write the other instance's database replica.

**Reason:** a second instance on the bucket, such as a trial instance or the new build during an upgrade, must never start on the first instance's data or stream over its backup.

**Tests:** `backup/replica-paths.test.ts › keeps the replicas of two instances on one bucket apart, and each fresh volume restores only its own`.

### `instance/image-starts`

When the server starts on an image of its data directory taken at any one instant, the server MUST open the database and answer `GET /health` with `200`.

**Reason:** a volume snapshot, an APFS snapshot (so Time Machine) and a host's disk snapshot each take an image at one instant, and a crash leaves one.

**Tests:** `compliance/backup-restore.test.ts › answers every write the instance had acknowledged before the copy began, and every blob they name`, `compliance/instance-lifecycle.test.ts › answers every write acknowledged before the process was killed, and every blob they name`.

### `instance/image-keeps-writes`

When the server starts on an image of its data directory taken at any one instant, the server MUST answer every write it had acknowledged before that instant.

**Tests:** `compliance/backup-restore.test.ts › answers every write the instance had acknowledged before the copy began, and every blob they name`, `compliance/instance-lifecycle.test.ts › answers every write acknowledged before the process was killed, and every blob they name`.

### `instance/image-keeps-blobs`

When the server starts on an image of its data directory taken at any one instant, the server MUST serve every blob that a write acknowledged before that instant names, with the bytes that were uploaded.

**Reason:** the server makes a blob's bytes and name durable before it acknowledges the upload, so an image at any instant never holds a row that names a blob whose file is missing or empty.

**Tests:** `compliance/backup-restore.test.ts › answers every write the instance had acknowledged before the copy began, and every blob they name`, `compliance/instance-lifecycle.test.ts › answers every write acknowledged before the process was killed, and every blob they name`.

### `instance/stop-writes-into-file`

When the server is stopped on `SIGTERM` or `SIGINT` while no other process holds a read transaction on the database, the server MUST leave every write it acknowledged in the database file itself, so that the file holds them without the log beside it.

**Reason:** an owner who stops the instance and copies the data directory must not lose the writes the log still held.

**Tests:** `compliance/instance-lifecycle.test.ts › moves every acknowledged write into the database file when stopped on %s`.

### `instance/stop-reader-keeps-writes`

While another process holds a read transaction on the database, when the server is stopped on `SIGTERM` or `SIGINT`, the server MUST keep every write it acknowledged, in the file or in the log beside it, so that the next start answers it.

**Reason:** a process that holds a read transaction, such as a replicator, can keep the log from being moved into the file, and the next start applies the log as it always does.

**Tests:** `compliance/instance-lifecycle.test.ts › leaves the writes in the log while another connection holds a snapshot, and the next start answers every one of them`.

### `instance/copy-under-reader`

When the server starts on a copy of the data directory that read the database file, then the log, then the blobs, one after another, while a read transaction on the database was held from before the first read until after the last, the server MUST open the copy and answer every write it had acknowledged before that transaction began.

**Reason:** a copy that reads the files one after another with no such transaction can take the database file before a checkpoint and the log after it, and so hold a database that is not whole. The blobs are read last so that every blob a copied row names is in the copy.

**Tests:** `compliance/instance-lifecycle.test.ts › restores every write acknowledged before the first read from a copy taken file by file under a held read transaction, and loses writes from the same copy without one`.

### `instance/salt-refuses-credentials`

When the server starts on a data directory with an `API_KEY_SALT` other than the one its keys were minted under, the server MUST answer `401 unauthorized` to a request that carries an ordinary key or an app's access token, minted under the original salt.

**Reason:** the database holds a hash of each key, made with the salt, and the salt is a setting outside the data directory. A restore without it has every row and no credential that opens one.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses the working key, the management key and an app's access token with 401 unauthorized, and accepts all three again under the original salt`, `compliance/backup-restore.test.ts › refuses a key it holds when started with a different API_KEY_SALT`.

### `instance/salt-original-accepted`

When the server starts again under the `API_KEY_SALT` that an ordinary key or an app's access token was minted under, the server MUST accept that credential as it did before a start under another salt refused it.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses the working key, the management key and an app's access token with 401 unauthorized, and accepts all three again under the original salt`.

### `instance/salt-no-setup-proof`

When the server starts on a claimed database, under an `API_KEY_SALT` other than the one its keys were minted under, the server MUST NOT print a setup code.

**Reason:** the completed claim is independent of key hashes, so an incorrect salt cannot reopen setup.

**Tests:** `compliance/instance-lifecycle.test.ts › keeps the completed claim and offers no setup code or unauthenticated key mint under another API_KEY_SALT`.

### `instance/salt-no-unauthenticated-mint`

When the server starts on a claimed database, under an `API_KEY_SALT` other than the one its keys were minted under, and a request that carries no credential sends `POST /keys`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/instance-lifecycle.test.ts › keeps the completed claim and offers no setup code or unauthenticated key mint under another API_KEY_SALT`.

### `instance/claim-survives-missing-credentials`

When owner account rows or ordinary key rows disappear from a claimed database, the server MUST retain the completed claim after restart.

**Reason:** Missing credentials do not establish authority to replace the owner.

**Tests:** `compliance/instance-lifecycle.test.ts › does not reopen setup after deleting %s rows`.

### `instance/claim-missing-owner-recovery`

When a claimed instance's owner account is missing, the server MUST refuse local password recovery with `404 owner_not_found`.

**Tests:** `compliance/instance-lifecycle.test.ts › does not reopen setup after deleting %s rows`.

## Health

`GET /health` answers without a credential (`keys-and-oauth/health-open`). It reports four components, each probed on its own, and an overall `status`.

### `instance/health-components`

When `GET /health` is answered, the server MUST name in `components` exactly four components, `database`, `database_write`, `disk` and `blob_storage`.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`, `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`.

### `instance/health-component-status`

When `GET /health` is answered, the server MUST answer each component's `status` as `ok`, `degraded` or `down`.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`, `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`, `› answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-overall`

When `GET /health` is answered, the server MUST answer the overall `status` as `down` when any component is `down`, otherwise as `degraded` when any component is `degraded`, otherwise as `ok`.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`, `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`, `› answers 503 with the database write down when the database refuses a write, and 200 once it takes one`, `› answers 503 with blob storage down when the disk store refuses, and 200 once it answers`, `› answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-down-503`

When any component is `down`, the server MUST answer `GET /health` with `503`.

**Reason:** a container's health check and a deploy gate read the status code, and an instance whose database, disk or blob folder refuses is not serving.

**Tests:** `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`, `› answers 503 with the database write down when the database refuses a write, and 200 once it takes one`, `› answers 503 with blob storage down when the disk store refuses, and 200 once it answers`.

### `instance/health-not-down-200`

When no component is `down`, the server MUST answer `GET /health` with `200`, whether the overall `status` is `ok` or `degraded`.

**Reason:** a `degraded` instance is still serving.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`, `compliance/health.test.ts › answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-database-down`

If the database refuses a read of the table of keys, then the server MUST answer the `database` component of `GET /health` as `down`.

**Tests:** `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`.

### `instance/health-write-down`

If the database refuses the write that the `database_write` probe makes, with any code other than `write_contention`, then the server MUST answer the `database_write` component of `GET /health` as `down`.

**Reason:** a database that reads can still refuse every write, because the volume is read-only or full, and only a committed write shows it.

**Tests:** `compliance/health.test.ts › answers 503 with the database write down when the database refuses a write, and 200 once it takes one`.

### `instance/health-blob-down`

If the disk store refuses to look for a blob, or its folder or its `.marfa-store` marker is missing, then the server MUST answer the `blob_storage` component of `GET /health` as `down`.

**Reason:** a store that cannot be reached is not healthy because it holds no blob: every name is absent from a folder that is gone.

**Tests:** `compliance/health.test.ts › answers 503 with blob storage down when the disk store refuses, and 200 once it answers`, `› answers the disk component degraded, never down, and blob storage down, when the blob folder is gone, and ok once it returns`.

### `instance/health-contention-degraded`

If the write that the `database_write` probe makes is refused with `write_contention`, then the server MUST answer the `database_write` component as `degraded`, not `down`.

**Reason:** a lock held past the busy budget is a busy instance rather than a broken one. An archive restore holds it until it commits (`search-and-filters/restore-writers-wait`).

**Tests:** `compliance/health.test.ts › answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-timeout-degraded`

If a component's probe has given no answer within two seconds, then the server MUST answer that component as `degraded`.

**Reason:** a refusal is known and a silence is not.

**Tests:** `compliance/health.test.ts › answers the write component degraded and the status 200 when the probe has given no answer within two seconds, and ok once the lock is released`.

### `instance/health-disk-down`

If the bytes available on the database's volume and on the disk store's volume can both be read, and the lesser of the two is below 1 MiB, then the server MUST answer the `disk` component of `GET /health` as `down`.

**Tests:** `compliance/disk-space-faults.test.ts › answers the disk component down, and the status 503, when the lesser of the two volumes has under 1 MiB`.

### `instance/health-disk-degraded`

If the bytes available on the database's volume and on the disk store's volume can both be read, and the lesser of the two is below 64 MiB and at least 1 MiB, then the server MUST answer the `disk` component of `GET /health` as `degraded`.

**Tests:** `compliance/disk-space-faults.test.ts › answers the disk component degraded, and the status 200, when the lesser of the two volumes has 1 MiB or more and under 64 MiB`.

### `instance/health-disk-unknown`

If the bytes available on either the database's volume or the disk store's volume cannot be read, then the server MUST answer the `disk` component of `GET /health` as `degraded`, never `down`.

**Reason:** only a measured shortage is a failure.

**Tests:** `compliance/health.test.ts › answers the disk component degraded, never down, and blob storage down, when the blob folder is gone, and ok once it returns`.

### `instance/health-write-reuse`

When `GET /health` is called while an attempt of the `database_write` probe's write is in progress, or less than ten seconds after the last attempt finished, the server MUST answer the `database_write` component with the outcome of that attempt, a refusal included.

**Reason:** the operation takes no credential, so what a caller can make the server do through it stays small.

**Tests:** `compliance/health.test.ts › answers the calls within ten seconds of its last write with that write's outcome, and writes again after`.

### `instance/health-write-once`

The server MUST commit the write of the `database_write` probe at most once in ten seconds, however many callers ask.

**Tests:** `compliance/health.test.ts › commits its write once in ten seconds however many callers ask`.

### `instance/health-write-again`

When `GET /health` is called while no attempt of the `database_write` probe's write is in progress, ten seconds or more after the last attempt finished, the server MUST attempt the write again.

**Tests:** `compliance/health.test.ts › answers the calls within ten seconds of its last write with that write's outcome, and writes again after`.

### `instance/health-error-authorized`

While a component is `degraded` or `down` and the database can read the table of keys, when a credential holding `instance.read` sends `GET /health`, the server MUST answer that component with an `error` that says why.

**Tests:** `compliance/health.test.ts › is given to a key with instance.read and withheld without that permission`.

### `instance/health-error-others`

When a request without direct owner/local authority or `instance.read` sends `GET /health`, the server MUST NOT answer an `error` on any component.

**Reason:** the text is the database's or the operating system's own and carries paths and driver detail.

**Tests:** `compliance/health.test.ts › is given to a key with instance.read and withheld without that permission`.

### `instance/health-error-key-table`

While the database cannot read the table of keys, the server MUST NOT answer an `error` on any component of `GET /health` to a request bearing an ordinary key that cannot be verified.

**Reason:** a bearer credential that the server cannot verify is not given the text.

**Tests:** `compliance/health.test.ts › is withheld from bearer credentials while the database cannot look keys up`.

### `instance/health-unknown-key`

When a request that carries a credential the instance does not hold sends `GET /health`, the server MUST answer it as it answers a request that carries no credential.

**Tests:** `compliance/instance.test.ts › answers /health to a request that names a key the instance does not hold as it does to one that names none`, `compliance/health.test.ts › is given to a key with instance.read and withheld without that permission`.

## Upgrading

Until the first public release nothing upgrades a database in place (`search-and-filters/restore-version`). If a database has an incompatible declared schema, a retired registry table or a retired setting, the server refuses to start and tells the owner why before changing the database file.

### `instance/upgrade-refuses-retired-tables`

If the server starts on a database that holds the retired registry table `custom_types` or `custom_edge_types`, whether or not it also lacks tables, then the server MUST refuse to start.

**Reason:** this build holds the type registry in a place of its own and upgrades nothing in place, so a file that still holds the retired registry is carried forward by an archive.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table, holds no rows and holds the retired custom_types table`.

### `instance/upgrade-refuses-retired-setting`

If the server starts on a database that holds the retired setting `space_config`, whether or not it also lacks tables, then the server MUST refuse to start.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds the retired space_config setting`.

### `instance/upgrade-refuses-schema`

If the server starts on a database in which a table, an index or a trigger the server declares differs from the server's definition of it, a table the server declares carries an index or a trigger the server does not declare, or a table the server declares is missing while another of its own tables holds a row, then the server MUST refuse to start.

**Reason:** an index over a missing column fails with a driver error after the file's header has been rewritten, and a missing column fails nowhere until a request meets it, so the refusal is made before either. A database that lacks tables and holds no row is completed under `instance/unfinished-completed`.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`.

### `instance/upgrade-names-cause`

When the server refuses to start on a database under `instance/upgrade-refuses-retired-tables`, `instance/upgrade-refuses-retired-setting` or `instance/upgrade-refuses-schema`, the server MUST name in its log message what it found and the path of the database file.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`.

### `instance/upgrade-leaves-file`

If the server refuses to start on a database under `instance/upgrade-refuses-retired-tables`, `instance/upgrade-refuses-retired-setting` or `instance/upgrade-refuses-schema`, then the server MUST leave the database file byte for byte as it found it.

**Reason:** SQLite may create an empty `-wal` file and a `-shm` file beside a database it opens and then refuses, and neither holds anything the database holds.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`, `› refuses a database that lacks a table, holds no rows and holds the retired custom_types table`, `› refuses a database that lacks a table and holds the retired space_config setting`.

### `instance/upgrade-opens-no-port`

If the server refuses to start on a database under `instance/upgrade-refuses-retired-tables`, `instance/upgrade-refuses-retired-setting` or `instance/upgrade-refuses-schema`, then the server MUST NOT listen on its port.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`.

### `instance/upgrade-way-forward`

When the server refuses to start on a database under `instance/upgrade-refuses-retired-tables`, `instance/upgrade-refuses-retired-setting` or `instance/upgrade-refuses-schema`, the server MUST say in its log message that the way forward is to export with the build that wrote the file, start on a fresh file and restore the archive there.

**Reason:** an owner told only that the file was refused goes looking for the cause in the wrong place.

**Tests:** `compliance/instance-lifecycle.test.ts › says in its refusal to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse`, `› refuses a database that lacks a table and holds the retired space_config setting`.

### `instance/upgrade-restore-may-refuse`

When the server refuses to start on a database under `instance/upgrade-refuses-retired-tables`, `instance/upgrade-refuses-retired-setting` or `instance/upgrade-refuses-schema`, the server MUST say in its log message that the restore it names can refuse an archive the writing build did not write.

**Reason:** the message does not promise a restore the contract does not.

**Tests:** `compliance/instance-lifecycle.test.ts › says in its refusal to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse`.

### `instance/upgrade-exit-78`

If the server refuses to start on a database under `instance/upgrade-refuses-retired-tables`, `instance/upgrade-refuses-retired-setting` or `instance/upgrade-refuses-schema`, then the server MUST exit with status 78.

**Reason:** what supervises the process tells a stop that starting again will not mend from one that it may.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 78, not 1, when it refuses a database under the contract's upgrade rule`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`, `› refuses a database that lacks a table, holds no rows and holds the retired custom_types table`, `› refuses a database that lacks a table and holds the retired space_config setting`.

### `instance/upgrade-exit-1`

If the server stops for a failure to start that is not a refused database, then the server MUST exit with status 1.

**Reason:** a failed start that starting again may mend, such as a port in use, is not told apart from a refused database by anything but the status.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 1, not 78, when the database file is not a database at all`, `› exits with status 1, not 78, when the port it was given is already taken`.

## Stopping

An instance is stopped by `SIGTERM` or `SIGINT`, and a container runtime follows `SIGTERM` with `SIGKILL` after ten seconds by default.

### `instance/stop-ends-streams`

When the server is stopped, the server MUST end each event stream it has open with a terminal `stream_incomplete` frame.

**Reason:** a stream never ends of its own accord, so the server's close would wait on it until the bound ran out and the stop would end as a failure, and a client cut off with no closing frame cannot tell a stop from a fault. `events/incomplete-cursor` holds the frame.

**Tests:** `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`, `› names the last event the stream sent as the cursor of its closing frame`.

### `instance/stop-ends-copy-stream`

When the server is stopped, the server MUST end an open copy stream, `GET /events?edges=all&copy=1`, with a terminal `stream_incomplete` frame.

**Tests:** `compliance/stream-shutdown.test.ts › ends an open copy stream with stream_incomplete when the server is stopped, and exits with status 0`.

### `instance/stop-ends-late-stream`

When the server is stopped, the server MUST answer an event stream that is opened after the stop has begun with a terminal `stream_incomplete` frame.

**Tests:** `compliance/stream-late-stop.test.ts › is answered with stream_incomplete and server_stopping, and closed`, `› is answered the same way when it is a copy stream`.

### `instance/stop-stream-reason`

When the server ends an event stream because it is stopped, the server MUST give the `stream_incomplete` frame the `reason` `server_stopping`.

**Tests:** `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`, `› names the last event the stream sent as the cursor of its closing frame`.

### `instance/stop-stream-cursor`

When the server ends an event stream because it is stopped, the server MUST give the `stream_incomplete` frame the id of the last event the stream sent as its `cursor`, or `null` when the stream sent none.

**Reason:** every event after the cursor is still in the log, so the client's recovery is the same as for any other `stream_incomplete`: connect again from it.

**Tests:** `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`, `› names the last event the stream sent as the cursor of its closing frame`.

### `instance/stop-frame-no-id`

When the server ends an event stream because it is stopped, the server MUST NOT give the `stream_incomplete` frame an `id:`.

**Tests:** `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`, `› names the last event the stream sent as the cursor of its closing frame`.

### `instance/stop-closes-stream`

When the server has sent the `stream_incomplete` frame on a stream because it is stopped, the server MUST close the stream.

**Tests:** `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `instance/stop-waits-for-work`

When the server is stopped, the server MUST let the bulk action and the housekeeping runs in flight, the webhook deliveries among them, finish before it closes its storage, unless a run outlives the stop's wait for it.

**Reason:** a run cut off mid-write leaves its record unwritten.

**Tests:** `compliance/stop-waits-for-work.test.ts › lets the bulk action and the housekeeping run finish before the storage closes, and exits 0`, `compliance/stop-webhook.test.ts › records a webhook delivery released by shutdown before closing storage`.

### `instance/stop-exit-0`

When the server is stopped on `SIGTERM` or `SIGINT` and the server and its storage have closed, the server MUST exit with status 0.

**Reason:** a stop that the runtime kills is read as a crash.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 0 within eight seconds when stopped on %s`, `› exits with status 0 within eight seconds when stopped with an event stream open`.

### `instance/stop-within-eight`

When the server is stopped on `SIGTERM` or `SIGINT`, the server MUST exit within eight seconds of the signal.

**Reason:** the grace a container runtime gives a stopped process is ten seconds by default, and eight leaves two for the runtime.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 0 within eight seconds when stopped on %s`, `› exits with status 0 within eight seconds when stopped with an event stream open`, `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `instance/stop-exit-1-open-request`

If a request that was open at the signal is still open when the server's wait for requests ends, then the server MUST exit with status 1.

**Reason:** a request that never ends cannot be waited for, so the stop is a failure the supervisor can see.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 1, not 0, when a request in flight is still open at the end of the stop's wait`.

### `instance/stop-slow-run-exit-0`

If a bulk action or a housekeeping run outlives the stop's wait for it while the server and its storage close within theirs, then the server MUST exit with status 0.

**Reason:** the run is resumed at the next start, so it does not make the stop a failure.

**Tests:** `compliance/bulk-job-long.test.ts › exits 0 when a run outlives the stop's wait, and the job is finished once, on the return`, `compliance/stop-webhook.test.ts › exits 0 when an unanswered webhook keeps housekeeping past the stop wait`.

## Long jobs

### `instance/long-job-health`

While the server runs an archive export, an archive restore, an NDJSON export, a bulk action, the blob orphan sweep, version thinning or the retirement of inactive grants, the server MUST answer `GET /health` in a time that does not grow with the number of items the job covers.

**Reason:** the database driver runs each statement synchronously behind a promise, so a job that never hands the process to other requests stops every request, `/health` included, for as long as it runs, and a container whose health check waits five seconds restarts a server that is working. A restore also holds the write lock, which makes the write probe `degraded` and is not a held process.

**Tests:** waiting on #2069.

## The root in a browser

The one address answers a page or the description by what the caller asks for in `Accept`.

### `instance/root-page`

When the server does not refuse `GET /` and the request carries an `Accept` that names `text/html` and either does not name `application/json` or names it after `text/html`, the server MUST answer `200` with an HTML page.

**Reason:** a person who opens the server's address in a browser was handed the instance's description as raw JSON, with nothing in it to read and nothing to do next.

**Tests:** `compliance/instance.test.ts › answers a browser at the root with a page and a program with the JSON`, `› answers a page when text/html comes before application/json, and the description when it comes after or when the request names neither`.

### `instance/root-description`

When the server does not refuse `GET /` and the request carries no `Accept`, or an `Accept` that does not name `text/html`, or one that names `application/json` before `text/html`, the server MUST answer `200` with the description.

**Reason:** a program asking for the description must never be handed a page, and `*/*`, which is what a program sends by default, is the description.

**Tests:** `compliance/instance.test.ts › answers a browser at the root with a page and a program with the JSON`, `› answers a page when text/html comes before application/json, and the description when it comes after or when the request names neither`.

### `instance/root-vary`

The server MUST send a `Vary` header that names `Accept` on every answer to `GET /` and `HEAD /`, a refusal included.

**Reason:** the one address answers a page or the description by what the caller asks for, and a cache must not hand one the other's, nor a refusal to a caller it was not meant for.

**Tests:** `compliance/instance.test.ts › answers a browser at the root with a page and a program with the JSON`, `› sends Vary: Accept on a refusal at the root as on the answers it varies`.

### `instance/root-home`

When the owner's browser session requests `GET /` and the request is one `instance/root-page` answers with a page, the server MUST answer a page headed by the instance's name.

**Reason:** the owner who opens the server's address needs the way into every console page, not the notice a visitor is given.

**Tests:** `compliance/console-pages.test.ts › is shown to the owner's browser, headed by the instance's name`.

### `instance/root-home-search`

When the owner's browser session requests `GET /` and the request is one `instance/root-page` answers with a page, the server MUST include in the page a search field named `q`.

**Reason:** the owner finds a page or a setting by name from Home, without knowing which page holds it.

**Tests:** `compliance/console-pages.test.ts › holds a search for pages and settings`.

### `instance/root-home-no-store`

The server MUST send `Cache-Control: no-store` on the page it answers to the owner's browser session at `GET /`.

**Reason:** the page is the owner's, and a cache must not hand it to a browser without the session.

**Tests:** `compliance/console-pages.test.ts › is not cached`.

### `instance/settings-owner-read`

When the owner's browser session sends `GET /auth/owner/settings.json`, the server MUST answer `200` with a `data` list that holds, for each setting in the table at the end of this chapter, an entry with its `name`, `label`, `group`, `description`, `secret`, `live` and `set`, and its `value` in words unless it holds a secret.

**Reason:** the console's All settings pages and its search read the settings from this one answer. `secret` is true for every setting that holds a credential, `live` is true for a setting the owner can also change while the server runs, and `set` says whether the environment states the setting. Nothing returns a secret's value (`authentication/console-settings-no-secret`).

**Tests:** `compliance/console-pages.test.ts › show the owner the log and every setting, and carry no secret's value`.

### `instance/root-search-key`

When the owner's browser session requests `GET /` for a page with the query key `q`, the server MUST NOT refuse `q` as undeclared.

**Reason:** the search on Home is a form that submits `q` to the root.

**Tests:** `compliance/console-pages.test.ts › takes a search from the owner's browser`.

### `instance/root-search-key-other`

If a request to `GET /` that is not the owner's browser session asking for a page carries the query key `q`, then the server MUST refuse `q` as `search-and-filters/undeclared-key` refuses an undeclared key.

**Reason:** the root declares no query key to a program, and `q` belongs to the page it shows the owner alone.

**Tests:** `compliance/console-pages.test.ts › refuses a search from anybody else, and any other key from everybody`.

## Pages

The root is not the only page. The sign-in, consent and device approval pages are pages too, and so is what a refusal or an unserved path renders for a request that accepts `text/html`.

### `instance/page-policy`

When the server answers with an HTML page, a page a refusal renders and one given before any operation has run included, the server MUST send a `Content-Security-Policy`.

**Reason:** the sign-in, consent, device approval and error pages act on the owner's signed-in session, so a policy limits what an injection into one of them can do. A refusal renders a page like any other, so a refusal a middleware makes before any operation has run carries the policy too.

**Tests:** `compliance/instance.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `› sends the page policy on the page a refusal renders, and none on the refusal a program is sent`.

### `instance/page-policy-nonce-only`

The server MUST write the `Content-Security-Policy` of an HTML page so that it allows a script or a style only when it carries the nonce the policy names.

**Reason:** no script or style source is allowed by origin, `'self'` included, because the same origin serves a blob's bytes at its link without a credential and under the type its uploader named, and a source allowed by origin would run them. A blob's bytes are not a page of this server and keep the policy of `blobs/download-sandbox`.

**Tests:** `compliance/instance.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `› names in its policy the one nonce its page carries, a new one on each answer at one address`.

### `instance/page-policy-default-none`

The server MUST write the `Content-Security-Policy` of an HTML page with `default-src 'none'`.

**Tests:** `compliance/instance.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`.

### `instance/page-policy-json-none`

When the server answers the root or a refusal as JSON, the server MUST NOT send a `Content-Security-Policy` on it.

**Reason:** the policy is the page's, and a JSON answer is not a page.

**Tests:** `compliance/instance.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `› sends the page policy on the page a refusal renders, and none on the refusal a program is sent`.

### `instance/page-nonce-fresh`

The server MUST name in the `Content-Security-Policy` of each HTML page a nonce of its own, different from the nonce of every other page it answers.

**Reason:** a nonce that repeats across responses can be read from one page and carried by an injection into the next.

**Tests:** `compliance/instance.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `› sends the page policy on the page a refusal renders, and none on the refusal a program is sent`, `› names in its policy the one nonce its page carries, a new one on each answer at one address`.

### `instance/page-nonce-carried`

When the server answers with an HTML page, the server MUST carry in the page the nonce its own policy names, and no other.

**Reason:** a page that carries another nonce does not work under its policy.

**Tests:** `compliance/instance.test.ts › names in its policy the one nonce its page carries, a new one on each answer at one address`.

## An unfinished database

The server creates its tables one statement at a time, so a start that is stopped partway leaves a database with the first of them.

### `instance/unfinished-completed`

When the server starts on a database that holds some of its own tables, lacks the rest, differs from its schema in nothing else and holds neither `custom_types` nor `custom_edge_types`, and none of the tables it creates holds a row, the server MUST create the tables it lacks and start.

**Reason:** nothing is written to the server's own tables before the last is made, so none holds a row, and refusing the database would send an owner looking for another build when no other build wrote it.

**Tests:** `compliance/instance-lifecycle.test.ts › creates the tables it lacks and remains unclaimed until a real claim`.

### `instance/unfinished-ends-fresh`

When the server completes an unfinished database, the server MUST leave it holding what a new database holds, unclaimed, with no key, no item and an `instance_id` of its own.

**Tests:** `compliance/instance-lifecycle.test.ts › creates the tables it lacks and remains unclaimed until a real claim`.

### `instance/unfinished-foreign-ignored`

When the server starts on a database that holds some of its own tables, lacks the rest, differs from its schema in nothing else and holds neither `custom_types` nor `custom_edge_types`, and holds rows only in tables it does not create, the server MUST create the tables it lacks and start.

**Reason:** a table the server does not create, such as a replication sidecar's, may hold rows and does not count.

**Tests:** `compliance/instance-lifecycle.test.ts › does not count a row in a table it does not create, and leaves that table as it was`.

### `instance/unfinished-foreign-kept`

When the server completes an unfinished database, the server MUST leave the rows of a table it does not create as they were.

**Tests:** `compliance/instance-lifecycle.test.ts › does not count a row in a table it does not create, and leaves that table as it was`.

## The configuration operations

`GET /config`, `PUT /config` and `PATCH /config` hold the instance's display name, levers and live settings. What a lever does is `types/strict-mode`, `types/source-allowlist` and `types/source-filter`, and the bounds of a retention are `housekeeping/retention-days-range` and `housekeeping/retention-hours-range`. That `PUT /config` replaces the configuration whole is `types/config`, and the code a lever missing a member gets is `types/config-lever-missing-field`.

### `instance/config-name`

When `PUT /config` supplies `name`, the server MUST store it with whitespace at each end removed.

**Tests:** `compliance/instance-config.test.ts › sets, trims, persists and clears the name without changing identity`.

### `instance/config-name-invalid`

If a supplied `name` is empty after trimming, exceeds 200 Unicode code points after trimming, or contains a C0 control, DEL, C1 control or Unicode bidirectional control character, then the server MUST refuse `PUT /config` with `400 validation_error`.

**Tests:** `compliance/instance-config.test.ts › refuses invalid names and escapes the name in pages on later requests`.

### `instance/config-name-live`

When `PUT /config` has acknowledged a display name, the server MUST use that name in subsequent root descriptions and existing page labels that identify the instance, without requiring a restart.

**Tests:** `compliance/instance-config.test.ts › sets, trims, persists and clears the name without changing identity`, `› refuses invalid names and escapes the name in pages on later requests`.

### `instance/config-name-durable`

When the server restarts on the same database, the server MUST retain the configured display name.

**Tests:** `compliance/instance-config.test.ts › sets, trims, persists and clears the name without changing identity`.

### `instance/config-name-page-escaped`

When an HTML page identifies the instance by its display name, the server MUST render that name as text.

**Tests:** `compliance/instance-config.test.ts › refuses invalid names and escapes the name in pages on later requests`.

### `instance/config-unauthenticated`

If a request that carries no credential, or a credential the instance does not hold, sends `GET /config` or `PUT /config`, then the server MUST answer `401 unauthorized`, whatever a `PUT` body within the request cap holds.

**Tests:** `compliance/instance-config.test.ts › answers 401 unauthorized to both operations for no credential and for a key the instance does not hold`, `› asks for a credential, then config.manage, before it reads the body`.

### `instance/config-management-no-bypass`

If a credential holding `instance.read` but not `config.manage` sends `GET /config` or `PUT /config`, then the server MUST answer `403 forbidden` with `details.required_scope` `config.manage`.

**Reason:** `instance.read` does not imply configuration access; the general permission boundary is `types/config-permission`.

**Tests:** `compliance/instance-config.test.ts › refuses both operations without config.manage and serves them when it is granted`.

### `instance/config-permission-first`

If a key without `config.manage` sends `PUT /config` with a body within the request cap that is also wrong, then the server MUST answer `403 forbidden` rather than refuse the body.

**Tests:** `compliance/instance-config.test.ts › asks for a credential, then config.manage, before it reads the body`.

### `instance/config-takes-back-read`

When a key holding `config.manage` sends `PUT /config` with a body that is otherwise valid and carries the `instance_id` a `GET /config` answered, the server MUST answer `200`.

**Reason:** the use of an operation that replaces the whole is to read the configuration, change one lever and send it back, and an identity that the read hands over must not be refused as an unknown key.

**Tests:** `compliance/schema-enforcement.test.ts › takes a body back as read, and refuses one addressed elsewhere`, `compliance/instance-config.test.ts › leaves the identity the root answers as it was after any PUT, refused ones included`.

### `instance/config-wrong-identity`

If a key holding `config.manage` sends `PUT /config` with a body that is otherwise valid and names an `instance_id` other than the instance's own, then the server MUST answer `400 validation_error` with `details.errors[0].path` `instance_id`.

**Reason:** a backup script pointed at the wrong host must not be answered `200`.

**Tests:** `compliance/schema-enforcement.test.ts › takes a body back as read, and refuses one addressed elsewhere`, `compliance/instance-config.test.ts › reads the body's shape before the identity, so a body wrong in both is refused for its shape`.

### `instance/config-wrong-identity-keeps`

When the server refuses a `PUT /config` for an `instance_id` other than the instance's own, the server MUST keep the stored configuration as it was.

**Tests:** `compliance/schema-enforcement.test.ts › takes a body back as read, and refuses one addressed elsewhere`, `compliance/instance-config.test.ts › leaves the identity the root answers as it was after any PUT, refused ones included`.

### `instance/config-empty-identity`

If a key holding `config.manage` sends `PUT /config` with an `instance_id` that is the empty string, then the server MUST answer `400 validation_error` with `details.errors[0].path` `instance_id`, without the instance's own identity in the answer.

**Reason:** the refusal for an identity that names another instance says which instance this is, so an answer without it shows the body was refused for its shape.

**Tests:** `compliance/instance-config.test.ts › refuses an empty identity by the schema, naming instance_id`.

### `instance/config-shape-before-identity`

If a key holding `config.manage` sends `PUT /config` with a body that has a key the server does not know, a retention outside its range or a lever of the wrong shape, and names an `instance_id` other than the instance's own, then the server MUST answer `400 validation_error` for the body's shape, with no error naming `instance_id`.

**Tests:** `compliance/instance-config.test.ts › reads the body's shape before the identity, so a body wrong in both is refused for its shape`.

### `instance/config-missing-field-before-identity`

If a key holding `config.manage` sends `PUT /config` with a lever that lacks a member it requires and an `instance_id` other than the instance's own, then the server MUST answer `400 missing_required_field` with `details.field` naming the member's path.

**Tests:** `compliance/instance-config.test.ts › names a lever's missing field before the identity too`.

### `instance/config-unknown-key-path`

If a key holding `config.manage` sends `PUT /config` with a key at the top level of the body that the server does not know, then the server MUST answer `400 validation_error` naming the key in `details.unknown_body_fields`.

**Reason:** a key one letter wrong, such as `trash_retention_day`, must not be dropped while the answer is `200`, because that would erase every override the instance held.

**Tests:** `compliance/schema-enforcement.test.ts › refuses a configuration key it does not know, and keeps the configuration`, `compliance/instance-config.test.ts › reads the body's shape before the identity, so a body wrong in both is refused for its shape`.

### `instance/config-clear-keeps-identity`

When a key holding `config.manage` sends `PUT /config` with `{}`, the server MUST go on answering the instance's `instance_id` at `GET /config`.

**Reason:** the identity is not configuration, so the clear does not remove it.

**Tests:** `compliance/schema-enforcement.test.ts › PUT replaces the configuration wholesale and GET reads it back`, `compliance/instance-config.test.ts › reads back each setting that has been set, and no field for one that has not`.

### `instance/config-read-set`

When a key holding `config.manage` sends `GET /config`, the server MUST answer each setting that has been set with the value last written, the five retention fields and `enforcement` with its three levers among them.

**Tests:** `compliance/instance-config.test.ts › reads back each setting that has been set, and no field for one that has not`.

### `instance/config-read-unset-absent`

When a key holding `config.manage` sends `GET /config`, the server MUST leave out the field of each setting that has not been set.

**Reason:** an instance that has set nothing answers its `instance_id` alone.

**Tests:** `compliance/instance-config.test.ts › reads back each setting that has been set, and no field for one that has not`.

### `instance/config-omitted-removed`

When a key holding `config.manage` sends `PUT /config` with a body that leaves out a setting an earlier `PUT` set, the server MUST remove that setting, so that `GET /config` answers no field for it.

**Reason:** a setting left out goes back to its default.

**Tests:** `compliance/instance-config.test.ts › takes away each setting a later PUT leaves out`.

### `instance/config-patch-merges`

When a key holding `config.manage` sends `PATCH /config`, the server MUST set each setting the body names to the value sent, leave every setting the body does not name as it was, and answer the configuration as stored beside the instance's identity.

**Reason:** `PUT /config` replaces the whole, so two callers that each read the configuration, change one setting and send it back undo each other. A patch names only what it changes.

**Tests:** `compliance/instance-config.test.ts › changes only the settings a PATCH names, so a second caller's change is not undone`.

### `instance/config-patch-clears`

When a key holding `config.manage` sends `PATCH /config` with a setting set to `null`, the server MUST remove that setting, so that `GET /config` answers no field for it and leaves the other settings as they were.

**Tests:** `compliance/instance-config.test.ts › changes only the settings a PATCH names, so a second caller's change is not undone`.

### `instance/config-patch-refused`

If a key holding `config.manage` sends `PATCH /config` with a key the server does not know, a retention outside its range or an `instance_id` other than the instance's own, then the server MUST answer `400 validation_error` and keep the stored configuration.

**Tests:** `compliance/instance-config.test.ts › refuses a PATCH it would refuse as a PUT, and keeps the configuration`.

### `instance/config-audit`

When the server accepts `PUT /config`, the server MUST record an audit entry with the `action` `config.update`, the `resource_type` `config` and the `key_id` of the key that wrote.

**Tests:** `compliance/instance-config.test.ts › records a config.update audit entry for the key that wrote, and none for a refused write`.

### `instance/config-refused-no-audit`

When the server refuses `PUT /config`, the server MUST NOT record a `config.update` audit entry.

**Reason:** a refused body wrote nothing, so there is nothing to record.

**Tests:** `compliance/instance-config.test.ts › records a config.update audit entry for the key that wrote, and none for a refused write`.

### `instance/config-query-key`

If a key holding `config.manage` sends `GET /config` or `PUT /config` with a query key, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/instance-config.test.ts › refuses a query key on both operations`.

### `instance/config-query-key-order`

If a request to `GET /config` or `PUT /config` carries a query key, then the server MUST answer `401 unauthorized` to no credential or one it does not hold, and `403 forbidden` to a credential without `config.manage`, before it refuses the query key.

**Tests:** `compliance/instance-config.test.ts › asks for a credential, then config.manage, before it reads the query, so a query key is refused 401, then 403, then 400`.

### `instance/config-cap-refused`

If a key holding `config.manage` sends `PUT /config` with a body larger than the request cap, then the server MUST answer `413 request_too_large`.

**Reason:** no setting bounds its own size, so the lists in a lever are held only by the cap on the body, which is 1048576 bytes unless `MARFA_MAX_REQUEST_BYTES` sets another.

**Tests:** `compliance/instance-config.test.ts › refuses a body past the request cap with 413 request_too_large, and keeps the configuration`.

### `instance/config-cap-keeps`

When the server refuses a `PUT /config` for a body larger than the request cap, the server MUST keep the stored configuration as it was.

**Tests:** `compliance/instance-config.test.ts › refuses a body past the request cap with 413 request_too_large, and keeps the configuration`.

### `instance/config-at-cap-accepted`

When a key holding `config.manage` sends `PUT /config` with an otherwise valid body of exactly the request cap, the server MUST accept it.

**Tests:** `compliance/instance-config.test.ts › refuses a body past the request cap with 413 request_too_large, and keeps the configuration`.

## Private control socket at boot

### `instance/control-stale-restart`

When the configured private control socket path holds a socket that refuses connections, the server MUST replace that socket and start its private control listener.

**Tests:** `compliance/control-socket.test.ts › starts on the same control socket after SIGKILL`.

### `instance/control-live-refused`

When another listener accepts connections at the configured private control socket path, the server MUST refuse to start without disrupting that listener.

**Tests:** `compliance/control-socket.test.ts › refuses a live control socket and preserves its listener`.

### `instance/control-start-concurrent`

When multiple processes concurrently start their private control listeners on the same stale socket path, the server MUST allow at most one process to start successfully.

**Tests:** `compliance/control-socket.test.ts › allows only one concurrent restart on a stale control socket`.

### `instance/control-close-excludes-start`

While another process is closing its private control listener at the configured socket path, the server MUST refuse to start its own private control listener at that path until the closing process finishes its socket cleanup.

**Tests:** `compliance/control-socket.test.ts › refuses startup until a closing listener has finished its socket cleanup`.

### `instance/control-nonsocket-refused`

When the configured private control socket path holds a file that is not a socket, the server MUST refuse to start without removing that file.

**Tests:** `compliance/control-socket.test.ts › refuses a non-socket control path and preserves its contents`.

## Test hooks

A test hook is a route on the private control socket that moves the server's clock or sets a fault, or a setting that starts the server at another time or contract version. The conformance harness drives them through the target interface (`conformance/README.md`, "Target interface"). They exist only to test the server, so each rule here keeps them out of an instance that holds data.

### `instance/test-hooks-off`

While `MARFA_TEST_HOOKS` is not true, the server MUST NOT serve a test hook on any listener.

**Reason:** a test hook can move the clock and hold a housekeeping job, which an instance that holds data must never allow.

**Tests:** `compliance/test-hooks.test.ts › serves no test hook on any listener while MARFA_TEST_HOOKS is not true`.

### `instance/test-hooks-http`

The server MUST NOT serve a test hook on its HTTP listener, whatever `MARFA_TEST_HOOKS` holds.

**Tests:** `compliance/test-hooks.test.ts › serves no test hook on the HTTP listener, even with MARFA_TEST_HOOKS true`.

### `instance/test-hooks-production-refused`

If `MARFA_TEST_HOOKS` is true and `NODE_ENV` is `production` when the server starts, then the server MUST refuse to start and name `MARFA_TEST_HOOKS`.

**Tests:** `compliance/test-hooks.test.ts › refuses to start in production with MARFA_TEST_HOOKS true, naming the setting`.

### `instance/test-clock-offset-needs-hooks`

If `MARFA_TEST_CLOCK_OFFSET_MS` is greater than 0 and `MARFA_TEST_HOOKS` is not true when the server starts, then the server MUST refuse to start and name `MARFA_TEST_CLOCK_OFFSET_MS`.

**Tests:** `compliance/test-hooks.test.ts › refuses a clock offset without MARFA_TEST_HOOKS, naming the setting`.

### `instance/test-clock-offset`

Where `MARFA_TEST_CLOCK_OFFSET_MS` is set, the server MUST read the time as that many milliseconds later than the system clock.

**Tests:** `compliance/test-hooks.test.ts › reads the time as MARFA_TEST_CLOCK_OFFSET_MS later than the system clock`.

### `instance/test-clock-sign-in`

While `MARFA_TEST_HOOKS` is true, the server MUST stamp the sign-in library's persisted session and credential times with the time the server reads.

**Reason:** A session, a sign-in token and an authorization link carry a time the server later compares with its clock. If the library kept the system's, moving the clock would put the two out of step.

**Tests:** `compliance/test-hooks.test.ts › stamps a sign-in with the time the server reads`.

### `instance/test-clock-forward`

If the clock is asked to move back, then the server MUST refuse and keep the time it reads.

**Reason:** ids, versions and cursors assume time does not go back.

**Tests:** `compliance/test-hooks.test.ts › refuses to move the clock back, and keeps the time it reads`.

### `instance/test-contract-version-needs-hooks`

If `MARFA_TEST_CONTRACT_VERSION` is set and `MARFA_TEST_HOOKS` is not true when the server starts, then the server MUST refuse to start and name `MARFA_TEST_CONTRACT_VERSION`.

**Tests:** `compliance/test-hooks.test.ts › refuses a contract version without MARFA_TEST_HOOKS, naming the setting`.

### `instance/test-contract-version`

Where `MARFA_TEST_CONTRACT_VERSION` is set, the server MUST name that version as the root's `contract`, in `X-Marfa-Contract` and as the document's `info.version`.

**Reason:** A harness shows what a change of contract does to what the server kept, such as a stored answer to a repeated request, by restarting the server onto the next version.

**Tests:** `compliance/test-hooks.test.ts › names MARFA_TEST_CONTRACT_VERSION as the contract in the root, the header and the document`.

### `instance/test-faults-cleared-at-start`

When the server starts, the server MUST hold no fault.

**Tests:** `compliance/test-hooks.test.ts › holds no fault after a restart`, `compliance/write-faults.test.ts › does not outlive it: the write it was aimed at lands, and the fault is not listed`.

## Telemetry

Telemetry is on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and these rules hold where it is.

### `instance/telemetry-instance-id`

Where telemetry is on, the server MUST carry the instance's `instance_id` as the resource attribute `service.instance.id` of every log record and span it exports, unless `OTEL_RESOURCE_ATTRIBUTES` names `service.instance.id`, which stands in its place.

**Reason:** instances sending to one collector, such as an owner's, a demo and a test, cannot otherwise be told apart. The id is the one the root answers, so an operator finds the instance an export came from by it. The instance's configured `name` is not carried, because it can change while the server runs and can be personal.

**Tests:** `compliance/telemetry-identity.test.ts › names the instance's id on every log record and span it exports`.

### `instance/telemetry-exception-id`

Where telemetry is on and exceptions go to error tracking, the server MUST carry the instance's `instance_id` as the property `service.instance.id` of every exception it sends once it has read its id, unless `OTEL_RESOURCE_ATTRIBUTES` names `service.instance.id`, which stands in its place.

**Reason:** the id is in the database, which opens after the server starts, so an exception captured before it opens goes unnamed.

**Tests:** `compliance/telemetry-identity.test.ts › names the instance and the environment in an exception and an error notification`.

### `instance/telemetry-attributes`

Where telemetry is on, the server MUST carry each attribute `OTEL_RESOURCE_ATTRIBUTES` names as a resource attribute of every log record and span it exports and as a property of every exception it sends, in place of its own attribute of the same name.

**Reason:** the operator is the one who knows what the instance is for, and the standard variable is how an instance marks itself apart, as `deployment.environment=staging` does.

**Tests:** `compliance/telemetry-identity.test.ts › names the attributes and the service name the operator set, in place of its own`, `› names the instance and the environment in an exception and an error notification`.

### `instance/telemetry-service-name`

Where telemetry is on and `OTEL_SERVICE_NAME` is set, the server MUST carry it as the resource attribute `service.name`, whatever `OTEL_RESOURCE_ATTRIBUTES` names.

**Tests:** `compliance/telemetry-identity.test.ts › names the attributes and the service name the operator set, in place of its own`.

### `instance/telemetry-error-environment`

Where `ERROR_WEBHOOK_URL` is set and `OTEL_RESOURCE_ATTRIBUTES` names `deployment.environment.name` or `deployment.environment`, the server MUST name the value of the first of them it names, in that order, as the `environment` of each notification it posts.

**Reason:** a notification from a test instance that said `production` would send the person reading it to the wrong place.

**Tests:** `compliance/telemetry-identity.test.ts › names the instance and the environment in an exception and an error notification`, `› names deployment.environment.name in an error notification before deployment.environment`.

## Settings refused at boot

The server reads its settings once, when it starts, and the table at the end of this chapter gives each one's rule. A client meets a refused setting as a process that exits, so these rules are about the exit status, the log message and the files left behind.

### `instance/settings-edge-accepted`

When every setting is inside its rule, one at the edge of its rule and a pair at the edge of a rule between two settings included, the server MUST start.

**Tests:** `compliance/instance-lifecycle.test.ts › starts with each of those settings one step inside its rule and each cross-field rule at its edge`.

### `instance/settings-refused-exit`

If a setting is outside the rule the table gives it, then the server MUST exit with status 1 instead of starting.

**Reason:** status 78 is for an incompatible database, so a supervisor can tell a stop that editing the settings will mend from one that exporting and restoring will.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`, `› names every setting that is outside its rule in one refusal`, `› refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`, `› refuses a MARFA_AUTH_SECRET of 31 characters, without printing it`, `› refuses to start with status 1, naming %s, when each setting is inside its own rule and the two disagree`.

### `instance/settings-refused-no-port`

If the server refuses a setting at boot, then the server MUST NOT listen on its port.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`, `› names every setting that is outside its rule in one refusal`.

### `instance/settings-refused-no-files`

If the server refuses a setting at boot, then the server MUST NOT create the database file, nor a log or an index beside it.

**Reason:** the settings are read before the database is opened, so a refused setting leaves a data directory as it was.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`, `› names every setting that is outside its rule in one refusal`.

### `instance/settings-refused-names-each`

If more than one setting is outside its own rule, then the server MUST name every one of them, each on a line of its own, in one refusal.

**Reason:** an owner who is told one setting at a time restarts the server once for each.

**Tests:** `compliance/instance-lifecycle.test.ts › names every setting that is outside its rule in one refusal`, `› refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`.

### `instance/settings-refused-only-bad`

If the server refuses a setting at boot, then the server MUST NOT name in its refusal a setting that is inside its rule.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`.

### `instance/settings-refused-value-shown`

If a setting that does not hold a secret is outside its rule, then the server MUST show the value it was given in the setting's line of the refusal, as `(got "<value>")`.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`, `› refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`.

### `instance/settings-refused-secret-hidden`

If a setting that holds a secret is outside its rule, then the server MUST NOT print its value anywhere in its refusal.

**Reason:** the log is read by more people than the secret is meant for. The settings that hold a secret include `API_KEY_SALT`, `MARFA_AUTH_SECRET`, `S3_ENDPOINT` and `S3_SECRET_ACCESS_KEY`, since an address can carry a credential.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`, `› refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`, `› refuses a MARFA_AUTH_SECRET of 31 characters, without printing it`.

### `instance/settings-secret-padded`

If a setting whose allowed values the settings table gives as text with no whitespace around it has whitespace around its value, then the server MUST refuse to start and name the setting.

**Reason:** a secret is used as written, never trimmed, so the whitespace would be part of it.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`.

### `instance/settings-auth-secret-short`

If `MARFA_AUTH_SECRET` is set to fewer than 32 characters, then the server MUST refuse to start and name the setting.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a MARFA_AUTH_SECRET of 31 characters, without printing it`.

### `instance/settings-cross-field`

If every setting is inside its own rule and a setting the table says must be at least another is lower than it, then the server MUST refuse to start and name the lower setting.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s, when each setting is inside its own rule and the two disagree`.

### `instance/settings-cross-field-last`

While any setting is outside its own rule, the server MUST NOT report in the same refusal a rule that compares two settings or that holds only in production.

**Reason:** a rule between two settings, or one that `NODE_ENV` decides, cannot be read until every setting parses.

**Tests:** `compliance/instance-lifecycle.test.ts › names only the setting outside its rule, and holds back the cross-field rule until every setting parses`.

## Settings

The server reads each of these environment variables once, when it starts, and a blank value counts as unset. What a value outside its allowed values does is under "Settings refused at boot".

<!-- settings-table:start -->

| Setting                                     | Default                       | Allowed values                                                     | What it sets                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                  | `development`                 | `production`, `development` or `test`                              | The environment the server runs in. Production makes `API_KEY_SALT`, `MARFA_AUTH_SECRET` and `MARFA_AUTH_BASE_URL` mandatory, and the two secrets strong.                                                                                                         |
| `PORT`                                      | `8600`                        | Whole number, 0 to 65535                                           | The port the server listens on. Zero lets the operating system assign a port.                                                                                                                                                                                     |
| `MARFA_LISTEN_HOST`                         | None                          | Any text                                                           | The IP address or hostname the public HTTP listener binds to. Unset uses the runtime's unspecified address: IPv6 when available, otherwise IPv4.                                                                                                                  |
| `SQLITE_PATH`                               | `./data/marfa.db`             | Any text                                                           | The path of the database file. A value starting with `file:` is passed to the database as written, and `:memory:` opens a database held in memory.                                                                                                                |
| `MARFA_CONTROL_SOCKET`                      | None                          | Any text                                                           | Absolute private Unix socket path. Defaults to control/marfa.sock beside the database. Its directory must belong to the server account with mode 0700. Linux requires getfacl.                                                                                    |
| `MARFA_CONTROL_ONLY`                        | `false`                       | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Start only the private control listener, without public HTTP or background jobs, for local recovery.                                                                                                                                                              |
| `MARFA_TEST_HOOKS`                          | `false`                       | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Serve the clock and fault routes a conformance harness drives on the private control socket. Never on the public listener, and refused when `NODE_ENV` is production. Leave off on every instance that holds real data.                                           |
| `MARFA_TEST_CLOCK_OFFSET_MS`                | `0` ms                        | Whole number of milliseconds, 0 to 3153600000000                   | How far ahead of the system clock the server's clock starts. Needs `MARFA_TEST_HOOKS`, so a harness that moved the clock can restart the server without the time going back.                                                                                      |
| `MARFA_TEST_CONTRACT_VERSION`               | The build's contract version  | Whole number, 0 to 2147483647                                      | The contract version the server speaks instead of the build's, in the root's `contract`, the `X-Marfa-Contract` header and the document's `info.version`. Needs `MARFA_TEST_HOOKS`, so a harness can show what a change of contract does to what the server kept. |
| `SQLITE_BUSY_BUDGET_MS`                     | `5000` ms                     | Whole number of milliseconds, 0 to 2147483647                      | How long a write that meets a locked database is retried before the server answers `503 write_contention`. At 0 the first refusal is answered.                                                                                                                    |
| `BLOB_PATH`                                 | `./data/blobs`                | Any text                                                           | The folder of the disk store, where every upload lands.                                                                                                                                                                                                           |
| `MARFA_DISK_RESERVE_BYTES`                  | `134217728` bytes             | Whole number of bytes, 0 or more                                   | The free space on the disk store's volume that uploads, restores, and archive exports must leave. An export's temporary files are included. A request that would take the volume below it is refused `507 insufficient_storage`. At 0 nothing is held back.       |
| `MARFA_UPLOAD_IDLE_TIMEOUT_MS`              | `60000` ms                    | Whole number of milliseconds, 1 to 2147483647                      | How long a restore or a blob upload may receive no bytes before the server ends it `408 request_timeout`. An upload has no other time limit while bytes keep arriving.                                                                                            |
| `MARFA_MAX_REQUEST_BYTES`                   | `1048576` bytes               | Whole number of bytes, 1 or more                                   | The largest ordinary JSON request body. A larger body is answered `413 request_too_large`. Bulk writes, connector state, client registration, blob uploads and inbound webhook deliveries have separate limits.                                                   |
| `MARFA_MAX_BULK_REQUEST_BYTES`              | `16777216` bytes              | Whole number of bytes, 1 or more                                   | The largest body the bulk operations accept.                                                                                                                                                                                                                      |
| `S3_BUCKET`                                 | None                          | Any text                                                           | The bucket of an S3-compatible object store. The store is attached when this is set.                                                                                                                                                                              |
| `S3_REGION`                                 | `us-east-1`                   | Any text                                                           | The region of the object store.                                                                                                                                                                                                                                   |
| `S3_ENDPOINT`                               | None                          | Absolute `http` or `https` URL                                     | The endpoint of the object store. When blank, the store's provider chooses it.                                                                                                                                                                                    |
| `S3_ACCESS_KEY_ID`                          | None                          | Any text                                                           | The access key ID for the object store.                                                                                                                                                                                                                           |
| `S3_SECRET_ACCESS_KEY`                      | None                          | Text with no whitespace around it                                  | The secret access key for the object store.                                                                                                                                                                                                                       |
| `S3_FORCE_PATH_STYLE`                       | `true`                        | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether the object store is addressed by path rather than by virtual host. Read only when `S3_ENDPOINT` is set.                                                                                                                                                   |
| `S3_PREFIX`                                 | `blobs`                       | `/`-joined segments of letters, digits, `.`, `_` and `-`           | The key prefix the instance keeps everything in the bucket under: its blobs and, in the image, its database replica under `db/`. Each instance on a bucket needs its own. A `/` at either end is dropped; a `.` or `..` segment is refused.                       |
| `MARFA_BLOB_MIN_COPIES`                     | `1`                           | Whole number, 1 or more                                            | The fewest live copies a blob keeps. A drop that would leave fewer is refused.                                                                                                                                                                                    |
| `MARFA_BLOB_READ_IDLE_TIMEOUT_MS`           | `30000` ms                    | Whole number of milliseconds, 1 to 2147483647                      | How long a blob read may make no progress before its stream and file or socket are closed. Slow consumers must read within this interval.                                                                                                                         |
| `MARFA_BLOB_REPLICATE_INTERVAL_MS`          | `60000` ms                    | Whole number of milliseconds, 1 to 3153600000000                   | How often the `blob-replicate` job gives every attached store its copies. The job has no off switch.                                                                                                                                                              |
| `MARFA_BLOB_REPLICATE_BATCH`                | `100`                         | Whole number, 1 or more                                            | The most blobs one replication run copies.                                                                                                                                                                                                                        |
| `MARFA_BLOB_REPLICATE_BATCH_BYTES`          | `1073741824` bytes            | Whole number of bytes, 1 or more                                   | The most bytes one replication run copies.                                                                                                                                                                                                                        |
| `MARFA_BLOB_INTEGRITY_INTERVAL_MS`          | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the `blob-integrity` job checks the copies it holds. The job has no off switch.                                                                                                                                                                         |
| `MARFA_BLOB_INTEGRITY_BATCH`                | `500`                         | Whole number, 1 or more                                            | The most copies one integrity run checks.                                                                                                                                                                                                                         |
| `MARFA_BLOB_INTEGRITY_BATCH_BYTES`          | `1073741824` bytes            | Whole number of bytes, 1 or more                                   | The most bytes one integrity run checks.                                                                                                                                                                                                                          |
| `MARFA_BLOB_CLEANUP_INTERVAL_MS`            | `86400000` ms                 | Whole number of milliseconds, 0 to 3153600000000                   | How often the `blob-orphans` job sweeps for unreferenced blobs. At 0 the sweep is off.                                                                                                                                                                            |
| `MARFA_BLOB_CLEANUP_GRACE_MS`               | `86400000` ms                 | Whole number of milliseconds, 0 to 3153600000000                   | How long an unreferenced blob stands in the orphan report before a later run purges it. At 0 the next run purges it.                                                                                                                                              |
| `MARFA_ENRICHMENT_ENABLED`                  | `true`                        | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether the server extracts text from uploaded files.                                                                                                                                                                                                             |
| `MARFA_ENRICHMENT_OCR_ENABLED`              | `true`                        | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether the server reads text from images with OCR. When off, images are recorded as unsupported.                                                                                                                                                                 |
| `MARFA_ENRICHMENT_TESSDATA_DIR`             | None                          | Any text                                                           | The folder where the OCR language model is cached. When unset, it is a `tessdata` folder beside the database file.                                                                                                                                                |
| `MARFA_ENRICHMENT_INTERVAL_MS`              | `30000` ms                    | Whole number of milliseconds, 1 to 3153600000000                   | How often the enrichment sweep runs.                                                                                                                                                                                                                              |
| `MARFA_ENRICHMENT_BATCH_SIZE`               | `8`                           | Whole number, 1 or more                                            | The most items one enrichment sweep extracts.                                                                                                                                                                                                                     |
| `MARFA_ENRICHMENT_ITEM_TIMEOUT_MS`          | `60000` ms                    | Whole number of milliseconds, 1 to 2147483647                      | How long the extraction of one item may take.                                                                                                                                                                                                                     |
| `MARFA_ENRICHMENT_MAX_BLOB_BYTES`           | `20971520` bytes              | Whole number of bytes, 1 or more                                   | The largest blob the server extracts text from. A larger blob is skipped unread.                                                                                                                                                                                  |
| `MARFA_ENRICHMENT_MAX_TEXT_CHARS`           | `100000`                      | Whole number, 1 or more                                            | The most UTF-16 code units of extracted text the server keeps. Longer text is cut short, never through a character.                                                                                                                                               |
| `MARFA_ENRICHMENT_MAX_INFLATED_BYTES`       | `67108864` bytes              | Whole number of bytes, 1 or more                                   | The most a document may inflate to when the server extracts its text, all of its parts together. A document that inflates past it is skipped.                                                                                                                     |
| `MARFA_ENRICHMENT_MAX_MEMORY_BYTES`         | `268435456` bytes             | Whole number of bytes, 1 or more                                   | The most the JavaScript heap of the process that reads one document's text may take. That process also holds the document and what it inflates to, outside the heap, so allow this and the two limits above together. A document that needs more is skipped.      |
| `MARFA_ENRICHMENT_MAX_ATTEMPTS`             | `3`                           | Whole number, 1 or more                                            | How many times the server tries to extract text from a failing item before it stops.                                                                                                                                                                              |
| `TRUSTED_PROXY_CIDRS`                       | None                          | Comma-separated CIDR ranges, IPv4 or IPv6                          | The address ranges of the proxies whose `X-Forwarded-For` header the server believes. When empty, the header is ignored.                                                                                                                                          |
| `TRUSTED_PROXY_HEADER`                      | None                          | An HTTP header name                                                | The name of a header that the platform's edge overwrites with the client address. It takes precedence over `TRUSTED_PROXY_CIDRS`.                                                                                                                                 |
| `API_KEY_SALT`                              | None. Required in production. | Text with no whitespace around it                                  | The salt for hashing API keys and app tokens. Changing it invalidates every existing key and token. Outside production, an unset salt falls back to a built-in one.                                                                                               |
| `MARFA_AUTH_SECRET`                         | None. Required in production. | Text of at least 32 characters, with no whitespace around it       | The secret that signs sign-in cookies, authorize queries, read-view tokens and credential-free blob links. It must be at least 32 characters. Outside production, an unset secret falls back to a random one for each process.                                    |
| `MARFA_AUTH_BASE_URL`                       | None. Required in production. | Absolute `http` or `https` URL                                     | The public URL for OAuth, cookies, and links. It has no user name, password or query string. Outside production, an unset URL uses the assigned port with `http://127.0.0.1` when `MARFA_LISTEN_HOST` is `127.0.0.1`, otherwise `http://localhost`.               |
| `CORS_ORIGINS`                              | None                          | Comma-separated origins, each `scheme://host[:port]` with no path  | The browser origins allowed to call the API across origins, beside the web pages the owner approves, and trusted by the sign-in forms. Each is an exact scheme and host with no trailing slash.                                                                   |
| `MARFA_PERMISSION_BUNDLES`                  | None                          | JSON array of permission bundles                                   | The permission bundles the consent screen offers, replacing the built-in ones. Each entry has a string `id`, an array of `scopes` and a boolean `default_on`.                                                                                                     |
| `ENABLE_HSTS`                               | `false`                       | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether the server sends the `Strict-Transport-Security` header.                                                                                                                                                                                                  |
| `RATE_LIMIT_ENABLED`                        | `true`                        | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether the rate limiter is on.                                                                                                                                                                                                                                   |
| `RATE_LIMIT_REQUESTS`                       | `1000`                        | Whole number, 1 or more                                            | The requests one credential may make to one group of operations in each window. A `GET` may make twice as many, except in a group that another setting caps.                                                                                                      |
| `RATE_LIMIT_WINDOW_MS`                      | `60000` ms                    | Whole number of milliseconds, 1 to 3153600000000                   | The length of a rate-limit window.                                                                                                                                                                                                                                |
| `RATE_LIMIT_KEYS_REQUESTS`                  | `200`                         | Whole number, 1 or more                                            | The requests one credential may make in each window to the operations under `/keys`.                                                                                                                                                                              |
| `RATE_LIMIT_AGGREGATE_MULTIPLIER`           | `4`                           | Whole number, 0 or more                                            | The multiplier of `RATE_LIMIT_REQUESTS` that caps a credential across every operation in a window. At 0 there is no such cap.                                                                                                                                     |
| `MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS`      | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the `rate-limit-cleanup` job drops expired rate-limit windows.                                                                                                                                                                                          |
| `MARFA_CONNECTOR_HOLD_MS`                   | `180000` ms                   | Whole number of milliseconds, 1000 to 3600000                      | How long a connector's hold on its registration lasts after its last take or renewal.                                                                                                                                                                             |
| `MARFA_INBOUND_MAX_BYTES`                   | `26214400` bytes              | Whole number of bytes, 1 or more                                   | The largest inbound webhook delivery the server stores.                                                                                                                                                                                                           |
| `RATE_LIMIT_INBOUND_REQUESTS`               | `600`                         | Whole number, 1 or more                                            | The deliveries one inbound endpoint accepts in each rate-limit window.                                                                                                                                                                                            |
| `MARFA_INBOUND_BACKLOG_DELIVERIES`          | `10000`                       | Whole number, 1 or more                                            | The unhandled deliveries one registration may hold before the server refuses more deliveries for it.                                                                                                                                                              |
| `MARFA_INBOUND_BACKLOG_BYTES`               | `1073741824` bytes            | Whole number of bytes, 1 or more                                   | The bytes of unhandled deliveries one registration may hold before the server refuses more deliveries for it.                                                                                                                                                     |
| `MARFA_INBOUND_RETAINED_DELIVERIES`         | `10000`                       | Whole number, 1 or more                                            | The most deliveries the server retains across live and retired endpoints.                                                                                                                                                                                         |
| `MARFA_INBOUND_RETAINED_BYTES`              | `1073741824` bytes            | Whole number of bytes, 1 or more                                   | The most bytes of deliveries the server retains across live and retired endpoints.                                                                                                                                                                                |
| `MARFA_INBOUND_CLEANUP_INTERVAL_MS`         | `60000` ms                    | Whole number of milliseconds, 1 to 3153600000000                   | How often the `inbound-delivery-cleanup` job runs.                                                                                                                                                                                                                |
| `MARFA_INBOUND_IN_FLIGHT_BYTES`             | `104857600` bytes             | Whole number of bytes, 1 or more                                   | The most bytes of inbound webhook deliveries the server holds in memory at once.                                                                                                                                                                                  |
| `MARFA_INBOUND_READ_TIMEOUT_MS`             | `30000` ms                    | Whole number of milliseconds, 1 to 2147483647                      | How long a delivery's body has to arrive whole.                                                                                                                                                                                                                   |
| `MARFA_INBOUND_HANDLED_RETENTION_DAYS`      | `7` days                      | Whole number of days, 0 to 36500                                   | How long the server keeps a handled delivery. `PUT /config` overrides it. At 0 age does not expire a delivery.                                                                                                                                                    |
| `MARFA_INBOUND_PENDING_RETENTION_DAYS`      | `30` days                     | Whole number of days, 0 to 36500                                   | How long the server keeps an unhandled delivery. `PUT /config` overrides it. At 0 age does not expire a delivery.                                                                                                                                                 |
| `MARFA_HOUSEKEEPING_POLL_INTERVAL_MS`       | `1000` ms                     | Whole number of milliseconds, 1 to 2147483647                      | How often the housekeeping scheduler asks its table which jobs are due.                                                                                                                                                                                           |
| `AUDIT_RETENTION_DAYS`                      | `90` days                     | Whole number of days, 0 to 36500                                   | How long the server keeps audit entries and webhook delivery history. At 0 no entry expires by age. `PUT /config` overrides it.                                                                                                                                   |
| `AUDIT_CLEANUP_INTERVAL_MS`                 | `86400000` ms                 | Whole number of milliseconds, 1 to 3153600000000                   | How often the `audit-cleanup` job runs.                                                                                                                                                                                                                           |
| `MARFA_REVOKED_GRANT_RETENTION_DAYS`        | `90` days                     | Whole number of days, 0 to 36500                                   | How long a revoked application grant is kept. At 0 the job that purges them is off. `PUT /config` does not override it.                                                                                                                                           |
| `MARFA_GRANT_INACTIVITY_DAYS`               | `365` days                    | Whole number of days, 0 to 36500                                   | How long an application grant may go unused before the server retires it. At 0 grants are never retired. `/config` overrides it.                                                                                                                                  |
| `MARFA_EVENT_LOG_RETENTION_HOURS`           | `168` hours                   | Whole number of hours, 0 to 876000                                 | The least time an event stays in the event log, which bounds how far back a stream can replay. At 0 no event expires by age. `PUT /config` overrides it.                                                                                                          |
| `MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS`       | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the `event-log-cleanup` job runs.                                                                                                                                                                                                                       |
| `VERSION_THINNING_INTERVAL_MS`              | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the `version-thinning` job runs.                                                                                                                                                                                                                        |
| `FEED_EXPIRY_INTERVAL_MS`                   | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the `feed-expiry` job runs.                                                                                                                                                                                                                             |
| `VERSION_RECENT_DAYS`                       | `30` days                     | Whole number of days, 0 to 36500                                   | The window in which the version policy keeps every version of an item.                                                                                                                                                                                            |
| `VERSION_DAILY_SNAPSHOT_DAYS`               | `90` days                     | Whole number of days, 0 to 36500                                   | The window in which the version policy keeps one version a day. It must be at least `VERSION_RECENT_DAYS`.                                                                                                                                                        |
| `VERSION_WEEKLY_SNAPSHOT_DAYS`              | `365` days                    | Whole number of days, 0 to 36500                                   | The window in which the version policy keeps one version a week. It must be at least `VERSION_DAILY_SNAPSHOT_DAYS`.                                                                                                                                               |
| `VERSION_MAX_VERSIONS`                      | `500`                         | Whole number, 1 or more                                            | The most versions the version policy keeps for one item.                                                                                                                                                                                                          |
| `TRASH_RETENTION_DAYS`                      | `60` days                     | Whole number of days, 0 to 36500                                   | How long an item stays in the trash before the server deletes it. At 0 nothing in the trash expires by age. `PUT /config` overrides it.                                                                                                                           |
| `TRASH_PURGE_INTERVAL_MS`                   | `86400000` ms                 | Whole number of milliseconds, 1 to 3153600000000                   | How often the `trash-purge` job runs.                                                                                                                                                                                                                             |
| `AUTH_SESSION_CLEANUP_INTERVAL_MS`          | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the `auth-session-cleanup` job drops expired sign-in sessions.                                                                                                                                                                                          |
| `MARFA_DCR_CLIENT_RETENTION_DAYS`           | `1` day                       | Whole number of days, 0 to 36500                                   | How long a dynamically registered client with no grants is kept, counted from its registration or the last time an approval page offered it. At 0 the job that removes them is off.                                                                               |
| `MARFA_DCR_CLIENT_CLEANUP_INTERVAL_MS`      | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the job that removes dynamically registered clients with no grants runs.                                                                                                                                                                                |
| `MARFA_BULK_ACTION_JOB_RETENTION_MS`        | `604800000` ms                | Whole number of milliseconds, 0 to 3153600000000                   | How long a finished bulk-action job is kept. At 0 the sweep that removes them is off.                                                                                                                                                                             |
| `MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS`      | `3600000` ms                  | Whole number of milliseconds, 1 to 3153600000000                   | How often the sweep that removes finished bulk-action jobs runs.                                                                                                                                                                                                  |
| `MARFA_BULK_ACTION_POLL_INTERVAL_MS`        | `500` ms                      | Whole number of milliseconds, 1 to 2147483647                      | The base interval at which the bulk-action worker looks for work.                                                                                                                                                                                                 |
| `MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS`    | `60000` ms                    | Whole number of milliseconds, 1 to 2147483647                      | The longest the bulk-action worker waits between looks for work when it is idle. It must be at least `MARFA_BULK_ACTION_POLL_INTERVAL_MS`.                                                                                                                        |
| `MARFA_BULK_ACTION_POLL_BACKOFF_MULTIPLIER` | `2`                           | Decimal number, 1 to 100                                           | The factor by which the bulk-action worker's wait grows after each look that finds no work.                                                                                                                                                                       |
| `MARFA_SSE_MAX_VIEWERS`                     | `0`                           | Whole number, 0 or more                                            | The most event-stream viewers one server instance serves at once. At 0 there is no limit.                                                                                                                                                                         |
| `MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES`     | `false`                       | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether outbound webhooks may reach loopback, private and other non-public addresses.                                                                                                                                                                             |
| `MARFA_ERROR_REPORTING_ENABLED`             | `true`                        | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Send error alerts and exception reports to configured receivers. `/config` overrides it; receiver addresses and credentials stay machine settings.                                                                                                                |
| `MARFA_HEARTBEAT_ENABLED`                   | `true`                        | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Send scheduled requests to the configured heartbeat receiver. `/config` overrides it; its address stays a machine setting.                                                                                                                                        |
| `ERROR_WEBHOOK_URL`                         | None                          | Absolute `http` or `https` URL                                     | The URL the server posts a notice to when a request fails with a 500 error. When blank, no notice is sent.                                                                                                                                                        |
| `MARFA_ERROR_WEBHOOK_TIMEOUT_MS`            | `5000` ms                     | Whole number of milliseconds, 1 to 2147483647                      | How long one post to `ERROR_WEBHOOK_URL` may take.                                                                                                                                                                                                                |
| `MARFA_HEARTBEAT_URL`                       | None                          | Absolute `http` or `https` URL                                     | The URL the server requests on a schedule, so that something else can notice when the requests stop. When blank, there is no heartbeat.                                                                                                                           |
| `MARFA_HEARTBEAT_INTERVAL_MS`               | `60000` ms                    | Whole number of milliseconds, 1 to 3153600000000                   | How often the server requests `MARFA_HEARTBEAT_URL`.                                                                                                                                                                                                              |
| `MARFA_PLACEMENT_REGION`                    | None                          | Any text                                                           | Free text naming the region the server runs in, reported at `/health` as `placement.region`.                                                                                                                                                                      |
| `MARFA_PLACEMENT_LOCATION`                  | None                          | Any text                                                           | Free text naming the location the server runs in, reported at `/health` as `placement.location`.                                                                                                                                                                  |
| `MARFA_PLACEMENT_COUNTRY`                   | None                          | Any text                                                           | Free text naming the country the server runs in, reported at `/health` as `placement.country`.                                                                                                                                                                    |
| `MARFA_OTEL_SAMPLE_RATIO`                   | `0.05`                        | Decimal number, 0 to 1                                             | The share of traces exported. A trace that contains an error is exported whatever this says: the span that failed, the spans held for the trace (at most 500) and every span after it.                                                                            |
| `OTEL_SERVICE_NAME`                         | `marfa-server`                | Any text                                                           | The service name on exported telemetry. It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.                                                                                                                                                  |
| `OTEL_RESOURCE_ATTRIBUTES`                  | None                          | Comma-separated `key=value` pairs, values percent-encoded          | Attributes added to everything exported, as OpenTelemetry defines them. One named here replaces the server's own of the same name, such as `deployment.environment`, which an error notification names too.                                                       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`               | None                          | Absolute `http` or `https` URL                                     | The base URL of the OTLP receiver. Setting it turns telemetry on: the server exports traces to `v1/traces` and logs to `v1/logs` under it. Unset, nothing is exported and the telemetry SDK is not loaded.                                                        |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`        | None                          | Absolute `http` or `https` URL                                     | The URL traces post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.                                                                                                                                          |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`          | None                          | Absolute `http` or `https` URL                                     | The URL logs post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_HEADERS`                | None                          | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with every OTLP export, as `key=value` pairs.                                                                                                                                                                                                    |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`         | None                          | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with trace exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS`           | None                          | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with log exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                              |
| `MARFA_POSTHOG_HOST`                        | None                          | Absolute `http` or `https` URL                                     | The PostHog host that receives exception reports, which OTLP cannot carry into error tracking. It needs `OTEL_EXPORTER_OTLP_ENDPOINT` and `MARFA_POSTHOG_PROJECT_TOKEN` set too.                                                                                  |
| `MARFA_POSTHOG_PROJECT_TOKEN`               | None                          | Text with no whitespace around it                                  | The PostHog project token for exception reports. It needs `OTEL_EXPORTER_OTLP_ENDPOINT` and `MARFA_POSTHOG_HOST` set too.                                                                                                                                         |

<!-- settings-table:end -->

### `instance/live-settings`

When an authorized caller replaces or updates the configuration, the server MUST accept `version_recent_days`, `version_daily_snapshot_days`, `version_weekly_snapshot_days`, `version_max_versions`, `grant_inactivity_days`, `enrichment_enabled`, `enrichment_ocr_enabled`, `error_reporting_enabled` and `heartbeat_enabled` as persisted overrides of their environment defaults.

**Reason:** the owner can change version retention, unused-app retirement, file reading and reporting without changing machine configuration.

**Tests:** `compliance/instance-config.test.ts › keeps live settings across restart, preserves omitted choices and clears to the environment`.

### `instance/live-policy-validation`

If a configuration write would make the effective recent, daily and weekly version windows decrease in that order, set a negative window or inactivity period, set a version count below one, or enable reporting without a configured receiver, then the server MUST refuse it with `400 validation_error` without changing the stored configuration.

**Reason:** validation includes environment defaults exposed by clearing an override. Addresses and credentials remain machine settings.

**Tests:** `compliance/instance-config.test.ts › keeps live settings across restart, preserves omitted choices and clears to the environment`.

### `instance/live-work`

When a persisted override changes, the server MUST use the effective choice for future work without a restart, including a job disabled when the process started.

**Reason:** disabling does not promise to cancel an extraction or request already in flight. Version deletion and unused-app retirement recheck the effective policy in the transaction that removes the versions or revokes the grant. A zero version window is empty; a zero inactivity period disables retirement. Type-specific version policies retain precedence.

**Tests:** `compliance/live-settings.test.ts › starts disabled work after a live choice and stops it again without restarting`.
