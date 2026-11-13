# The instance

What one deployment says about itself, and what happens to it as an owner runs it: the identity it answers to, the features and contract version it advertises, how it compresses its answers, backing up, health, a database the build did not write, stopping, the pages it renders, the configuration operations and the settings that stop it from starting. The credential chapters state what a key may reach and the registry chapters state what the data plane holds.

`GET /` answers one of two things. The description is the JSON object with `name`, `version`, `instance_id`, `contract`, `features` and `max_request_bytes`, and with `release` when the build is a numbered release. A page is the HTML a browser is given instead.

## Needs attention

### `instance/attention-authority`

When a private local command sends `GET /attention`, the server MUST return an unpaginated `data` array of concerns, each with `kind`, `reference`, `title` and `description`.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-credentials`

When a key or delegated credential sends `GET /attention`, the server MUST answer `403 forbidden`.

**Reason:** the aggregate includes the owner's folder and key inventories, which management permissions alone do not grant.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-session`

When a request that carries no bearer token and arrives by the public listener sends `GET /attention`, the server MUST answer `401 unauthorized`.

**Reason:** the owner reads attention through the private socket, as for the folder inventory.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-query`

If `GET /attention` carries a query field, then the server MUST answer `400 validation_error`.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-concerns`

When `GET /attention` completes its checks, the server MUST include degraded or down health components, housekeeping jobs whose last run failed, connectors whose last run failed or that report problems or have said nothing for more than 24 hours, active folders whose current sign-ins report problems, paused removals or a first sync waiting, and live keys expiring within the next seven days inclusive.

**Reason:** connector silence follows the latest registration, heartbeat, or received run; folder totals exclude historical sign-ins and do not claim that a copy is online.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-no-backup`

Where neither `S3_BUCKET` nor `MARFA_BACKUP_PATH` is set, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `no_backup_destination`, the title `No backups are kept`, and a description that names `MARFA_BACKUP_PATH`, `S3_BUCKET` and `marfa server restart`.

**Reason:** an instance with no destination keeps no backup, and an owner who never reads the install output can run for months without knowing it.

**Tests:** `compliance/backups.test.ts › says in attention that no backups are kept and how to set one, and says an interval of 0 differently`, `cli/attention.test.ts › tells the owner in plain words that no backups are kept, and how to set one`.

### `instance/attention-backup-off`

Where a destination is set and `backup_interval_seconds` is 0, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `turned_off`.

**Reason:** an interval of 0 is a choice, and it is told differently from having nowhere to put a backup.

**Tests:** `compliance/backups.test.ts › says in attention that no backups are kept and how to set one, and says an interval of 0 differently`.

### `instance/attention-backup-destination-set`

Where `S3_BUCKET` or `MARFA_BACKUP_PATH` is set, the server MUST NOT include an entry with the reference `no_backup_destination` in `GET /attention`.

**Tests:** `compliance/backups.test.ts › says in attention that no backups are kept and how to set one, and says an interval of 0 differently`.

### `instance/attention-backup-store`

While the object store or the backup folder does not take the copies that wait for it, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `store`, whose description gives the reason and, when files wait, how many wait for their second copy.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/attention-backup-store-title`

While the object store or the backup folder does not take the copies that wait for it, when `GET /attention` completes its checks, the server MUST title the entry with the reference `store` `The backup folder is not there` while the disk of the backup folder is not there, `The backup folder is not answering` while a look at it does not answer, and otherwise `Files are waiting for their copy in the object store` or `Files are waiting for their copy in the backup folder`.

**Reason:** a run that copied nothing because one file was refused is not a store that is gone, and the title says what is known.

**Tests:** `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`, `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `› tells one file the object store refused as files waiting for their copy, not as a store that is gone`.

### `instance/attention-backup-run`

While the last backup run, taken on the schedule or by hand, failed or put a backup that lacks files, and no entry with the reference `store` is listed for a destination that did not answer it, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `run`, whose description is `backups.last_error`.

**Reason:** a backup taken by hand with `POST /backups` is not a run of the `backup` job, so the housekeeping check does not see it.

**Tests:** `compliance/backup-folder.test.ts › lists in attention a backup run by hand that failed, until a later one is put`, `› puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`.

### `instance/attention-backup-told-once`

While an entry of kind `backup` with the reference `store` is listed, the server MUST NOT list an entry with the reference `run` for a last backup run that failed because the destination did not answer.

**Reason:** one fault is one entry. A folder that is gone, or an object store that does not answer, fails the backup run and the copies together, and the owner reads the folder once.

**Tests:** `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`, `› lists in attention a backup run by hand that failed, until a later one is put`.

### `instance/attention-backup-no-job-twice`

While an entry of kind `backup` with the reference `run` or `store` is listed, the server MUST NOT list as a job entry the failed last run of the `backup` job or the `blob-replicate` job that it tells.

**Reason:** one fault is one entry.

**Tests:** `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`, `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`.

### `instance/attention-backup-quiet`

Where a destination is set, while it takes copies, no file waits for one, the last backup run was whole and `backup_interval_seconds` is above 0, the server MUST NOT include an entry of kind `backup` in `GET /attention`.

**Tests:** `compliance/backup-folder.test.ts › says nothing in health or attention while the folder answers and no file waits for its copy`, `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-unavailable`

If a check fails or does not answer within its bounded deadline, then the server MUST answer `GET /attention` with known concerns and an `unavailable` item identifying the check whose state is unknown.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

### `instance/attention-empty`

When every attention check completes without finding a concern, the server MUST return an empty `data` array from `GET /attention`.

**Tests:** `cli/attention.test.ts › shares private-socket attention, keeps known concerns, and refuses every other credential`.

## Background work

### `instance/background-request-authority`

When a request starts or wakes background work, the server MUST evaluate that work's authorization independently of the request's authority.

**Reason:** housekeeping runs as server-owned work, even if the requesting key is revoked after the run is admitted; a bulk-action job rechecks its stored credential under `items/job-credential-lost` and can still record its failure.

**Tests:** `compliance/background-authority.test.ts › background jobs after the requesting key is revoked`, `compliance/background-authority-webhooks.test.ts › sends the delivery a write woke after the key that made the write is revoked`.

## Identity

### `instance/id-at-root`

When `GET /` is answered with the description, the server MUST give it an `instance_id` that is a UUIDv7.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`, `compliance/instance.test.ts › describes itself at the root`, `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/request-limit-at-root`

When `GET /` is answered with the description, the server MUST give it a `max_request_bytes` equal to the request cap, which is 1048576 unless `max_request_bytes` sets another.

**Reason:** the root needs no credential, so a device can learn the limit before it sends a body the server would close the connection on. A size is no secret.

**Tests:** `compliance/instance.test.ts › describes itself at the root`, `compliance/request-limit.test.ts › names at the root a lowered request cap and refuses a body past it`, `› names at the root a raised request cap and reads a body past the default`.

### `instance/id-at-config`

When a key holding `config.manage` sends `GET /config`, the server MUST answer an `instance_id` equal to the one the root answers.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`, `compliance/instance-config.test.ts › answers one identity to every caller, keeps it across a restart, and shares it with no other instance`.

### `instance/id-in-archive`

When a credential that may export sends `GET /export?format=archive`, the server MUST write into the archive's `manifest.json` an `instance_id` equal to the one the root answers.

**Reason:** the manifest is a file nothing echoes back, so an export that wrote another name, or none, would go unnoticed at every other operation.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`.

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

**Reason:** another instance at the address the client knew holds none of the items its copy was built from, so a write sent there would land on items the client never read.

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

**Tests:** `compliance/instance-header.test.ts › refuses an empty, repeated, uppercase or malformed instance id 400 validation_error`, `› answers 401 before it judges the header, and judges it before the body's depth and text and the write's own refusals`.

### `instance/write-instance-order`

When a write names `X-Marfa-Instance-Id` and meets more than one of the answers this section gives it, the server MUST give the first in this order: no valid credential on an operation that requires one, `401`; a header that is not one lowercase UUIDv7, `400`; another instance's id, `409 instance_changed`; then the answers it gives the same write without the header, a body nested more than 64 levels, a body holding a surrogate escape with no partner and an answer recorded under its `Idempotency-Key` among them.

**Reason:** a write sent to another instance is refused for that alone, so the refusal says nothing about the body, the items it names or the credential's reach there.

**Tests:** `compliance/instance-header.test.ts › answers 401 before it judges the header, and judges it before the body's depth and text and the write's own refusals`, `› keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`, `› refuses another instance on a conditional read before it judges the read's reach`.

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

**Reason:** a read of a copy is held to the instance by its reach (`reach/conditional-certified`), and the sign-in operations and inbound senders hold no copy.

**Tests:** `compliance/instance-header.test.ts › answers a GET, a request under /auth and an inbound delivery as it answers one without the header`.

## What it advertises

### `instance/root-no-credential`

When a request that carries no credential sends `GET /`, the server MUST answer `200`.

**Reason:** the identity is read by a caller that holds no key yet.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`, `compliance/instance.test.ts › answers a browser at the root with a page and a program with the JSON`.

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

When a credential that may export sends `GET /export?format=archive`, the server MUST write the archive's `manifest.json` with a `version` of 1.

**Reason:** the version is the one marker of the archive's layout, and a restore reads only the version its own build writes (`search-and-filters/restore-version`).

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`.

### `instance/archive-written-by`

When a credential that may export sends `GET /export?format=archive`, the server MUST write the archive's `manifest.json` with a `written_by` of `marfa-server` and the version of the build, separated by a space.

**Reason:** a restore that refuses an archive of another version names the build that can read it, and only the manifest says which build wrote it.

**Tests:** `compliance/instance-identity.test.ts › names itself the same way at the root, at /config and in an archive`.

### `instance/contract-header`

The server MUST send `X-Marfa-Contract`, with the number the root answers as `contract`, on every answer to a request whose request line, headers and `Host` it can parse, whether it is a read, a refusal, a page, a stream, a download, a request the rate limiter refuses or a preflight.

**Reason:** a client checks the answer it is about to read against the contract it was built for, so the header cannot be missing on the answers a layer in front of the routes shapes. A request the server cannot parse is refused by the HTTP layer before anything that knows the contract sees it.

**Tests:** `compliance/instance.test.ts › sends its contract version on every answer, a refusal included`, `› sends its contract version on every kind of answer, not only a JSON body`, `compliance/contract-header.test.ts › sends its contract version on a request the limiter refuses`, `› sends its contract version on a preflight from an origin the instance allows`.

## Compression

### `instance/gzip-json`

When a `GET` request carries an `Authorization` header and an `Accept-Encoding` header that accepts `gzip`, the server MUST send a JSON answer with `Content-Encoding: gzip`.

**Reason:** the pages a hydration reads are mostly item bodies, which compress several times over, and over a slow link their bytes are most of the time a device waits.

**Tests:** `compliance/instance.test.ts › gzips a JSON answer to a GET that carries a credential and accepts gzip, a refusal included`.

### `instance/gzip-needs-authorization`

If a request carries no `Authorization` header, then the server MUST NOT send its JSON answer with a `Content-Encoding`.

**Reason:** a page on another site can make a browser send its session cookie with text of the page's choosing, and the size of a compressed answer that holds that text beside a secret can give the secret away (BREACH). A browser sends no `Authorization` header a page did not give it.

**Tests:** `compliance/instance.test.ts › answers a request without a credential uncompressed, where the same request with one is gzipped`.

### `instance/event-stream-uncompressed`

The server MUST NOT send an event stream with a `Content-Encoding`.

**Reason:** a compressor holds back what it has not filled a block with, so a frame would wait for the frames after it.

**Tests:** `compliance/instance.test.ts › sends an event stream uncompressed to a request that accepts gzip`.

## The reference's groups

### `instance/document-groups`

When `GET /openapi.json` is answered, the server MUST give each operation in `paths` and each request in `webhooks` exactly one tag.

**Tests:** `compliance/instance.test.ts › declares no tag that no operation carries, and no operation without one`, `› lists every operation once, under its own tag, in each tag's x-operation-order`.

### `instance/document-tags`

When `GET /openapi.json` is answered, the server MUST declare in `tags` exactly the tags that its operations carry.

**Tests:** `compliance/instance.test.ts › declares no tag that no operation carries, and no operation without one`.

### `instance/document-operation-order`

When `GET /openapi.json` is answered, the server MUST write on each tag an `x-operation-order` that lists each operation carrying the tag once, by its `operationId`.

**Reason:** the order interleaves paths, so `paths` alone cannot carry it, and a reader of the document needs the order from the server.

**Tests:** `compliance/instance.test.ts › lists every operation once, under its own tag, in each tag's x-operation-order`.

### `instance/document-paths-order`

When `GET /openapi.json` is answered, the server MUST write `paths` in the order of each path's earliest operation in the tags' `x-operation-order` lists.

**Tests:** `compliance/instance.test.ts › lists every operation once, under its own tag, in each tag's x-operation-order`.

## What a credential can reach

`GET /overview` answers a key or an app's token with a short summary of what the instance holds that the credential can reach, so a caller learns the instance before it lists anything.

### `instance/overview-credential-only`

When a request to `GET /overview` carries no key or app token, including one made with the owner's browser session or on the private local command, the server MUST answer `401 unauthorized`.

**Reason:** the answer describes one credential's reach, and the owner's session and the private command are not a credential.

**Tests:** `compliance/overview.test.ts › refuses a request with no credential, the owner's browser session and the private command, and answers a key`.

### `instance/overview-fields`

When `GET /overview` is answered `200`, the server MUST give `instance` with the `name` and `version` and give `credential` with its `kind`.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`.

### `instance/overview-no-reach`

When the credential may read no type, the server MUST answer `GET /overview` with `200`, `instance` and `credential`, and no list and no `total`, whatever its edge permissions.

**Tests:** `compliance/overview.test.ts › answers a key that reaches no type with the instance and itself only`.

### `instance/overview-omit-empty`

The server MUST leave an empty list or an absent field out of the `GET /overview` answer, rather than send an empty list or `null`.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`, `› answers a key that reaches no type with the instance and itself only`.

### `instance/overview-types`

When `GET /overview` is answered `200`, the server MUST list in `types` each type outside the `system` namespace that the credential may read, including a type registered while the server runs, with its `id`, its `description` when it has one and the `count` of its active items that the credential may read.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`.

### `instance/overview-total`

When `GET /overview` is answered `200` with `types`, the server MUST give in `total` the number of active items the credential may read across every type `types` would list before its cut.

**Reason:** `types` is cut at its cap, so a caller cannot add up the counts it was sent to learn how much it can reach.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`, `› leaves out a type the key cannot read and everything counted from it`.

### `instance/overview-types-order`

The server MUST order `types` in the `GET /overview` answer from the type with the most active items to the type with the fewest.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`.

### `instance/overview-unreadable`

The server MUST NOT include in the `GET /overview` answer a type the credential may not read, an item of such a type in any count, or a tag that only such items carry.

**Reason:** a summary that named an unreadable type or tag would disclose what the credential is kept from.

**Tests:** `compliance/overview.test.ts › leaves out a type the key cannot read and everything counted from it`.

### `instance/overview-tags`

When `GET /overview` is answered `200`, the server MUST list in `tags` the tags that active items the credential may read carry, the most used first, each with its `count`.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`.

### `instance/overview-edge-types`

When `GET /overview` is answered `200`, the server MUST list in `edge_types`, sorted by `id`, each edge type the credential's edge permissions let it read, with `access` set to `write` where they let it write and to `read` otherwise.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`, `› holds each list to its cap, says what was cut and keeps the answer small`.

