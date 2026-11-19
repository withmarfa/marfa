# The instance

What one deployment says about itself, and what happens to it as an owner runs it: the identity it answers to, the features and contract version it advertises, how it compresses its answers, backing up, health, a database the build did not write, stopping, the pages it renders, the configuration operations and the settings that stop it from starting. The credential chapters state what a key may reach and the registry chapters state what the data plane holds.

`GET /` answers one of two things. The description is the JSON object with `name`, `version`, `instance_id`, `contract`, `features` and `max_request_bytes`. A page is the HTML a browser is given instead.

## Needs attention

### `instance/attention-authority`

When a caller holding `instance.read` sends `GET /attention`, the server MUST return an unpaginated `data` array of concerns, each with `kind`, `reference`, `title` and `description`.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`, `compliance/owner-tasks.test.ts › lets a key holding each permission do each owner task`.

### `instance/attention-permission`

If a credential without `instance.read` sends `GET /attention`, then the server MUST answer `403 forbidden` with `details.required_scope` `instance.read`.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`, `compliance/owner-tasks.test.ts › refuses each owner task to a key that lacks its permission, naming the permission`.

### `instance/attention-session`

When a request that carries no bearer token and arrives by the public listener sends `GET /attention`, the server MUST answer `401 unauthorized`.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`.

### `instance/attention-query`

If `GET /attention` carries a query field, then the server MUST answer `400 validation_error`.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`.

### `instance/attention-concerns`

When `GET /attention` completes its checks, the server MUST include degraded or down health components, housekeeping jobs whose last run failed, connectors whose last run failed or that report problems or have said nothing for more than 24 hours, active folders whose current sign-ins report problems, paused removals or a first sync waiting, live keys expiring within the next seven days inclusive, and a clock more than 7 days later or more than an hour earlier than the trusted time (`housekeeping/clock-ahead-held`, `housekeeping/clock-followed`).

**Reason:** connector silence follows the latest registration, heartbeat, or received run; folder totals exclude historical sign-ins and do not claim that a copy is online.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`.

### `instance/attention-no-backup`

Where neither `object_store_bucket` nor `backup_path` is set, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `no_backup_destination`, the title `No backups are kept`, and a description that names `backup_path`, `object_store_bucket` and `PATCH /config`.

**Reason:** an instance with no destination keeps no backup, and an owner who never reads the install output can run for months without knowing it.

**Tests:** `compliance/backups.test.ts › says in attention that no backups are kept and how to set one, and says an interval of 0 differently`, `cli/attention.test.ts › tells the owner in plain words that no backups are kept, and how to set one`.

### `instance/attention-backup-off`

Where a destination is set and `backup_interval_seconds` is 0, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `turned_off`.

**Reason:** an interval of 0 is a choice, and it is told differently from having nowhere to put a backup.

**Tests:** `compliance/backups.test.ts › says in attention that no backups are kept and how to set one, and says an interval of 0 differently`.

### `instance/attention-backup-destination-set`

Where `object_store_bucket` or `backup_path` is set, the server MUST NOT include an entry with the reference `no_backup_destination` in `GET /attention`.

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

**Tests:** `compliance/backup-folder.test.ts › lists in attention a backup run by hand that failed, until a later one is put`, `› puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`.

### `instance/attention-backup-incomplete`

While the copy record holds no copy in the destination of a file the last backup put names, the last backup run did not fail, the destination takes the copies that wait for it and `instance/backup-health-parts-damaged` does not hold, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `incomplete`, whose description says how many of those files wait.

**Reason:** a fresh instance cannot restore the files until replication copies them, and the owner learns it before they need the backup. The server reads the copy record and asks the destination about no file on a backup; `blob-integrity` strikes a copy it finds missing or altered (`stores/integrity-strikes`), and from then the file waits again.

**Tests:** `compliance/backups.test.ts › calls the newest backup incomplete in its answer, health and attention while the object store lacks files it names, refuses a restore from it, and clears once replication copies them`, `› calls the newest backup incomplete again once blob-integrity finds a copy of a file it names gone from the object store, until replication copies the file again`, `› calls the backups failing, not incomplete, in health and attention while files wait for their copy and a part an older backup names is damaged`.

### `instance/attention-backup-told-once`

While an entry of kind `backup` with the reference `store` is listed, the server MUST NOT list an entry with the reference `run` for a last backup run that failed because the destination did not answer.

**Reason:** one fault is one entry. A folder that is gone, or an object store that does not answer, fails the backup run and the copies together, and the owner reads the folder once.

**Tests:** `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`, `› lists in attention a backup run by hand that failed, until a later one is put`.

### `instance/attention-backup-no-job-twice`

While an entry of kind `backup` with the reference `run` or `store` is listed, the server MUST NOT list as a job entry the failed last run of the `backup` job or the `blob-replicate` job that it tells.

**Reason:** one fault is one entry.

**Tests:** `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`, `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`.

### `instance/attention-backup-unlocked`

Where `backup_path` is set and the file system that holds `<backup_path>/files/<instance id>/` takes no file locks, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `folder_unlocked`, whose description names that folder.

**Reason:** a copy of this instance started on the same backup folder could remove the files this one is still copying there.

**Tests:** waiting on #3116.

### `instance/attention-backup-parts-damaged`

While `instance/backup-health-parts-damaged` holds, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `parts_damaged`, whose description says how many parts are damaged.

**Reason:** a restore of a backup that names a damaged part is refused, so the owner learns of it before they need that backup.

**Tests:** `compliance/backup-parts.test.ts › says in health and attention that a part is damaged once a restore of its own backup finds it altered, until a backup stores the part again`.

### `instance/attention-backup-quiet`

Where a destination is set, while it takes copies, no file waits for one, the last backup run was whole, the copy record holds a copy in the destination of each file the last backup put names, `backup_interval_seconds` is above 0, `instance/backup-health-parts-damaged` does not hold and no entry is listed under `instance/attention-backup-unlocked`, the server MUST NOT include an entry of kind `backup` in `GET /attention`.

**Tests:** `compliance/backup-folder.test.ts › says nothing in health or attention while the folder answers and no file waits for its copy`, `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`.

### `instance/attention-clock-ahead`

While the server's clock is more than 7 days later than the trusted time (`housekeeping/clock-ahead-held`), the server MUST answer `GET /attention` with a concern of kind `clock` and reference `clock_ahead` whose description says how far ahead the clock is and names `marfa housekeeping confirm-clock`.

**Reason:** the jobs that delete do nothing while the clock is that far ahead (`housekeeping/clock-ahead-held`), and the owner is the one who can say whether the clock is right.

**Tests:** `compliance/clock-hold.test.ts › deletes nothing at 2, 31, 61, 91 and 400 days ahead, and cleans up by its rules once the owner confirms the clock`.

### `instance/attention-clock-behind`

While the server's clock is more than an hour earlier than the trusted time, the server MUST answer `GET /attention` with a concern of kind `clock` and reference `clock_behind`.

**Reason:** the server stamps writes by its clock (`housekeeping/clock-followed`), so a write can carry an earlier time than writes before it, which an owner should know of.

**Tests:** `compliance/clock-hold.test.ts › stamps by the clock when it is set back, and keeps the trusted time through a crash`.

### `instance/attention-unavailable`

If a check fails or does not answer within its bounded deadline, then the server MUST answer `GET /attention` with known concerns and an `unavailable` item identifying the check whose state is unknown.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`.

### `instance/attention-empty`

When every attention check completes without finding a concern, the server MUST return an empty `data` array from `GET /attention`.

**Tests:** `cli/attention.test.ts › shares attention with the private socket and a key holding instance.read, keeps known concerns, and refuses every other credential`.

## Background work

### `instance/background-request-authority`

When the key that started a housekeeping run, or that made a write that woke a webhook delivery, is revoked while the work is waiting or running, the server MUST finish the work as though the key stood.

**Reason:** housekeeping and webhook deliveries are the server's own work, not the requester's. A bulk-action job is the exception: it rechecks its stored credential under `items/job-credential-lost` and can still record its failure.

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

A client that keeps a copy of one instance names that instance in `X-Marfa-Instance-Id` on what it sends, so a write that reaches another instance at the same address is refused where it lands. In this section a write is a `POST`, `PUT`, `PATCH` or `DELETE` to an operation outside `/auth`, `/oauth` and `/grants`, `POST /items/bulk-get`, `POST /items/lookup` and `POST /items/counts` among them. An inbound webhook address is served ahead of any credential and is not one.

### `instance/write-names-own`

When a write names in `X-Marfa-Instance-Id` the instance's own `instance_id`, the server MUST answer it as it answers the same write without the header.

**Tests:** `compliance/instance-header.test.ts › takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it`, `› keeps no refusal under an Idempotency-Key, and replays the first answer whatever instance the repeat names`, `› refuses another instance on POST /items/bulk-get and POST /items/lookup`.

### `instance/write-names-other`

If a write names in `X-Marfa-Instance-Id` a UUIDv7 other than the instance's own `instance_id`, then the server MUST answer `409 instance_changed`.

**Reason:** another instance at the address the client knew holds none of the items its copy was built from, so a write sent there would land on items the client never read.

**Tests:** `compliance/instance-header.test.ts › takes a write naming this instance, and refuses one naming another 409 instance_changed without writing it`, `› refuses another instance on every write operation the document publishes outside /auth, /oauth and /grants`, `› refuses a count naming another instance 409 instance_changed, answering no count`.

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

### `instance/write-instance-every-operation`

The server MUST judge `X-Marfa-Instance-Id` on every write.

**Tests:** `compliance/instance-header.test.ts › refuses another instance on every write operation the document publishes outside /auth, /oauth and /grants`, `› refuses another instance on POST /items/bulk-get and POST /items/lookup`.

### `instance/write-instance-ignored`

When a `GET`, a request to an operation under `/auth`, `/oauth` or `/grants`, or a delivery to an inbound webhook address names `X-Marfa-Instance-Id`, the server MUST answer it as it answers the same request without the header.

**Reason:** a read of a copy is held to the instance by its reach (`reach/conditional-certified`), and the sign-in operations, the OAuth operations, the app grants and inbound senders hold no copy.

**Tests:** `compliance/instance-header.test.ts › answers a GET, a request under /auth, /oauth or /grants and an inbound delivery as it answers one without the header`.

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

When `GET /` is answered with the description, the server MUST answer `version` as the release the server runs, three dot-separated whole numbers.

**Reason:** a person who is upgrading names a release, and reads it here. A build made from a checkout carries `0.0.0`, which has the same form.

**Tests:** `compliance/instance.test.ts › describes itself at the root`, `› names its version as three whole numbers`.

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

When `GET /` is answered with the description, the server MUST answer `contract` as the integer that `info.version` of the contract's `openapi.json` writes.

**Reason:** a client is built for the number its copy of the document names, so the server answers that number whichever build serves it.

**Tests:** `compliance/instance.test.ts › carries one contract version at the root and in its document`, `› describes itself at the root`, `compliance/hook-free-server.test.ts › names the contract of its document at the root, in the document it serves and in a header, as a release build does`.

### `instance/contract-document`

When `GET /openapi.json` is answered, the server MUST answer `info.version` as the text of the number the root answers as `contract`.

**Tests:** `compliance/instance.test.ts › carries one contract version at the root and in its document`.

### `instance/contract-header`

The server MUST send `X-Marfa-Contract`, with the number the root answers as `contract`, on every answer to a request whose request line, headers and `Host` it can parse, whether it is a read, a refusal, a page, a stream, a download, a request the rate limiter refuses or a preflight.

**Reason:** a client checks the answer it is about to read against the contract it was built for, so the header cannot be missing on the answers a layer in front of the routes shapes. A request the server cannot parse is refused by the HTTP layer before anything that knows the contract sees it.

**Tests:** `compliance/instance.test.ts › sends its contract version on every answer, a refusal included`, `› sends its contract version on every kind of answer, not only a JSON body`, `compliance/contract-header.test.ts › sends its contract version on a request the limiter refuses`, `› sends its contract version on a preflight from an origin the instance allows`.

### `instance/contract-request-other`

If a request names `X-Marfa-Contract` with a value other than the digits that write the number the root answers as `contract`, then the server MUST answer `412 contract_mismatch`.

**Reason:** a client built for another contract reads what the server sends in shapes the server does not mean, and a write it sends carries shapes the server does not read as the client meant. The value is refused whatever it is, a number, an empty value, text, a signed number or one with a leading zero.

**Tests:** `compliance/contract-request.test.ts › refuses a request naming another contract, or a value that is not the digits of this one, 412 contract_mismatch`.

### `instance/contract-request-repeated`

If a request names `X-Marfa-Contract` on more than one header line, then the server MUST answer `412 contract_mismatch`, whatever the lines hold.

**Tests:** `compliance/contract-request.test.ts › refuses a request that names its contract on two header lines, though both name this one`.

### `instance/contract-request-unchanged`

When the server answers a request `412 contract_mismatch`, the server MUST leave unchanged everything the request would have changed.

**Tests:** `compliance/contract-request.test.ts › refuses a write naming another contract without writing it`.

### `instance/contract-request-optional`

The server MUST NOT refuse a request for naming no `X-Marfa-Contract`.

**Reason:** a caller built for no contract, such as a script, a connector or an inbound sender, has none to name.

**Tests:** `compliance/contract-request.test.ts › serves a request naming no contract, and one naming this contract, as it serves each other`.

### `instance/contract-request-every-operation`

The server MUST judge `X-Marfa-Contract` on every request, whatever its method, its path and its credential.

**Tests:** `compliance/contract-request.test.ts › refuses another contract on every operation the document publishes, and on a path no operation serves`, `› refuses another contract on HEAD and OPTIONS, the MCP door, the OAuth token door, the device code door, an inbound endpoint, a well-known document and a route over the private socket`.

### `instance/contract-request-first`

When a request names another contract and meets another refusal, such as a missing credential, another instance in `X-Marfa-Instance-Id` or a body that is not JSON, the server MUST answer `412 contract_mismatch`.

**Reason:** a request built for another contract is refused for that alone, so what else the server says of it, such as a refusal of its body, is not a rule the client was built for.

**Tests:** `compliance/contract-request.test.ts › answers 412 before it judges the credential, the instance and the body`.

### `instance/contract-request-not-recorded`

When the server answers a write that carries an `Idempotency-Key` `412 contract_mismatch`, the server MUST answer the same write sent again under that key, naming the contract the root answers, as a first attempt.

**Reason:** a client that meets the refusal is rebuilt for the contract the server speaks, and sends its queue again under the same keys.

**Tests:** `compliance/contract-request.test.ts › keeps no refusal under an Idempotency-Key`.

### `instance/contract-request-cors`

When a preflight from an origin the instance allows names `X-Marfa-Contract` in `Access-Control-Request-Headers`, the server MUST name it in `Access-Control-Allow-Headers`.

**Reason:** a page that names its contract on a request is sent a preflight first, and a browser that is not told the header is allowed does not send the request.

**Tests:** `compliance/contract-header.test.ts › allows a request header naming the contract in a preflight from an origin the instance allows`.

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

An owner has two backups of an instance. Where `object_store_bucket` is set, the server backs itself up to that object store, and where `backup_path` is set, to that folder: on a schedule, and when the owner asks. With neither set, it keeps no backup. Each backup is a manifest and the parts it names, which together make an archive, as `GET /export?format=archive` writes one, of every item and instance line, the trash included, and of no file's bytes, since the object store, or the backup folder's files area, already keeps a copy of each file as an attached store. Each part is named for its bytes, so a part that a later backup holds unchanged is stored once. And an image of the data directory, such as a machine backup takes, holds everything the instance keeps: the database file, the log beside it that holds the writes not yet moved into the file, and the folder of blob files. Neither holds the setting `MARFA_KEY_SALT`, and a backup holds no credential, so after a backup is restored, sign-in, keys, apps, webhooks, inbound endpoints and connector keys are set up again, the instance's addresses and name are set again, and the audit log and the event log are not restored.

### `instance/backup-object`

Where `object_store_bucket` is set, when the server takes a backup, the server MUST put its manifest in the object store as one object named `<object_store_prefix>/backups/<instance id>/<created>.json`, where `<instance id>` is the instance's id and `<created>` is its manifest's `created_at` in ISO 8601 basic format, such as `20261109T101530.250Z`.

**Reason:** a server that replaces another can start on the same prefix, and the folder keeps each instance's backups apart. The basic format holds no colon, so a copy of the backup lands whole on a FAT or exFAT disk and on Windows, and the names still sort by time.

**Tests:** `compliance/backups.test.ts › puts one manifest in the prefix's backups folder for its instance, named for its created_at, and parts named for their bytes that together hold what an archive export with state any and files false holds for a key that reaches everything`.

### `instance/backup-folder-file`

Where `backup_path` is set, when the server takes a backup, the server MUST write its manifest as one file named `<backup_path>/backups/<instance id>/<created>.json`, where `<instance id>` is the instance's id and `<created>` is its manifest's `created_at` in ISO 8601 basic format, such as `20261109T101530.250Z`.

**Reason:** a server that replaces another, given the same folder, restores its backups, and the folder keeps each instance's backups apart. The basic format holds no colon, which a FAT or exFAT disk refuses in a file's name, and the names still sort by time.

**Tests:** `compliance/backup-folder.test.ts › writes each backup as one manifest named for its created_at in the folder's backups folder for its instance, its parts named for their bytes, and a copy of each file it names in the folder's files area`.

### `instance/backup-part-named`

Where `object_store_bucket` or `backup_path` is set, when the server takes a backup, the server MUST store each part its manifest names as `<root>/backup-parts/<instance id>/<sha256>.ndjson.gz`, where `<root>` is `<object_store_prefix>` or `<backup_path>` and `<sha256>` is the SHA-256 of the part's bytes in lowercase hex.

**Reason:** a part is named for what it holds, so a part that two backups share is stored once, and a restore tells a part that was altered from the one its manifest names.

**Tests:** `compliance/backups.test.ts › puts one manifest in the prefix's backups folder for its instance, named for its created_at, and parts named for their bytes that together hold what an archive export with state any and files false holds for a key that reaches everything`, `compliance/backup-folder.test.ts › writes each backup as one manifest named for its created_at in the folder's backups folder for its instance, its parts named for their bytes, and a copy of each file it names in the folder's files area`.

### `instance/backup-manifest-form`

When the server takes a backup, the server MUST write its manifest as a JSON object that holds `format` `"marfa-backup"`, `version` `1`, in `archive` the manifest an archive of the backup's lines carries, and in `parts` each part in archive order with its `entry`, `sha256`, `size_bytes` and `lines`.

**Tests:** `compliance/backups.test.ts › puts one manifest in the prefix's backups folder for its instance, named for its created_at, and parts named for their bytes that together hold what an archive export with state any and files false holds for a key that reaches everything`, `compliance/backup-folder.test.ts › writes each backup as one manifest named for its created_at in the folder's backups folder for its instance, its parts named for their bytes, and a copy of each file it names in the folder's files area`.

### `instance/backup-parts-archive`

When the server takes a backup, the server MUST name in its manifest, for each entry of the archive, parts whose bytes, joined in the order the manifest names them, are that entry.

**Reason:** each part is a whole gzip file, and gzip files joined end to end read as one, so a restore reads the parts in order as the archive an export writes.