### `instance/overview-views-folders`

When `GET /overview` is answered `200`, the server MUST list in `views` and in `folders` each view and folder the credential may read, as its `id` and `title`, sorted by title.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`.

### `instance/overview-key`

Where the credential is a key, the server MUST answer `credential` in the `GET /overview` answer with `kind` set to `key`, the key's `label`, its type permissions grouped under `write`, `read` and `none`, and the permissions it holds.

**Tests:** `compliance/overview.test.ts › answers the instance, the key, and what it reads with counts, tags, edge types, views and folders`, `› leaves out a type the key cannot read and everything counted from it`.

### `instance/overview-app`

Where the credential is the token of a signed-in app, the server MUST answer `credential` in the `GET /overview` answer with `kind` set to `app`, no `label`, and the type permissions and permissions its granted scopes give.

**Tests:** `compliance/overview.test.ts › reports a signed-in app as an app with the scopes it was granted`.

### `instance/overview-list-caps`

The server MUST hold `types` and `edge_types` to 50 entries, `tags`, `views` and `folders` to 30 entries, and each level of `credential.type_permissions` to 30 patterns in the `GET /overview` answer.

**Reason:** a caller reads the answer into its context, and an instance can hold hundreds of types and tags.

**Tests:** `compliance/overview.test.ts › holds each list to its cap, says what was cut and keeps the answer small`.

### `instance/overview-truncated`

When the server cuts a list of the `GET /overview` answer at its cap, the server MUST give in `truncated`, under the list's name, how many entries the list held before the cut.

**Tests:** `compliance/overview.test.ts › holds each list to its cap, says what was cut and keeps the answer small`.

### `instance/overview-text-cap`

The server MUST cut each description and title in the `GET /overview` answer at 100 characters.

**Tests:** `compliance/overview.test.ts › holds each list to its cap, says what was cut and keeps the answer small`.

## Backing up

An owner has two backups of an instance. Where `S3_BUCKET` is set, the server backs itself up to that object store, and where `MARFA_BACKUP_PATH` is set, to that folder: on a schedule, and when the owner asks. With neither set, it keeps no backup. Each backup is an archive, as `GET /export?format=archive` writes one, of every item and instance line, the trash included, and of no file's bytes, since the object store, or the backup folder's files area, already keeps a copy of each file as an attached store. And an image of the data directory, such as a machine backup takes, holds everything the instance keeps: the database file, the log beside it that holds the writes not yet moved into the file, and the folder of blob files. Neither holds the setting `MARFA_KEY_SALT`, and a backup holds no credential, so sign-in, keys and apps are set up again after a backup is restored.

### `instance/backup-object`

Where `S3_BUCKET` is set, when the server takes a backup, the server MUST put it in the object store as one object named `<S3_PREFIX>/backups/<instance id>/<created_at>.tar`, where `<instance id>` is the instance's id and `<created_at>` is its manifest's `created_at`.

**Reason:** a server that replaces another can start on the same prefix, and the folder keeps each instance's backups apart.

**Tests:** `compliance/backups.test.ts › puts one object in the prefix's backups folder for its instance, named for its created_at, holding what an archive export with state any and files false holds for a key that reaches everything`.

### `instance/backup-folder-file`

Where `MARFA_BACKUP_PATH` is set, when the server takes a backup, the server MUST write it as one file named `<MARFA_BACKUP_PATH>/backups/<instance id>/<created_at>.tar`, where `<instance id>` is the instance's id and `<created_at>` is its manifest's `created_at`.

**Reason:** a server that replaces another, given the same folder, restores its backups, and the folder keeps each instance's backups apart.

**Tests:** `compliance/backup-folder.test.ts › writes each backup as one file named for its created_at in the folder's backups folder for its instance, and a copy of each file it names in the folder's files area`.

### `instance/backup-folder-copies`

Where `MARFA_BACKUP_PATH` is set, the server MUST NOT give a backup its name in the folder before `<MARFA_BACKUP_PATH>/files/<instance id>/<first four hex digits>/<hex>` holds the bytes of each file the backup names but those its manifest names in `lost_blobs`, where `<hex>` is the file's SHA-256 in hex.

**Reason:** a backup carries no file's bytes, so the folder alone restores a backup only while it holds a copy of each file. Each file is copied once and kept while a backup names it, so a backup costs what changed since the last.

**Tests:** `compliance/backup-folder.test.ts › writes each backup as one file named for its created_at in the folder's backups folder for its instance, and a copy of each file it names in the folder's files area`, `› refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-whole`

Where `MARFA_BACKUP_PATH` is set, if a backup run fails, or the process ends, before the server has written the whole backup and a copy of each file it names but those it names in `lost_blobs`, then the server MUST NOT leave a file directly under `<MARFA_BACKUP_PATH>/backups/<instance id>/` whose name reads as a backup.

**Reason:** the server writes a backup under a name that begins with `.`, which no listing reads, and gives it its name only once it is whole and synced to the disk.

**Tests:** `compliance/backup-folder.test.ts › leaves no file a listing reads as a backup when a run fails partway or its process ends, and clears what it left at the next run`.

### `instance/backup-folder-leftovers`

Where `MARFA_BACKUP_PATH` is set, when the server runs a backup, the server MUST first remove what a process that ended left half written under `<MARFA_BACKUP_PATH>/backups/<instance id>/` and `<MARFA_BACKUP_PATH>/files/<instance id>/`.

**Tests:** `compliance/backup-folder.test.ts › leaves no file a listing reads as a backup when a run fails partway or its process ends, and clears what it left at the next run`.

### `instance/backup-folder-not-made`

Where `MARFA_BACKUP_PATH` is set, the server MUST NOT create the folder it names.

**Reason:** a folder on a disk that is not mounted is missing, and one made in its place would be on another disk. The server makes only the folders inside it, and only once it holds the instance's store marker, so an empty mount point fails a backup too.

**Tests:** `compliance/backup-folder.test.ts › counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back`, `› refuses to start with a backup folder inside its blob folder, or one that does not exist, and makes none`, `› refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-unmarked`

Where `MARFA_BACKUP_PATH` is set, while `<MARFA_BACKUP_PATH>/files/<instance id>/` does not hold the marker of the store the server recorded there, the server MUST NOT write into `<MARFA_BACKUP_PATH>`.

**Reason:** the folder may be a mount point whose disk is not mounted. A server that first started on an empty mount point on Linux wrote its marker into that mount point, so once the real disk mounts over it the marker is out of sight and each backup fails loudly; `POST /backups/folder/adopt` then starts afresh on the disk, as it does for a disk that replaced the old one.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-unmarked-error`

Where `MARFA_BACKUP_PATH` is set, if a backup run fails because `<MARFA_BACKUP_PATH>/files/<instance id>/` does not hold the marker of the store the server recorded there, then the server MUST name the command `marfa backups folder adopt` in the run's error message.

**Reason:** the message reaches the owner in the answer to `POST /backups` and in `backups.last_error` of `GET /health`, so the owner learns how to go on with a disk that replaced the old one.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt`

Where `MARFA_BACKUP_PATH` is set, when the private local command sends `POST /backups/folder/adopt` while the folder `MARFA_BACKUP_PATH` names exists and `<MARFA_BACKUP_PATH>/files/<instance id>/` holds no store marker, the server MUST take that files folder as a store of kind `folder` with an id no store had before, which it answers in `store_id`.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-forgets`

When the server adopts a backup folder under `instance/backup-folder-adopt`, the server MUST list the store it recorded at that files folder before as detached in `GET /blobs/stores`, with no copy in the copy record.

**Reason:** the copies went with the old disk. The next backup copies every file it names to the new store (`instance/backup-folder-copies`).

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-others`

When the server adopts a backup folder under `instance/backup-folder-adopt`, the server MUST NOT change a copy the copy record records in any other store.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-backups`

When the server adopts a backup folder under `instance/backup-folder-adopt`, the server MUST answer in `backups_forgotten` how many backups it had recorded in the store it recorded at that files folder before.

**Reason:** those backups went with the old disk, so the server stops holding the files they name under `instance/backup-keeps-files`, and a file only they named is purged as any other unnamed file.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-held`

If the private local command sends `POST /backups/folder/adopt` while `<MARFA_BACKUP_PATH>/files/<instance id>/` holds the marker of the store the server recorded there, then the server MUST answer `409 conflict`.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-missing`

If the private local command sends `POST /backups/folder/adopt` while the folder `MARFA_BACKUP_PATH` names does not exist, then the server MUST answer `503 blob_store_unavailable`.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-object-store`

Where `S3_BUCKET` is set, if the private local command sends `POST /backups/folder/adopt`, then the server MUST answer `409 conflict`.

**Reason:** an instance that backs up to an object store has no backup folder to adopt.

**Tests:** `compliance/backups.test.ts › refuses to adopt a backup folder on an instance that backs up to an object store`.

### `instance/backup-folder-adopt-foreign`

If the private local command sends `POST /backups/folder/adopt` while `<MARFA_BACKUP_PATH>/files/<instance id>/` holds the marker of a store other than the one the server recorded there, then the server MUST answer `409 conflict`.

**Reason:** the marker may be another instance's or another server's store, and adopting over it would take that store's files as this instance's own. The refusal leaves the marker as it is, and the error message says to remove it to adopt the folder afresh.

**Tests:** `compliance/backup-folder.test.ts › refuses to adopt a files folder that holds another store's marker, and leaves the marker as it is`.

### `instance/backup-folder-missing-start`

Where `MARFA_BACKUP_PATH` names a folder that does not exist, and the server has not attached a backup folder at that path before, the server MUST refuse to start.

**Reason:** the owner learns at once that the folder is wrong. A folder the server has attached before may be on a disk that is not mounted yet, so the server starts and each backup fails until it is back.

**Tests:** `compliance/backup-folder.test.ts › refuses to start with a backup folder inside its blob folder, or one that does not exist, and makes none`.

### `instance/backup-folder-inside`

Where `MARFA_BACKUP_PATH` names a folder inside the data directory or the blob folder, the server MUST refuse to start.

**Reason:** a backup there is lost with what it backs up.

**Tests:** `compliance/backup-folder.test.ts › refuses to start with a backup folder inside its blob folder, or one that does not exist, and makes none`.

### `instance/backup-one-destination`

Where both `S3_BUCKET` and `MARFA_BACKUP_PATH` are set, the server MUST refuse to start.

**Reason:** backups go to one place, so a restore knows where to read them.

**Tests:** `compliance/backup-folder.test.ts › refuses to start with both S3_BUCKET and MARFA_BACKUP_PATH set`.

### `instance/backup-holds-export`

When the server takes a backup, the server MUST put in it the items, edges, rows and instance lines that `GET /export?format=archive&state=any&files=false` would send a key that holds every permission and reaches every type at that moment, but for the `source` lines that `search-and-filters/archive-sources` gives a backup.

**Tests:** `compliance/backups.test.ts › puts one object in the prefix's backups folder for its instance, named for its created_at, holding what an archive export with state any and files false holds for a key that reaches everything`.

### `instance/backup-no-file-bytes`

When the server takes a backup, the server MUST name every file its items name under the manifest's `missing_blobs`, and carry no file's bytes.

**Reason:** the object store or the backup folder already holds a copy of each file the instance has replicated, so a backup that carried them would put every file there again each time.

**Tests:** `compliance/backups.test.ts › puts one object in the prefix's backups folder for its instance, named for its created_at, holding what an archive export with state any and files false holds for a key that reaches everything`.

### `instance/backup-lost-files-named`

When the server takes a backup, the server MUST name in the manifest's `lost_blobs` each file the backup names of which no attached store gives the bytes whole.

**Reason:** a restore then tells a file that was gone before the backup from one taken out of the backup folder after it. Where `MARFA_BACKUP_PATH` is set the server learns it as it copies each file to the folder; for the object store, from each store's answer for the copies the copy record names.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file in lost_blobs and in health, and clears health with the next backup that loses none`.

### `instance/backup-lost-files-put`

If a file a backup names is one no attached store gives the bytes of whole, then the server MUST still put the backup.

**Reason:** one lost file stops no backup of every item, edge and setting.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file in lost_blobs and in health, and clears health with the next backup that loses none`.

### `instance/backup-lost-files-answered`

When the private local command sends `POST /backups`, the server MUST answer in `blobs_lost` the hash of each file the manifest of the backup it put names in `lost_blobs`.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file in lost_blobs and in health, and clears health with the next backup that loses none`.

### `instance/backup-keeps-files`

While the server has recorded a backup it put in the object store or the backup folder, and has neither thinned that backup nor, while a later backup was recorded, found it missing from three or more consecutive listings of the store of which the first and the last are more than 31 days apart, the server MUST NOT purge a file that backup names.

**Reason:** Backups contain no file bytes and outlive the orphan grace. The server knows a backup only by its record and the store's listings, and one listing can leave out an object the store holds. So the server takes a backup to be gone only once several listings over longer than retention have left it out, and a listing that shows it again starts the count over.

**Tests:** `compliance/backup-files.test.ts › keeps a file a retained backup names once nothing else names it, across a restart, so a fresh server on the bucket restores it whole`.

### `instance/backup-no-credentials`

When the server takes a backup, the server MUST NOT put in it a key, an app's token, the owner's password or passkeys, the contents of `marfa.secrets`, or the object store's credentials.

**Reason:** a backup that leaked from the bucket gives nobody access to the instance or to the bucket.

**Tests:** `compliance/backups.test.ts › holds no key, token, password, secret or object store credential`.

### `instance/backup-whole`

Where `S3_BUCKET` is set, if a backup run fails, or the process ends, before the object store has taken the whole backup, then the server MUST NOT leave an object under `<S3_PREFIX>/backups/` that holds part of it.

**Reason:** a backup larger than one part goes up as a multipart upload, which no listing or read sees until it completes. An upload the process left unfinished still holds its parts in the bucket until a lifecycle rule or the store's own clean-up removes them.

**Tests:** `compliance/backup-faults.test.ts › leaves no object and no spool when killed while putting a backup larger than one part`.

### `instance/backup-slow-store`

When the object store takes a backup's bytes more slowly than the 30 seconds a client download may stall, the server MUST still put the whole backup.

**Reason:** the 30 seconds bounds a client that stopped reading. A backup's put has a deadline of its own that allows for a slow uplink.

**Tests:** `compliance/backup-faults.test.ts › puts a backup whole when the object store takes it more slowly than a client download may stall`.

### `instance/backup-spool-gone`

When the server starts after a process that ended during a backup, the server MUST hold none of that backup's spool on its disk.

**Tests:** `compliance/backup-faults.test.ts › leaves no object and no spool when killed while putting a backup larger than one part`.

### `instance/backup-interval`

Where `S3_BUCKET` or `MARFA_BACKUP_PATH` is set and `backup_interval_seconds` is above 0, the server MUST run a backup once that interval has passed since the last run ended.

**Tests:** `compliance/backups.test.ts › backs up on its interval with no request`.

### `instance/backup-off`

Where `backup_interval_seconds` is 0, the server MUST NOT run a backup that no request asked for.

**Tests:** `compliance/backups.test.ts › takes no scheduled backup while backup_interval_seconds is 0, and leaves backup out of the housekeeping listing`.

### `instance/backup-unchanged`

When a scheduled backup run finds that nothing a backup holds has changed since the last backup the server put, the server MUST NOT put another.

**Reason:** a backup costs a read of the whole database, and an instance that is not being written to has nothing new to keep.

**Tests:** `compliance/backups.test.ts › skips a scheduled run when nothing changed, counts a settings change as a change, and puts one when asked`.