**Tests:** `compliance/backups.test.ts › puts one manifest in the prefix's backups folder for its instance, named for its created_at, and parts named for their bytes that together hold what an archive export with state any and files false holds for a key that reaches everything`, `compliance/backup-folder.test.ts › writes each backup as one manifest named for its created_at in the folder's backups folder for its instance, its parts named for their bytes, and a copy of each file it names in the folder's files area`.

### `instance/backup-folder-copies`

Where `backup_path` is set, the server MUST NOT write a backup's manifest in the folder before `<backup_path>/files/<instance id>/<first four hex digits>/<hex>` holds the bytes of each file the backup names but those its `files.ndjson.gz` names as `lost`, where `<hex>` is the file's SHA-256 in hex.

**Reason:** a backup carries no file's bytes, so the folder alone restores a backup only while it holds a copy of each file. Each file is copied once and kept while a backup names it, so a backup costs what changed since the last.

**Tests:** `compliance/backup-folder.test.ts › writes each backup as one manifest named for its created_at in the folder's backups folder for its instance, its parts named for their bytes, and a copy of each file it names in the folder's files area`, `› refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-reserve`

Where `backup_path` names a folder on a volume that also holds the database or the disk store's folder, if a copy of a file there, or a backup, would leave less free on that volume than `disk_reserve_bytes`, then the server MUST leave the file uncopied there, or the backup unwritten.

**Reason:** the reserve keeps room for every other write on the volume the server lives on. A folder on a disk of its own holds back none of it: the copy needs only room for the file.

**Tests:** `compliance/backup-folder.test.ts › leaves a file uncopied that would take the server's own volume below its reserve, says so in health by the setting's name, and copies it once there is room`, `› writes no archive that would take the server's own volume below its reserve, and writes it once there is room`.

### `instance/backup-folder-reserve-said`

Where `backup_path` names a folder on a volume that also holds the database or the disk store's folder, while a file waits because a copy of it there would leave less free on that volume than `disk_reserve_bytes`, the server MUST name `disk_reserve_bytes` in `backups.store_error`.

**Tests:** `compliance/backup-folder.test.ts › leaves a file uncopied that would take the server's own volume below its reserve, says so in health by the setting's name, and copies it once there is room`.

### `instance/backup-folder-whole`

Where `backup_path` is set, if a backup run fails, or the process ends, before the server has written the backup's manifest whole, then the server MUST NOT leave a file directly under `<backup_path>/backups/<instance id>/` whose name reads as that backup.

**Reason:** the server writes the manifest last, under a name that begins with `.`, which no listing reads, and gives it its name only once it is whole and synced to the disk.

**Tests:** `compliance/backup-folder.test.ts › leaves no file a listing reads as a backup when a run fails partway or its process ends, and clears what it left at the next run`.

### `instance/backup-part-whole`

Where `object_store_bucket` or `backup_path` is set, if a backup run fails, or the process ends, while the server stores a part, then the server MUST NOT leave under `<root>/backup-parts/<instance id>/`, where `<root>` is `<object_store_prefix>` or `<backup_path>`, a file or object named as a part that does not hold the bytes whose SHA-256 its name gives.

**Reason:** a part goes to the folder under a name that begins with `.` and takes its name once it is whole and synced to the disk, and to the object store in one put, or a multipart upload that no listing or read sees until it completes.

**Tests:** `compliance/backup-folder.test.ts › leaves no file a listing reads as a backup when a run fails partway or its process ends, and clears what it left at the next run`, `compliance/backup-faults.test.ts › leaves no object and no spool when killed while putting a backup larger than one part`.

### `instance/backup-manifest-last`

Where `object_store_bucket` or `backup_path` is set, the server MUST NOT write a backup's manifest before the destination lists every part the manifest names at the size the manifest gives.

**Reason:** a listed backup is one whose parts are all there. A backup that fails before its manifest is written is never listed, and the next run stores only the parts the destination still lacks.

**Tests:** `compliance/backup-parts.test.ts › lists no backup whose manifest was not written, deletes no part while that manifest may still land, and the next run stores only the parts it lacks`.

### `instance/backup-folder-leftovers`

Where `backup_path` is set, when the server runs a backup, the server MUST first remove what a process that ended left half written under `<backup_path>/backups/<instance id>/`, `<backup_path>/backup-parts/<instance id>/` and `<backup_path>/files/<instance id>/`.

**Tests:** `compliance/backup-folder.test.ts › leaves no file a listing reads as a backup when a run fails partway or its process ends, and clears what it left at the next run`.

### `instance/backup-folder-not-made`

Where `backup_path` is set, the server MUST NOT create the folder it names.

**Reason:** a folder on a disk that is not mounted is missing, and one made in its place would be on another disk. The server makes only the folders inside it, and only once it holds the instance's store marker, so an empty mount point fails a backup too.

**Tests:** `compliance/backup-folder.test.ts › counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back`, `› reports a backup folder that does not exist as unusable, keeps serving files, makes none, and takes it once it exists`, `› refuses a backup folder inside its data directory or its blob folder, judged where links lead, and makes none`, `› refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-unmarked`

Where `backup_path` is set, while `<backup_path>/files/<instance id>/` does not hold the marker of the store the server recorded there, the server MUST NOT write into `<backup_path>`.

**Reason:** the folder may be a mount point whose disk is not mounted. A server that first started on an empty mount point on Linux wrote its marker into that mount point, so once the real disk mounts over it the marker is out of sight and each backup fails loudly; `POST /backups/folder/adopt` then starts afresh on the disk, as it does for a disk that replaced the old one.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-unmarked-error`

Where `backup_path` is set, if a backup run fails because `<backup_path>/files/<instance id>/` does not hold the marker of the store the server recorded there, then the server MUST name the command `marfa backups folder adopt` in the run's error message.

**Reason:** the message reaches the owner in the answer to `POST /backups` and in `backups.last_error` of `GET /health`, so the owner learns how to go on with a disk that replaced the old one.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt`

Where `backup_path` is set, when a caller holding `backups.manage` sends `POST /backups/folder/adopt` while the folder `backup_path` names exists and `<backup_path>/files/<instance id>/` holds no store marker, the server MUST take that files folder as a store of kind `folder` with an id no store had before, which it answers in `store_id`.

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

If a caller holding `backups.manage` sends `POST /backups/folder/adopt` while `<backup_path>/files/<instance id>/` holds the marker of the store the server recorded there, then the server MUST answer `409 conflict`.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-missing`

If a caller holding `backups.manage` sends `POST /backups/folder/adopt` while the folder `backup_path` names does not exist, then the server MUST answer `503 blob_store_unavailable`.

**Tests:** `compliance/backup-folder.test.ts › refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store`.

### `instance/backup-folder-adopt-object-store`

Where `object_store_bucket` is set, if a caller holding `backups.manage` sends `POST /backups/folder/adopt`, then the server MUST answer `409 conflict`.

**Reason:** an instance that backs up to an object store has no backup folder to adopt.

**Tests:** `compliance/backups.test.ts › refuses to adopt a backup folder on an instance that backs up to an object store`.

### `instance/backup-folder-adopt-foreign`

If a caller holding `backups.manage` sends `POST /backups/folder/adopt` while `<backup_path>/files/<instance id>/` holds the marker of a store other than the one the server recorded there, then the server MUST answer `409 conflict`.

**Reason:** the marker may be another instance's or another server's store, and adopting over it would take that store's files as this instance's own. The refusal leaves the marker as it is, and the error message says to remove it to adopt the folder afresh.

**Tests:** `compliance/backup-folder.test.ts › refuses to adopt a files folder that holds another store's marker, and leaves the marker as it is`.

### `instance/backup-folder-missing-unusable`

If `backup_path` names a folder that does not exist, and the server has not attached a backup folder at that path before, then the server MUST answer `GET /health` with `backups.status` `failing`, `backups.reason` `destination_unusable` and a `backups.store_error` that says the folder does not exist.

**Reason:** the owner learns at once that the folder is wrong, from any app. A folder the server has attached before may be on a disk that is not mounted yet, so each backup fails until it is back, as `instance/backup-folder-unmarked` says.

**Tests:** `compliance/backup-folder.test.ts › reports a backup folder that does not exist as unusable, keeps serving files, makes none, and takes it once it exists`.

### `instance/backup-destination-unusable-serves`

If the backup folder or the object store the settings name cannot be used, then the server MUST keep serving each file from its disk store.

**Reason:** a wrong setting stops the second copy and the backups, never the files the owner already has.

**Tests:** `compliance/backup-folder.test.ts › reports a backup folder that does not exist as unusable, keeps serving files, makes none, and takes it once it exists`, `compliance/destination-settings.test.ts › reports an object store that refuses its secret as unusable, keeps serving files from the disk, and takes the store once the secret is right`.

### `instance/backup-destination-retried`

While the backup folder or the object store the settings name cannot be used, when a backup runs, the server MUST first try again to take that destination into use.

**Reason:** a disk mounted late or a secret mended outside the server is taken without another write to `/config`.

**Tests:** `compliance/backup-folder.test.ts › reports a backup folder that does not exist as unusable, keeps serving files, makes none, and takes it once it exists`.

### `instance/backup-folder-inside-refused`

If a write to `/config` sets `backup_path` to a folder inside the data directory or the blob folder, judged where symbolic links lead, then the server MUST answer `400 validation_error` naming `backup_path`.

**Reason:** a backup there is lost with what it backs up.

**Tests:** `compliance/backup-folder.test.ts › refuses a backup folder inside its data directory or its blob folder, judged where links lead, and makes none`.

### `instance/backup-folder-unlocked-start`

Where `backup_path` is set and the file system that holds `<backup_path>/files/<instance id>/` takes no file locks, the server MUST NOT refuse to start because it cannot keep another server from that folder.

**Reason:** the server serves without its backup folder, so it starts and tells the owner under `instance/attention-backup-unlocked`. A lock file there that belongs to another account, or has a second link, still refuses the start, since a copy of the instance may be using the folder.

**Tests:** waiting on #3116.

### `instance/backup-one-destination-refused`

If a write to `/config` would leave both `object_store_bucket` and `backup_path` set, then the server MUST answer `400 validation_error` naming the one the write sets.

**Reason:** backups go to one place, so a restore knows where to read them.

**Tests:** `compliance/backup-folder.test.ts › refuses a write to /config that would set both object_store_bucket and backup_path, and keeps what was stored`.

### `instance/backup-holds-export`

When the server takes a backup, the server MUST put in it the items, edges, rows and instance lines that `GET /export?format=archive&state=any&files=false` would send a key that holds every permission and reaches every type at that moment, but for the `source` lines that `archive/archive-sources` gives a backup.

**Tests:** `compliance/backups.test.ts › puts one manifest in the prefix's backups folder for its instance, named for its created_at, and parts named for their bytes that together hold what an archive export with state any and files false holds for a key that reaches everything`.

### `instance/backup-no-file-bytes`

When the server takes a backup, the server MUST name every file its items name in its `files.ndjson.gz`, each as `not_carried` or `lost`, and carry no file's bytes.

**Reason:** the object store or the backup folder already holds a copy of each file the instance has replicated, so a backup that carried them would put every file there again each time. A file that has not been replicated yet leaves the backup incomplete until its copy is made (`instance/backup-health-incomplete`).

**Tests:** `compliance/backups.test.ts › puts one manifest in the prefix's backups folder for its instance, named for its created_at, and parts named for their bytes that together hold what an archive export with state any and files false holds for a key that reaches everything`.

### `instance/backup-lost-files-named`

When the server takes a backup, the server MUST name as `lost` in its `files.ndjson.gz` each file the backup names of which no attached store gives the bytes whole.

**Reason:** a restore then tells a file that was gone before the backup from one taken out of the backup folder after it. Where `backup_path` is set the server learns it as it copies each file to the folder; for the object store, from each store's answer for the copies the copy record names.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file lost and in health, and clears health with the next backup that loses none`.

### `instance/backup-lost-files-put`

If a file a backup names is one no attached store gives the bytes of whole, then the server MUST still put the backup.

**Reason:** one lost file stops no backup of every item, edge and setting.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file lost and in health, and clears health with the next backup that loses none`.

### `instance/backup-lost-files-answered`

When a caller holding `backups.manage` sends `POST /backups`, the server MUST answer in `blobs_lost` the hash of each file the backup it put names as `lost`.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file lost and in health, and clears health with the next backup that loses none`.

### `instance/backup-line-cap`

If an item, an earlier version of an item or an edge a backup would hold takes more than 67108864 bytes on its archive line, then the server MUST answer `POST /backups` with `409 export_entry_unrestorable`, with `details.entry` naming the item or edge, without putting the backup.

**Reason:** a restore reads no line longer (`archive/restore-text-cap`), so such a backup could never be restored, and an owner told at the time can correct the item while the earlier backups still stand.

**Tests:** `compliance/archive-line-cap.test.ts › refuses an export and a backup whose item line is past the limit, naming the item`.

### `instance/backup-answer-waiting`

When a caller holding `backups.manage` sends `POST /backups`, the server MUST answer in `blobs_waiting` how many files the backup it put names of which the copy record holds no copy in the destination.

**Reason:** the object store takes a file's copy when replication reaches it, which can be after the backup that names it. The server reads the copy record and asks the destination about no file on a backup; `blob-integrity` strikes a copy it finds missing or altered (`stores/integrity-strikes`), and from then the file waits again.

**Tests:** `compliance/backups.test.ts › calls the newest backup incomplete in its answer, health and attention while the object store lacks files it names, refuses a restore from it, and clears once replication copies them`.

### `instance/backup-part-stored-once`

Where `object_store_bucket` or `backup_path` is set, when the server takes a backup, the server MUST NOT store a part that the destination already holds under its name with the bytes whose SHA-256 that name gives.

**Reason:** a backup then costs what changed since the last one, not the whole instance. The server takes a part as held while the destination lists it as it was when the server stored or last hashed it: an object store by its ETag, and a backup folder by the file's size, modified time, inode and, where the file system records one, birth time. It reads and hashes any other part, so a part written since is checked byte for byte.

**Tests:** `compliance/backup-parts.test.ts › stores none of the parts of a backup that holds what the last one held, and not the rows of a large table that did not change, and answers what it sent`.

### `instance/backup-unchanged-parts`

When the server takes a backup that holds the same lines as the last backup it put, the server MUST store none of the backup's parts that the destination holds under their names with the bytes whose SHA-256 those names give.

**Reason:** a backup asked for when nothing has changed costs one manifest, and a part lost or altered in the destination since is stored again (`instance/backup-part-stored-again`).

**Tests:** `compliance/backup-parts.test.ts › stores none of the parts of a backup that holds what the last one held, and not the rows of a large table that did not change, and answers what it sent`, `› stores again a part missing from its instance's parts folder or altered there, sends only those parts, and both backups then restore`.

### `instance/backup-large-table-once`

When the server takes a backup, the server MUST NOT store again the rows of a table whose rows' values take 4194304 bytes or more and have not changed since the last backup it put.

**Reason:** a large table that is not being written to is not stored again because another table changed.

**Tests:** `compliance/backup-parts.test.ts › stores none of the parts of a backup that holds what the last one held, and not the rows of a large table that did not change, and answers what it sent`.

### `instance/backup-answer-sent`

When a caller holding `backups.manage` sends `POST /backups`, the server MUST answer in `sent_bytes` how many bytes of parts the backup stored that the destination did not already hold under their names with the bytes whose SHA-256 those names give.

**Tests:** `compliance/backup-parts.test.ts › stores none of the parts of a backup that holds what the last one held, and not the rows of a large table that did not change, and answers what it sent`, `› stores again a part missing from its instance's parts folder or altered there, sends only those parts, and both backups then restore`.

### `instance/backup-part-stored-again`

Where `object_store_bucket` or `backup_path` is set, if a backup the server takes names a part that `<root>/backup-parts/<instance id>/` lacks, or holds with bytes other than those whose SHA-256 its name gives and lists with another ETag, or in a backup folder another size, modified time, inode or birth time, than it had when the server last stored or hashed that part, or holds in a backup folder that answers but cannot give that part's bytes, where `<root>` is `<object_store_prefix>` or `<backup_path>`, then the server MUST store that part there again.

**Reason:** each backup restores whole, not only the first one that named a part. A write through the store gives an object another ETag, and a write through the file system gives a file another modified time. An object store that changes an object's bytes and keeps its ETag breaks its own promise of durability, and the server finds that change only when a restore reads the part (`instance/backup-restore-parts-checked`). A disk can change a file's bytes and keep all four, which `instance/backup-folder-part-rehashed` bounds. A part whose read fails on a bad sector or a permission does not fail the backup: the server counts it as damaged and stores it again where the backup names it.

**Tests:** `compliance/backup-parts.test.ts › stores again a part missing from its instance's parts folder or altered there, sends only those parts, and both backups then restore`, `› hashes a due folder part only an older backup names while a manifest does not read, and counts a part it cannot read as damaged, storing it again where a backup names it`.

### `instance/backup-folder-part-rehashed`

Where `backup_path` is set, when the server takes a backup, the server MUST read and hash the parts in `<backup_path>/backup-parts/<instance id>/` that it last stored or hashed 7 days or more before, oldest first, until their listed sizes reach 536870912 bytes, and always the oldest one, but for a part that backup's clean-up finds no backup names.

**Reason:** a disk can change a file's bytes and keep its size, modified time, inode and birth time, by decay or by a write in place that sets the time back, and `instance/backup-part-stored-again` does not see that change. The server finds such a change at the first backup 7 days or more after the part's last hash, or once it has read the parts due before it, whichever backups name the part and whether or not every backup's manifest reads. A backup runs only when something changed or the owner asks for one. An object store checks its own objects, and reading them again would be billed.

**Tests:** `compliance/backup-parts.test.ts › takes a folder part as held while its size, modified time, inode and birth time are unchanged, and hashes it again once 7 days have passed since its last hash`, `› hashes a due folder part only an older backup names while a manifest does not read, and counts a part it cannot read as damaged, storing it again where a backup names it`.

### `instance/backup-keeps-files`

While the server has recorded a backup it put in the object store or the backup folder, and has neither thinned that backup nor, while a later backup was recorded, found it missing from three or more consecutive listings of the store, the last of which lists backups of its own such that thinning them together with that backup would delete that backup, the server MUST NOT purge a file that backup names.

**Reason:** Backups contain no file bytes and outlive the orphan grace. The server knows a backup only by its record and the store's listings, and one listing can leave out an object the store holds. So the server takes a backup to be gone only once several listings in a row have left it out and thinning would delete it anyway, and a listing that shows it again starts the count over. Being missing never lets go of a backup that thinning keeps, however the clock has moved. Thinning is judged on the listed backups and that one backup, so another backup the listings leave out cannot push it out of the days thinning keeps.

**Tests:** `compliance/backup-files.test.ts › keeps a file a retained backup names once nothing else names it, across a restart, so a fresh server on the bucket restores it whole`.

### `instance/backup-no-credentials`

When the server takes a backup, the server MUST NOT put in it a key, an app's token, the owner's password or passkeys, the contents of `marfa.secrets`, or the object store's credentials.

**Reason:** a backup that leaked from the bucket gives nobody access to the instance or to the bucket.

**Tests:** `compliance/backups.test.ts › holds no key, token, password, secret or object store credential`.