### `instance/backup-setting-change`

The server MUST count a change to a stored setting as a change a backup holds.

**Tests:** `compliance/backups.test.ts › skips a scheduled run when nothing changed, counts a settings change as a change, and puts one when asked`.

### `instance/backup-run-now`

When the private local command sends `POST /backups`, the server MUST put a backup, whether or not anything has changed since the last.

**Tests:** `compliance/backups.test.ts › skips a scheduled run when nothing changed, counts a settings change as a change, and puts one when asked`.

### `instance/backup-one-at-a-time`

While a backup run is under way, when the private local command sends `POST /backups`, the server MUST answer `409 housekeeping_job_running` and start no second run.

**Tests:** `compliance/backup-faults.test.ts › runs one backup at a time, answering a second ask with 409 housekeeping_job_running`.

### `instance/backup-unreachable`

If the object store or the backup folder does not take a backup, then the server MUST count the failed run and run again at the next interval.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`, `› runs the next scheduled backup after a failed one when nothing has changed since the last backup put`, `compliance/backup-folder.test.ts › counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back`.

### `instance/backup-health-failing`

While the last backup run failed, the server MUST answer `GET /health` with `backups.status` `failing` and an overall `status` no better than `degraded`.

**Reason:** a backup that stops working is the failure an owner learns of only when they need the backup.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`, `compliance/backup-folder.test.ts › counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back`.

### `instance/backup-health-lost`

While the last backup run put a backup whose manifest names a file in `lost_blobs`, the server MUST answer `GET /health` with `backups.status` `failing`.

**Reason:** a lost file is a failure the owner learns of at once, and the run counts among `backups.failures`.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file in lost_blobs and in health, and clears health with the next backup that loses none`.

### `instance/backup-health-lost-named`

While the last backup run put a backup whose manifest names files in `lost_blobs`, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST name the first ten of those files in `backups.last_error`.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file in lost_blobs and in health, and clears health with the next backup that loses none`.

### `instance/backup-health-detail`

When a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST include in `backups` the last backup put, how many runs in a row have failed, and the last failure.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`.

### `instance/backup-health-destination`

Where `S3_BUCKET` or `MARFA_BACKUP_PATH` is set, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.destination` as `bucket` or `folder`, for the one that is set.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`, `compliance/backup-folder.test.ts › says in health that backups go to a folder`.

### `instance/backup-health-off`

Where neither `S3_BUCKET` nor `MARFA_BACKUP_PATH` is set, the server MUST answer `GET /health` with `backups.status` `off` and `backups.reason` `no_backup_destination`.

**Tests:** `compliance/backups.test.ts › says in health that backups are off on an instance with nowhere to put them, and answers 409 no_backup_destination at each door`.

### `instance/backup-health-store-failing`

While the object store or the backup folder does not take the copies that wait for it, the server MUST answer `GET /health` with `backups.status` `failing` and an overall `status` no better than `degraded`, whether or not `backup_interval_seconds` is 0.

**Reason:** a store that stops answering is the failure an owner learns of only when the next backup fails or a restore needs the files, and an interval of 0 does not stop files waiting for their second copy.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/backup-health-store-named`

While the object store or the backup folder does not take the copies that wait for it, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.store_error` with the reason as text.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/backup-health-copies-waiting`

Where `S3_BUCKET` or `MARFA_BACKUP_PATH` is set, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.copies_waiting` with the number of files that waited for their copy in the destination when `blob-replicate` last ran.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says nothing in health or attention while the folder answers and no file waits for its copy`.

### `instance/backup-health-folder-disk`

While the disk of the backup folder is not there, the server MUST answer `GET /health` with `backups.status` `failing` without waiting for a backup run or a run of `blob-replicate`.

**Reason:** a disk that was unplugged or did not mount is the commonest way a folder backup stops, and the owner should hear of it when they look, not at the next run.

**Tests:** `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/backup-health-store-answers-in-time`

While an attached store leaves the questions of `blob-replicate` unanswered, the server MUST answer `GET /health` within three seconds.

**Reason:** health reads what the last run found and never asks the object store itself, so a store that hangs cannot make the report that names it hang too.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`.

### `instance/backup-health-folder-answers-in-time`

While a look at the backup folder's disk does not answer, the server MUST answer `GET /health` within three seconds with `backups.status` `failing` and a `backups.store_error` that says the folder did not answer in time.

**Reason:** a mount that hangs holds the look for as long as it likes, and the report that names it must not hang with it.

**Tests:** `compliance/backup-folder.test.ts › answers health within three seconds and says the folder is not answering while a look at its mount hangs`.

### `instance/backup-health-store-clears`

When the object store or the backup folder takes copies again and a run of `blob-replicate` has ended `ok`, the server MUST answer `backups.store_error` as `null`.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/backup-health-quiet`

Where a destination is set, while it takes copies, no file waits for one and the last backup run was whole, the server MUST answer `GET /health` with `backups.status` `ok` and `backups.store_error` `null`.

**Reason:** a report that is never empty is not read.

**Tests:** `compliance/backup-folder.test.ts › says nothing in health or attention while the folder answers and no file waits for its copy`.

### `instance/backup-no-bucket`

Where neither `S3_BUCKET` nor `MARFA_BACKUP_PATH` is set, when the private local command sends `GET /backups`, `POST /backups`, `POST /backups/folder/adopt` or `POST /backups/{instance_id}/{name}/restore`, the server MUST answer `409 no_backup_destination`.

**Tests:** `compliance/backups.test.ts › says in health that backups are off on an instance with nowhere to put them, and answers 409 no_backup_destination at each door`.

### `instance/backups-owner-only`

When a key or an app's token sends `GET /backups`, `POST /backups`, `POST /backups/folder/adopt` or `POST /backups/{instance_id}/{name}/restore`, the server MUST answer `403 forbidden`.

**Reason:** a backup holds every item of the instance, which no grant of a key or an app covers.

**Tests:** `compliance/backups.test.ts › lists the backups newest first to the owner, and refuses a key at each door`, `compliance/backup-folder.test.ts › refuses a key at the adopt door`.

### `instance/backups-list`

When the private local command sends `GET /backups`, the server MUST answer with each backup in an instance's folder under `<S3_PREFIX>/backups/` or `<MARFA_BACKUP_PATH>/backups/`, this instance's and any other's, newest first, each with its `name`, `instance_id`, `created_at` and `size_bytes`.

**Reason:** a fresh server started on the prefix of an instance it replaces restores that instance's backup.

**Tests:** `compliance/backups.test.ts › lists the backups newest first to the owner, and refuses a key at each door`, `› restores a named backup into a fresh server on the same bucket, files included`, `compliance/backup-folder.test.ts › restores a named backup into a fresh server on another data path from the folder alone, every line and file`.

### `instance/backup-restore`

When the private local command sends `POST /backups/{instance_id}/{name}/restore`, the server MUST restore the backup of that name in that instance's folder from the object store or the backup folder as `POST /restore` restores the same archive.

**Reason:** the server reads the backup itself, so a restore after a move needs no copy of the backup on the owner's computer.

**Tests:** `compliance/backups.test.ts › restores a named backup into a fresh server on the same bucket, files included`, `compliance/backup-folder.test.ts › restores a named backup into a fresh server on another data path from the folder alone, every line and file`.

### `instance/backup-folder-restore-files`

Where `MARFA_BACKUP_PATH` is set, when the private local command sends `POST /backups/{instance_id}/{name}/restore`, the server MUST read each file the backup names that the instance does not hold from `<MARFA_BACKUP_PATH>/files/<instance_id>/`.

**Tests:** `compliance/backup-folder.test.ts › restores a named backup into a fresh server on another data path from the folder alone, every line and file`.

### `instance/backup-folder-restore-lacking`

Where `MARFA_BACKUP_PATH` is set, if a file the backup names, which the instance that took it held and the manifest does not name in `lost_blobs`, is held whole neither in `<MARFA_BACKUP_PATH>/files/<instance_id>/` nor by the restoring instance, then the server MUST answer `POST /backups/{instance_id}/{name}/restore` with `409 backup_files_missing` and each such file's hash in `details.missing_blobs`.

**Reason:** a restore that left a file out would lose it without a word. The refusal restores nothing; the backup's archive file, restored through `POST /restore`, restores the rest without those files.

**Tests:** `compliance/backup-folder.test.ts › refuses a restore with 409 backup_files_missing naming each file the folder does not hold, and restores nothing`, `› refuses a restore that lacks a file before it reads any file from the folder`, `› refuses a restore that meets a copy altered to the same size, names it, and places no file`.

### `instance/backup-folder-restore-first`

Where `MARFA_BACKUP_PATH` is set, if the server answers `POST /backups/{instance_id}/{name}/restore` with `409 backup_files_missing`, then the server MUST NOT hold in its blob folder a file it read from the backup folder for that restore.

**Reason:** the server works out which files it lacks before it reads any, so a refused restore costs neither the reading nor the room. A copy that proves altered or gone only when it is read refuses the restore before any file is placed.

**Tests:** `compliance/backup-folder.test.ts › refuses a restore that lacks a file before it reads any file from the folder`, `› refuses a restore that meets a copy altered to the same size, names it, and places no file`.

### `instance/backup-folder-restore-held`

Where `MARFA_BACKUP_PATH` is set, when the private local command sends `POST /backups/{instance_id}/{name}/restore`, the server MUST NOT read from the backup folder a file of which an attached store of the restoring instance holds a copy whole.

**Reason:** a rollback on the instance that took the backup then needs room only for the files it lacks.

**Tests:** `compliance/backup-folder.test.ts › restores a backup over the instance that took it with room for none of the files it already holds`.

### `instance/backup-folder-restore-lost`

Where `MARFA_BACKUP_PATH` is set, if a file the manifest names in `lost_blobs` is held whole neither in `<MARFA_BACKUP_PATH>/files/<instance_id>/` nor by the restoring instance, then the server MUST NOT refuse `POST /backups/{instance_id}/{name}/restore` for that file.

**Reason:** the file was gone before the backup was taken, so no folder could restore it. The restore names it in `blobs_missing`, as a restore of the same archive through `POST /restore` does.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it`.

### `instance/backup-restore-unknown`

If `POST /backups/{instance_id}/{name}/restore` names no backup the object store holds directly under `<S3_PREFIX>/backups/<instance_id>/`, or the backup folder holds directly under `<MARFA_BACKUP_PATH>/backups/<instance_id>/`, then the server MUST answer `404 backup_not_found`.

**Tests:** `compliance/backups.test.ts › answers 404 backup_not_found for a name the object store does not hold, or one that is not a backup's`.

### `instance/backup-thinning-day`

When the server has put a backup, the server MUST keep every backup of its own taken in the 24 hours before that backup was taken.

**Reason:** the day is counted from when the backup was taken, so a slow put deletes nothing it would otherwise keep.

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup of this instance`, `› keeps every backup taken in the day before the one just put, however long the put took`.

### `instance/backup-thinning-daily`

When the server has put a backup, the server MUST keep, of its own backups taken between one and 31 days before, the newest of each UTC day, and delete the others.

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup of this instance`.

### `instance/backup-thinning-old`

When the server has put a backup, the server MUST delete each of its own backups taken more than 31 days before.

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup of this instance`.

### `instance/backup-thinning-only-backups`

When the server thins its backups, the server MUST NOT delete an object or file other than a backup it recorded putting, listed directly under `<S3_PREFIX>/backups/<instance id>/` or `<MARFA_BACKUP_PATH>/backups/<instance id>/`, where `<instance id>` is its own.

**Reason:** the prefix also holds the instance's files, another instance on the same prefix keeps its own backups, and the bucket may hold objects the instance did not write. A backup in its own folder that its database never recorded, such as one put after the image of the data directory the server started on, is kept (`instance/backup-found-keeps-files`).

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup of this instance`, `compliance/bucket-sharing.test.ts › keeps the files a backup in its folder names when its database never recorded that backup, and deletes only the backups it recorded`.

### `instance/backup-found-keeps-files`

While a backup that the server did not record putting is listed directly under `<S3_PREFIX>/backups/<instance id>/` or `<MARFA_BACKUP_PATH>/backups/<instance id>/`, where `<instance id>` is its own, the server MUST NOT purge a file that backup's manifest names.

**Reason:** a server started on an image of its data directory does not record the backups put after the image, and those backups restore their files from the bucket. Such a backup stops holding its files as `instance/backup-keeps-files` lets a recorded one go: once three or more consecutive listings, the first and the last more than 31 days apart, have left it out. Where the server cannot list or read that folder, a file the object store holds a copy of is not purged.

**Tests:** `compliance/bucket-sharing.test.ts › keeps the files a backup in its folder names when its database never recorded that backup, and deletes only the backups it recorded`.

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

**Tests:** `compliance/database-file.test.ts › moves every acknowledged write into the database file when stopped on %s`.

### `instance/stop-reader-keeps-writes`

While another process holds a read transaction on the database, when the server is stopped on `SIGTERM` or `SIGINT`, the server MUST keep every write it acknowledged, in the file or in the log beside it, so that the next start answers it.

**Reason:** a process that holds a read transaction, such as a replicator, can keep the log from being moved into the file, and the next start applies the log as it always does.

**Tests:** `compliance/database-file.test.ts › leaves the writes in the log while another connection holds a snapshot, and the next start answers every one of them`.

### `instance/copy-under-reader`

When the server starts on a copy of the data directory that read the database file, then the log, then the blobs, one after another, while a read transaction on the database was held from before the first read until after the last, the server MUST open the copy and answer every write it had acknowledged before that transaction began.

**Reason:** a copy that reads the files one after another with no such transaction can take the database file before a checkpoint and the log after it, and so hold a database that is not whole. The blobs are read last so that every blob a copied row names is in the copy.

**Tests:** `compliance/database-file.test.ts › restores every write acknowledged before the first read from a copy taken file by file under a held read transaction, and loses writes from the same copy without one`.

### `instance/salt-refuses-credentials`

When the server starts on a data directory with a `MARFA_KEY_SALT` other than the one its keys were minted under, the server MUST answer `401 unauthorized` to a request that carries an ordinary key or an app's access token, minted under the original salt.

**Reason:** the database holds a hash of each key, made with the salt, and the salt is a setting outside the data directory. A restore without it has every row and no credential that opens one.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses the working key, the management key and an app's access token with 401 unauthorized, and accepts all three again under the original salt`, `compliance/backup-restore.test.ts › refuses a key it holds when started with a different MARFA_KEY_SALT`.

### `instance/salt-original-accepted`

When the server starts again under the `MARFA_KEY_SALT` that an ordinary key or an app's access token was minted under, the server MUST accept that credential as it did before a start under another salt refused it.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses the working key, the management key and an app's access token with 401 unauthorized, and accepts all three again under the original salt`.

### `instance/salt-no-setup-proof`

When the server starts on a claimed database, under a `MARFA_KEY_SALT` other than the one its keys were minted under, the server MUST NOT print a setup code.

**Reason:** the completed claim is independent of key hashes, so an incorrect salt cannot reopen setup.

**Tests:** `compliance/instance-lifecycle.test.ts › keeps the completed claim and offers no setup code or unauthenticated key mint under another MARFA_KEY_SALT`.

### `instance/salt-no-unauthenticated-mint`

When the server starts on a claimed database, under a `MARFA_KEY_SALT` other than the one its keys were minted under, and a request that carries no credential sends `POST /keys`, the server MUST answer `401 unauthorized`.

**Tests:** `compliance/instance-lifecycle.test.ts › keeps the completed claim and offers no setup code or unauthenticated key mint under another MARFA_KEY_SALT`.

### `instance/claim-survives-missing-credentials`

When owner account rows or ordinary key rows disappear from a claimed database, the server MUST retain the completed claim after restart.

**Reason:** Missing credentials do not establish authority to replace the owner.

**Tests:** `compliance/database-file.test.ts › does not reopen setup after deleting %s rows`.

### `instance/claim-missing-owner-recovery`

When a claimed instance's owner account is missing, the server MUST refuse local password recovery with `404 owner_not_found`.

**Tests:** `compliance/database-file.test.ts › does not reopen setup after deleting %s rows`.

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

**Tests:** `compliance/health.test.ts › answers 503 with blob storage down when the disk store refuses, and 200 once it answers`, `› answers the disk component degraded, never down, and blob storage down, when the free space cannot be read and the store refuses, and ok once both are cleared`.

### `instance/health-contention-degraded`

If the write that the `database_write` probe makes is refused with `write_contention`, then the server MUST answer the `database_write` component as `degraded`, not `down`.

**Reason:** a lock held past the write wait is a busy instance rather than a broken one. An archive restore holds it until it commits (`search-and-filters/restore-writers-wait`).

**Tests:** `compliance/health.test.ts › answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-timeout-degraded`

If a component's probe has given no answer within two seconds, then the server MUST answer that component as `degraded`.

**Reason:** a refusal is known and a silence is not.

**Tests:** `compliance/health.test.ts › answers the write component degraded and the status 200 when the probe has given no answer within two seconds, and ok once the lock is released`, `compliance/health.test.ts › answers the disk and blob storage components degraded within two seconds when the filesystem does not answer, while other requests are served, and ok once it does`.

### `instance/health-disk-down`

If the bytes available on the database's volume and on the disk store's volume can both be read, and the lesser of the two is below 1 MiB, then the server MUST answer the `disk` component of `GET /health` as `down`.

**Tests:** `compliance/disk-space-faults.test.ts › answers the disk component down, and the status 503, when the lesser of the two volumes has under 1 MiB`.

### `instance/health-disk-degraded`

If the bytes available on the database's volume and on the disk store's volume can both be read, and the lesser of the two is at least 1 MiB and below the greater of 64 MiB and the instance's disk reserve (`disk_reserve_bytes`, 128 MiB unless set), then the server MUST answer the `disk` component of `GET /health` as `degraded`.

**Tests:** `compliance/disk-space-faults.test.ts › answers the disk component degraded, and the status 200, when the lesser of the two volumes has 1 MiB or more and under 64 MiB`, `compliance/disk-reserve-health.test.ts › answers the disk component degraded below a reserve above 64 MiB, and ok at it`.

### `instance/health-disk-unknown`

If the bytes available on either the database's volume or the disk store's volume cannot be read, then the server MUST answer the `disk` component of `GET /health` as `degraded`, never `down`.

**Reason:** only a measured shortage is a failure.

**Tests:** `compliance/health.test.ts › answers the disk component degraded, never down, and blob storage down, when the free space cannot be read and the store refuses, and ok once both are cleared`.

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

When a request without local authority or `instance.read` sends `GET /health`, the server MUST NOT answer an `error` on any component.

**Reason:** the text is the database's or the operating system's own and carries paths and driver detail.

**Tests:** `compliance/health.test.ts › is given to a key with instance.read and withheld without that permission`.

### `instance/health-error-key-table`

While the database cannot read the table of keys, the server MUST NOT answer an `error` on any component of `GET /health` to a request bearing an ordinary key that cannot be verified.

**Reason:** a bearer credential that the server cannot verify is not given the text.

**Tests:** `compliance/health.test.ts › is withheld from bearer credentials while the database cannot look keys up`.

### `instance/health-unknown-key`

When a request that carries a credential the instance does not hold sends `GET /health`, the server MUST answer it as it answers a request that carries no credential.

**Tests:** `compliance/instance.test.ts › answers /health to a request that names a key the instance does not hold as it does to one that names none`, `compliance/health.test.ts › is given to a key with instance.read and withheld without that permission`.

### `instance/health-housekeeping`

When a credential holding `instance.read` sends `GET /health`, the server MUST answer a `housekeeping` object with `failed`, the name, finish time and error of each job whose last run failed (`null` when the schedule cannot be read in time), and `unreadable_settings`, the keys of the stored settings that no longer read.

**Reason:** an owner needs to see that background work has stopped, or that a setting has fallen back to its default, without reading every job. A request without `instance.read` is given no such object, as it is given no `error`.

**Tests:** `compliance/health.test.ts › names a job whose last run failed to a key with instance.read, and clears it once the job runs well`, `compliance/health.test.ts › names a stored setting that no longer reads, and the setting stands at its default`.

### `instance/health-housekeeping-withheld`

When a request without `instance.read` sends `GET /health`, the server MUST answer without a `housekeeping` object.

**Tests:** `compliance/health.test.ts › gives no housekeeping object to a request without instance.read, though a job has failed`.

## A database this build did not write

A database records the schema version of the build that wrote it. The server starts on a database that holds its own schema, and upgrades one an earlier build wrote whole, after copying it. It refuses to start, before changing the database file, on one a newer build wrote and on one whose schema is not the one its version declares.

### `instance/upgrade-refuses-newer`

If the server starts on a database that records a schema version later than its own, then the server MUST refuse to start.

**Reason:** an earlier build does not know what a later one changed, so it cannot read the file safely.

**Tests:** `compliance/database-file.test.ts › refuses to start on a database a newer build wrote, and leaves it as it was`.

### `instance/upgrade-refuses-schema`

If the server starts on a database in which a table, an index or a trigger the server declares differs from the server's definition of it, in which a table the server declares carries an index or a trigger the server does not declare, or in which a table the server declares is missing while another of its own tables holds a row, then the server MUST refuse to start.

**Reason:** an index over a missing column fails with a driver error after the file's header has been rewritten, and a missing column fails nowhere until a request meets it, so the refusal is made before either. A database that lacks tables and holds no row is completed under `instance/unfinished-completed`.

**Tests:** `compliance/database-file.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`.

### `instance/upgrade-migrates-older`

When the server starts on a database at an earlier schema version of its own, whose schema is the one that version declares, the server MUST apply every later migration in one transaction before it takes a request.

**Tests:** waiting on #2802.

### `instance/upgrade-copy-before`

When the server upgrades a database that holds a row, the server MUST write a copy of the database as it stands, to the file `<database file>.before-upgrade` beside it, before it applies any migration.

**Reason:** an upgrade that goes wrong, or a build the owner wants to go back from, leaves the database as the earlier build wrote it.

**Tests:** waiting on #2802.

### `instance/upgrade-copy-refused`

If the copy before an upgrade cannot be written, or would leave less free space on the database's volume than `disk_reserve_bytes`, then the server MUST refuse to start and leave the database file byte for byte as it found it.

**Tests:** waiting on #2802.

### `instance/upgrade-copy-last`

When the server has written a copy before an upgrade, the server MUST keep no copy from before an earlier upgrade.

**Reason:** one copy is enough to go back one build, and each copy is as large as the database.

**Tests:** waiting on #2802.

### `instance/upgrade-names-cause`

When the server refuses to start on a database under `instance/upgrade-refuses-schema` or `instance/upgrade-refuses-newer`, the server MUST name in its log message what it found and the path of the database file.

**Tests:** `compliance/database-file.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses to start on a database a newer build wrote, and leaves it as it was`.

### `instance/upgrade-leaves-file`

If the server refuses to start on a database under `instance/upgrade-refuses-schema` or `instance/upgrade-refuses-newer`, then the server MUST leave the database file byte for byte as it found it.

**Reason:** SQLite may create an empty `-wal` file and a `-shm` file beside a database it opens and then refuses, and neither holds anything the database holds.

**Tests:** `compliance/database-file.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`, `› refuses to start on a database a newer build wrote, and leaves it as it was`.

### `instance/upgrade-opens-no-port`

If the server refuses to start on a database under `instance/upgrade-refuses-schema` or `instance/upgrade-refuses-newer`, then the server MUST NOT listen on its port.

**Tests:** `compliance/database-file.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses to start on a database a newer build wrote, and leaves it as it was`.

### `instance/upgrade-way-forward`

When the server refuses to start on a database under `instance/upgrade-refuses-schema`, the server MUST say in its log message that the way forward is to export with the build that wrote the file, start on a fresh file and restore the archive there.

**Reason:** no update reaches such a file, and an owner told only that the file was refused goes looking for the cause in the wrong place.

**Tests:** `compliance/database-file.test.ts › says in its refusal to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse`.

### `instance/upgrade-restore-may-refuse`

When the server refuses to start on a database under `instance/upgrade-refuses-schema`, the server MUST say in its log message that the restore it names can refuse an archive the writing build did not write.

**Reason:** the message does not promise a restore the contract does not.

**Tests:** `compliance/database-file.test.ts › says in its refusal to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse`.

### `instance/upgrade-exit-78`

If the server refuses to start on a database under `instance/upgrade-refuses-schema` or `instance/upgrade-refuses-newer`, then the server MUST exit with status 78.

**Reason:** what supervises the process tells a stop that starting again will not mend from one that it may.

**Tests:** `compliance/database-file.test.ts › exits with status 78, not 1, when it refuses a database this build did not write`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`, `› refuses to start on a database a newer build wrote, and leaves it as it was`.

### `instance/upgrade-exit-1`

If the server stops for a failure to start that is not a refusal under `instance/upgrade-refuses-schema` or `instance/upgrade-refuses-newer`, then the server MUST exit with status 1.

**Reason:** a failed start that starting again may mend, such as a port in use, is not told apart from a refused database by anything but the status.

**Tests:** `compliance/database-file.test.ts › exits with status 1, not 78, when the database file is not a database at all`, `compliance/instance-lifecycle.test.ts › exits with status 1, not 78, when the port it was given is already taken`.

## Stored times

### `instance/stored-time-form`

The server MUST store every time it keeps as RFC 3339 UTC text with milliseconds, as `YYYY-MM-DDTHH:mm:ss.sssZ`.

**Reason:** text in this form sorts in the order of its instants for the years 0000 to 9999, so the database compares and orders times as instants, and it is the form every time is answered in. A time an RFC fixes as whole seconds on the wire, such as `expires_in`, is still answered that way.

**Tests:** `compliance/stored-times.test.ts › keeps every time in its database as UTC text with milliseconds`.

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

When the server is stopped, the server MUST let the bulk action, the housekeeping runs and the webhook delivery attempts in flight finish before it closes its storage, unless one outlives the stop's wait for it.

**Reason:** a run or an attempt cut off mid-write leaves its record unwritten. An attempt the stop's wait cuts off stays `pending` and is made again after the next start.

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

While the server runs an archive export, an archive restore, an NDJSON export, a bulk action, the blob orphan sweep, version thinning or the retirement of inactive grants, the server MUST answer `GET /health` between two steps of the job, without waiting for the job to end.

**Reason:** a long job that held up other requests would stop every request, `/health` included, for as long as it runs, and a container whose health check waits five seconds restarts a server that is working. The fixture checks the order of the answer and a later step of the job, which the server records, where a time would measure the machine. A restore also holds the write lock, which makes the write probe `degraded` and is not a held process.

**Tests:** `compliance/long-job-health-restore.test.ts › is answered between the first and the last line of an archive restore`, `compliance/long-job-health.test.ts › is answered between two pages of an archive export`, `› is answered between two pages of an NDJSON export`, `› is answered between two chunks of a bulk action`, `› is answered between two pages of the blob orphan sweep`, `› is answered between two pages of version thinning`, `compliance/long-job-health-credentials.test.ts › is answered between two grants of the retirement of inactive grants`.

## Open connections

The public listener holds at most `MARFA_MAX_CONNECTIONS` connections open, and at most `MARFA_MAX_CONNECTIONS_PER_ADDRESS` for one caller address. The private control socket has no bound. Each open connection takes a file descriptor, so at start the server raises its open-file limit as far as the system allows. Where that limit still leaves fewer than 256 descriptors beside `MARFA_MAX_CONNECTIONS`, for the database, blob files, outbound sockets and the connections being turned away, the server lowers both caps to fit and logs the caps it holds. A cap named below is the cap the server holds.

### `instance/connections-listener-cap`

While the public listener holds `MARFA_MAX_CONNECTIONS` connections open, when another connection arrives, the server MUST end it before it reads a request, answering `503 too_many_connections` with a `Retry-After` of 5 unless 64 turned-away connections are already being answered or the answer cannot be written within one second, when it closes the connection with no answer.

**Reason:** A `503` tells a client that the server, and not its request, cannot take the connection now, and a client already retries a `5xx` without counting it against a write (`queue-and-verdicts/environmental-uncounted`). The bound on answers being written keeps a flood of refused connections from holding the descriptors the cap protects.

**Tests:** `compliance/connection-caps.test.ts › turns a connection away past the listener's cap and serves again once one closes`.

### `instance/connections-listener-freed`

When an open connection on the public listener ends, the server MUST serve a new connection that the listener's cap had turned away.

**Tests:** `compliance/connection-caps.test.ts › turns a connection away past the listener's cap and serves again once one closes`.

### `instance/connections-address-cap`

While one caller address holds `MARFA_MAX_CONNECTIONS_PER_ADDRESS` connections open on the public listener, when that address opens another, the server MUST end it before it reads a request, answering `503 too_many_connections` with a `Retry-After` of 5 unless 64 turned-away connections are already being answered or the answer cannot be written within one second, when it closes the connection with no answer.

**Reason:** One caller, or one program that leaks connections, cannot take every place the listener has.

**Tests:** `compliance/connection-caps.test.ts › turns an address away past its share and serves the same address again once one closes`.

### `instance/connections-address-own`

While one caller address is held at its cap of connections, the server MUST serve a connection from another address.

**Tests:** `compliance/connection-caps.test.ts › turns an address away past its share and serves the same address again once one closes`.

### `instance/connections-proxy-total`

Where the server believes the forwarded address of a peer, the server MUST count that peer's connections in the listener's cap alone.

**Reason:** A proxy holds one connection for many callers, and the server cannot tell the callers apart before it reads a request, so a per-address cap would hold back every caller behind the proxy.

**Tests:** `compliance/connection-caps.test.ts › counts a believed proxy's connections in the listener's cap alone`.

## Bodies on the public listener

The public listener reads most request bodies whole before it answers. `POST /blobs`, `POST /restore`, `PUT /owner/picture`, `PUT /profile/picture` and a delivery to an inbound endpoint stream their bodies instead, under the idle limits their own chapters give.

### `instance/body-deadline`

If the public listener reads a request body whole, other than one sent to `POST /blobs`, `POST /restore`, `PUT /owner/picture`, `PUT /profile/picture` or an inbound endpoint, and the body has not arrived whole 180 seconds after the request's head, then the server MUST answer `408 request_timeout`.

**Reason:** a body at the 16 MiB default of `max_bulk_request_bytes` takes about 134 seconds over a 1 Mbit/s link, and 180 seconds allows for that while a client that stops sending cannot hold the memory its body takes.

**Tests:** `compliance/public-body.test.ts › is answered 408 request_timeout with the connection closed when it has not arrived by the deadline, and is taken when it arrives in time`, `› answers 401 unauthorized to a declared body before any of it is sent, when no credential comes with it`.

### `instance/body-deadline-closes`

When the server answers `408 request_timeout` to a body that has not arrived by the deadline `instance/body-deadline` gives, the server MUST close the connection.