### `instance/backup-whole`

Where `object_store_bucket` is set, if a backup run fails, or the process ends, before the object store has taken the backup's manifest, then the server MUST NOT leave an object under `<object_store_prefix>/backups/` that names that backup.

**Reason:** the manifest is the last object a backup puts. A part larger than one upload part goes up as a multipart upload, which no listing or read sees until it completes; an upload the process left unfinished still holds its pieces in the bucket until a lifecycle rule or the store's own clean-up removes them.

**Tests:** `compliance/backup-faults.test.ts › leaves no object and no spool when killed while putting a backup larger than one part`.

### `instance/backup-slow-store`

When the object store takes a backup's bytes more slowly than the 30 seconds a client download may stall, the server MUST still put the whole backup.

**Reason:** the 30 seconds bounds a client that stopped reading. A backup's put has a deadline of its own that allows for a slow uplink.

**Tests:** `compliance/backup-faults.test.ts › puts a backup whole when the object store takes it more slowly than a client download may stall`.

### `instance/backup-spool-gone`

When the server starts after a process that ended during a backup, the server MUST hold none of that backup's spool on its disk.

**Tests:** `compliance/backup-faults.test.ts › leaves no object and no spool when killed while putting a backup larger than one part`.

### `instance/backup-interval`

Where `object_store_bucket` or `backup_path` is set and `backup_interval_seconds` is above 0, the server MUST run a backup once that interval has passed since the last run ended.

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

When a caller holding `backups.manage` sends `POST /backups`, the server MUST put a backup, whether or not anything has changed since the last.

**Tests:** `compliance/backups.test.ts › skips a scheduled run when nothing changed, counts a settings change as a change, and puts one when asked`.

### `instance/backup-asker-gone-early`

If the key that sent `POST /backups` is revoked before the backup sends its first part, then the server MUST answer `401 unauthorized` and put no backup.

**Tests:** `compliance/owner-tasks.test.ts › puts no backup for a key revoked before the backup's upload begins`.

### `instance/backup-asker-gone-late`

If the key that sent `POST /backups` is revoked while the backup is put, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/owner-tasks.test.ts › records no backup for a key revoked while its backup uploads`.

### `instance/backup-asker-gone-late-unlisted`

If the key that sent `POST /backups` is revoked while the backup is put, then the server MUST NOT list that backup in `GET /backups`, either when it answers or after a later backup run.

**Reason:** a backup put for a caller whose access ended is not one the owner can count on or restore from, so the server deletes what it wrote of it rather than keep it.

**Tests:** `compliance/owner-tasks.test.ts › records no backup for a key revoked while its backup uploads`.

### `instance/backup-asker-gone-late-unrecorded`

If the key that sent `POST /backups` is revoked while the backup is put, then the server MUST leave `backups.last_backup` of `GET /health` as it was.

**Tests:** `compliance/owner-tasks.test.ts › records no backup for a key revoked while its backup uploads`.

### `instance/backup-asker-gone-store-failed`

If the key that sent `POST /backups` is revoked while the backup is put and the object store or the backup folder does not take the backup, then the server MUST count the failed run in `backups.failures` of `GET /health`.

**Tests:** `compliance/owner-tasks.test.ts › counts the failed run when the backup folder fails a backup whose key was revoked while it uploads`.

### `instance/backup-one-at-a-time`

While a backup run is under way, when a caller holding `backups.manage` sends `POST /backups`, the server MUST answer `409 housekeeping_job_running` and start no second run.

**Tests:** `compliance/backup-faults.test.ts › runs one backup at a time, answering a second ask with 409 housekeeping_job_running`.

### `instance/backup-unreachable`

If the object store or the backup folder does not take a backup, then the server MUST count the failed run and run again at the next interval.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`, `› runs the next scheduled backup after a failed one when nothing has changed since the last backup put`, `compliance/backup-folder.test.ts › counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back`.

### `instance/backup-health-failing`

While the last backup run failed, the server MUST answer `GET /health` with `backups.status` `failing` and an overall `status` no better than `degraded`.

**Reason:** a backup that stops working is the failure an owner learns of only when they need the backup. A backup run by hand that failed is failing while scheduled backups are turned off too.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`, `compliance/backup-folder.test.ts › counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back`, `› says a backup run by hand that failed as failing in health while scheduled backups are turned off, and off once one is put`.

### `instance/backup-health-lost`

While the last backup run put a backup that names a file as `lost`, the server MUST answer `GET /health` with `backups.status` `failing`.

**Reason:** a lost file is a failure the owner learns of at once, and the run counts among `backups.failures`.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file lost and in health, and clears health with the next backup that loses none`.

### `instance/backup-health-lost-named`

While the last backup run put a backup that names files as `lost`, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST name the first ten of those files in `backups.last_error`.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`, `compliance/backup-faults.test.ts › puts the backup, names the file lost and in health, and clears health with the next backup that loses none`.

### `instance/backup-health-incomplete`

Where `backup_interval_seconds` is above 0, while the copy record holds no copy in the destination of a file the last backup put names, the last backup run did not fail, the destination takes the copies that wait for it and `instance/backup-health-parts-damaged` does not hold, the server MUST answer `GET /health` with `backups.status` `incomplete`.

**Reason:** a backup is complete once the copy record holds a copy in its destination of every file it names, so a fresh instance can restore them. The server reads the copy record and asks the destination about no file on a backup; `blob-integrity` strikes a copy it finds missing or altered (`stores/integrity-strikes`), and from then the file waits again. Replication copies the files without the owner, so the overall `status` stays as it was.

**Tests:** `compliance/backups.test.ts › calls the newest backup incomplete in its answer, health and attention while the object store lacks files it names, refuses a restore from it, and clears once replication copies them`, `› calls the newest backup incomplete again once blob-integrity finds a copy of a file it names gone from the object store, until replication copies the file again`, `› calls the backups failing, not incomplete, in health and attention while files wait for their copy and a part an older backup names is damaged`.

### `instance/backup-health-parts-damaged`

Where `object_store_bucket` or `backup_path` is set, while a part under `<root>/backup-parts/<instance id>/`, where `<root>` is `<object_store_prefix>` or `<backup_path>`, that the server found holding bytes other than those whose SHA-256 its name gives, or in a backup folder that answers could not read, is named by a backup it keeps, and the server has neither stored that part again nor found it whole since, the server MUST answer `GET /health` with `backups.status` `failing` and an overall `status` no better than `degraded`.

**Reason:** a restore of a backup that names such a part is refused. The server finds a part damaged when a restore of one of its own backups reads it, and when a backup checks each part a backup it keeps names, as `instance/backup-part-stored-again` and `instance/backup-folder-part-rehashed` say.

**Tests:** `compliance/backup-parts.test.ts › says in health and attention that a part is damaged once a restore of its own backup finds it altered, until a backup stores the part again`, `› hashes a due folder part only an older backup names while a manifest does not read, and counts a part it cannot read as damaged, storing it again where a backup names it`.

### `instance/backup-health-damaged-count`

Where `object_store_bucket` or `backup_path` is set, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.damaged_parts` with how many parts `instance/backup-health-parts-damaged` holds for, or `null` when the count could not be read.

**Tests:** `compliance/backup-parts.test.ts › says in health and attention that a part is damaged once a restore of its own backup finds it altered, until a backup stores the part again`.

### `instance/backup-health-files-waiting`

Where `object_store_bucket` or `backup_path` is set, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.last_backup_files_waiting` with how many files the last backup put names of which the copy record holds no copy in the destination, or `null` when no backup was put or the count could not be read.

**Tests:** `compliance/backups.test.ts › calls the newest backup incomplete in its answer, health and attention while the object store lacks files it names, refuses a restore from it, and clears once replication copies them`.

### `instance/backup-health-detail`

When a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST include in `backups` the last backup put, how many runs in a row have failed, and the last failure.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`.

### `instance/backup-health-destination`

Where `object_store_bucket` or `backup_path` is set or its stored value does not read, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.destination` as `bucket` or `folder`, for that setting.

**Tests:** `compliance/backup-faults.test.ts › counts a backup the object store cannot take, shows it in health, and clears it with the next backup that is put`, `compliance/backup-folder.test.ts › says in health that backups go to a folder`, `compliance/destination-settings.test.ts › starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again`, `› starts over a missing or empty blob folder while a stored backup_path does not read, leaves the folder and its store alone, and serves the files once the folder returns`.

### `instance/backup-health-off`

Where neither `object_store_bucket` nor `backup_path` is set, the server MUST answer `GET /health` with `backups.status` `off` and `backups.reason` `no_backup_destination`.

**Tests:** `compliance/backups.test.ts › says in health that backups are off on an instance with nowhere to put them, and answers 409 no_backup_destination at each door`.

### `instance/backup-health-turned-off`

Where a destination is set and `backup_interval_seconds` is 0, the server MUST answer `GET /health` with `backups.reason` `turned_off`.

**Reason:** the reason stays while a failure or a damaged part makes `backups.status` `failing`, so an owner reads both.

**Tests:** `compliance/backups.test.ts › takes no scheduled backup while backup_interval_seconds is 0, and leaves backup out of the housekeeping listing`, `compliance/backup-folder.test.ts › says a backup run by hand that failed as failing in health while scheduled backups are turned off, and off once one is put`, `› says a backup folder that takes no copies as failing in health while scheduled backups are turned off, and off once it takes them`.

### `instance/backup-health-turned-off-status`

Where a destination is set and `backup_interval_seconds` is 0, while the last backup run did not fail, the destination takes the copies that wait for it and `instance/backup-health-parts-damaged` does not hold, the server MUST answer `GET /health` with `backups.status` `off`.

**Tests:** `compliance/backups.test.ts › takes no scheduled backup while backup_interval_seconds is 0, and leaves backup out of the housekeeping listing`, `compliance/backup-folder.test.ts › says a backup run by hand that failed as failing in health while scheduled backups are turned off, and off once one is put`, `› says a backup folder that takes no copies as failing in health while scheduled backups are turned off, and off once it takes them`.

### `instance/backup-health-store-failing`

While the object store or the backup folder does not take the copies that wait for it, the server MUST answer `GET /health` with `backups.status` `failing` and an overall `status` no better than `degraded`, whether or not `backup_interval_seconds` is 0.

**Reason:** a store that stops answering is the failure an owner learns of only when the next backup fails or a restore needs the files, and an interval of 0 does not stop files waiting for their second copy.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`, `› says a backup folder that takes no copies as failing in health while scheduled backups are turned off, and off once it takes them`.

### `instance/backup-health-store-named`

While the object store or the backup folder does not take the copies that wait for it, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.store_error` with the reason as text.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/backup-health-copies-waiting`

Where `object_store_bucket` or `backup_path` is set, when a request authorized by `instance.read` or local authority sends `GET /health`, the server MUST answer `backups.copies_waiting` with the number of files that waited for their copy in the destination when `blob-replicate` last ran.

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

When the object store or the backup folder takes copies again and a run of `blob-replicate` has ended `succeeded`, the server MUST answer `backups.store_error` as `null`.

**Tests:** `compliance/blob-store-silent.test.ts › answers health within its deadline, names the store and the files that wait, and clears once the store answers and replication has caught up`, `compliance/backup-folder.test.ts › says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up`.

### `instance/backup-health-quiet`

Where a destination is set and `backup_interval_seconds` is above 0, while it takes copies, no file waits for one, the last backup run was whole, the copy record holds a copy in the destination of each file the last backup put names and `instance/backup-health-parts-damaged` does not hold, the server MUST answer `GET /health` with `backups.status` `ok`, `backups.store_error` `null` and `backups.damaged_parts` `0`.

**Reason:** a report that is never empty is not read.

**Tests:** `compliance/backup-folder.test.ts › says nothing in health or attention while the folder answers and no file waits for its copy`.

### `instance/backup-no-bucket`

Where neither `object_store_bucket` nor `backup_path` is set, when a caller the operation admits sends `GET /backups`, `POST /backups`, `POST /backups/folder/adopt` or `POST /backups/{instance_id}/{name}/restore`, the server MUST answer `409 no_backup_destination`.

**Tests:** `compliance/backups.test.ts › says in health that backups are off on an instance with nowhere to put them, and answers 409 no_backup_destination at each door`.

### `instance/backup-destination-set-list`

When a write to `/config` sets `object_store_bucket` or `backup_path` and returns `200`, the server MUST answer the next `GET /backups` from a caller holding `backups.manage` with the backups the destination that write set holds.

**Reason:** a script can set the destination and use it in its next request.

**Tests:** `compliance/backup-destination.test.ts › is the one the next GET /backups lists, whether it is an object store or a backup folder, with a backup in each destination to tell them apart`.

### `instance/backup-destination-set-take`

When a write to `/config` sets `object_store_bucket` or `backup_path` and returns `200`, the server MUST put the backup the next `POST /backups` from a caller holding `backups.manage` takes in the destination that write set.

**Tests:** `compliance/backup-destination.test.ts › is the one the next POST /backups writes to, whether it is an object store or a backup folder`.

### `instance/backup-destination-set-restore`

When a write to `/config` sets `object_store_bucket` or `backup_path` and returns `200`, the server MUST read the backup that the next `POST /backups/{instance_id}/{name}/restore` names from the destination that write set, for a caller the operation admits.

**Tests:** `compliance/backup-destination.test.ts › is the one the next restore reads from, whether it is an object store or a backup folder, with a backup in each destination to tell them apart`.

### `instance/backup-destination-unset`

When a write to `/config` leaves both `object_store_bucket` and `backup_path` unset and returns `200`, the server MUST answer the next `GET /backups`, `POST /backups`, `POST /backups/folder/adopt` or `POST /backups/{instance_id}/{name}/restore` from a caller the operation admits with `409 no_backup_destination`, also when the server could not record that it let the earlier store go.

**Reason:** the settings decide whether there is a destination, and a store the server still holds does not make one.

**Tests:** `compliance/backup-destination.test.ts › is no destination in the next GET /backups, POST /backups, adopt and restore once a write to /config unsets it, even when the server could not record that it let the store go`.

### `instance/backup-destination-unusable`

When a write to `/config` sets `object_store_bucket` to a store the server cannot use and returns `200`, the server MUST answer the next `GET /backups`, `POST /backups` or `POST /backups/{instance_id}/{name}/restore` from a caller the operation admits with `503 blob_store_unavailable`, and with no other status.

**Reason:** the owner needs to know that the configured store needs attention, and a store the settings name is never a missing destination.

**Tests:** `compliance/backup-destination.test.ts › is answered 503 blob_store_unavailable by the next GET /backups, POST /backups and restore when the object store a write to /config names cannot be used, and never 409`.

### `instance/backups-list`

When a caller holding `backups.manage` sends `GET /backups`, the server MUST answer with each backup in an instance's folder under `<object_store_prefix>/backups/` or `<backup_path>/backups/`, this instance's and any other's, newest first, each with its `name`, `instance_id`, `created_at` and `size_bytes`, the bytes of its manifest and of every part the manifest names, or of the manifest alone where it does not read.

**Reason:** a fresh server started on the prefix of an instance it replaces restores that instance's backup.

**Tests:** `compliance/backups.test.ts › lists the backups newest first to the owner, and refuses a key without backups.manage at each door`, `› restores a named backup into a fresh server on the same bucket, files included`, `compliance/backup-folder.test.ts › restores a named backup into a fresh server on another data path from the folder alone, every line and file`.

### `instance/backups-permission`

If a credential without `backups.manage` sends `GET /backups`, `POST /backups` or `POST /backups/folder/adopt`, then the server MUST answer `403 forbidden` with `details.required_scope` `backups.manage`.

**Tests:** `compliance/backups.test.ts › lists the backups newest first to the owner, and refuses a key without backups.manage at each door`, `compliance/backup-folder.test.ts › refuses a key without backups.manage at the adopt door`, `compliance/owner-tasks.test.ts › refuses each owner task to a key that lacks its permission, naming the permission`.

### `instance/backup-restore`

When a caller the operation admits sends `POST /backups/{instance_id}/{name}/restore`, the server MUST restore the backup of that name in that instance's folder from the object store or the backup folder as `POST /restore` restores the archive its manifest and parts make.

**Reason:** the server reads the backup itself, so a restore after a move needs no copy of the backup on the owner's computer.

**Tests:** `compliance/backups.test.ts › restores a named backup into a fresh server on the same bucket, files included`, `compliance/backup-folder.test.ts › restores a named backup into a fresh server on another data path from the folder alone, every line and file`.

### `instance/backup-bucket-restore-lacking`

Where `object_store_bucket` is set, if a file the backup names, which the instance that took it held and the manifest does not name in `lost_blobs`, is held whole neither in the object store nor by the restoring instance, then the server MUST answer `POST /backups/{instance_id}/{name}/restore` with `409 backup_files_missing` and each such file's hash in `details.missing_blobs`.

**Reason:** a restore that left a file out would lose it without a word, as `instance/backup-folder-restore-lacking` says for the folder. The refusal restores nothing; a restore asked to leave the files out restores the rest (`instance/backup-restore-allow-missing`).

**Tests:** `compliance/backups.test.ts › calls the newest backup incomplete in its answer, health and attention while the object store lacks files it names, refuses a restore from it, and clears once replication copies them`.

### `instance/backup-folder-restore-files`

Where `backup_path` is set, when a caller the operation admits sends `POST /backups/{instance_id}/{name}/restore`, the server MUST read each file the backup names that the instance does not hold from `<backup_path>/files/<instance_id>/`.

**Tests:** `compliance/backup-folder.test.ts › restores a named backup into a fresh server on another data path from the folder alone, every line and file`.

### `instance/backup-folder-restore-lacking`

Where `backup_path` is set, if a file the backup names, which the instance that took it held and the backup does not name as `lost`, is held whole neither in `<backup_path>/files/<instance_id>/` nor by the restoring instance, then the server MUST answer `POST /backups/{instance_id}/{name}/restore` with `409 backup_files_missing` and each such file's hash in `details.missing_blobs`.

**Reason:** a restore that left a file out would lose it without a word. The refusal restores nothing; a restore asked to leave the files out restores the rest (`instance/backup-restore-allow-missing`).

**Tests:** `compliance/backup-folder.test.ts › refuses a restore with 409 backup_files_missing naming each file the folder does not hold, and restores nothing`, `› refuses a restore that lacks a file before it reads any file from the folder`, `› refuses a restore that meets a copy altered to the same size, names it, and places no file`.

### `instance/backup-folder-restore-first`

Where `backup_path` is set, if the server answers `POST /backups/{instance_id}/{name}/restore` with `409 backup_files_missing`, then the server MUST NOT hold in its blob folder a file it read from the backup folder for that restore.

**Reason:** the server works out which files it lacks before it reads any, so a refused restore costs neither the reading nor the room. A copy that proves altered or gone only when it is read refuses the restore before any file is placed.

**Tests:** `compliance/backup-folder.test.ts › refuses a restore that lacks a file before it reads any file from the folder`, `› refuses a restore that meets a copy altered to the same size, names it, and places no file`.

### `instance/backup-folder-restore-held`

Where `backup_path` is set, when a caller the operation admits sends `POST /backups/{instance_id}/{name}/restore`, the server MUST NOT read from the backup folder a file of which an attached store of the restoring instance holds a copy whole.

**Reason:** a restore over the instance that took the backup then needs room only for the files it lacks.