**Reason:** the rest of the body may still be on its way, and a connection kept open would read it as the next request.

**Tests:** `compliance/public-body.test.ts › is answered 408 request_timeout with the connection closed when it has not arrived by the deadline, and is taken when it arrives in time`.

### `instance/body-deadline-streamed`

While bytes of a `POST /blobs` body keep arriving within the upload's idle limit, the server MUST NOT answer `408 request_timeout`, however long the whole body takes.

**Tests:** `compliance/public-body.test.ts › leaves a blob upload whose parts keep arriving to its own idle limit, past the deadline`.

### `instance/credential-before-body`

If a request with a body is sent to an operation that requires a credential and carries no credential, or one that is malformed, unknown, expired or revoked, then the server MUST answer `401 unauthorized` before it reads the body.

**Reason:** a caller with no credential cannot make the server hold a body the operation would refuse once it has arrived.

**Tests:** `compliance/public-body.test.ts › answers 401 unauthorized to a declared body before any of it is sent, when no credential comes with it`, `› answers 401 naming the expiry to a key past its expires_at before any of the body is sent`, `compliance/well-formed-text.test.ts › answers a missing credential 401 before it reads a body holding a surrogate escape with no partner`, `compliance/connector-check-order.test.ts › answers a declared body over the cap 413 before a missing credential's 401, and a missing credential 401 before a body nested too deep`.

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

### `instance/root-page-signed-in`

When the server answers `GET /` with an HTML page to a request that carries the owner's live browser session, the server MUST name the owner's email on the page.

**Reason:** a person who signs in is sent to the root, and a page that still asks them to sign in tells them nothing about what happened.

**Tests:** `compliance/owner-pages.test.ts › names the signed-in owner at the root, with the passkeys page and sign-out, and asks anyone else to sign in`.

### `instance/root-page-signed-in-ways`

When the server answers `GET /` with an HTML page to a request that carries the owner's live browser session, the server MUST put on the page a link to `/auth/owner/passkeys` and a form that posts to `/auth/sign-out`.

**Reason:** Marfa has no owner console, so the passkeys page and signing out are all a signed-in browser can do here.

**Tests:** `compliance/owner-pages.test.ts › names the signed-in owner at the root, with the passkeys page and sign-out, and asks anyone else to sign in`.

### `instance/root-page-session-unused`

When the server answers `GET /` with an HTML page to a request that carries the owner's live browser session, the server MUST NOT send a `Set-Cookie` header.

**Reason:** Looking at the root is not a use of the session, so it neither extends the session nor sends its cookie again.

**Tests:** `compliance/owner-pages.test.ts › sends a signed-in browser no cookie from the root`.

### `instance/root-page-signed-out`

When the server answers `GET /` with an HTML page to a request that carries no live owner browser session, the server MUST put on the page a link to `/auth/sign-in`.

**Tests:** `compliance/owner-pages.test.ts › names the signed-in owner at the root, with the passkeys page and sign-out, and asks anyone else to sign in`.

## Pages

The root is not the only page. The sign-in, consent and device approval pages are pages too, and so is what a refusal or an unserved path renders for a request that accepts `text/html`.

### `instance/page-policy`

When the server answers with an HTML page, a page a refusal renders and one given before any operation has run included, the server MUST send a `Content-Security-Policy`.

**Reason:** the sign-in, consent, device approval and error pages act on the owner's signed-in session, so a policy limits what an injection into one of them can do. A refusal renders a page like any other, so a refusal a middleware makes before any operation has run carries the policy too.

**Tests:** `compliance/page-policy.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `compliance/instance.test.ts › sends the page policy on the page a refusal renders, and none on the refusal a program is sent`.

### `instance/page-policy-nonce-only`

The server MUST write the `Content-Security-Policy` of an HTML page so that it allows a script or a style only when it carries the nonce the policy names.

**Reason:** no script or style source is allowed by origin, `'self'` included, because the same origin serves a blob's bytes at its link without a credential and under the type its uploader named, and a source allowed by origin would run them. A blob's bytes are not a page of this server and keep the policy of `blobs/download-sandbox`.

**Tests:** `compliance/page-policy.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `compliance/instance.test.ts › names in its policy the one nonce its page carries, a new one on each answer at one address`.

### `instance/page-policy-default-none`

The server MUST write the `Content-Security-Policy` of an HTML page with `default-src 'none'`.

**Tests:** `compliance/page-policy.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`.

### `instance/page-policy-images-other`

When the server writes the `Content-Security-Policy` of an HTML page, the server MUST write the page's `img-src` as `data:`, whether or not the page has a `connect-src`.

**Reason:** no page shows a picture from the server's address, so none has a reason to load an image from it.

**Tests:** `compliance/page-policy.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`.

### `instance/page-policy-json-none`

When the server answers the root or a refusal as JSON, the server MUST NOT send a `Content-Security-Policy` on it.

**Reason:** the policy is the page's, and a JSON answer is not a page.

**Tests:** `compliance/page-policy.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `compliance/instance.test.ts › sends the page policy on the page a refusal renders, and none on the refusal a program is sent`.

### `instance/page-nonce-fresh`

The server MUST name in the `Content-Security-Policy` of each HTML page a nonce of its own, different from the nonce of every other page it answers.

**Reason:** a nonce that repeats across responses can be read from one page and carried by an injection into the next.

**Tests:** `compliance/page-policy.test.ts › sends a content security policy with every HTML page and a nonce of its own with each`, `compliance/instance.test.ts › sends the page policy on the page a refusal renders, and none on the refusal a program is sent`, `› names in its policy the one nonce its page carries, a new one on each answer at one address`.

### `instance/page-nonce-carried`

When the server answers with an HTML page, the server MUST carry in the page the nonce its own policy names, and no other.

**Reason:** a page that carries another nonce does not work under its policy.

**Tests:** `compliance/instance.test.ts › names in its policy the one nonce its page carries, a new one on each answer at one address`.

## An unfinished database

A database can hold some of the server's tables and no rows, such as one a start stopped partway through making its tables leaves.

### `instance/unfinished-completed`

When the server starts on a database that holds some of its own tables, lacks the rest, differs from its schema in nothing else, and none of the tables it creates holds a row, the server MUST create the tables it lacks and start.

**Reason:** nothing is written to the server's own tables before the last is made, so none holds a row, and refusing the database would send an owner looking for another build when no other build wrote it.

**Tests:** `compliance/database-file.test.ts › creates the tables it lacks and remains unclaimed until a real claim`.

### `instance/unfinished-ends-fresh`

When the server completes an unfinished database, the server MUST leave it holding what a new database holds, unclaimed, with no key, no item and an `instance_id` of its own.

**Tests:** `compliance/database-file.test.ts › creates the tables it lacks and remains unclaimed until a real claim`.

## Durability

A write the server confirms is one a client may rely on.

### `instance/confirmed-write-durable`

When the server answers a write with a success status, the server MUST have synced that write to stable storage, so that it is present after the machine loses power or the server's process is killed.

**Reason:** a commit that waits for its data to reach the drive, not the operating system's cache, is the only one a power cut or a kernel panic cannot take back. On macOS a plain `fsync` leaves the data in the drive's cache, so the server asks for a full flush there. A page of `POST /items/bulk` or `POST /edges/bulk` is one transaction whatever its `atomic` says, so it pays for one sync.

**Tests:** `compliance/durability.test.ts › syncs each commit in full on every connection`, `› keeps every write it confirmed through kills at random points, and leaves a file that checks out`.

### `instance/announced-write-durable`

The server MUST NOT announce a write, in an event on a stream or in a webhook delivery, before that write is synced to stable storage.

**Reason:** a subscriber acts on what it is told, and a write lost to a power cut after it was announced is one the subscriber holds and the instance does not.

**Tests:** `compliance/durability.test.ts › sends no event for an entry of a best-effort page until the page is answered`.

### `instance/damaged-file-reported`

If a read or a write meets pages of the database file that SQLite cannot read, then the server MUST answer that request `500 internal_error`, report the database `down` in `GET /health` and keep serving.

**Reason:** SQLite keeps no checksum of a page's content, so a changed byte inside a stored value cannot be told from the value. A start does not check the whole file, since `PRAGMA quick_check` reads every page and takes seconds on an instance of 250,000 items; damage to the structure is reported when a request meets it.

**Tests:** `compliance/durability.test.ts › answers 500 for what reads them, reports the database down, and keeps serving`.

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

### `instance/config-unknown-key-patch`

If a key holding `config.manage` sends `PATCH /config` with a key at the top level of the body that the server does not know, then the server MUST answer `400 validation_error` naming the key in `details.unknown_body_fields`, and store none of the write.

**Reason:** a setting the server no longer has, or an old name for one, is refused plainly instead of being taken and ignored.

**Tests:** `compliance/settings-seed.test.ts › starts with a row the server has no setting for, leaves it out of the configuration, and refuses it in a write`.

### `instance/stored-setting-unknown`

If the settings table holds a row for a setting the server does not have when the server starts, then the server MUST start, leave the row out of `GET /config` and `GET /config/settings`, and keep the row.

**Reason:** a database that outlives a build must not stop the server over a setting nobody reads, and the row is not the server's to delete.

**Tests:** `compliance/settings-seed.test.ts › starts with a row the server has no setting for, leaves it out of the configuration, and refuses it in a write`.

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

When the server accepts `PUT /config`, the server MUST record an audit entry with the `action` `config.update`, the `resource_type` `config` and as `key_id` the credential that wrote: the key's id or `local:process` for the private local process.

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

**Reason:** no setting bounds its own size, so the lists in a lever are held only by the cap on the body, which is 1048576 bytes unless `max_request_bytes` sets another.

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

**Tests:** `compliance/control-socket-close.test.ts › refuses startup until a closing listener has finished its socket cleanup`.

### `instance/control-nonsocket-refused`

When the configured private control socket path holds a file that is not a socket, the server MUST refuse to start without removing that file.

**Tests:** `compliance/control-socket.test.ts › refuses a non-socket control path and preserves its contents`.

## Test hooks

A test hook is a route on the private control socket that moves the server's clock or sets a fault, or a setting that starts the server at another time or contract version. The conformance harness drives them through the target interface (`conformance/TARGET-INTERFACE.md`, "The adapter"). They exist only to test the server, so a release build does not contain them, and each rule here keeps them out of an instance that holds data.

### `instance/test-hooks-off`

While `MARFA_TEST_HOOKS` is not true, the server MUST NOT serve a test hook on any listener.

**Reason:** a test hook can move the clock and hold a housekeeping job, which an instance that holds data must never allow.

**Tests:** `compliance/test-hooks.test.ts › serves no test hook on any listener while MARFA_TEST_HOOKS is not true`.

### `instance/test-hooks-http`

The server MUST NOT serve a test hook on its HTTP listener, whatever `MARFA_TEST_HOOKS` holds.

**Tests:** `compliance/test-hooks.test.ts › serves no test hook on the HTTP listener, even with MARFA_TEST_HOOKS true`.

### `instance/test-hooks-not-built`

If `MARFA_TEST_HOOKS` is true when the server starts and the server was built without test hooks, then the server MUST refuse to start and name `MARFA_TEST_HOOKS`.

**Reason:** the fault registry, the clock offset and the test routes are compiled into a server only when it is built with the cargo feature `test-hooks`. A release build leaves them out, so an instance that holds data has no code a hook could reach. A setting that cannot take effect is refused, never ignored.

**Tests:** `compliance/hook-free-server.test.ts › refuses to start with MARFA_TEST_HOOKS true and names the setting`.

### `instance/test-clock-offset-needs-hooks`

If `MARFA_TEST_CLOCK_OFFSET_MS` is greater than 0 and `MARFA_TEST_HOOKS` is not true when the server starts, then the server MUST refuse to start and name `MARFA_TEST_CLOCK_OFFSET_MS`.

**Tests:** `compliance/test-hooks.test.ts › refuses a clock offset without MARFA_TEST_HOOKS, naming the setting`.

### `instance/test-clock-offset`

Where `MARFA_TEST_CLOCK_OFFSET_MS` is set, the server MUST read the time as that many milliseconds later than the system clock.

**Tests:** `compliance/test-hooks.test.ts › reads the time as MARFA_TEST_CLOCK_OFFSET_MS later than the system clock`.

### `instance/test-clock-sign-in`

While `MARFA_TEST_HOOKS` is true, the server MUST stamp the stored sign-in and credential times with the time the server reads.

**Reason:** A session, a sign-in token and an authorization link carry a time the server later compares with its clock. If one kept the system's time, moving the clock would put the two out of step.

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

Telemetry has two parts, each with settings of its own. Traces and log records are on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Exception reports to error tracking are on when `MARFA_POSTHOG_HOST` and `MARFA_POSTHOG_PROJECT_TOKEN` are set. One being unset, or unusable, leaves the other as it was. `OTEL_SDK_DISABLED` set to `true` in any case turns both parts off; any other value, including `1`, leaves them as they were. The error webhook is not telemetry, so `OTEL_SDK_DISABLED` does not turn it off.

### `instance/telemetry-exception-report`

When `MARFA_POSTHOG_HOST` is an `https` address, or an `http` address on this machine, with no user name or password, `MARFA_POSTHOG_PROJECT_TOKEN` is set, `OTEL_SDK_DISABLED` is not `true`, the effective reporting preference `error_reporting_enabled` is on, and a request ends in an unhandled fault, the server MUST send one exception report, whatever the `OTEL_EXPORTER_OTLP_*` settings are.

**Reason:** an operator who wants error tracking should not have to run an OTLP collector for it, and a collector that cannot be reached is the traces' trouble alone. This is the rule the command line follows (`device/cli-exception-report`), so one set of shell settings means the same to both. The stored `error_reporting_enabled` choice defaults to on.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are sent with the PostHog host and project token alone, and no trace or log record`.

### `instance/telemetry-exception-reporting-off`

While the effective reporting preference `error_reporting_enabled` is off, the server MUST send no exception report, whatever the PostHog settings are.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are not sent when MARFA_ERROR_REPORTING_ENABLED is false`.

### `instance/telemetry-disabled`

When `OTEL_SDK_DISABLED` is `true` in any case, the server MUST export no trace, no log record and no exception report.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are not sent, nor is anything else, when OTEL_SDK_DISABLED is true`.

### `instance/telemetry-disabled-only-true`

If `OTEL_SDK_DISABLED` holds a value other than `true` in any case, then the server MUST export traces, log records and exception reports as the other telemetry settings say.

**Reason:** OpenTelemetry's own rule, which operators' tools follow: only `true` disables the SDK, so `1` does not.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are still sent, with traces and logs, when OTEL_SDK_DISABLED is any value but true, 1 included`.

### `instance/telemetry-disabled-webhook`

While `OTEL_SDK_DISABLED` is `true` in any case and `MARFA_ERROR_WEBHOOK_URL` is set, the server MUST still post an error notification for a request that fails with a 500 error.

**Reason:** the notice is how an owner hears of a fault, and it is not telemetry.

**Tests:** `compliance/telemetry-exception-alone.test.ts › still post an error notification when OTEL_SDK_DISABLED is true in any case`.

### `instance/telemetry-exception-host-unusable`

If `MARFA_POSTHOG_HOST` is not an `https` address, or an `http` address on this machine, or has a user name or password, then the server MUST send no exception report to it.

**Reason:** the project token travels with every report, so it goes only where it cannot be read on the way.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are all that a host the token may not travel to stops: traces and logs still go`.

### `instance/telemetry-exception-host-unusable-traces`