**Tests:** `compliance/backup-folder.test.ts › restores a backup over the instance that took it with room for none of the files it already holds`.

### `instance/backup-folder-restore-lost`

Where `backup_path` is set, if a file the backup names as `lost` is held whole neither in `<backup_path>/files/<instance_id>/` nor by the restoring instance, then the server MUST NOT refuse `POST /backups/{instance_id}/{name}/restore` for that file.

**Reason:** the file was gone before the backup was taken, so no folder could restore it. The restore names it in `blobs_missing`, as a restore of the same archive through `POST /restore` does.

**Tests:** `compliance/backup-folder.test.ts › puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it`.

### `instance/backup-restore-unknown`

If `POST /backups/{instance_id}/{name}/restore` names no backup the object store holds directly under `<object_store_prefix>/backups/<instance_id>/`, or the backup folder holds directly under `<backup_path>/backups/<instance_id>/`, then the server MUST answer `404 backup_not_found`.

**Tests:** `compliance/backups.test.ts › answers 404 backup_not_found for a name the object store does not hold, or one that is not a backup's`.

### `instance/backup-restore-allow-missing`

When a caller the operation admits sends `POST /backups/{instance_id}/{name}/restore` with `allow_missing_files` `true`, the server MUST restore the backup without each file that `instance/backup-bucket-restore-lacking` or `instance/backup-folder-restore-lacking` would refuse it for, and name each such file in `blobs_missing`.

**Reason:** an owner whose destination lost some files restores every item, edge and setting the backup holds, and learns which files are gone.

**Tests:** `compliance/backup-parts.test.ts › restores a backup without the files no store holds when asked to, naming them in blobs_missing`.

### `instance/backup-restore-flag-spelled`

If `POST /backups/{instance_id}/{name}/restore` gives `allow_missing_files` a value other than `true` or `false`, then the server MUST answer `400 validation_error` and change nothing the instance holds.

**Reason:** a query boolean has one spelling for each value, so a value a client misspells never decides whether files are left out.

**Tests:** `compliance/backup-parts.test.ts › refuses allow_missing_files given as anything but true or false with 400 validation_error, and restores nothing`.

### `instance/backup-restore-parts-checked`

If a part the manifest of the named backup names is missing from `<root>/backup-parts/<instance_id>/`, where `<root>` is `<object_store_prefix>` or `<backup_path>`, or holds bytes whose size or SHA-256 differs from what the manifest gives, then the server MUST answer `POST /backups/{instance_id}/{name}/restore` with `409 backup_parts_missing` and that part's name in `details.missing_parts`.

**Reason:** a restore that read a part another backup or another instance holds, or a part altered on the disk, would restore lines the backup never held.

**Tests:** `compliance/backup-parts.test.ts › refuses a restore with 409 backup_parts_missing naming each part missing from its instance's parts folder or altered there, and changes nothing`.

### `instance/backup-restore-parts-untouched`

If the server answers `POST /backups/{instance_id}/{name}/restore` with `409 backup_parts_missing`, then the server MUST NOT change an item, an edge, a row, a type or a setting the instance holds.

**Reason:** the server checks every part as it reads it, before the restore commits anything, so a refused restore leaves the instance as it was.

**Tests:** `compliance/backup-parts.test.ts › refuses a restore with 409 backup_parts_missing naming each part missing from its instance's parts folder or altered there, and changes nothing`.

### `instance/backup-restore-manifest-unread`

If the manifest of the backup that `POST /backups/{instance_id}/{name}/restore` names does not read as a JSON object of format `marfa-backup` and version `1` that names one part of each entry, in archive order, then the server MUST answer `400 validation_error` with a message that names the backup, and change nothing the instance holds.

**Tests:** `compliance/backup-parts.test.ts › refuses a restore whose manifest does not read, naming the backup, and changes nothing`.

### `instance/backup-thinning-day`

When the server has put a backup, the server MUST keep every backup of its own taken in the 24 hours before that backup was taken, or after it.

**Reason:** the day is counted from when the backup was taken, so a slow put deletes nothing it would otherwise keep. A backup taken later by the clock is one the clock ran ahead for, and is kept.

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each of the 31 older days that hold a backup, and deletes nothing that is not a listed backup of this instance`, `› keeps every backup taken in the day before the one just put, however long the put took`, `› keeps every backup when one is put 40 days after the last, and when the next comes six weeks later`.

### `instance/backup-thinning-daily`

When the server has put a backup, the server MUST keep, of its own backups taken more than 24 hours before that backup, the newest of each of the 31 most recent UTC days that hold one, and delete the others.

**Reason:** the days kept are the days that hold a backup, not a span back on the clock. A server that was off for weeks keeps the newest backup of each of its last 31 backup days after its first new one. A clock jump does not add days with no backups to the count.

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each of the 31 older days that hold a backup, and deletes nothing that is not a listed backup of this instance`, `› keeps every backup when one is put 40 days after the last, and when the next comes six weeks later`.

### `instance/backup-thinning-newest`

When the server has put a backup, the server MUST keep the newest of its own backups.

**Reason:** however wrong the clock, the instance always keeps the backup it took last by the clock.

**Tests:** `compliance/backup-thinning.test.ts › keeps every backup when one is put 40 days after the last, and when the next comes six weeks later`.

### `instance/backup-thinning-only-backups`

When the server thins its backups, the server MUST NOT delete an object or file other than the manifest of a backup it recorded putting, listed directly under `<object_store_prefix>/backups/<instance id>/` or `<backup_path>/backups/<instance id>/`, where `<instance id>` is its own.

**Reason:** the prefix also holds the instance's files, another instance on the same prefix keeps its own backups, and the bucket may hold objects the instance did not write. A backup in its own folder that its database never recorded, such as one put after the image of the data directory the server started on, is kept (`instance/backup-found-keeps-files`). The parts a thinned backup alone named are deleted after thinning, under `instance/backup-parts-removed`.

**Tests:** `compliance/backup-thinning.test.ts › keeps the last day and the newest of each of the 31 older days that hold a backup, and deletes nothing that is not a listed backup of this instance`, `compliance/bucket-sharing.test.ts › keeps the files a backup in its folder names when its database never recorded that backup, and deletes only the backups it recorded`.

### `instance/backup-found-keeps-files`

While a backup that the server did not record putting is listed directly under `<object_store_prefix>/backups/<instance id>/` or `<backup_path>/backups/<instance id>/`, where `<instance id>` is its own, the server MUST NOT purge a file that backup's manifest names.

**Reason:** a server started on an image of its data directory does not record the backups put after the image, and those backups restore their files from the bucket. Such a backup stops holding its files as `instance/backup-keeps-files` lets a recorded one go: once three or more consecutive listings have left it out and thinning the backups the last of them lists together with that backup would delete it. Where the server cannot list or read that folder, a file the object store holds a copy of is not purged.

**Tests:** `compliance/bucket-sharing.test.ts › keeps the files a backup in its folder names when its database never recorded that backup, and deletes only the backups it recorded`.

### `instance/backup-parts-removed`

Where `object_store_bucket` or `backup_path` is set, when the server has put a backup and has read the manifest of each backup listed directly under `<root>/backups/<instance id>/` and of each backup it records putting there, where `<root>` is `<object_store_prefix>` or `<backup_path>` and `<instance id>` is its own, the server MUST delete each part under `<root>/backup-parts/<instance id>/` that none of those manifests names and `instance/backup-parts-found-kept` does not keep.

**Reason:** a part that no backup names restores nothing, and thinning leaves such parts behind.

**Tests:** `compliance/backup-parts.test.ts › deletes the parts no listed backup names once it has read every manifest, and none while one does not read`.

### `instance/backup-parts-kept`

The server MUST NOT delete a part that the manifest of a backup listed directly under `<object_store_prefix>/backups/<instance id>/` or `<backup_path>/backups/<instance id>/` names.

**Reason:** the server deletes parts only in a backup run, once that run has written its manifest, and runs one backup at a time (`instance/backup-one-at-a-time`), so no run deletes a part that another run is about to name.

**Tests:** `compliance/backup-parts.test.ts › deletes the parts no listed backup names once it has read every manifest, and none while one does not read`.

### `instance/backup-parts-found-kept`

Where `object_store_bucket` or `backup_path` is set, while a backup that the server read under `<root>/backups/<instance id>/`, where `<root>` is `<object_store_prefix>` or `<backup_path>` and `<instance id>` is its own, and did not record putting has not been left out of three or more consecutive listings of that folder, the last of which lists backups of its own such that thinning them together with that backup would delete it, the server MUST NOT delete a part that backup's manifest named when the server read it.

**Reason:** a backup the folder leaves out of one listing may be there still, and a part deleted under it cannot be stored again from this instance. The server lets the parts go as it lets that backup's files go.

**Tests:** `compliance/backup-parts.test.ts › keeps the parts a backup it found in its folder names once the folder stops listing that backup, while it deletes a part no backup names`.

### `instance/backup-parts-unread`

If the manifest of a backup listed directly under `<object_store_prefix>/backups/<instance id>/` or `<backup_path>/backups/<instance id>/`, or of a backup the server records putting there, does not read, or the destination does not answer, then the server MUST NOT delete a part in that run.

**Reason:** the parts such a manifest names are not known, so any part may be one it needs.

**Tests:** `compliance/backup-parts.test.ts › deletes the parts no listed backup names once it has read every manifest, and none while one does not read`.

### `instance/backup-parts-manifest-failed`

While the process that failed to write a backup's manifest runs, and until a listing of `<root>/backups/<instance id>/`, where `<root>` is `<object_store_prefix>` or `<backup_path>`, shows that backup or the server stops holding the files it names under `instance/backup-keeps-files`, the server MUST NOT delete a part.

**Reason:** a write the destination refused may still land, and its manifest then names parts that only it names.

**Tests:** `compliance/backup-parts.test.ts › lists no backup whose manifest was not written, deletes no part while that manifest may still land, and the next run stores only the parts it lacks`.

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

When the server is stopped on `SIGTERM` or `SIGINT` while no other process holds a read of the database file open, the server MUST leave the database file holding every write it acknowledged, with none of them left in a file beside it.

**Reason:** an owner who stops the instance and copies the data directory must not lose the writes the log still held.

**Tests:** `compliance/database-file.test.ts › moves every acknowledged write into the database file when stopped on %s`.

### `instance/stop-reader-keeps-writes`

While another process holds open a read of the database file that began before the server's last acknowledged write, when the server is stopped on `SIGTERM` or `SIGINT`, the server MUST keep every write it acknowledged in the database files, so that the next start answers it.

**Reason:** a process that keeps a read open, such as a replicator, can keep the stop from moving every write into the file itself, and the next start finds the rest beside it.

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

When the server starts on a claimed database file whose owner row or key rows are missing, the server MUST answer the setup status as claimed.

**Reason:** missing credentials do not establish authority to replace the owner.

**Tests:** `compliance/database-file.test.ts › does not reopen setup after deleting %s rows`.

### `instance/claim-missing-no-setup-code`

When the server starts on a claimed database file whose owner row or key rows are missing, the server MUST NOT print a setup code.

**Tests:** `compliance/database-file.test.ts › does not reopen setup after deleting %s rows`.

### `instance/claim-missing-refuses-claim`

When the server starts on a claimed database file whose owner row or key rows are missing, the server MUST refuse every request to claim the instance with `409`, whether it arrives on the private socket or over HTTP.

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

When `GET /health` is answered, the server MUST answer the overall `status` as `down` when any component is `down`, otherwise as `degraded` when any component is `degraded`, `backups.status` is `failing` or `housekeeping.held` names a hold, otherwise as `ok`.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`, `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`, `› answers 503 with the database write down when the database refuses a write, and 200 once it takes one`, `› answers 503 with blob storage down when the disk store refuses, and 200 once it answers`, `› answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-down-unavailable`

When any component is `down`, the server MUST answer `GET /health` with `503`.

**Reason:** a container's health check and a deploy gate read the status code, and an instance whose database, disk or blob folder refuses is not serving.

**Tests:** `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`, `› answers 503 with the database write down when the database refuses a write, and 200 once it takes one`, `› answers 503 with blob storage down when the disk store refuses, and 200 once it answers`.

### `instance/health-not-down-ok`

When no component is `down`, the server MUST answer `GET /health` with `200`, whether the overall `status` is `ok` or `degraded`.

**Reason:** a `degraded` instance is still serving.

**Tests:** `compliance/instance.test.ts › answers /health without a credential and names its components`, `compliance/health.test.ts › answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-database-down`

If the database refuses a read, then the server MUST answer the `database` component of `GET /health` as `down`.

**Tests:** `compliance/health.test.ts › answers 503 with the database down when the database refuses a read, and 200 once it answers`.

### `instance/health-write-down`

If the database refuses the write that the `database_write` probe makes, with any code other than `write_contention`, then the server MUST answer the `database_write` component of `GET /health` as `down`.

**Reason:** a database that reads can still refuse every write, because the volume is read-only or full, and only a committed write shows it.

**Tests:** `compliance/health.test.ts › answers 503 with the database write down when the database refuses a write, and 200 once it takes one`.

### `instance/health-blob-down`

If the disk store refuses to look for a blob, or its folder or its `.marfa-store` marker is missing, or the marker names another store, then the server MUST answer the `blob_storage` component of `GET /health` as `down`.

**Reason:** the server uses the marker to identify its own store. A missing or mismarked folder cannot serve its blobs.

**Tests:** `compliance/health.test.ts › answers 503 with blob storage down when the disk store refuses, and 200 once it answers`, `› answers the disk component degraded, never down, and blob storage down, when the free space cannot be read and the store refuses, and ok once both are cleared`, `compliance/blob-store-folders.test.ts › answers blob storage down while the folder holds another store's marker, and ok when it holds the server's own`.

### `instance/health-contention-degraded`

If the write that the `database_write` probe makes is refused with `write_contention`, then the server MUST answer the `database_write` component as `degraded`, not `down`.

**Reason:** a lock held past the write wait is a busy instance rather than a broken one. An archive restore holds it until it commits, and `instance/health-restore-running` says so.

**Tests:** `compliance/health.test.ts › answers 200 and degraded while the write is refused, and ok once the lock is released`.

### `instance/health-restore-running`

While a restore runs, when a credential with `instance.read` sends `GET /health`, the server MUST answer the `database_write` component as `degraded` with an `error` that says a restore is running.

**Reason:** a bare `degraded` leaves an owner and a monitor guessing at a fault that is the restore doing its work, and a probe that queued behind the restore would only report a refusal.

**Tests:** `compliance/restore-faults.test.ts › refuses each kind of write at once, naming the restore, while reads and the restore itself go on`.

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

### `instance/health-disk-reserve-unfit`

If `disk_reserve_bytes` is above 0 and not less than the size of the volume that holds the database or the disk store's folder, and the `disk` component of `GET /health` is `degraded`, then the server MUST say in its `error` that the reserve is not less than the volume, and name `disk_reserve_bytes`.

**Reason:** a reserve as large as its volume can never be met, so the component is degraded for as long as the setting stands, and the owner needs to be told to lower it.

**Tests:** `compliance/disk-reserve-health.test.ts › says in the disk component's error that the reserve is not less than the volume, naming the setting, where it is not`.

### `instance/health-disk-unknown`

If the bytes available on either the database's volume or the disk store's volume cannot be read, then the server MUST answer the `disk` component of `GET /health` as `degraded`, never `down`.

**Reason:** only a measured shortage is a failure.

**Tests:** `compliance/health.test.ts › answers the disk component degraded, never down, and blob storage down, when the free space cannot be read and the store refuses, and ok once both are cleared`.

### `instance/health-write-reuse`

When `GET /health` is called while an attempt of the `database_write` probe's write is in progress, or less than ten seconds after the last attempt finished, the server MUST answer the `database_write` component with the outcome of that attempt, a refusal included.

**Reason:** the operation takes no credential, so what a caller can make the server do through it stays small.

**Tests:** `compliance/health.test.ts › answers the calls within ten seconds of its last write with that write's outcome, and writes again after`.

### `instance/health-write-once`

The server MUST attempt the write of the `database_write` probe at most once in ten seconds, however many callers ask.

**Reason:** the operation takes no credential, so the writes a caller can make the server attempt through it stay few.

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

While the database refuses reads, the server MUST NOT answer an `error` on any component of `GET /health` to a request that bears a bearer credential.

**Reason:** the server cannot verify a bearer credential while the database refuses reads, and an unverified credential is not given the text.

**Tests:** `compliance/health.test.ts › is withheld from bearer credentials while the database cannot look keys up`.

### `instance/health-unknown-key`

When a request that carries a credential the instance does not hold sends `GET /health`, the server MUST answer it as it answers a request that carries no credential.

**Tests:** `compliance/instance.test.ts › answers /health to a request that names a key the instance does not hold as it does to one that names none`, `compliance/health.test.ts › is given to a key with instance.read and withheld without that permission`.

### `instance/health-housekeeping`

When a credential holding `instance.read` sends `GET /health`, the server MUST answer a `housekeeping` object with `failed`, the name, finish time and error of each job whose last run failed (`null` when the schedule cannot be read in time), `unreadable_settings`, the keys of the stored settings that no longer read, and `held`, why the jobs that delete are held (`null` while they run).

**Reason:** an owner needs to see that background work has stopped, or that a stored setting no longer reads, without reading every job. A request without `instance.read` is given no such object, as it is given no `error`.

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

If the server starts on a database file whose structure is not the one the schema version it records declares, because something the server declares differs, something the server does not declare is added, or something is missing while the database already holds data, then the server MUST refuse to start.

**Reason:** a database of another structure fails with a driver error after the file has been changed, or fails nowhere until a request meets the difference, so the refusal is made before either. A database that lacks parts of what a first start makes and holds no data is completed under `instance/unfinished-completed`.

**Tests:** `compliance/database-file.test.ts › refuses a database holding %s, changes nothing in its files, and opens no port`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`.

### `instance/upgrade-migrates-older`

When the server starts on a database an earlier schema version of its own wrote, whose structure is the one that version declares, the server MUST upgrade it before it takes a request, and answer it from then on as at the version it now has.

**Tests:** waiting on #2802.

### `instance/upgrade-failure-keeps-old`

If upgrading a database fails before it is whole, then the server MUST refuse to start and leave the database answering as it did at the schema version it was at before the start.

**Reason:** an upgrade that stops partway must not leave a database that is neither version.

**Tests:** waiting on #2802.

### `instance/upgrade-keeps-references`

If upgrading a database would leave something it holds referring to something it does not hold, then the server MUST refuse to start and leave the database file byte for byte as it found it.

**Reason:** the references between what a database holds are checked once, before the upgrade is kept, because an upgrade can rebuild what holds them.

**Tests:** waiting on #2802.

### `instance/upgrade-keeps-rows`

When the server upgrades a database, the server MUST answer every read a client could make before the upgrade with the same data after it.

**Reason:** an upgrade that rebuilds what holds the data can lose what refers to it along the way.

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

### `instance/upgrade-exit-refusal`

If the server refuses to start on a database under `instance/upgrade-refuses-schema`, `instance/upgrade-refuses-newer` or `instance/upgrade-keeps-references`, then the server MUST exit with status 78.

**Reason:** what supervises the process tells a stop that starting again will not mend from one that it may.

**Tests:** `compliance/database-file.test.ts › exits with status 78, not 1, when it refuses a database this build did not write`, `› refuses a database that lacks a table and holds a row in one it creates, and changes nothing`, `› refuses a database that lacks a table and has a column it does not declare, though it holds no rows`, `› refuses to start on a database a newer build wrote, and leaves it as it was`.

### `instance/upgrade-exit-failure`

If the server stops for a failure to start that is not a refusal under `instance/upgrade-refuses-schema`, `instance/upgrade-refuses-newer` or `instance/upgrade-keeps-references`, then the server MUST exit with status 1.

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

When the server is stopped, the server MUST end an open copy stream, `GET /events?edges=all&copy=true`, with a terminal `stream_incomplete` frame.

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

### `instance/stop-exit-clean`

When the server is stopped on `SIGTERM` or `SIGINT` and the server and its storage have closed, the server MUST exit with status 0.

**Reason:** a stop that the runtime kills is read as a crash.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 0 within eight seconds when stopped on %s`, `› exits with status 0 within eight seconds when stopped with an event stream open`.

### `instance/stop-exits-in-time`

When the server is stopped on `SIGTERM` or `SIGINT`, the server MUST exit within eight seconds of the signal.

**Reason:** the grace a container runtime gives a stopped process is ten seconds by default, and eight leaves two for the runtime.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 0 within eight seconds when stopped on %s`, `› exits with status 0 within eight seconds when stopped with an event stream open`, `compliance/stream-shutdown.test.ts › ends the stream with stream_incomplete and server_stopping, closes it, and stops within ten seconds`.

### `instance/stop-exit-failed-open-request`

If a request that was open at the signal is still open when the server's wait for requests ends, then the server MUST exit with status 1.

**Reason:** a request that never ends cannot be waited for, so the stop is a failure the supervisor can see.

**Tests:** `compliance/instance-lifecycle.test.ts › exits with status 1, not 0, when a request in flight is still open at the end of the stop's wait`.

### `instance/stop-slow-run-exit-clean`

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

The public listener reads most request bodies whole before it answers. `POST /blobs`, `POST /restore`, `PUT /profile/avatar` and a delivery to an inbound endpoint stream their bodies instead, under the idle limits their own chapters give.

### `instance/body-deadline`

If the public listener reads a request body whole, other than one sent to `POST /blobs`, `POST /restore`, `PUT /profile/avatar` or an inbound endpoint, and the body has not arrived whole 180 seconds after the request's head, then the server MUST answer `408 request_timeout`.

**Reason:** a body at the 16 MiB default of `max_bulk_request_bytes` takes about 134 seconds over a 1 Mbit/s link, and 180 seconds allows for that while a client that stops sending cannot hold the memory its body takes. The deadline does not move with the settings: an owner who raises `max_bulk_request_bytes` or `max_request_bytes` above about 21 MiB gets bodies that cannot arrive in time over a 1 Mbit/s link, and the descriptions of both settings say so.

**Tests:** `compliance/public-body.test.ts › is answered 408 request_timeout with the connection closed when it has not arrived by the deadline, and is taken when it arrives in time`, `› answers 401 unauthorized to a declared body before any of it is sent, when no credential comes with it`.

### `instance/public-body-declared`

If a request to `POST /owner`, `POST /setup/exchange`, `POST /setup/claim`, `POST /auth/sign-in`, `POST /auth/passkeys/sign-in/options`, `POST /auth/passkeys/sign-in`, `POST /auth/consent`, `POST /oauth/token`, `POST /oauth/revoke`, `POST /oauth/device-authorization`, `POST /auth/device` or `POST /auth/device/consent` declares a body longer than 32768 bytes, then the server MUST answer `413 request_too_large` before it reads any of the body.

**Reason:** these operations judge no credential before they read the body, so any caller can send them, and the general cap, which an owner can set up to a terabyte, would let such a caller make the server hold a body for the whole of the deadline in `instance/body-deadline`. The largest real body at these operations is about half a kilobyte, a consent decision that carries an authorization's signed query, so 32768 bytes leaves room for any. Registration, the other operation of this kind, has a smaller cap of its own (`keys-and-oauth/register-body-cap`).

**Tests:** `compliance/public-body.test.ts › answers 413 to a body over 32768 bytes declared to it, before any of it is sent`.

### `instance/public-body-streamed`

If a request to `POST /owner`, `POST /setup/exchange`, `POST /setup/claim`, `POST /auth/sign-in`, `POST /auth/passkeys/sign-in/options`, `POST /auth/passkeys/sign-in`, `POST /auth/consent`, `POST /oauth/token`, `POST /oauth/revoke`, `POST /oauth/device-authorization`, `POST /auth/device` or `POST /auth/device/consent` sends more than 32768 bytes of body without declaring its length, then the server MUST answer `413 request_too_large`.

**Reason:** a body with no declared length cannot be refused at the head, so the server stops reading at the cap.

**Tests:** `compliance/public-body.test.ts › answers 413 to a body that streams past 32768 bytes to it, and takes one just under it`.

### `instance/body-deadline-closes`

When the server answers `408 request_timeout` to a body that has not arrived by the deadline `instance/body-deadline` gives, the server MUST close the connection.

**Reason:** the rest of the body may still be on its way, and a connection kept open would read it as the next request.

**Tests:** `compliance/public-body.test.ts › is answered 408 request_timeout with the connection closed when it has not arrived by the deadline, and is taken when it arrives in time`.

### `instance/body-deadline-streamed`

While bytes of a `POST /blobs` body keep arriving within the upload's idle limit, the server MUST NOT answer `408 request_timeout`, however long the whole body takes.

**Tests:** `compliance/public-body.test.ts › leaves a blob upload whose parts keep arriving to its own idle limit, past the deadline`.

### `instance/credential-before-body`

If a request with a body is sent to an operation that requires a credential and carries no credential, or one that is malformed, unknown, expired or revoked, and neither `connectors/order-cap-before-credential` nor `mcp/foreign-origin` has it answered first, then the server MUST answer `401 unauthorized` before it reads the body.

**Reason:** a caller with no credential cannot make the server hold a body the operation would refuse once it has arrived.

**Tests:** `compliance/public-body.test.ts › answers 401 unauthorized to a declared body before any of it is sent, when no credential comes with it`, `› answers 401 naming the expiry to a key past its expires_at before any of the body is sent`, `compliance/well-formed-text.test.ts › answers a missing credential 401 before it reads a body holding a surrogate escape with no partner`, `compliance/connector-check-order.test.ts › answers a declared body over the cap 413 before a missing credential's 401, and a missing credential 401 before a body nested too deep`.

### `instance/credential-judged-after-body`

If the credential a request carries is revoked, loses the permission its operation needs, or ends, as a revoked key, a revoked app grant or a signed-out owner browser session does, while the public listener reads the request's body whole, other than a body sent to `POST /blobs`, `POST /restore`, `PUT /profile/avatar` or an inbound endpoint, and the body arrives whole within its size and time limits, then the server MUST answer the request as it answers the same request sent after that change.

**Reason:** a credential the server judged when the head arrived proves nothing about the moment the body is whole, and a caller who sends a body slowly must not keep authority the owner has taken away. A body that does not arrive whole is answered under `instance/body-deadline` or its own refusals.

**Tests:** `compliance/public-body.test.ts › is answered 401 once the body is whole when its key was revoked meanwhile`, `› is answered as a fresh request is once the body is whole when its key lost the permission meanwhile`, `› is answered 401 once the body is whole when the app's grant was revoked meanwhile`, `› is answered 401 once the body is whole when the owner's browser session was signed out meanwhile`, `› is answered 401 once the body is whole when its key was revoked meanwhile, with the rate limiter on`.

### `instance/credential-judged-before-streamed-commit`

If the credential a `POST /blobs` or `PUT /profile/avatar` request carries is revoked while the server is reading the request's body, then the server MUST refuse the request with `401 unauthorized` once the body is whole and valid, and store nothing from it.

**Reason:** these bodies stream, so the server does not judge the caller again when the body is whole, but it judges the caller in the step that stores the upload, and a caller whose authority has ended is not given the result.

**Tests:** `compliance/public-body.test.ts › is refused 401 and stores no avatar when the key was revoked while a profile avatar streamed in`, `› is refused 401 when the key was revoked while a blob streamed in`.

### `instance/bodiless-method-body-unread`

If a `GET`, `HEAD`, `DELETE` or `OPTIONS` request carries a body, then the server MUST answer it without reading the body, as it answers the same request with no body.

**Reason:** no operation takes a body under these methods, so a body cannot change the answer, and the server does not wait for one.

**Tests:** `compliance/public-body.test.ts › is not waited for on a GET, HEAD, DELETE or OPTIONS request, which is answered as it is with no body`.

### `instance/unserved-method-before-body`

If a `POST`, `PUT` or `PATCH` request with a body is sent to a path where no operation takes its method, then the server MUST answer `404 not_found` before it reads the body.

**Tests:** `compliance/public-body.test.ts › is answered 404 not_found before the body when no operation at the path takes the method`.

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

A database file can be left unfinished when a first start stops partway: it holds part of what a first start makes, differs from the server's structure in nothing else, and holds no data.

### `instance/unfinished-completed`

When the server starts on an unfinished database file, the server MUST finish it and start.

**Reason:** nothing is written before a first start has finished, so an unfinished file holds no data, and refusing it would send an owner looking for another build when no other build wrote it.

**Tests:** `compliance/database-file.test.ts › creates the tables it lacks and remains unclaimed until a real claim`.

### `instance/unfinished-ends-fresh`

When the server finishes an unfinished database file, the server MUST then answer as a new instance: unclaimed, with no key, no item and an `instance_id` of its own.

**Tests:** `compliance/database-file.test.ts › creates the tables it lacks and remains unclaimed until a real claim`.

## One server on its files

A database and a blob folder belong to one running server at a time. A second server started on either is refused before it changes anything of the first's, however it names them, and a server that ends, however it ends, leaves nothing that refuses the next.

### `instance/open-database-held`

If the server starts on a database file that another running server has open, then the server MUST refuse to start, whatever control socket, working directory and path to that file it was given.

**Reason:** each server would take the database's blob folder and background work as its own, and the second would empty the uploads the first is receiving. A control socket of its own, a relative path and a path through a symbolic link do not make the file another one, and a control socket both servers share does not make the refusal one about the socket.

**Tests:** `compliance/one-server.test.ts › is refused on the database however its path is written, though it has a control socket of its own, and names the database`, `› is refused on the database, not the control socket, when both have the socket beside the database`, `› is not refused once the running server is killed, and empties the spool it left`.

### `instance/open-blobs-held`

If the server starts on a blob folder that another running server has open, then the server MUST refuse to start, whatever database it was given.

**Reason:** a server empties the files it was receiving when it starts, and those in a folder another server has open are that server's uploads in progress. A server that has only read from a blob folder since it returned does not have it open.

**Tests:** `compliance/one-server.test.ts › is refused on the blob folder though it has a database of its own, and names the folder`.

### `instance/open-held-named`

When the server refuses to start under `instance/open-database-held` or `instance/open-blobs-held`, the server MUST name in its log message the database file or the blob folder it was given and say that another server has it open.

**Reason:** the owner stops the other server or gives this one files of its own, and needs to know which.

**Tests:** `compliance/one-server.test.ts › is refused on the database however its path is written, though it has a control socket of its own, and names the database`, `› is refused on the database, not the control socket, when both have the socket beside the database`, `› is refused on the blob folder though it has a database of its own, and names the folder`.

### `instance/open-database-one-link`

If the server's database file has more than one hard link, then the server MUST refuse to start and say in its log message how many hard links the file has.

**Reason:** a second hard link is a second name for the same file, and SQLite keeps a write-ahead log beside each name it opens a file by. A server started on the other name would write the file through a log of its own while the first writes through its log, and damage it.

**Tests:** `compliance/one-server.test.ts › is refused on a second hard link to the database, and says why`.

### `instance/open-lock-file-mode`

When the server starts and its own account owns the file `<database file>.server-lock` beside its database or the file `.server-lock` in its blob folder, and that file has one hard link and a mode that lets its owner read and write it, the server MUST NOT refuse to start for the rest of the file's mode.

**Reason:** a mount's group setting, such as Kubernetes `fsGroup`, a `chmod -R` or a restore under another mode opens the file to a group, and the server makes it private to its own account again. A lock file that belongs to another account or has a second link still refuses the start, since another server may hold it.

**Tests:** `compliance/one-server.test.ts › is not refused, and makes the lock files private again`.

### `instance/open-held-leaves-files`

If the server refuses to start under `instance/open-database-held` or `instance/open-blobs-held`, then the server MUST leave the running server's database, blob folder and uploads in progress as they were.

**Tests:** `compliance/one-server.test.ts › leaves the running server's upload in progress, which lands once it is let go`.

### `instance/open-after-end`

When the server starts on a database and a blob folder whose last server has ended, however it ended, the server MUST NOT refuse to start under `instance/open-database-held` or `instance/open-blobs-held`.

**Reason:** a supervisor starts a killed or crashed server again at once, on the same files.

**Tests:** `compliance/one-server.test.ts › is not refused once the running server is killed, and empties the spool it left`.

### `instance/open-needs-log`

If the server's database file cannot keep a write-ahead log, then the server MUST refuse to start and say in its log message that the database cannot keep one.

**Reason:** the server reads while it writes, which SQLite allows only with a write-ahead log, and SQLite keeps the mode a database had when it cannot change it, without an error. A database on a file system that keeps no shared memory, such as some network file systems, cannot keep the log.

**Tests:** `compliance/one-server.test.ts › is refused, saying so, and the same file is opened when it can keep one`.

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

`GET /config`, `PUT /config` and `PATCH /config` hold the instance's display name, levers and live settings. What a lever does is `types/strict-mode`, `types/source-allowlist` and `types/source-filter`, and the bounds of a retention are `housekeeping/retention-days-range`. That `PUT /config` replaces the configuration whole is `types/config`, and the code a lever missing a member gets is `types/config-lever-missing-field`.

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

When a key holding `config.manage` sends `GET /config`, the server MUST answer each setting that has been set with the value last written, including `enforcement` with its three levers.

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

While `MARFA_TEST_HOOKS` is true, the server MUST answer a sign-in's `created_at` as the time the server reads.

**Reason:** a browser session carries a time the server later compares with its clock. If it kept the system's time, moving the clock would put the two out of step.

**Tests:** `compliance/test-hooks.test.ts › stamps a sign-in with the time the server reads`.

### `instance/test-clock-forward`

If `advance_ms` asks the clock to move back, then the server MUST refuse and keep the time it reads.

**Reason:** an advance is time passing, which never runs back. A clock set back is `jump_ms`.

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

**Reason:** an operator who wants error tracking should not have to run an OTLP collector for it, and a collector that cannot be reached is the traces' trouble alone. This is the rule the command line follows (`cli/cli-exception-report`), so one set of shell settings means the same to both. The stored `error_reporting_enabled` choice defaults to on.

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

While `OTEL_SDK_DISABLED` is `true` in any case and `error_webhook_url` is set, the server MUST still post an error notification for a request that fails with a 500 error.

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

Where `error_webhook_url` is set and `OTEL_RESOURCE_ATTRIBUTES` names `deployment.environment.name` or `deployment.environment`, the server MUST name the value of the first of them it names, in that order, as the `environment` of each notification it posts.

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

**Reason:** the log is read by more people than the secret is meant for. The settings that hold a secret include `MARFA_KEY_SALT`, `MARFA_AUTH_SECRET` and the `OTEL_EXPORTER_OTLP_*` endpoints and headers, since an address can carry a credential.

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