Where `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED` is not `true`, if `MARFA_POSTHOG_HOST` is unusable as `instance/telemetry-exception-host-unusable` describes, then the server MUST still export its traces and log records.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are all that a host the token may not travel to stops: traces and logs still go`.

### `instance/telemetry-host-unusable-warning`

If `MARFA_POSTHOG_HOST` is unusable as `instance/telemetry-exception-host-unusable` describes and `OTEL_SDK_DISABLED` is not `true`, then the server MUST log a warning at boot that exception reports are off, naming the setting and not its value.

**Reason:** the address can carry a credential, so the warning does not repeat it.

**Tests:** `compliance/telemetry-exception-alone.test.ts › are all that a host the token may not travel to stops: traces and logs still go`.

### `instance/telemetry-instance-id`

Where traces and log records are exported, the server MUST carry the instance's `instance_id` as the resource attribute `service.instance.id` of every log record and span it exports, unless `OTEL_RESOURCE_ATTRIBUTES` names `service.instance.id`, which stands in its place.

**Reason:** instances sending to one collector, such as an owner's, a demo and a test, cannot otherwise be told apart. The id is the one the root answers, so an operator finds the instance an export came from by it. The instance's configured `name` is not carried, because it can change while the server runs and can be personal.

**Tests:** `compliance/telemetry-identity.test.ts › names the instance's id on every log record and span it exports`.

### `instance/telemetry-exception-id`

Where exceptions go to error tracking, the server MUST carry the instance's `instance_id` as the property `service.instance.id` of every exception it sends once it has read its id, unless `OTEL_RESOURCE_ATTRIBUTES` names `service.instance.id`, which stands in its place.

**Reason:** the id is in the database, which opens after the server starts, so an exception captured before it opens goes unnamed.

**Tests:** `compliance/telemetry-identity.test.ts › names the instance and the environment in an exception and an error notification`.

### `instance/telemetry-attributes`

Where anything is exported, the server MUST carry each attribute `OTEL_RESOURCE_ATTRIBUTES` names as a resource attribute of every log record and span it exports and as a property of every exception it sends, in place of its own attribute of the same name.

**Reason:** the operator is the one who knows what the instance is for, and the standard variable is how an instance marks itself apart, as `deployment.environment=staging` does.

**Tests:** `compliance/telemetry-identity.test.ts › names the attributes and the service name the operator set, in place of its own`, `› names the instance and the environment in an exception and an error notification`.

### `instance/telemetry-service-name`

Where anything is exported and `OTEL_SERVICE_NAME` is set, the server MUST carry it as the resource attribute `service.name`, whatever `OTEL_RESOURCE_ATTRIBUTES` names.

**Tests:** `compliance/telemetry-identity.test.ts › names the attributes and the service name the operator set, in place of its own`.

### `instance/telemetry-error-environment`

Where `MARFA_ERROR_WEBHOOK_URL` is set and `OTEL_RESOURCE_ATTRIBUTES` names `deployment.environment.name` or `deployment.environment`, the server MUST name the value of the first of them it names, in that order, as the `environment` of each notification it posts.

**Reason:** a notification from a test instance that said `production` would send the person reading it to the wrong place.

**Tests:** `compliance/telemetry-identity.test.ts › names the instance and the environment in an exception and an error notification`, `› names deployment.environment.name in an error notification before deployment.environment`.

## Settings refused at boot

The server reads its start-only settings once, when it starts, and the tables under "Settings" give each one's rule. While test hooks are on, it also reads the seed of each stored setting, and refuses one outside the setting's rule in the same way. A client meets a refused setting as a process that exits, so these rules are about the exit status, the log message and the files left behind.

### `instance/settings-edge-accepted`

When every setting is inside its rule, one at the edge of its rule and a pair at the edge of a rule between two settings included, the server MUST start.

**Tests:** `compliance/instance-lifecycle.test.ts › starts with each of those settings one step inside its rule and each cross-field rule at its edge`.

### `instance/settings-refused-exit`

If a setting is outside the rule its table gives it, then the server MUST exit with status 1 instead of starting.

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

**Reason:** the log is read by more people than the secret is meant for. The settings that hold a secret include `MARFA_KEY_SALT`, `MARFA_AUTH_SECRET`, `S3_ENDPOINT` and `S3_SECRET_ACCESS_KEY`, since an address can carry a credential.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s and no other setting, when it is %s`, `› refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`, `› refuses a MARFA_AUTH_SECRET of 31 characters, without printing it`.

### `instance/settings-secret-padded`

If a setting whose allowed values the start-only table gives as text with no whitespace around it has whitespace around its value, then the server MUST refuse to start and name the setting.

**Reason:** a secret is used as written, never trimmed, so the whitespace would be part of it.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one`.

### `instance/settings-auth-secret-short`

If `MARFA_AUTH_SECRET` is set to fewer than 32 characters, then the server MUST refuse to start and name the setting.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses a MARFA_AUTH_SECRET of 31 characters, without printing it`.

### `instance/settings-cross-field`

If every setting is inside its own rule and a setting that a rule across settings says must be at least another is lower than it, then the server MUST refuse to start and name the lower setting.

**Tests:** `compliance/instance-lifecycle.test.ts › refuses to start with status 1, naming %s, when each setting is inside its own rule and the two disagree`.

### `instance/settings-cross-field-last`

While any setting is outside its own rule, the server MUST NOT report in the same refusal a rule that compares two settings.

**Reason:** a rule between two settings cannot be read until every setting parses.

**Tests:** `compliance/instance-lifecycle.test.ts › names only the setting outside its rule, and holds back the cross-field rule until every setting parses`.

## Settings

A setting is either stored or start-only. A **stored** setting lives in the database and changes while the server runs, through `PUT /config` and `PATCH /config`, with no restart; its key is the field those operations read and write, and the environment never overrides it. A **start-only** setting is an environment variable the server needs before its database opens, and the server reads it once, when it starts. A blank environment value counts as unset. What a value outside its rule does is under "Settings refused at boot".

## Stored settings

A duration an owner sets is in seconds, or in days or hours for a retention. Each bound is wide enough that no owner meets it and narrow enough that a slip of a digit is refused: a duration to a year (31536000 seconds), a timeout to an hour, a count to a million, a byte count to a terabyte and a retention to a hundred years (36500 days). Where a setting differs, the row says so in its bound: a rate-limit window runs to a day, a retry count to 100 and extracted text to a hundred million characters. The server fixes the other timings and batch sizes it works to, such as how often each housekeeping job runs.

| Key                              | Default            | Allowed values                                            | What it sets                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disk_reserve_bytes`             | `134217728` bytes  | Whole number of bytes, 0 to 1099511627776                 | The free space on the disk store's volume that uploads, restores, and archive exports must leave. An export's temporary files are included. A request that would take the volume below it is refused `507 insufficient_storage`. At 0 nothing is held back.                                                                        |
| `max_request_bytes`              | `1048576` bytes    | Whole number of bytes, 1 to 1099511627776                 | The largest ordinary JSON request body. A larger body is answered `413 request_too_large`. Bulk writes, connector state, client registration, blob uploads and inbound webhook deliveries have separate limits.                                                                                                                    |
| `max_bulk_request_bytes`         | `16777216` bytes   | Whole number of bytes, 1 to 1099511627776                 | The largest body the bulk operations accept.                                                                                                                                                                                                                                                                                       |
| `blob_min_copies`                | `1`                | Whole number, 1 to 1000000                                | The fewest live copies a blob keeps. A drop that would leave fewer is refused.                                                                                                                                                                                                                                                     |
| `blob_cleanup_enabled`           | `true`             | `true` or `false`                                         | Whether the `blob-orphans` job sweeps for unreferenced blobs. When off, no blob is reported or purged.                                                                                                                                                                                                                             |
| `blob_cleanup_grace_seconds`     | `86400` seconds    | Whole number of seconds, 0 to 31536000                    | How long an unreferenced blob stands in the orphan report before a later run purges it. At 0 the next run purges it.                                                                                                                                                                                                               |
| `backup_interval_seconds`        | `3600` seconds     | Whole number of seconds, 0 to 31536000                    | How often the `backup` job puts a backup in the object store when anything it holds has changed. At 0 scheduled backups are off.                                                                                                                                                                                                   |
| `enrichment_enabled`             | `true`             | `true` or `false`                                         | Whether the server extracts text from uploaded files.                                                                                                                                                                                                                                                                              |
| `enrichment_ocr_enabled`         | `true`             | `true` or `false`                                         | Whether the server reads text from images with OCR. When off, images are recorded as unsupported.                                                                                                                                                                                                                                  |
| `enrichment_max_blob_bytes`      | `20971520` bytes   | Whole number of bytes, 1 to 1099511627776                 | The largest blob the server extracts text from. A larger blob gets no extracted text.                                                                                                                                                                                                                                              |
| `enrichment_max_text_chars`      | `100000`           | Whole number, 1 to 100000000                              | The most Unicode characters of extracted text the server keeps, counted as characters, not UTF-16 code units. Longer text is cut short.                                                                                                                                                                                            |
| `enrichment_max_inflated_bytes`  | `67108864` bytes   | Whole number of bytes, 1 to 1099511627776                 | The most a document may inflate to when the server extracts its text, all of its parts together. A document that inflates past it is skipped.                                                                                                                                                                                      |
| `enrichment_max_memory_bytes`    | `1073741824` bytes | Whole number of bytes, 1 to 1099511627776                 | The most memory reading one file may use. A file that needs more is skipped.                                                                                                                                                                                                                                                       |
| `enrichment_max_attempts`        | `3`                | Whole number, 1 to 100                                    | How many times the server tries to extract text from a failing item before it stops.                                                                                                                                                                                                                                               |
| `sign_in_address`                | None               | An origin with no path, or empty                          | The address people sign in at, which OAuth, cookies and links use. An origin has a scheme, a host and an optional port, with no user name, password, path, query or fragment. Empty uses `http://localhost` with the port the server listens on, whatever `MARFA_LISTEN_HOST` is. It joins `addresses` without being listed there. |
| `cors_origins`                   | None               | List of origins, each `scheme://host[:port]` with no path | The browser origins allowed to call the API across origins, beside the web pages the owner approves, and trusted by the sign-in forms.                                                                                                                                                                                             |
| `rate_limit_enabled`             | `true`             | `true` or `false`                                         | Whether the rate limiter is on for a key's or an app's requests, and for app registration, device code requests, passkey sign-in challenges and deliveries to inbound addresses.                                                                                                                                                   |
| `rate_limit_requests`            | `4000`             | Whole number, 1 to 1000000                                | The requests one key or app may make to all operations together in each window.                                                                                                                                                                                                                                                    |
| `rate_limit_window_seconds`      | `60` seconds       | Whole number of seconds, 1 to 86400                       | The length of a rate-limit window.                                                                                                                                                                                                                                                                                                 |
| `rate_limit_keys_requests`       | `200`              | Whole number, 1 to 1000000                                | The requests one credential may make in each window to the operations under `/keys`.                                                                                                                                                                                                                                               |
| `inbound_max_bytes`              | `26214400` bytes   | Whole number of bytes, 1 to 1099511627776                 | The largest inbound webhook delivery the server stores.                                                                                                                                                                                                                                                                            |
| `rate_limit_inbound_requests`    | `600`              | Whole number, 1 to 1000000                                | The deliveries one inbound endpoint accepts in each rate-limit window.                                                                                                                                                                                                                                                             |
| `inbound_backlog_deliveries`     | `10000`            | Whole number, 1 to 1000000                                | The unhandled deliveries one registration may hold before the server refuses more deliveries for it.                                                                                                                                                                                                                               |
| `inbound_backlog_bytes`          | `1073741824` bytes | Whole number of bytes, 1 to 1099511627776                 | The bytes of unhandled deliveries one registration may hold before the server refuses more deliveries for it.                                                                                                                                                                                                                      |
| `inbound_retained_deliveries`    | `10000`            | Whole number, 1 to 1000000                                | The most deliveries the server retains across live and retired endpoints.                                                                                                                                                                                                                                                          |
| `inbound_retained_bytes`         | `1073741824` bytes | Whole number of bytes, 1 to 1099511627776                 | The most bytes of deliveries the server retains across live and retired endpoints.                                                                                                                                                                                                                                                 |
| `inbound_in_flight_bytes`        | `104857600` bytes  | Whole number of bytes, 1 to 1099511627776                 | The most bytes of inbound webhook deliveries the server holds in memory at once.                                                                                                                                                                                                                                                   |
| `inbound_handled_retention_days` | `7` days           | Whole number of days, 0 to 36500                          | How long the server keeps a handled delivery. At 0 age does not expire a delivery.                                                                                                                                                                                                                                                 |
| `inbound_pending_retention_days` | `30` days          | Whole number of days, 0 to 36500                          | How long the server keeps an unhandled delivery. At 0 age does not expire a delivery.                                                                                                                                                                                                                                              |
| `audit_retention_days`           | `90` days          | Whole number of days, 0 to 36500                          | How long the server keeps audit entries and webhook delivery history. At 0 no entry expires by age.                                                                                                                                                                                                                                |
| `revoked_grant_retention_days`   | `90` days          | Whole number of days, 0 to 36500                          | How long a revoked application grant is kept. At 0 no revoked grant is purged.                                                                                                                                                                                                                                                     |
| `grant_inactivity_days`          | `365` days         | Whole number of days, 0 to 36500                          | How long an application grant may go unused before the server retires it. At 0 grants are never retired. `/config` overrides it.                                                                                                                                                                                                   |
| `event_log_retention_hours`      | `720` hours        | Whole number of hours, 0 to 876000                        | The least time an event stays in the event log, which bounds how far back a stream can replay. At 0 no event expires by age.                                                                                                                                                                                                       |
| `version_recent_days`            | `30` days          | Whole number of days, 0 to 36500                          | The window in which the version policy keeps every version of an item.                                                                                                                                                                                                                                                             |
| `version_daily_snapshot_days`    | `90` days          | Whole number of days, 0 to 36500                          | The window in which the version policy keeps one version a day. It must be at least `version_recent_days`.                                                                                                                                                                                                                         |
| `version_weekly_snapshot_days`   | `365` days         | Whole number of days, 0 to 36500                          | The window in which the version policy keeps one version a week. It must be at least `version_daily_snapshot_days`.                                                                                                                                                                                                                |
| `version_max_versions`           | `500`              | Whole number, 1 to 1000000                                | The most versions the version policy keeps for one item.                                                                                                                                                                                                                                                                           |
| `trash_retention_days`           | `60` days          | Whole number of days, 0 to 36500                          | How long an item stays in the trash before the server deletes it. At 0 nothing in the trash expires by age.                                                                                                                                                                                                                        |
| `row_log_retention_days`         | `30` days          | Whole number of days, 0 to 36500                          | How long a table keeps a batch in its change log, which bounds how far back a batch can be undone. At 0 no batch leaves the log by age.                                                                                                                                                                                            |
| `dcr_client_retention_days`      | `1` day            | Whole number of days, 0 to 36500                          | How long a dynamically registered client with no grants is kept, counted from its registration or the last time an approval page offered it. At 0 no such client is removed.                                                                                                                                                       |
| `sse_max_viewers`                | `0`                | Whole number, 0 to 1000000                                | The most event-stream viewers one server instance serves at once. At 0 there is no limit.                                                                                                                                                                                                                                          |
| `mcp_fetch_enabled`              | `true`             | `true` or `false`                                         | Whether MCP tools fetch a file from a web address, or a file a chat attached, to save it. When off, a tool asked to fetch one is refused.                                                                                                                                                                                          |
| `mcp_fetch_max_bytes`            | `52428800` bytes   | Whole number of bytes, 1 to 1099511627776                 | The largest file an MCP tool fetches from a web address to save. A larger file is refused and nothing is stored.                                                                                                                                                                                                                   |
| `mcp_fetch_timeout_seconds`      | `60` seconds       | Whole number of seconds, 1 to 3600                        | How long an MCP tool's fetch of a file from a web address may take, from connecting to the last byte.                                                                                                                                                                                                                              |
| `error_reporting_enabled`        | `true`             | `true` or `false`                                         | Send error alerts and exception reports to the receivers the environment names.                                                                                                                                                                                                                                                    |
| `heartbeat_enabled`              | `true`             | `true` or `false`                                         | Send scheduled requests to the heartbeat receiver the environment names.                                                                                                                                                                                                                                                           |
| `addresses`                      | None               | List of origins, each `scheme://host[:port]` with no path | The addresses people reach this instance at, such as `https://marfa.example`. Each is an origin: a scheme, a host and an optional port, with no path. Links the server builds and browser origins it accepts for sign-in come from this list and the sign-in address.                                                              |