| Key                              | Default            | Allowed values                                                                               | What it sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disk_reserve_bytes`             | `134217728` bytes  | Whole number of bytes, 0 to 1099511627776                                                    | The free space on the disk store's volume that uploads, restores, and archive exports must leave. An export's temporary files are included. A request that would take the volume below it is refused `507 insufficient_storage`. A backup folder on a volume the server shares is held to it, and counts as on a disk of its own only when its device and its free space both differ from the server's, so a shared pool whose free space changes between two reads can look separate. Health reports the disk as degraded when the database's or the disk store's volume has less free than the greater of this and 64 MiB. At 0 no write is refused for room, and health still degrades below 64 MiB. |
| `max_request_bytes`              | `1048576` bytes    | Whole number of bytes, 1 to 1099511627776                                                    | The largest ordinary JSON request body. A larger body is answered `413 request_too_large`. Bulk writes, connector state, client registration, blob uploads and inbound webhook deliveries have separate limits. The server waits 180 seconds for a body, so a body larger than about 21 MiB can't arrive in time over a 1 Mbit/s link.                                                                                                                                                                                                                                                                                                                                                                  |
| `max_bulk_request_bytes`         | `16777216` bytes   | Whole number of bytes, 1 to 33554432                                                         | The largest body the bulk operations accept. It may be at most half of the 67108864 bytes a restore reads on one archive line, so that an item written at this limit fits on its line. The server waits 180 seconds for a body, so a body larger than about 21 MiB can't arrive in time over a 1 Mbit/s link.                                                                                                                                                                                                                                                                                                                                                                                           |
| `blob_min_copies`                | `1`                | Whole number, 1 to 1000000                                                                   | The fewest live copies a blob keeps. A drop that would leave fewer is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `blob_cleanup_enabled`           | `true`             | `true` or `false`                                                                            | Whether the `blob-orphans` job sweeps for unreferenced blobs. When off, no blob is reported or purged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blob_cleanup_grace_seconds`     | `86400` seconds    | Whole number of seconds, 0 to 31536000                                                       | How long an unreferenced blob stands in the orphan report before a later run purges it. At 0 the next run purges it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `backup_interval_seconds`        | `3600` seconds     | Whole number of seconds, 0 to 31536000                                                       | How often the `backup` job puts a backup in the backup folder or the object store when anything it holds has changed. At 0 scheduled backups are off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `backup_path`                    | None               | An absolute path with no `..` in it, or empty                                                | The folder the server backs itself up to: each backup under `backups/<instance id>/` and a copy of each file under `files/<instance id>/`. The folder must exist, outside the data directory and the blob folder, and the server never creates it. It cannot be set while `object_store_bucket` is. When neither is set, the server keeps no backup. Changing it needs a sign-in from the last five minutes.                                                                                                                                                                                                                                                                                            |
| `object_store_bucket`            | None               | A name of 1 to 255 letters, digits, `.`, `:`, `-` and `_`, other than `.` and `..`, or empty | The bucket of an S3-compatible object store, which keeps a second copy of each file and the backups. The store is in use while this is set. Changing it needs a sign-in from the last five minutes, and removes `object_store_secret_access_key` unless the same write sets it.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `object_store_region`            | `us-east-1`        | A name of 1 to 63 letters, digits, `-` and `_` that can be part of a host name, or empty     | The region of the object store, such as `us-east-1` or `auto`. Changing it needs a sign-in from the last five minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `object_store_endpoint`          | None               | An absolute `http` or `https` URL with no user name or password, or empty                    | The endpoint of the object store. A `/` that is the whole path is dropped. When empty, the store's provider chooses it. Changing it needs a sign-in from the last five minutes, and removes `object_store_secret_access_key` unless the same write sets it.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `object_store_path_style`        | `true`             | `true` or `false`                                                                            | Whether the object store is addressed by path rather than by virtual host, where the bucket goes before the endpoint's host. Read only while `object_store_endpoint` is set. Changing it needs a sign-in from the last five minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `object_store_prefix`            | `marfa`            | `/`-joined segments of letters, digits, `.`, `_` and `-`                                     | The key prefix the instance keeps everything under in the bucket: its files under `blobs/` and its backups under `backups/`. Each running instance on a bucket needs its own; a server that replaces an instance starts on its prefix. A `/` at either end is dropped; a `.` or `..` segment is refused. Changing it needs a sign-in from the last five minutes.                                                                                                                                                                                                                                                                                                                                        |
| `object_store_access_key_id`     | None               | Text of 1 to 256 characters, or empty                                                        | The access key ID for the object store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `object_store_secret_access_key` | None               | A secret: text of 1 to 4096 characters with no whitespace around it, or empty                | The secret access key for the object store. A write that changes `object_store_bucket` or `object_store_endpoint` removes it, unless the write sets it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `error_webhook_url`              | None               | A secret: an absolute `http` or `https` URL, or empty                                        | The URL the server posts a notice to when a request fails with a 500 error, while `error_reporting_enabled` is true. When empty, no notice is sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `heartbeat_url`                  | None               | A secret: an absolute `http` or `https` URL, or empty                                        | The URL the server requests on a schedule while `heartbeat_enabled` is true, so that something else can notice when the requests stop. When empty, there is no heartbeat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `allow_private_addresses`        | `false`            | `true` or `false`                                                                            | Whether the server may send to loopback, private and other addresses that are not public: webhooks, `heartbeat_url`, `error_webhook_url` and `object_store_endpoint`. Changing it needs a sign-in from the last five minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `enrichment_enabled`             | `true`             | `true` or `false`                                                                            | Whether the server extracts text from uploaded files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `enrichment_ocr_enabled`         | `true`             | `true` or `false`                                                                            | Whether the server reads text from images with OCR. When off, images are recorded as unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `enrichment_max_blob_bytes`      | `20971520` bytes   | Whole number of bytes, 1 to 1099511627776                                                    | The largest blob the server extracts text from. A larger blob gets no extracted text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `enrichment_max_text_chars`      | `100000`           | Whole number, 1 to 100000000                                                                 | The most Unicode characters of extracted text the server keeps, counted as characters, not UTF-16 code units. Longer text is cut short.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `enrichment_max_inflated_bytes`  | `67108864` bytes   | Whole number of bytes, 1 to 1099511627776                                                    | The most a document may inflate to when the server extracts its text, all of its parts together. A document that inflates past it is skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `enrichment_max_memory_bytes`    | `1073741824` bytes | Whole number of bytes, 1 to 1099511627776                                                    | The most memory reading one file may use. A file that needs more is skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `enrichment_max_attempts`        | `3`                | Whole number, 1 to 100                                                                       | How many times the server tries to extract text from a failing item before it stops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sign_in_address`                | None               | An origin with no path, or empty                                                             | The address people sign in at, which OAuth, cookies and links use. An origin has a scheme, a host and an optional port, with no user name, password, path, query or fragment. Empty uses `http://localhost` with the port the server listens on, whatever `MARFA_LISTEN_HOST` is. It joins `addresses` without being listed there.                                                                                                                                                                                                                                                                                                                                                                      |
| `cors_origins`                   | None               | List of origins, each `scheme://host[:port]` with no path                                    | The browser origins allowed to call the API across origins with a token, beside the web pages the owner approves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `rate_limit_enabled`             | `true`             | `true` or `false`                                                                            | Whether the rate limiter is on for a key's or an app's requests, and for app registration, device code requests, passkey sign-in challenges and deliveries to inbound addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rate_limit_requests`            | `4000`             | Whole number, 1 to 1000000                                                                   | The requests one key or app may make to all operations together in each window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `rate_limit_window_seconds`      | `60` seconds       | Whole number of seconds, 1 to 86400                                                          | The length of a rate-limit window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rate_limit_keys_requests`       | `200`              | Whole number, 1 to 1000000                                                                   | The requests one credential may make in each window to the operations under `/keys`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `inbound_max_bytes`              | `26214400` bytes   | Whole number of bytes, 1 to 1099511627776                                                    | The largest inbound webhook delivery the server stores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rate_limit_inbound_requests`    | `600`              | Whole number, 1 to 1000000                                                                   | The deliveries one inbound endpoint accepts in each rate-limit window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `inbound_backlog_deliveries`     | `10000`            | Whole number, 1 to 1000000                                                                   | The unhandled deliveries one registration may hold before the server refuses more deliveries for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `inbound_backlog_bytes`          | `1073741824` bytes | Whole number of bytes, 1 to 1099511627776                                                    | The bytes of unhandled deliveries one registration may hold before the server refuses more deliveries for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `inbound_retained_deliveries`    | `10000`            | Whole number, 1 to 1000000                                                                   | The most deliveries the server retains across live and retired endpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `inbound_retained_bytes`         | `1073741824` bytes | Whole number of bytes, 1 to 1099511627776                                                    | The most bytes of deliveries the server retains across live and retired endpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `inbound_in_flight_bytes`        | `104857600` bytes  | Whole number of bytes, 1 to 1099511627776                                                    | The most bytes of inbound webhook deliveries the server holds in memory at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `inbound_handled_retention_days` | `7` days           | Whole number of days, 0 to 36500                                                             | How long the server keeps a handled delivery. At 0 age does not expire a delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `inbound_pending_retention_days` | `30` days          | Whole number of days, 0 to 36500                                                             | How long the server keeps an unhandled delivery. At 0 age does not expire a delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `audit_retention_days`           | `90` days          | Whole number of days, 0 to 36500                                                             | How long the server keeps audit entries and webhook delivery history. At 0 no entry expires by age.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `revoked_grant_retention_days`   | `90` days          | Whole number of days, 0 to 36500                                                             | How long a revoked application grant is kept. At 0 no revoked grant is purged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `grant_inactivity_days`          | `365` days         | Whole number of days, 0 to 36500                                                             | How long an application grant may go unused before the server retires it. At 0 grants are never retired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `event_log_retention_days`       | `30` days          | Whole number of days, 0 to 36500                                                             | The least time an event stays in the event log, which bounds how far back a stream can replay, and the time the server keeps the answer to a write sent with an `Idempotency-Key`. At 0 neither expires by age.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `version_recent_days`            | `30` days          | Whole number of days, 0 to 36500                                                             | The window in which the version policy keeps every version of an item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `version_daily_snapshot_days`    | `90` days          | Whole number of days, 0 to 36500                                                             | The window in which the version policy keeps one version a day. It must be at least `version_recent_days`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `version_weekly_snapshot_days`   | `365` days         | Whole number of days, 0 to 36500                                                             | The window in which the version policy keeps one version a week. It must be at least `version_daily_snapshot_days`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version_max_versions`           | `500`              | Whole number, 1 to 1000000                                                                   | The most versions the version policy keeps for one item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `trash_retention_days`           | `60` days          | Whole number of days, 0 to 36500                                                             | How long an item stays in the trash before the server deletes it. At 0 nothing in the trash expires by age.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `row_log_retention_days`         | `30` days          | Whole number of days, 0 to 36500                                                             | How long a table keeps a batch in its change log, which bounds how far back a batch can be undone. At 0 no batch leaves the log by age.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unapproved_app_retention_hours` | `1` hour           | Whole number of hours, 0 to 876000                                                           | How long a dynamically registered client with no grants is kept, counted from its registration or the last time an approval page offered it. At 0 none is removed by age.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `event_stream_max_viewers`       | `0`                | Whole number, 0 to 1000000                                                                   | The most event-stream viewers one server instance serves at once. At 0 there is no limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mcp_fetch_enabled`              | `true`             | `true` or `false`                                                                            | Whether MCP tools fetch a file from a web address, or a file a chat attached, to save it. When off, a tool asked to fetch one is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mcp_fetch_max_bytes`            | `52428800` bytes   | Whole number of bytes, 1 to 1099511627776                                                    | The largest file an MCP tool fetches from a web address to save. A larger file is refused and nothing is stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mcp_fetch_timeout_seconds`      | `60` seconds       | Whole number of seconds, 1 to 3600                                                           | How long an MCP tool's fetch of a file from a web address may take, from connecting to the last byte.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `error_reporting_enabled`        | `true`             | `true` or `false`                                                                            | Send error alerts to `error_webhook_url` and exception reports to the receiver the environment names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `heartbeat_enabled`              | `true`             | `true` or `false`                                                                            | Send scheduled requests to `heartbeat_url`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `update_check_enabled`           | `true`             | `true` or `false`                                                                            | Whether the server checks GitHub for new Marfa releases every few hours. When off, it makes no request for them and reports no release as newer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `addresses`                      | None               | List of origins, each `scheme://host[:port]` with no path                                    | The addresses people reach this instance at, such as `https://marfa.example`. Each is an origin: a scheme, a host and an optional port, with no path. Links the server builds come from this list and the sign-in address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### `instance/settings-listed`

When a caller holding `config.manage` or `instance.read`, or the private local process, sends `GET /config/settings`, the server MUST answer `200` with `data`, an entry for each stored setting holding its `key`, `description`, `value`, `default`, `stored`, `rule`, `secret` and `together`, and `set` for a secret; `rules`, an entry for each rule across settings holding its `name`, `description` and `keys`; and `start_only`, an entry for each start-only setting holding its `name`, `description`, `secret` and `set`.

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

### `instance/cors-origins-permission`

When a key holding `config.manage` sends `PATCH /config` that changes `cors_origins`, the server MUST store the change.

**Tests:** `compliance/instance-addresses.test.ts › lets a key holding config.manage change cors_origins`.

### `instance/sign-in-address-authority-unchanged`

If a key sends `PUT /config` or `PATCH /config` that names `sign_in_address` at the value it already has, then the server MUST apply the write as it would for any other setting.

**Reason:** a client that sends the whole configuration back does not move the sign-in address, and refusing it would refuse every key that does so.

**Tests:** `compliance/instance-addresses.test.ts › is refused to a key, which has no sign-in to renew`.

### `instance/sign-in-address-unconfirmed`

If a write moves the sign-in address of a claimed instance, the first sign-in address stored included, without `confirm_sign_in_address_change` set to `true`, then the server MUST answer `409 sign_in_address_change_unconfirmed` with the consequences of the change in `details.consequences`, and store none of the write.

**Reason:** the change signs everyone out and can strand passkeys and apps, so the person is told what it will do before it does it.

**Tests:** `compliance/instance-addresses.test.ts › is not moved, and the answer names the consequences, until a write confirms it`.

### `instance/sign-in-address-confirmed`

When a caller that `keys-and-oauth/step-up-recent` or `keys-and-oauth/step-up-socket` admits sends `confirm_sign_in_address_change` set to `true` with a new sign-in address that passes the check `instance/sign-in-address-check-passed` states, or that `instance/sign-in-address-check-skip` lets through, the server MUST store the address.

**Tests:** `compliance/instance-addresses.test.ts › is not moved, and the answer names the consequences, until a write confirms it`.

### `instance/sign-in-address-check-refused`

If a write moves the sign-in address of a claimed instance with `confirm_sign_in_address_change` set to `true` and without the skip `instance/sign-in-address-check-skip` states, and the new address does not answer `GET /` within 5 seconds with `200` and this instance's `instance_id`, then the server MUST answer `409 sign_in_address_check_failed` and store none of the write.

**Reason:** a mistyped or unready address would end every sign-in, and only the machine the server runs on could put it back. The server asks at a fixed path and follows no redirect, so a redirect answers as another server.

**Tests:** `compliance/step-up.test.ts › refuses a move to an address that answers as another instance, redirects, answers nothing or never answers, with 409 sign_in_address_check_failed, and changes nothing`, `compliance/step-up.test.ts › is skipped for the private local command when the body sets skip_sign_in_address_check, and that field is refused to an app with 403 forbidden`.

### `instance/sign-in-address-check-reason`

When the server names why a new sign-in address failed its check, the server MUST name `unreachable` when nothing answered, `timed_out` when nothing answered within 5 seconds of being asked, and `not_this_instance` when an answer came that was not `200` with this instance's `instance_id`.

**Tests:** `compliance/step-up.test.ts › names why an address failed the check while private addresses are allowed: unreachable, timed_out or not_this_instance`.

### `instance/sign-in-address-check-private`

Where `allow_private_addresses` is `false`, if a new sign-in address leads to an address that is not public and fails its check, then the server MUST name `not_this_instance` as the reason, whatever happened.

**Reason:** the instance's own address is often on the loopback or a private network, so the check of a move reaches such an address whatever `allow_private_addresses` says, and tells no more about it than whether this instance answers there.

**Tests:** `compliance/step-up.test.ts › refuses a move to an address that answers as another instance, redirects, answers nothing or never answers, with 409 sign_in_address_check_failed, and changes nothing`.

### `instance/sign-in-address-check-passed`

When a write moves the sign-in address with `confirm_sign_in_address_change` set to `true`, and the new address answers `GET /` with `200` and this instance's `instance_id`, the server MUST store the address, whether or not the address is on the loopback or a private network.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`, `compliance/step-up.test.ts › is skipped for the private local command when the body sets skip_sign_in_address_check, and that field is refused to an app with 403 forbidden`.

### `instance/sign-in-address-check-skip`

When the private local command sends `skip_sign_in_address_check` set to `true` with a move of the sign-in address that `confirm_sign_in_address_change` confirms, the server MUST store the address without asking it.

**Reason:** a host can be set up to answer only once the instance answers to its name.

**Tests:** `compliance/step-up.test.ts › is skipped for the private local command when the body sets skip_sign_in_address_check, and that field is refused to an app with 403 forbidden`.

### `instance/sign-in-address-check-skip-refused`

If a caller other than the private local command sends `skip_sign_in_address_check` set to `true`, then the server MUST answer `403 forbidden` and store none of the write.

**Tests:** `compliance/step-up.test.ts › is skipped for the private local command when the body sets skip_sign_in_address_check, and that field is refused to an app with 403 forbidden`.

### `instance/sign-in-address-ends-sessions`

When a write moves the sign-in address with `confirm_sign_in_address_change` set to `true`, the server MUST end every browser session in the write that stores the address, so that no session cookie made before it opens anything afterward.

**Reason:** the confirmation tells the person that everyone signed in on a browser is signed out (`browser_sessions_end`). A session's cookie belongs to the old address, so none is kept: the owner signs in again at the new address.

**Tests:** `compliance/instance-addresses.test.ts › ends every browser session, so a session token from before the move opens nothing under either cookie name`.

### `instance/sign-in-address-ends-apps`

When a write moves the sign-in address with `confirm_sign_in_address_change` set to `true`, the server MUST end every app's access tokens and refresh tokens in the write that stores the address, so that none issued before it is accepted afterward, the token that sent the write included.

**Reason:** the confirmation tells the person that apps sign in again (`apps_sign_in_again`): their tokens were issued by the old address, and an app reconnects at the new issuer.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`.

### `instance/sign-in-address-keeps-grants`

When a write moves the sign-in address, the server MUST keep every app's grant, so that an authorization the grant covers is answered with a code once the person signs in at the new address, without the consent screen.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`.

### `instance/sign-in-address-keeps-keys`

When a write moves the sign-in address, the server MUST keep every API key working.

**Reason:** a key is not issued by the sign-in address, so moving the address leaves it as it was.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`.

### `instance/sign-in-address-moved-answer`

When a write moves the sign-in address, the server MUST answer the configuration with `sign_in_moved` holding `consequences`, as `POST /config/address-check` names them for the same change before it, and `next_steps`.

**Reason:** the app that made the move guides the person through what follows from the answer alone, since the move ended the app's own sign-in.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`.

### `instance/sign-in-address-next-steps`

When the server names the next steps of a move of the sign-in address, the server MUST name `sign_in`, with the sign-in page at the new address as `url`, and then `add_passkey`, with the link `GET /owner/passkeys/add-url` answers at the new address as `url`, each with a `sentence`.

**Reason:** a passkey belongs to the address it was made for, and the server keeps it for that address (`passkeys_unusable` counts those that stop working), so the owner adds one at the new address. A password sign-in works at the new address, so nobody is locked out.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`.

### `instance/sign-in-address-forgets-devices`

When a write confirms a move of the sign-in address, the server MUST count each later password sign-in that carries a device cookie set before the move as one with no device cookie.

**Reason:** a device cookie is signed for the owner's credentials as they stand, and the move renews them with the browser sessions it ends, so no browser stays known.

**Tests:** `compliance/sign-in-limits.test.ts › counts a device cookie set before a confirmed move of the sign-in address as no device cookie`.

### `instance/sign-in-needs-address`

While no sign-in address is set, if a caller sends `POST /auth/sign-in` over a connection whose own address is not on the loopback, or names through a trusted proxy an address that is not on the loopback, then the server MUST answer `403 forbidden` with a message that says how to set the sign-in address.

**Reason:** Until the owner says where people reach the instance, the server cannot tell a sign-in through the owner's own proxy from one through anyone else's. A caller is local only by its own connection.

**Tests:** `compliance/sign-in-door-limits.test.ts › refuses a password sign-in from a caller off this machine 403, and answers one from this machine`.

### `instance/address-check`

When a key holding `config.manage` sends `POST /config/address-check` with `sign_in_address`, `addresses` or both, the server MUST answer `200` with the `sign_in_address` and the `addresses` as they would be after the change, `requires_confirmation`, `consequences`, each of them `code`, `sentence` and `count`, `next_steps`, empty unless the sign-in address moves, and `sign_in_address_check` while `requires_confirmation` is `true`.

**Reason:** an app shows the person what a change does before it asks for the write. `requires_confirmation` is `true` when a write of the same change needs `confirm_sign_in_address_change`, and `next_steps` are what `instance/sign-in-address-next-steps` names.

**Tests:** `compliance/instance-addresses.test.ts › writes nothing, and answers the addresses after the change, whether it needs confirming and what it does`, `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`.

### `instance/address-check-instance`

When the server asks the new sign-in address in an address check, the server MUST answer `sign_in_address_check` with `passed` set to `true` when the address passes the check `instance/sign-in-address-check-passed` states, and otherwise `passed` set to `false` with the `reason` that a write of the same change would be refused for.

**Reason:** an app shows the person whether the address reaches this instance before it asks them to confirm a move that ends every sign-in.

**Tests:** `compliance/step-up.test.ts › is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps`, `compliance/step-up.test.ts › refuses a move to an address that answers as another instance, redirects, answers nothing or never answers, with 409 sign_in_address_check_failed, and changes nothing`, `compliance/step-up.test.ts › names why an address failed the check while private addresses are allowed: unreachable, timed_out or not_this_instance`.

### `instance/address-check-private-unasked`

Where `allow_private_addresses` is `false`, if a caller that neither `keys-and-oauth/step-up-recent` nor `keys-and-oauth/step-up-socket` admits sends `POST /config/address-check` with a new sign-in address that leads to an address that is not public, then the server MUST NOT send a request to that address.

**Reason:** the server asks an address on the loopback or a private network only for a caller who could move the sign-in address there.

**Tests:** `compliance/step-up.test.ts › sends no request to an address that is not public for a caller that could not make the move, and answers needs_recent_sign_in, while an app whose owner signed in just now has it asked`.

### `instance/address-check-private-reason`

When the server does not ask a new sign-in address in an address check, as `instance/address-check-private-unasked` states, the server MUST answer `sign_in_address_check` with `passed` set to `null` and `reason` set to `needs_recent_sign_in`.

**Reason:** the app tells the person to sign in again before the address can be checked, since the move itself would ask the same.

**Tests:** `compliance/step-up.test.ts › sends no request to an address that is not public for a caller that could not make the move, and answers needs_recent_sign_in, while an app whose owner signed in just now has it asked`.

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

**Tests:** `compliance/instance-config.test.ts › keeps live settings across restart, preserves omitted choices and clears to the default`.

### `instance/live-policy-validation`

If a configuration write would make the effective recent, daily and weekly version windows decrease in that order, set a negative window or inactivity period, set a version count below one, or turn reporting from off to on without a configured receiver, then the server MUST refuse it with `400 validation_error` without changing the stored configuration.

**Reason:** validation includes the defaults exposed by clearing a stored setting. A receiver is `heartbeat_url` for the heartbeat, and `error_webhook_url` or an exception receiver set where Marfa runs for error reporting.

**Tests:** `compliance/instance-config.test.ts › keeps live settings across restart, preserves omitted choices and clears to the default`, `compliance/restore-says.test.ts › restores a reporting setting that is turned on where no receiver is set, names it, and still refuses turning it on again from off`.

### `instance/live-work`

When a stored setting changes, the server MUST use the effective choice for future work without a restart, including a job disabled when the process started.

**Reason:** disabling does not promise to cancel an extraction or request already in flight. Version deletion and unused-app retirement recheck the effective policy in the transaction that removes the versions or revokes the grant. A zero version window is empty; a zero inactivity period disables retirement. Type-specific version policies retain precedence.

**Tests:** `compliance/live-settings.test.ts › starts disabled work after a live choice and stops it again without restarting`.

## Secret settings

A stored setting the table gives as a secret holds a credential: `object_store_secret_access_key`, `heartbeat_url` and `error_webhook_url`, whose address is itself the credential. It is written through `PUT /config` and `PATCH /config` like any stored setting, and never read back.

### `instance/secret-sealed`

The server MUST NOT write the value of a secret setting into its database file other than sealed with the settings key it keeps in `marfa.settings.key` beside the database.

**Reason:** a copy of the database, which a backup or a careless copy can make, then holds no secret anyone can read without the machine's key.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/secret-not-answered`