### `instance/settings-listed`

When a caller holding `config.manage` or `instance.read`, or the private local process, sends `GET /config/settings`, the server MUST answer `200` with `data`, an entry for each stored setting holding its `key`, `description`, `value`, `default`, `stored`, `rule` and `together`; `rules`, an entry for each rule across settings holding its `name`, `description` and `keys`; and `start_only`, an entry for each start-only setting holding its `name`, `description`, `secret` and `set`.

**Reason:** an app or the command line lists the settings from this one answer, so it keeps no copy of the tables. `value` is the one in force, `stored` the value held in the database or `null`, and `together` the keys of the other settings a rule across settings ties to this one.

**Tests:** `compliance/instance-addresses.test.ts › names every stored setting with its value, default and rule, and every start-only setting by environment name`, `› is read through a private socket as it is through a key`.

### `instance/settings-listed-no-value`

When the server answers `GET /config/settings`, the server MUST NOT include the value of a start-only setting.

**Reason:** some start-only settings hold a secret, and the rest are the machine's own. The entry says only whether the environment sets the setting.

**Tests:** `compliance/instance-addresses.test.ts › shows no value of a start-only setting`.

### `instance/settings-listed-needs-read`

If a caller holding neither `config.manage` nor `instance.read` sends `GET /config/settings`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/instance-addresses.test.ts › is refused to a key that holds neither config.manage nor instance.read`.

### `instance/settings-seed`

While `MARFA_TEST_HOOKS` is true, the server MUST take the default of a stored setting from the environment variable `MARFA_` plus the setting's key in capitals, and a value stored for the setting stays in force over that variable.

**Reason:** a stored setting has one home, so a change made through `/config` always takes effect. The seed lets a harness start a server with a short retention without a write.

**Tests:** `compliance/settings-seed.test.ts › starts at the value the environment gives, and a value stored for it stays in force over the variable`.

### `instance/tuning-needs-hooks`

If `MARFA_TEST_TUNING` is set and `MARFA_TEST_HOOKS` is not true when the server starts, then the server MUST refuse to start and name `MARFA_TEST_TUNING`.

**Tests:** `compliance/settings-seed.test.ts › refuses a tuning without MARFA_TEST_HOOKS, naming the setting`, `compliance/hook-free-server.test.ts › refuses a tuning and names the setting, where a hooked server takes it`.

### `instance/tuning-names`

If `MARFA_TEST_TUNING` names a timing or a batch size the server does not have, then the server MUST refuse to start and name `MARFA_TEST_TUNING`.

**Tests:** `compliance/settings-seed.test.ts › refuses a tuning that names a timing the server does not have`.

### `instance/tuning-interval`

While `MARFA_TEST_HOOKS` is true, the server MUST run a housekeeping job at the interval `MARFA_TEST_TUNING` gives it, and each other job at its own.

**Reason:** a harness shortens one job's interval, or holds every job back, without any owner having a setting for it.

**Tests:** `compliance/settings-seed.test.ts › lists a job at the interval the tuning gives it, and another at its own`.

### `instance/addresses-origin`

If a write names an address with a path, a query, a fragment, a user name or password, or a scheme other than `http` or `https`, in `addresses`, `cors_origins` or `sign_in_address`, then the server MUST answer `400 validation_error` and store none of the write.

**Reason:** an address is an origin: a scheme, a host and an optional port. Links and browser origins are built from it, so a path would be carried into every one of them.

**Tests:** `compliance/instance-addresses.test.ts › is an origin: one with a path, a query, a fragment, a user name or another scheme is refused`.

### `instance/addresses-plain-spelling`

When the server stores an address, the server MUST store its plainest spelling, with a lowercase host, no default port and no trailing slash.

**Tests:** `compliance/instance-addresses.test.ts › is stored in its plainest spelling, with a lowercase host, no default port and no trailing slash`.

### `instance/addresses-once`

When a write names the same origin in more than one spelling, the server MUST store the origin once, in the place of its first spelling.

**Tests:** `compliance/instance-addresses.test.ts › is stored in its plainest spelling, with a lowercase host, no default port and no trailing slash`.

### `instance/addresses-hold-sign-in`

If a write sets `addresses` to a list that leaves out the sign-in address in force, then the server MUST answer `400 validation_error` naming `addresses` and the sign-in address, and store none of the write.

**Reason:** the sign-in address is always one of the instance's addresses, stored or not. The sign-in address in force is the stored one or, while none is stored, the instance's own address.

**Tests:** `compliance/instance-addresses.test.ts › are refused together when the list leaves out the sign-in address`, `compliance/instance-addresses.test.ts › are refused together when the list leaves out the instance's own address, though no sign-in address is stored`.

### `instance/sign-in-address-joins`

When a write sets `sign_in_address` and does not name `addresses`, the server MUST answer `addresses` at `GET /config` with the sign-in address among them.

**Tests:** `compliance/instance-addresses.test.ts › is always among the addresses, whether or not the list names it`.

### `instance/sign-in-address-authority`

If a key, even one holding `config.manage`, sends `PUT /config` or `PATCH /config` that would change `sign_in_address` or `cors_origins`, then the server MUST answer `403 forbidden` and store none of the write.

**Reason:** these two settings decide where sign-in cookies are valid and which web pages may call the API, so only a person at the instance, through the private local process, may change them.

**Tests:** `compliance/instance-addresses.test.ts › is refused to a key, which holds config.manage but not direct authority`.

### `instance/sign-in-address-authority-unchanged`

If a key sends `PUT /config` or `PATCH /config` that names `sign_in_address` or `cors_origins` at the value it already has, then the server MUST apply the write as it would for any other setting.

**Reason:** a client that sends the whole configuration back changes neither setting, and refusing it would make every such client need direct authority.

**Tests:** `compliance/instance-addresses.test.ts › is refused to a key, which holds config.manage but not direct authority`.

### `instance/sign-in-address-unconfirmed`

If the private local process moves the sign-in address of a claimed instance, the first sign-in address stored included, without `confirm_sign_in_address_change` set to `true`, then the server MUST answer `409 sign_in_address_change_unconfirmed` with the consequences of the change in `details.consequences`, and store none of the write.

**Reason:** the change signs everyone out and can strand passkeys and apps, so the person is told what it will do before it does it.

**Tests:** `compliance/instance-addresses.test.ts › is not moved, and the answer names the consequences, until a write confirms it`.

### `instance/sign-in-address-confirmed`

When the private local process sends `confirm_sign_in_address_change` set to `true` with a new sign-in address, the server MUST store the address.

**Tests:** `compliance/instance-addresses.test.ts › is not moved, and the answer names the consequences, until a write confirms it`.

### `instance/sign-in-address-ends-sessions`

When the private local process sends `confirm_sign_in_address_change` set to `true` with a new sign-in address, the server MUST end every browser session in the write that stores the address, so that no session cookie made before it opens anything afterward.

**Reason:** the confirmation tells the person that everyone signed in on a browser is signed out (`browser_sessions_end`). Only the private local process makes the change, so no browser session confirms it and none is kept: the owner signs in again at the new address. Keys and app grants are not browser sessions, and the change leaves them as they were.

**Tests:** `compliance/instance-addresses.test.ts › ends every browser session, so a session token from before the move opens nothing under either cookie name`.

### `instance/sign-in-address-forgets-devices`

When the private local process confirms a move of the sign-in address, the server MUST count each later password sign-in that carries a device cookie set before the move as one with no device cookie.

**Reason:** a device cookie is signed for the owner's credentials as they stand, and the move renews them with the browser sessions it ends, so no browser stays known.

**Tests:** `compliance/sign-in-limits.test.ts › counts a device cookie set before a confirmed move of the sign-in address as no device cookie`.

### `instance/sign-in-needs-address`

While no sign-in address is set, if a caller sends `POST /auth/sign-in` over a connection whose own address is not on the loopback, or names through a trusted proxy an address that is not on the loopback, then the server MUST answer `403 forbidden` with a message that says how to set the sign-in address.

**Reason:** Until the owner says where people reach the instance, the server cannot tell a sign-in through the owner's own proxy from one through anyone else's. A caller is local only by its own connection.

**Tests:** `compliance/sign-in-door-limits.test.ts › refuses a password sign-in from a caller off this machine 403, and answers one from this machine`.

### `instance/address-check`

When a key holding `config.manage` sends `POST /config/address-check` with `sign_in_address`, `addresses` or both, the server MUST answer `200` with the `sign_in_address` and the `addresses` as they would be after the change, `requires_confirmation`, and `consequences`, each of them `code`, `sentence` and `count`.

**Reason:** an app shows the person what a change does before it asks for the write. `requires_confirmation` is `true` when a write of the same change needs `confirm_sign_in_address_change`.

**Tests:** `compliance/instance-addresses.test.ts › writes nothing, and answers the addresses after the change, whether it needs confirming and what it does`.

### `instance/address-check-writes-nothing`

When the server answers `POST /config/address-check`, the server MUST store nothing.

**Tests:** `compliance/instance-addresses.test.ts › writes nothing, and answers the addresses after the change, whether it needs confirming and what it does`.

### `instance/address-check-sessions`

When the sign-in address in a check differs from the one in force and a browser session is live, the server MUST list the consequence `browser_sessions_end` with the number of live sessions as its `count`.

**Tests:** `compliance/instance-addresses.test.ts › writes nothing, and answers the addresses after the change, whether it needs confirming and what it does`.

### `instance/address-check-apps-and-passkeys`

When the sign-in address in a check differs from the one in force, the server MUST list the consequence `passkeys_unusable` while a passkey is registered for a host other than the new one and `apps_sign_in_again` while an app is connected, each with its number as its `count` and each left out while its number is 0.

**Tests:** `compliance/address-check-consequences.test.ts › names the passkeys that would stop working, with their number, only while one is registered for another host`, `compliance/address-check-consequences.test.ts › names the apps that would have to sign in again, with their number, only while one is connected`.

### `instance/address-check-removed`

When a check drops an address that is in force, the server MUST list a consequence `address_removed` for each address dropped, with a `count` of `null`, and a check that drops an address and moves nothing else needs no confirmation.

**Reason:** links that use a dropped address stop working, but nobody is signed out.

**Tests:** `compliance/instance-addresses.test.ts › names a dropped address as address_removed with no count, and needs no confirming for it`.

### `instance/address-check-spelling`

If the sign-in address in a check is the one in force spelled another way, then the server MUST answer `requires_confirmation` as `false` and list no consequence for the sign-in address.

**Tests:** `compliance/instance-addresses.test.ts › does not ask for confirming when the sign-in address is only spelled another way`.

### `instance/address-check-refused`