The server MUST NOT include the value of a secret setting in an answer to any request.

**Reason:** an app that reads the configuration is not trusted with every credential the owner set.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/secrets-set-named`

When the server answers `GET /config`, `PUT /config` or `PATCH /config` with the configuration, the server MUST answer `secrets_set`, present only while one is set, with the key of each secret setting stored with a value the server can read.

**Reason:** an app shows whether a secret is set without being given it. A body may send `secrets_set` back, and it sets nothing.

**Tests:** `compliance/secret-settings.test.ts › is named in secrets_set and listed as set with no value, kept by a PUT that leaves it out, and removed by null or an empty string`.

### `instance/secret-listed`

When the server answers `GET /config/settings`, the server MUST answer each secret setting's entry with `secret` `true`, `set` saying whether a value is in force, and `value`, `default` and `stored` all `null`.

**Tests:** `compliance/secret-settings.test.ts › is named in secrets_set and listed as set with no value, kept by a PUT that leaves it out, and removed by null or an empty string`.

### `instance/secret-put-keeps`

When `PUT /config` leaves out a secret setting, the server MUST keep the value stored for it, unless the setting is `object_store_secret_access_key` and the write changes `object_store_bucket` or `object_store_endpoint` (`instance/store-secret-removed`).

**Reason:** no answer gives a secret back, so a body read from `GET /config` and sent back whole could not name it. `PATCH /config` with `null` removes it.

**Tests:** `compliance/secret-settings.test.ts › is named in secrets_set and listed as set with no value, kept by a PUT that leaves it out, and removed by null or an empty string`.

### `instance/settings-empty-clears`

When a write to `/config` gives a setting whose allowed values the stored table ends with "or empty" the empty string, or, for a setting that is not a secret, text of white space alone, the server MUST remove the value stored for it.

**Tests:** `compliance/secret-settings.test.ts › is named in secrets_set and listed as set with no value, kept by a PUT that leaves it out, and removed by null or an empty string`, `compliance/destination-settings.test.ts › takes an untidy object store setting in its plain spelling, and refuses an endpoint that carries a credential without repeating it`.

### `instance/secret-refusal-hidden`

If a write to `/config` gives a secret setting a value outside its rule, then the server MUST NOT include that value in the refusal.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/config-audit-names-secret`

When the server records a write to `/config` in the audit log, the server MUST name the secret settings it wrote by key.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/secret-audit-no-value`

The server MUST NOT include the value of a secret setting in an audit entry.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/secret-not-logged`

The server MUST NOT write the value of a secret setting to its log or its standard error.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/backup-no-secret`

When the server takes a backup, the server MUST NOT put the value of a secret setting in it.

**Reason:** a backup leaves the machine, and the key that would open a sealed value never does, so a backup names each secret that was set (`archive/archive-secret-named`) and holds none.

**Tests:** `compliance/secret-settings.test.ts › is shown back nowhere: no answer, refusal, audit entry, log, export, backup or database page holds its value, where a setting that is no secret is shown`.

### `instance/secret-unreadable-unset`

If the server cannot open the value stored for a secret setting with its settings key, then the server MUST answer its entry in `GET /config/settings` with `set` `false` and `unreadable` `true` and, unless `instance/store-setting-unreadable-unused` applies, work as if the setting were not set.

**Reason:** the value came from another machine's key, or the key was lost, and a secret the server cannot read is never reported as set. The row stays, so a key put back opens it again.

**Tests:** `compliance/secret-settings.test.ts › is reported on a restore, and on the attention list, when the archive's instance had it set and this one holds no value it can read`, `compliance/secret-settings.test.ts › survives a lost or damaged settings key: the server starts, serves, and lists each stored secret to set again`.

### `instance/attention-secret-to-set`

While a secret setting holds a stored value the server cannot open, when `GET /attention` completes its checks, the server MUST include one entry of kind `setting` whose reference is the setting's key.

**Tests:** `compliance/secret-settings.test.ts › is reported on a restore, and on the attention list, when the archive's instance had it set and this one holds no value it can read`, `compliance/secret-settings.test.ts › survives a lost or damaged settings key: the server starts, serves, and lists each stored secret to set again`.

### `instance/settings-key-lost-starts`

If `marfa.settings.key` is missing, or opens as a file but its contents do not read (empty, truncated or damaged), when the server starts, then the server MUST start, make a new settings key, and refuse no request because of it.

**Reason:** the key protects secrets the owner can set again from any app, so losing it costs those secrets and nothing else.

**Tests:** `compliance/secret-settings.test.ts › survives a lost or damaged settings key: the server starts, serves, and lists each stored secret to set again`.

### `instance/settings-key-unopened-refused`

If `marfa.settings.key` cannot be opened as a file the server may keep, such as one with mode `000`, a symbolic link or a directory, when the server starts, then the server MUST refuse to start and leave that file as it was.

**Reason:** the server cannot read such a file to tell a lost key from one that is only out of reach, so replacing it could lose a key that opens the owner's secrets.

**Tests:** `compliance/secret-settings.test.ts › refuses to start on a settings key it cannot open, and keeps the file as it was`.

### `instance/settings-key-damaged-kept`

If the contents of `marfa.settings.key` do not read when the server starts, then the server MUST keep that file beside the database under a name that begins `marfa.settings.key.damaged-`.

**Reason:** whoever can mend the file can put it back and open the secrets sealed with it.

**Tests:** `compliance/secret-settings.test.ts › survives a lost or damaged settings key: the server starts, serves, and lists each stored secret to set again`.

## Destination and notice settings

The backup destination and the object store, its secret and the backup schedule, the error webhook and the heartbeat are stored settings. A write to `/config` that changes them takes effect without a restart.

`object_store_secret_access_key` is a secret that belongs to this machine as the other `object_store_` settings do, so no archive names it (`archive/archive-secret-named`).

Where files and backups go decides who holds a copy of them, so `backup_path`, `object_store_bucket`, `object_store_endpoint`, `object_store_region`, `object_store_path_style` and `object_store_prefix` change only as `keys-and-oauth/step-up-recent` and `keys-and-oauth/step-up-socket` allow.

### `instance/destination-unchanged`

If a key sends `PUT /config` or `PATCH /config` that gives each of `backup_path`, `object_store_bucket`, `object_store_endpoint`, `object_store_region`, `object_store_path_style` and `object_store_prefix` it names the value already stored for it, and leaves out none of them that is stored when it is a `PUT`, then the server MUST apply the write as it would for any other setting.

**Reason:** a client that sends the whole configuration back does not change where files and backups go, and refusing it would refuse every key that does so.

**Tests:** `compliance/destination-step-up.test.ts › restates the backup_path and object_store_ settings it reads back, by PATCH and by PUT`.

### `instance/store-secret-removed`

When a write to `/config` changes `object_store_bucket` or `object_store_endpoint` and does not set `object_store_secret_access_key`, the server MUST remove the value stored for `object_store_secret_access_key` in the same write.

**Reason:** a secret is given for one store, so the owner gives it again for the store the settings now name. `object_store_access_key_id` is no secret and stays.

**Tests:** `compliance/destination-step-up.test.ts › is removed by a write that changes object_store_bucket or object_store_endpoint without setting it, and kept through any other change`.

### `instance/store-secret-kept`

When a write to `/config` leaves `object_store_bucket` and `object_store_endpoint` as they are stored and does not name `object_store_secret_access_key`, the server MUST keep the value stored for `object_store_secret_access_key`.

**Tests:** `compliance/destination-step-up.test.ts › is removed by a write that changes object_store_bucket or object_store_endpoint without setting it, and kept through any other change`.

### `instance/backup-destination-follows`

When a write to `/config` changes `backup_path` or an `object_store_` setting, the server MUST take the destination they name into use for the copies and backups that begin after the write, without a restart.

**Tests:** `compliance/destination-settings.test.ts › takes a backup folder set through /config without a restart, and finishes a backup that was running in the folder it began in`, `compliance/destination-settings.test.ts › reports an object store that refuses its secret as unusable, keeps serving files from the disk, and takes the store once the secret is right`.

### `instance/backup-running-keeps-destination`

If the destination settings change while a backup runs, then the server MUST finish that backup in the destination it began in.

**Reason:** a backup is whole in one place or not written, never half in each.

**Tests:** `compliance/destination-settings.test.ts › takes a backup folder set through /config without a restart, and finishes a backup that was running in the folder it began in`.

### `instance/backup-health-unusable`

While the backup folder or the object store the settings name cannot be used, the server MUST answer `GET /health` with `backups.status` `failing`, `backups.reason` `destination_unusable` and `backups.store_error` saying why.

**Tests:** `compliance/destination-settings.test.ts › reports an object store that refuses its secret as unusable, keeps serving files from the disk, and takes the store once the secret is right`.

### `instance/attention-backup-unusable`

While the backup folder or the object store the settings name cannot be used, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` with the reference `store` and the title `The backup destination cannot be used`.

**Tests:** `compliance/destination-settings.test.ts › reports an object store that refuses its secret as unusable, keeps serving files from the disk, and takes the store once the secret is right`.

### `instance/object-store-endpoint-bare`

If a write to `/config` sets `object_store_endpoint` to a URL that carries a user name or a password, then the server MUST answer `400 validation_error` naming `object_store_endpoint`, with no part of the URL in the refusal.

**Reason:** the object store's errors, which the server logs, carry the whole endpoint, so a credential belongs in `object_store_access_key_id` and `object_store_secret_access_key`.

**Tests:** `compliance/destination-settings.test.ts › takes an untidy object store setting in its plain spelling, and refuses an endpoint that carries a credential without repeating it`.

### `instance/object-store-plain-spelling`

When a write to `/config` sets an `object_store_` setting or `backup_path`, the server MUST store it in its plain spelling: an endpoint whose whole path is `/` without it, a prefix without a `/` at either end, a folder without a `/` at its end, and text without spaces at either end.

**Tests:** `compliance/destination-settings.test.ts › takes an untidy object store setting in its plain spelling, and refuses an endpoint that carries a credential without repeating it`, `compliance/backup-folder.test.ts › refuses a backup folder inside its data directory or its blob folder, judged where links lead, and makes none`.

### `instance/heartbeat-url-live`

When a write to `/config` sets `heartbeat_url`, the server MUST list the `heartbeat` job and send its next heartbeat to that URL, without a restart.

**Tests:** `compliance/destination-settings.test.ts › lists and sends the heartbeat to a heartbeat_url set through /config, without a restart`.

### `instance/error-webhook-url-live`

When a write to `/config` sets `error_webhook_url`, the server MUST post its notice of each later request that fails with a 500 error to that URL, without a restart.

**Tests:** `compliance/destination-settings.test.ts › posts a notice of a 500 to an error_webhook_url set through /config, without a restart`.

## Where the server may send

The server sends to the destinations its settings name: webhooks, `heartbeat_url`, `error_webhook_url` and `object_store_endpoint`. While `allow_private_addresses` is `false`, the default, each is held to the rule webhooks are held to: an address is public only where `events/address-private`, `events/address-ipv6-global` and `events/address-mapped` judge it so. A credential that may change the configuration must not reach the network the server runs on unless a person just confirmed it, so the switch changes only as `keys-and-oauth/step-up-recent` and `keys-and-oauth/step-up-socket` allow.

### `instance/private-addresses-local`

When a write sets `allow_private_addresses` to `true` through `/config`, the server MUST send to destinations at addresses that are not public from then on, without a restart.

**Tests:** `compliance/destination-addresses.test.ts › refuses a key holding config.manage the switch, which an app whose owner signed in just now changes`, `› takes an object store on a private address once the private local process turns the switch on, and not before`.

### `instance/destination-private-refused`

Where `allow_private_addresses` is `false`, if a write to `/config` sets `heartbeat_url`, `error_webhook_url` or `object_store_endpoint` to a URL whose host is an address that is not public, then the server MUST answer `400 validation_error` naming the setting, with no part of the URL in the refusal.

**Reason:** `heartbeat_url` and `error_webhook_url` are secrets, and a URL can carry a credential.

**Tests:** `compliance/destination-addresses.test.ts › refuses a heartbeat_url, error_webhook_url or object_store_endpoint written as a private address while the switch is off`.

### `instance/object-store-region-name`

If a write to `/config` sets `object_store_region` to text that, with the whitespace around it removed, is neither empty nor a name of 1 to 63 ASCII letters, digits, hyphens and underscores for which `https://s3.<name>.amazonaws.com/` is a valid URL, then the server MUST answer `400 validation_error` naming the setting.

**Reason:** `auto` and names such as `us-east-1` and `my_region` are names, and with no endpoint the store's address is built from the region.

**Tests:** `compliance/destination-settings.test.ts › refuses an object store region that is not a plain name, and takes the names real stores use`.

### `instance/object-store-bucket-name`

If a write to `/config` sets `object_store_bucket` to text that, with the whitespace around it removed, is neither empty nor a name of 1 to 255 ASCII letters, digits, dots, colons, hyphens and underscores other than `.` and `..`, then the server MUST answer `400 validation_error` naming the setting.

**Reason:** Ceph writes a tenant's bucket as `tenant:bucket`. The bucket is a segment of each request's path, which `.` and `..` cannot be.

**Tests:** `compliance/destination-settings.test.ts › refuses an object store bucket that is not a valid name, and takes the names real stores use`.

### `instance/object-store-virtual-host`

Where `object_store_endpoint` is set and `object_store_path_style` is `false`, the server MUST address the object store at the host made of `object_store_bucket`, a dot and the endpoint's host, with the bucket left out of the path, in each request it sends to the store and in each link the store signs, whatever the endpoint's host begins with.

**Tests:** `compliance/destination-addresses.test.ts › reaches an object store by virtual host at the bucket before the endpoint's host, and not while that host leads to a private address`.

### `instance/object-store-virtual-host-refused`

If a write to `/config` that sets `object_store_bucket`, `object_store_endpoint` or `object_store_path_style` leaves `object_store_path_style` `false` with both `object_store_bucket` and `object_store_endpoint` set, and the bucket is not labels of 1 to 63 lowercase ASCII letters, digits and hyphens joined by dots with no label starting or ending with a hyphen, the endpoint's host is an IP address, or the bucket, a dot and the endpoint's host are longer than 253 characters, then the server MUST answer `400 validation_error` naming a setting the write sets, with no part of the endpoint in the refusal.

**Reason:** by virtual host the bucket is a part of a host name, which holds only such labels, carries no case and cannot go before an address. The endpoint is the store's own host, without the bucket: a host that begins with the bucket can be a store's own, as the bucket `s3` before `s3.store.example`.

**Tests:** `compliance/destination-settings.test.ts › refuses object store settings addressed by virtual host that cannot make the store's host, and takes the same values by path`.

### `instance/object-store-virtual-host-unusable`

While the stored `object_store_path_style` is `false` and the stored `object_store_bucket` and `object_store_endpoint` are values `instance/object-store-virtual-host-refused` refuses together, the server MUST NOT attach an object store.

**Tests:** `compliance/destination-settings.test.ts › starts over an emptied blob folder while the stored object store settings cannot make the store's host, names them on the attention list, and takes the store once path style is set again`.

### `instance/object-store-virtual-host-start`

While the stored `object_store_path_style` is `false` and the stored `object_store_bucket` and `object_store_endpoint` are values `instance/object-store-virtual-host-refused` refuses together, when the server starts, the server MUST NOT refuse the start because the blob folder is missing or holds no marker.

**Reason:** only a running server can take the corrected settings through `/config`.

**Tests:** `compliance/destination-settings.test.ts › starts over an emptied blob folder while the stored object store settings cannot make the store's host, names them on the attention list, and takes the store once path style is set again`.

### `instance/object-store-virtual-host-told`

While `instance/object-store-virtual-host-unusable` keeps an object store from being attached, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` and reference `store` that names `object_store_path_style` and holds no part of the endpoint.

**Tests:** `compliance/destination-settings.test.ts › starts over an emptied blob folder while the stored object store settings cannot make the store's host, names them on the attention list, and takes the store once path style is set again`.

### `instance/store-setting-unreadable-start`

Where `object_store_bucket` is set or its stored value does not read, and a stored setting whose key begins `object_store_` does not read, or where `object_store_bucket` is not set and the stored `backup_path` does not read, when the server starts, the server MUST NOT refuse the start because the blob folder is missing or holds no marker.

**Reason:** these are the settings that leave the server unable to tell which store is meant, and only a running server can take the corrected value through `/config`.

**Tests:** `compliance/destination-settings.test.ts › starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again`, `› starts over an emptied blob folder while a stored object store setting does not read, answers 503 for the file it held, and serves it once the setting is set again`, `› starts, purges nothing and names the setting without its value while a stored backup_path does not read, and purges the file once it is set again`, `› starts over a missing or empty blob folder while a stored backup_path does not read, leaves the folder and its store alone, and serves the files once the folder returns`.

### `instance/store-setting-unreadable-unused`