If a check names an address that is not an origin, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/instance-addresses.test.ts › is refused for an address that is not an origin`.

### `instance/live-settings`

When an authorized caller replaces or updates the configuration, the server MUST accept `version_recent_days`, `version_daily_snapshot_days`, `version_weekly_snapshot_days`, `version_max_versions`, `grant_inactivity_days`, `enrichment_enabled`, `enrichment_ocr_enabled`, `error_reporting_enabled` and `heartbeat_enabled` as stored settings.

**Reason:** the owner can change version retention, unused-app retirement, file reading and reporting without restarting the server.

**Tests:** `compliance/instance-config.test.ts › keeps live settings across restart, preserves omitted choices and clears to the environment`.

### `instance/live-policy-validation`

If a configuration write would make the effective recent, daily and weekly version windows decrease in that order, set a negative window or inactivity period, set a version count below one, or enable reporting without a configured receiver, then the server MUST refuse it with `400 validation_error` without changing the stored configuration.

**Reason:** validation includes the defaults exposed by clearing a stored setting. The receivers' addresses and credentials are start-only settings.

**Tests:** `compliance/instance-config.test.ts › keeps live settings across restart, preserves omitted choices and clears to the environment`.

### `instance/live-work`

When a stored setting changes, the server MUST use the effective choice for future work without a restart, including a job disabled when the process started.

**Reason:** disabling does not promise to cancel an extraction or request already in flight. Version deletion and unused-app retirement recheck the effective policy in the transaction that removes the versions or revokes the grant. A zero version window is empty; a zero inactivity period disables retirement. Type-specific version policies retain precedence.

**Tests:** `compliance/live-settings.test.ts › starts disabled work after a live choice and stops it again without restarting`.

## Start-only settings

The environment variables below are read once, when the server starts. Each is named `MARFA_` and what it sets, except the `OTEL_*` settings, which keep OpenTelemetry's standard names because operators' tools already set them, and the `S3_*` settings, which name the object store as its own tools do.

| Setting                                 | Default                                              | Allowed values                                                     | What it sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARFA_PORT`                            | `8600`                                               | Whole number, 0 to 65535                                           | The port the server listens on. Zero lets the operating system assign a port.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MARFA_LISTEN_HOST`                     | None                                                 | Any text                                                           | The IP address or hostname the public HTTP listener binds to. Unset uses the runtime's unspecified address: IPv6 when available, otherwise IPv4.                                                                                                                                                                                                                                                                                                                                                                                    |
| `MARFA_DATABASE_PATH`                   | `./data/marfa.db`                                    | Any text                                                           | The path of the database file. A value starting with `file:` is passed to the database as written, and `:memory:` opens a database held in memory.                                                                                                                                                                                                                                                                                                                                                                                  |
| `MARFA_CONTROL_SOCKET`                  | None                                                 | Any text                                                           | Absolute private Unix socket path. Defaults to control/marfa.sock beside the database. Its directory must belong to the server account with mode 0700.                                                                                                                                                                                                                                                                                                                                                                              |
| `MARFA_CONTROL_ONLY`                    | `false`                                              | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Start only the private control listener, without public HTTP or background jobs, for local recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MARFA_TEST_HOOKS`                      | `false`                                              | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Serve the clock and fault routes a conformance harness drives on the private control socket. Never on the public listener. A server built without test hooks refuses to start when it is true. Leave off on every instance that holds real data.                                                                                                                                                                                                                                                                                    |
| `MARFA_TEST_CLOCK_OFFSET_MS`            | `0` ms                                               | Whole number of milliseconds, 0 to 3153600000000                   | How far ahead of the system clock the server's clock starts. Needs `MARFA_TEST_HOOKS`, so a harness that moved the clock can restart the server without the time going back.                                                                                                                                                                                                                                                                                                                                                        |
| `MARFA_TEST_CONTRACT_VERSION`           | The build's contract version                         | Whole number, 0 to 1000000                                         | The contract version the server speaks instead of the build's, in the root's `contract`, the `X-Marfa-Contract` header and the document's `info.version`. Needs `MARFA_TEST_HOOKS`, so a harness can show what a change of contract does to what the server kept.                                                                                                                                                                                                                                                                   |
| `MARFA_TEST_TUNING`                     | None                                                 | Comma-separated `name=value` pairs                                 | Shortens a timing or a batch size the server fixes: `interval.<job>` or `interval.*` in milliseconds (neither reaches `backup`, whose interval is the stored `backup_interval_seconds`, and `interval.backup` is refused), `housekeeping_poll_ms`, `write_wait_ms`, `upload_idle_ms`, `blob_read_idle_ms`, `inbound_idle_ms` or `connector_hold_ms` in milliseconds, or `enrichment_batch`, `blob_replicate_batch`, `blob_replicate_batch_bytes`, `blob_integrity_batch` or `blob_integrity_batch_bytes`. Needs `MARFA_TEST_HOOKS`. |
| `MARFA_MAX_CONNECTIONS`                 | `1024`                                               | Whole number, 1 to 1000000                                         | The most connections the public listener holds open at once. The server lowers it at start where the open-file limit leaves too little room ("Open connections").                                                                                                                                                                                                                                                                                                                                                                   |
| `MARFA_MAX_CONNECTIONS_PER_ADDRESS`     | `256`                                                | Whole number, 1 to 1000000                                         | The most connections the public listener holds open for one caller address, where the listener does not believe a forwarded address. An IPv6 address counts with the rest of its /64. A value above `MARFA_MAX_CONNECTIONS` has no effect.                                                                                                                                                                                                                                                                                          |
| `MARFA_BLOB_PATH`                       | `./data/blobs`                                       | Any text                                                           | The folder of the disk store, where every upload lands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MARFA_BACKUP_PATH`                     | None                                                 | An absolute path with no `..` in it                                | The folder the server backs itself up to: each backup under `backups/<instance id>/` and a copy of each file under `files/<instance id>/`. The folder must exist, outside the data directory and the blob folder, and the server never creates it. Set it or `S3_BUCKET`, not both. When neither is set, the server keeps no backup.                                                                                                                                                                                                |
| `S3_BUCKET`                             | None                                                 | Any text                                                           | The bucket of an S3-compatible object store. The store is attached when this is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `S3_REGION`                             | `us-east-1`                                          | Any text                                                           | The region of the object store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `S3_ENDPOINT`                           | None                                                 | Absolute `http` or `https` URL                                     | The endpoint of the object store. When blank, the store's provider chooses it.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `S3_ACCESS_KEY_ID`                      | None                                                 | Any text                                                           | The access key ID for the object store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `S3_SECRET_ACCESS_KEY`                  | None                                                 | Text with no whitespace around it                                  | The secret access key for the object store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `S3_FORCE_PATH_STYLE`                   | `true`                                               | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether the object store is addressed by path rather than by virtual host. Read only when `S3_ENDPOINT` is set.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `S3_PREFIX`                             | `marfa`                                              | `/`-joined segments of letters, digits, `.`, `_` and `-`           | The key prefix the instance keeps everything under in the bucket: its files under `blobs/` and its backups under `backups/`. Each running instance on a bucket needs its own; a server that replaces an instance starts on its prefix. A `/` at either end is dropped; a `.` or `..` segment is refused.                                                                                                                                                                                                                            |
| `MARFA_ENRICHMENT_TESSDATA_DIR`         | None                                                 | Any text                                                           | A folder of OCR language models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MARFA_TRUSTED_PROXY_CIDRS`             | None                                                 | Comma-separated CIDR ranges, IPv4 or IPv6                          | The address ranges of the proxies whose `X-Forwarded-For` header, or the header `MARFA_TRUSTED_PROXY_HEADER` names, the server believes. When empty, `X-Forwarded-For` is ignored.                                                                                                                                                                                                                                                                                                                                                  |
| `MARFA_TRUSTED_PROXY_HEADER`            | None                                                 | An HTTP header name                                                | The name of a header that the platform's edge overwrites with the client address, believed only from a peer inside `MARFA_TRUSTED_PROXY_CIDRS`, which it needs. While it is set, `X-Forwarded-For` is ignored.                                                                                                                                                                                                                                                                                                                      |
| `MARFA_KEY_SALT`                        | None. Generated on first start into `marfa.secrets`. | Text with no whitespace around it                                  | The salt for hashing API keys and app tokens. Changing it invalidates every existing key and token. Unset, the server uses the salt in `marfa.secrets`, which it generated on first start.                                                                                                                                                                                                                                                                                                                                          |
| `MARFA_AUTH_SECRET`                     | None. Generated on first start into `marfa.secrets`. | Text of at least 32 characters, with no whitespace around it       | The secret that signs sign-in cookies, authorize queries, reach proofs and credential-free blob links. It must be at least 32 characters. Unset, the server uses the secret in `marfa.secrets`, which it generated on first start.                                                                                                                                                                                                                                                                                                  |
| `MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES` | `false`                                              | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether outbound webhooks may reach loopback, private and other non-public addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MARFA_ERROR_WEBHOOK_URL`               | None                                                 | Absolute `http` or `https` URL                                     | The URL the server posts a notice to when a request fails with a 500 error. When blank, no notice is sent.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MARFA_HEARTBEAT_URL`                   | None                                                 | Absolute `http` or `https` URL                                     | The URL the server requests on a schedule, so that something else can notice when the requests stop. When blank, there is no heartbeat.                                                                                                                                                                                                                                                                                                                                                                                             |
| `MARFA_OTEL_SAMPLE_RATIO`               | `0.05`                                               | Decimal number, 0 to 1                                             | The share of traces exported. A trace that contains an error is exported whatever this says: the span that failed, the spans held for the trace (at most 500) and every span after it.                                                                                                                                                                                                                                                                                                                                              |
| `OTEL_SDK_DISABLED`                     | `false`                                              | `true` in any case, or any other value                             | `true` in any case turns off traces, logs and exception reports together, whatever the other telemetry settings say. Any other value, including `1`, leaves them as they are. The error webhook stays on.                                                                                                                                                                                                                                                                                                                           |
| `OTEL_SERVICE_NAME`                     | `marfa-server`                                       | Any text                                                           | The service name on exported telemetry. It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `OTEL_RESOURCE_ATTRIBUTES`              | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | Attributes added to everything exported, as OpenTelemetry defines them. One named here replaces the server's own of the same name, such as `deployment.environment`, which an error notification names too.                                                                                                                                                                                                                                                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | None                                                 | Absolute `http` or `https` URL                                     | The base URL of the OTLP receiver. Setting it turns traces and logs on: the server exports traces to `v1/traces` and logs to `v1/logs` under it. Unset, no trace or log is exported; exception reports have settings of their own (`MARFA_POSTHOG_HOST`).                                                                                                                                                                                                                                                                           |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`    | None                                                 | Absolute `http` or `https` URL                                     | The URL traces post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`      | None                                                 | Absolute `http` or `https` URL                                     | The URL logs post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OTEL_EXPORTER_OTLP_HEADERS`            | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with every OTLP export, as `key=value` pairs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`     | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with trace exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS`       | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with log exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MARFA_POSTHOG_HOST`                    | None                                                 | Absolute `http` or `https` URL                                     | The PostHog host that receives exception reports, which OTLP cannot carry into error tracking. With `MARFA_POSTHOG_PROJECT_TOKEN` it turns exception reports on; no OTLP setting is needed. It must be an `https` address, or an `http` address on this machine, with no user name or password; any other value turns off exception reports alone and the boot log says so.                                                                                                                                                         |
| `MARFA_POSTHOG_PROJECT_TOKEN`           | None                                                 | Text with no whitespace around it                                  | The PostHog project token for exception reports. It needs `MARFA_POSTHOG_HOST` set too; no OTLP setting is needed.                                                                                                                                                                                                                                                                                                                                                                                                                  |

### `instance/secrets-generated`

When the server starts for the first time and `MARFA_KEY_SALT` or `MARFA_AUTH_SECRET` is unset, the server MUST generate the unset secret into the file `marfa.secrets` beside the database, readable by its owner alone.

**Reason:** an instance that is not configured by hand still has secrets of its own. A secret given in the environment is used as given and is not written to the file.

**Tests:** `compliance/hook-free-server.test.ts › generates both into a file only its owner can read, and keeps them across a restart`, `compliance/hook-free-server.test.ts › writes only the secret the environment does not give, and none when it gives both`.

### `instance/secrets-kept`

When the server starts and `marfa.secrets` holds a secret that the environment does not give, the server MUST use the secret in the file and generates no other.

**Reason:** regenerating the salt would end every key.

**Tests:** `compliance/hook-free-server.test.ts › uses the secret in the file, and refuses to replace a file that was lost`.

### `instance/secrets-missing-refused`

If the database exists, `marfa.secrets` does not and `MARFA_KEY_SALT` is unset when the server starts, then the server MUST refuse to start and name `MARFA_KEY_SALT`.

**Reason:** a new salt would end every key, so a lost file is for the owner to restore and never for the server to replace.

**Tests:** `compliance/hook-free-server.test.ts › uses the secret in the file, and refuses to replace a file that was lost`.

### `instance/secrets-not-exported`

When the server writes an archive export, the server MUST NOT include `marfa.secrets` in it.

**Reason:** an export is meant to be shared and restored elsewhere, and the secrets belong to the instance that made them.

**Tests:** `compliance/hook-free-server.test.ts › leaves marfa.secrets out of an export, whether the file was generated or the secrets came from the environment`.

### `instance/unknown-setting-warned`

When the server starts and the environment holds a variable whose name begins with `MARFA_` or `S3_` and names no setting of the server and none that the `marfa` command reads from a shell, the server MUST log one warning for each such variable, naming the variable and the closest setting when one is near, and containing no part of the variable's value.

**Reason:** a setting that was renamed or removed, or one spelled wrongly, would otherwise leave the owner on the default with no word of it. The server still starts, because the same variable can be a leftover that does no harm, and the warning is where the owner looks for it. A value is never logged, since a misnamed variable can hold a secret.

**Tests:** `compliance/hook-free-server.test.ts › warns once of each MARFA_ or S3_ variable it does not read, names the setting it is near, and starts`.

### `instance/unknown-setting-no-ignored-name`

When the setting closest to an unknown variable is one that the server ignores because its test hooks are off, the server MUST NOT offer the name it ignores as the correction.

**Reason:** a variable that seeds a stored setting, or that runs a test hook, does nothing on a server without hooks, so the correction would lead the owner to another variable the server ignores. The warning names the stored setting instead, and the way to set it.

**Tests:** `compliance/hook-free-server.test.ts › warns once of each MARFA_ or S3_ variable it does not read, names the setting it is near, and starts`.

### `instance/unknown-secret-name-refused`

If the environment holds a variable that names no setting of the server and is within two edits of the name of a secret, `MARFA_KEY_SALT` or `MARFA_AUTH_SECRET`, ignoring case and whatever the variable's prefix, and holds no variable named for that secret, then the server MUST refuse to start and name the variable and the secret.

**Reason:** a misspelled secret would not stop the server, which makes a secret of its own where the environment gives none: a new salt ends every key, and a new authentication secret ends every sign-in. This is the one misspelling that costs more than the start it stops. A wrong prefix, such as `MARF_AUTH_SECRET`, is as likely a slip as a wrong letter, so the name is judged whatever it begins with. When the secret itself is set, nothing is replaced, so the start goes on and the near name draws the ordinary warning.

**Tests:** `compliance/hook-free-server.test.ts › refuses a variable a letter from the name of a secret, which the server would replace, and starts without it`, `compliance/hook-free-server.test.ts › starts, and warns of the near name, when the secret itself is set`.

### `instance/unknown-setting-warned-after-refusal`

If another setting refuses the start, then the server MUST NOT log the warning for an unknown variable.

**Reason:** a refused start shows what to fix and no more, so a leftover variable's warning does not bury the refusal.

**Tests:** `compliance/hook-free-server.test.ts › logs no warning when another setting refuses the start`.

### `instance/proxy-header-trusted-peer`

While both `MARFA_TRUSTED_PROXY_HEADER` and `MARFA_TRUSTED_PROXY_CIDRS` are set, the server MUST read a caller's address from the header only when the request's peer is inside the ranges, and the peer's address stands for any other request.

**Tests:** `compliance/trusted-proxy.test.ts › is read only from a peer inside the ranges when ranges are set`.

### `instance/proxy-header-needs-ranges`

If `MARFA_TRUSTED_PROXY_HEADER` is set and `MARFA_TRUSTED_PROXY_CIDRS` is not, then the server MUST refuse to start with exit status 1 and a line that names `MARFA_TRUSTED_PROXY_CIDRS` as the setting to add.

**Reason:** the header holds the caller's address only when the edge that writes it sent the request, and the ranges are what tell the server which peers are that edge. A tunnel to a native server on the same machine connects from `127.0.0.0/8,::1/128`; a platform that does not publish its edge's addresses names `0.0.0.0/0,::/0`, so trusting every peer is a setting someone wrote down.

**Tests:** `compliance/trusted-proxy.test.ts › without MARFA_TRUSTED_PROXY_CIDRS stops the server starting, with a line that names the ranges to set`, `compliance/trusted-proxy.test.ts › is read only from a peer inside the ranges when ranges are set`.

### `instance/proxy-header-single`

If the header named by `MARFA_TRUSTED_PROXY_HEADER` holds a list, is sent more than once or does not hold one IP address, then the server MUST use the peer's address.

**Reason:** an edge writes exactly one address, so anything else did not come from it.

**Tests:** `compliance/trusted-proxy.test.ts › is read from a peer inside the ranges only when it holds one address`.

### `instance/proxy-forwarded-walk`

While `MARFA_TRUSTED_PROXY_CIDRS` is set and `MARFA_TRUSTED_PROXY_HEADER` is not, when a request's peer is inside the ranges, the server MUST read the entries of `X-Forwarded-For` from right to left, skip the entries inside the ranges, and take the first entry outside them as the caller's address, or the leftmost entry if every entry is inside, or the peer's address if there are none.

**Reason:** each proxy appends the address it saw, so only the entries right of the first address outside the ranges were written by a proxy. Everything further left came from the caller.

**Tests:** `compliance/trusted-proxy.test.ts › is read from the right, skipping the proxies, so that an address the caller wrote further left is never taken`, `compliance/trusted-proxy.test.ts › is ignored from a peer outside the ranges`.

### `instance/proxy-forwarded-malformed`

When the server walks `X-Forwarded-For` and meets an entry that is not an IP address, the server MUST stop there and take the last trusted address it read as the caller's address.

**Tests:** `compliance/trusted-proxy.test.ts › stops at an entry that is not an address and takes the last proxy address it read`.

### `instance/proxy-forwarded-limit`

When the server walks `X-Forwarded-For`, the server MUST read at most 32 entries.

**Reason:** more hops than any real chain of proxies has are not read, so a long header costs no more than a short one.

**Tests:** `compliance/trusted-proxy.test.ts › reads at most 32 entries, however long the chain`.

### `instance/proxy-mapped-address`

When the server compares an address with `MARFA_TRUSTED_PROXY_CIDRS` or reads one from a header, the server MUST treat an IPv4-mapped IPv6 address as the IPv4 address it maps.

**Tests:** `compliance/trusted-proxy.test.ts › treats an IPv4-mapped IPv6 address as the IPv4 address it maps, in the ranges and in the chain`.