While `object_store_bucket` is set or its stored value does not read, if a stored setting whose key begins `object_store_` does not read, then the server MUST NOT attach an object store.

**Reason:** every one of these settings decides which store is reached, so the server uses a store only as the owner set it.

**Tests:** `compliance/destination-settings.test.ts › starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again`.

### `instance/store-setting-unreadable-told`

While `instance/store-setting-unreadable-unused` keeps an object store from being attached, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` and reference `store` that names each stored setting whose key begins `object_store_` and does not read, and holds none of their values.

**Tests:** `compliance/destination-settings.test.ts › starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again`.

### `instance/backup-path-unreadable-told`

While `object_store_bucket` is not set and the stored `backup_path` does not read, when `GET /attention` completes its checks, the server MUST include one entry of kind `backup` and reference `store` that names `backup_path` and does not hold its value.

**Tests:** `compliance/destination-settings.test.ts › starts, purges nothing and names the setting without its value while a stored backup_path does not read, and purges the file once it is set again`, `› starts over a missing or empty blob folder while a stored backup_path does not read, leaves the folder and its store alone, and serves the files once the folder returns`.

### `instance/store-setting-set-again`

When a write to `/config` leaves every stored setting whose key begins `object_store_` readable, the server MUST try again to attach the object store the settings name, without a restart.

**Tests:** `compliance/destination-settings.test.ts › starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again`, `compliance/destination-settings.test.ts › starts over an emptied blob folder while a stored object store setting does not read, answers 503 for the file it held, and serves it once the setting is set again`.

### `instance/store-unusable-no-purge`

While the object store or backup folder the stored settings name is not in use, because it cannot be used or because a stored setting that names it does not read, the server MUST NOT purge a blob.

**Reason:** the server decides what to purge from what every store it names holds and what their backups name.

**Tests:** `compliance/destination-settings.test.ts › starts, attaches no object store, purges nothing and names the setting without its value while a stored object store setting does not read, and takes the store once it is set again`, `› purges nothing while the object store the settings name cannot be used, and purges the same file once no store is named`, `› starts, purges nothing and names the setting without its value while a stored backup_path does not read, and purges the file once it is set again`, `› starts over a missing or empty blob folder while a stored backup_path does not read, leaves the folder and its store alone, and serves the files once the folder returns`, `› tries the object store again when a sweep finds it out of use, and purges the file once it answers, with no restart or settings write`.

### `instance/store-unusable-retried`

While the object store the stored settings name is not in use because it could not be used, when `blob-orphans` runs, the server MUST try again to attach that store before it decides what to purge.

**Reason:** a store that comes back then needs no restart and no write to `/config` before purging resumes.

**Tests:** `compliance/destination-settings.test.ts › tries the object store again when a sweep finds it out of use, and purges the file once it answers, with no restart or settings write`.

### `instance/private-switch-off-refused`

If a write to `/config` sets `allow_private_addresses` to `false` while `heartbeat_url`, `error_webhook_url` or `object_store_endpoint` holds a URL whose host is an address that is not public, then the server MUST answer `400 validation_error` naming that setting.

**Tests:** `compliance/destination-addresses.test.ts › refuses a heartbeat_url, error_webhook_url or object_store_endpoint written as a private address while the switch is off`.

### `instance/heartbeat-private-unsent`

Where `allow_private_addresses` is `false`, if the host of `heartbeat_url` is a name whose lookup finds any address that is not public, then the server MUST NOT send the heartbeat.

**Tests:** `compliance/destination-addresses.test.ts › sends no heartbeat to a name that leads to a private address until the switch is on`.

### `instance/error-webhook-private-unsent`

Where `allow_private_addresses` is `false`, if the host of `error_webhook_url` is a name whose lookup finds any address that is not public, then the server MUST NOT send the notice of a failed request.

**Tests:** `compliance/destination-addresses.test.ts › sends no error notice to a name that leads to a private address until the switch is on`.

### `instance/object-store-private-unusable`

Where `allow_private_addresses` is `false`, if the host the object store is addressed at, the endpoint's own or the one `instance/object-store-virtual-host` makes, is a name whose lookup finds any address that is not public, then the server MUST answer `GET /health` with `backups.reason` `destination_unusable`.

**Reason:** the object store is never reached, so it cannot be used, and the owner sees why where every other unusable destination is reported (`instance/backup-health-unusable`).

**Tests:** `compliance/destination-addresses.test.ts › takes an object store on a private address once the private local process turns the switch on, and not before`, `› reaches an object store by virtual host at the bucket before the endpoint's host, and not while that host leads to a private address`.

## Start-only settings

The environment variables below are read once, when the server starts. Each is named `MARFA_` and what it sets, except the `OTEL_*` settings, which keep OpenTelemetry's standard names because operators' tools already set them.

| Setting                              | Default                                              | Allowed values                                                     | What it sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARFA_PORT`                         | `8600`                                               | Whole number, 0 to 65535                                           | The port the server listens on. Zero lets the operating system assign a port.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MARFA_LISTEN_HOST`                  | None                                                 | Any text                                                           | The IP address or hostname the public HTTP listener binds to. Unset uses the runtime's unspecified address: IPv6 when available, otherwise IPv4.                                                                                                                                                                                                                                                                                                                                                                                    |
| `MARFA_DATABASE_PATH`                | `./data/marfa.db`                                    | Any text                                                           | The path of the database file. A value starting with `file:` is passed to the database as written, and `:memory:` opens a database held in memory.                                                                                                                                                                                                                                                                                                                                                                                  |
| `MARFA_CONTROL_SOCKET`               | None                                                 | Any text                                                           | Absolute private Unix socket path. Defaults to control/marfa.sock beside the database. Its directory must belong to the server account with mode 0700.                                                                                                                                                                                                                                                                                                                                                                              |
| `MARFA_CONTROL_ONLY`                 | `false`                                              | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Start only the private control listener, without public HTTP or background jobs, for local recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MARFA_CLAIM_ADDRESS`                | None                                                 | An `https` origin, or an `http` one on a loopback name             | The sign-in address of an instance with no owner, for one that is claimed from another host. As it starts, the server stores it as `sign_in_address`, judged by that setting's rule, which also allows `http` only on `localhost`, `127.0.0.1` or `[::1]`. Once the instance has an owner, the server ignores it and logs that it did, and the address changes only through `/config`.                                                                                                                                              |
| `MARFA_OWNER_RECOVERY`               | `false`                                              | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Whether each start of an instance with an owner prints a recovery code in the server's own log, with which the owner chooses a new password at `/setup` without a shell. The code works once, for 60 minutes, and the next start replaces it. Off, a start removes any code an earlier start printed. Behind a platform proxy or shared edge, set `MARFA_TRUSTED_PROXY_HEADER` and `MARFA_TRUSTED_PROXY_CIDRS`, or every caller shares one attempt limit and wrong guesses can block the owner's code for a while.                  |
| `MARFA_TEST_HOOKS`                   | `false`                                              | `true`, `1`, `yes`, `on`, `false`, `0`, `no` or `off`, in any case | Serve the clock and fault routes a conformance harness drives on the private control socket. Never on the public listener. A server built without test hooks refuses to start when it is true. Leave off on every instance that holds real data.                                                                                                                                                                                                                                                                                    |
| `MARFA_TEST_CLOCK_OFFSET_MS`         | `0` ms                                               | Whole number of milliseconds, 0 to 3153600000000                   | How far ahead of the system clock the server's clock starts. Needs `MARFA_TEST_HOOKS`, so a harness that moved the clock can restart the server without the time going back.                                                                                                                                                                                                                                                                                                                                                        |
| `MARFA_TEST_CONTRACT_VERSION`        | The build's contract version                         | Whole number, 0 to 1000000                                         | The contract version the server speaks instead of the build's, in the root's `contract`, the `X-Marfa-Contract` header and the document's `info.version`. Needs `MARFA_TEST_HOOKS`, so a harness can show what a change of contract does to what the server kept.                                                                                                                                                                                                                                                                   |
| `MARFA_TEST_TUNING`                  | None                                                 | Comma-separated `name=value` pairs                                 | Shortens a timing or a batch size the server fixes: `interval.<job>` or `interval.*` in milliseconds (neither reaches `backup`, whose interval is the stored `backup_interval_seconds`, and `interval.backup` is refused), `housekeeping_poll_ms`, `write_wait_ms`, `upload_idle_ms`, `blob_read_idle_ms`, `inbound_idle_ms` or `connector_hold_ms` in milliseconds, or `enrichment_batch`, `blob_replicate_batch`, `blob_replicate_batch_bytes`, `blob_integrity_batch` or `blob_integrity_batch_bytes`. Needs `MARFA_TEST_HOOKS`. |
| `MARFA_MAX_CONNECTIONS`              | `1024`                                               | Whole number, 1 to 1000000                                         | The most connections the public listener holds open at once. The server lowers it at start where the open-file limit leaves too little room ("Open connections").                                                                                                                                                                                                                                                                                                                                                                   |
| `MARFA_MAX_CONNECTIONS_PER_ADDRESS`  | `256`                                                | Whole number, 1 to 1000000                                         | The most connections the public listener holds open for one caller address, where the listener does not believe a forwarded address. An IPv6 address counts with the rest of its /64. A value above `MARFA_MAX_CONNECTIONS` has no effect.                                                                                                                                                                                                                                                                                          |
| `MARFA_BLOB_PATH`                    | `./data/blobs`                                       | Any text                                                           | The folder of the disk store, where every upload lands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MARFA_ENRICHMENT_TESSDATA_DIR`      | None                                                 | Any text                                                           | A folder of OCR language models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MARFA_TRUSTED_PROXY_CIDRS`          | None                                                 | Comma-separated CIDR ranges, IPv4 or IPv6                          | The address ranges of the proxies whose `X-Forwarded-For` header, or the header `MARFA_TRUSTED_PROXY_HEADER` names, the server believes. When empty, `X-Forwarded-For` is ignored.                                                                                                                                                                                                                                                                                                                                                  |
| `MARFA_TRUSTED_PROXY_HEADER`         | None                                                 | An HTTP header name                                                | The name of a header that the platform's edge overwrites with the client address, believed only from a peer inside `MARFA_TRUSTED_PROXY_CIDRS`, which it needs. While it is set, `X-Forwarded-For` is ignored.                                                                                                                                                                                                                                                                                                                      |
| `MARFA_KEY_SALT`                     | None. Generated on first start into `marfa.secrets`. | Text with no whitespace around it                                  | The salt for hashing API keys and app tokens. Changing it invalidates every existing key and token. Unset, the server uses the salt in `marfa.secrets`, which it generated on first start.                                                                                                                                                                                                                                                                                                                                          |
| `MARFA_AUTH_SECRET`                  | None. Generated on first start into `marfa.secrets`. | Text of at least 32 characters, with no whitespace around it       | The secret that signs sign-in cookies, authorize queries, reach proofs and credential-free blob links. It must be at least 32 characters. Unset, the server uses the secret in `marfa.secrets`, which it generated on first start.                                                                                                                                                                                                                                                                                                  |
| `MARFA_OTEL_SAMPLE_RATIO`            | `0.05`                                               | Decimal number, 0 to 1                                             | The share of traces exported. A trace that contains an error is exported whatever this says: the span that failed, the spans held for the trace (at most 500) and every span after it.                                                                                                                                                                                                                                                                                                                                              |
| `OTEL_SDK_DISABLED`                  | `false`                                              | `true` in any case, or any other value                             | `true` in any case turns off traces, logs and exception reports together, whatever the other telemetry settings say. Any other value, including `1`, leaves them as they are. The error webhook stays on.                                                                                                                                                                                                                                                                                                                           |
| `OTEL_SERVICE_NAME`                  | `marfa-server`                                       | Any text                                                           | The service name on exported telemetry. It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `OTEL_RESOURCE_ATTRIBUTES`           | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | Attributes added to everything exported, as OpenTelemetry defines them. One named here replaces the server's own of the same name, such as `deployment.environment`, which an error notification names too.                                                                                                                                                                                                                                                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | None                                                 | Absolute `http` or `https` URL                                     | The base URL of the OTLP receiver. Setting it turns traces and logs on: the server exports traces to `v1/traces` and logs to `v1/logs` under it. Unset, no trace or log is exported; exception reports have settings of their own (`MARFA_POSTHOG_HOST`).                                                                                                                                                                                                                                                                           |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | None                                                 | Absolute `http` or `https` URL                                     | The URL traces post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`   | None                                                 | Absolute `http` or `https` URL                                     | The URL logs post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OTEL_EXPORTER_OTLP_HEADERS`         | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with every OTLP export, as `key=value` pairs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`  | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with trace exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS`    | None                                                 | Comma-separated `key=value` pairs, values percent-encoded          | The headers sent with log exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MARFA_POSTHOG_HOST`                 | None                                                 | Absolute `http` or `https` URL                                     | The PostHog host that receives exception reports, which OTLP cannot carry into error tracking. With `MARFA_POSTHOG_PROJECT_TOKEN` it turns exception reports on; no OTLP setting is needed. It must be an `https` address, or an `http` address on this machine, with no user name or password; any other value turns off exception reports alone and the boot log says so.                                                                                                                                                         |
| `MARFA_POSTHOG_PROJECT_TOKEN`        | None                                                 | Text with no whitespace around it                                  | The PostHog project token for exception reports. It needs `MARFA_POSTHOG_HOST` set too; no OTLP setting is needed.                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

### `instance/files-private`

While the server runs, the server MUST keep its database, the database's log files and its blob folder readable and writable by its own account alone, whatever umask it started under.

**Reason:** the database holds every item and the owner's credentials, and the blob folder holds every file's bytes.

**Tests:** `compliance/hook-free-server.test.ts › keeps no file or folder in its data folder open to group or others, though it starts under umask 022`.

### `instance/files-tightened`

When the server starts and its own account owns its database, one of the database's log files or its blob folder, and another account could read or enter it, the server MUST make it private to its own account before it serves a request.

**Reason:** a file made by an earlier start, or by an operator, keeps its mode and access control list unless the server changes them.

**Tests:** `compliance/hook-free-server.test.ts › makes a database and blob folder it owns private when an earlier start left them open`, `› makes a database named by a file URI with an escaped path private when an earlier start left it open`.

### `instance/files-folder-kept`

When the server starts and the folder that holds its database already exists, the server MUST NOT change the mode or the access control list of that folder or of any file in it other than the database, the database's log files, the copies of the database the server makes before an upgrade, the server's secrets file and the file `<database file>.server-lock` the server keeps beside the database.

**Reason:** an operator may keep the database in a folder that holds other things, and only the server's own files are the server's to change.

**Tests:** `compliance/hook-free-server.test.ts › leaves a shared folder that holds its database, and the other files there, as they were`.

### `instance/files-link-refused`

If the server's database, one of the database's log files or its blob folder is a symbolic link when the server starts, however its path is written, then the server MUST refuse to start, name the path and leave what the link points to unchanged.

**Reason:** the server changes modes only on what it keeps, and a link can point anywhere.

**Tests:** `compliance/hook-free-server.test.ts › refuses to start on a blob folder that is a symbolic link, and leaves what it points to as it was`, `› refuses to start on a blob folder named through a symbolic link with a trailing slash, and leaves what it points to as it was`.

### `instance/files-blobs-owned`

If the server's blob folder exists when the server starts and another account owns it, then the server MUST refuse to start, name the folder and leave it unchanged.

**Reason:** the server writes the owner's files inside its blob folder, and only a folder of its own is one it can keep private.

**Tests:** `compliance/hook-free-server.test.ts › refuses to start on a blob folder another account owns, and leaves it as it was`.

### `instance/files-blobs-apart`

If the server's blob folder is the folder that holds its database, or a folder above it, when the server starts, then the server MUST refuse to start, name the blob folder and leave it unchanged.

**Reason:** the server makes its blob folder private, and the folder that holds the database, with the other files in it, is not the server's to change (`instance/files-folder-kept`).

**Tests:** `compliance/hook-free-server.test.ts › refuses a blob folder that is the folder holding its database, or one above it, and leaves that folder as it was`.

### `instance/files-memory-none`

While the server's database is held in memory, the server MUST NOT check, make or change a database file, its log files or a secrets file.

**Reason:** a database held in memory keeps nothing in a file, so no folder holds a database the server must guard, and the server keeps its secrets in memory too.

**Tests:** `compliance/hook-free-server.test.ts › starts with an in-memory database from a folder other accounts can add files to, and makes nothing there`.

### `instance/files-way-guarded`

If another account could replace or remove what a folder on the path to the server's database or blob folder holds when the server starts, because that account owns the folder, may write to it while it is not both owned by the system's administrator account and marked sticky, or owns a symbolic link on that path or may change or remove one through its access control list, then the server MUST refuse to start, name the folder or link and leave the database and the blob folder unchanged.

**Reason:** whoever can replace a folder on the way decides which files the server makes private and where it writes the owner's data.

**Tests:** `compliance/hook-free-server.test.ts › refuses to start when another account could write to a folder on the way to its blob folder, and leaves the blob folder as it was`, `› refuses to start through a symbolic link whose access control list lets another account remove it`.

### `instance/files-holder-shared`

If another account may add files to the folder that holds the server's database, or to the folder the server would make its blob folder in, when the server starts, then the server MUST refuse to start, name the folder and make no file in it.

**Reason:** a file another account made first under a name the server keeps would be the file the server then writes the owner's data in.

**Tests:** `compliance/hook-free-server.test.ts › refuses to start with its database in a folder other accounts can add files to, and makes nothing there`.

### `instance/files-reach-refused`

If the folder that holds the server's database, or the folder the server would make its blob folder in, passes access to another account on to the files made in it, through its access control list, when the server starts, then the server MUST refuse to start, name the folder and make no file in it.

**Reason:** a file made in such a folder takes the folder's entries whatever the umask, so another account could read the database or a blob before the server could close it.

**Tests:** `compliance/hook-free-server.test.ts › refuses to start in a database folder that passes access on to another account, and makes nothing there, not even its control socket's folder`, `› refuses to make its blob folder in a folder that passes access on to another account, and makes nothing there`.

### `instance/unknown-setting-warned`

When the server starts and the environment holds a variable whose name begins with `MARFA_` and names no setting of the server and none that the `marfa` command reads from a shell, the server MUST log one warning for each such variable, naming the variable and the closest setting when one is near, and containing no part of the variable's value.

**Reason:** a setting that was renamed or removed, or one spelled wrongly, would otherwise leave the owner on the default with no word of it. The server still starts, because the same variable can be a leftover that does no harm, and the warning is where the owner looks for it. A value is never logged, since a misnamed variable can hold a secret.

**Tests:** `compliance/hook-free-server.test.ts › warns once of each MARFA_ variable it does not read, names the setting it is near, and starts`.

### `instance/unknown-setting-no-ignored-name`

When the setting closest to an unknown variable is one that the server ignores because its test hooks are off, the server MUST NOT offer the name it ignores as the correction.

**Reason:** a variable that seeds a stored setting, or that runs a test hook, does nothing on a server without hooks, so the correction would lead the owner to another variable the server ignores. The warning names the stored setting instead, and the way to set it.

**Tests:** `compliance/hook-free-server.test.ts › warns once of each MARFA_ variable it does not read, names the setting it is near, and starts`.

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
