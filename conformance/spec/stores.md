# Stores

Where a blob's bytes live, and the rules that keep them. A store is a place bytes live: the disk every upload lands on, and an object store attached beside it when one is configured. The referee boots its server with both, so every rule about the object store is asserted against one rather than left to a deployment nobody runs.

## The stores

### `stores/list`

When the operator key sends `GET /blobs/stores`, the server MUST answer `200` with every store, each with its `id`, `kind`, `locator`, `policy`, `attached_at` and `detached_at`.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`, `› lists each store with the time it was first attached`.

### `stores/list-disk-always`

The server MUST list the disk store on every instance, whatever its settings.

**Tests:** `compliance/blob-store-folders.test.ts › records a new blob's one location as the disk store, unverified`, `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`.

### `stores/list-kind`

When the operator key sends `GET /blobs/stores`, the server MUST answer each store's `kind` as `disk` or `s3`.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`.

### `stores/list-locator`

Where an object store is attached, when the operator key sends `GET /blobs/stores`, the server MUST answer its `locator` as `s3://<bucket>/<prefix>` and nothing else.

**Reason:** the locator is one a person can read, and an exact match leaves no room for a credential in it.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`.

### `stores/list-attached-at`

When the operator key sends `GET /blobs/stores`, the server MUST answer each store's `attached_at` as the time the store was first attached, the same on every listing.

**Tests:** `compliance/blob-stores.test.ts › lists each store with the time it was first attached`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/policy-all`

When the operator key sends `GET /blobs/stores`, the server MUST answer every store's `policy` as `all`, which wants every blob.

**Reason:** `all` is the one policy this build defines.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`.

### `stores/list-operator-only`

When a credential other than the operator key sends `GET /blobs/stores`, the server MUST answer `403 forbidden`, whether it is a working key or an app's access token.

**Tests:** `compliance/blob-stores.test.ts › refuses the listing to a working key`, `compliance/blob-store-settings.test.ts › is refused the operator's operations on the stores, the report and the jobs, and the copy stays`.

### `stores/folder-keeps-store`

When the server starts over a disk folder that holds the marker of a store, the server MUST list that store as still attached, with the copies the location log names for it.

**Reason:** a store's identity is read from a marker the store holds, not from the configuration that named it.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/fresh-folder-fresh-store`

When the server starts over a disk folder that holds no marker, the server MUST list a new store and claim no copies in it.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/detached-listed`

When the configuration no longer names a store, the server MUST go on listing it with `detached_at` set to the time it was found detached.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/detached-row`

While a copy sits in a store the configuration no longer names, the server MUST answer its location row with `detached` true.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/detached-not-checked`

While a copy sits in a store the configuration no longer names, the server MUST leave it out of the `blob-integrity` check.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/detached-not-missing`

While a copy sits in a store the configuration no longer names, the server MUST NOT count the blob as missing from the stores that are attached.

**Reason:** the copy stops counting, so `blob-replicate` has nothing to copy for it.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/detached-not-live`

While a copy sits in a store the configuration no longer names, the server MUST NOT count it among the live copies a drop keeps at `min_copies`.

**Tests:** `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/min-copies-reported`

When the operator key sends `GET /blobs/stores`, the server MUST answer `min_copies` as the instance's `MARFA_BLOB_MIN_COPIES`, which is 1 unless set.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`.

## The location log

The location log records which stores hold which blob.

### `stores/locations-listed`

When a credential that may read a blob sends `GET /blobs/{hash}/locations`, the server MUST answer `200` with a row for each copy the log holds, each naming its `store_id`, `kind` and `policy`, and carrying `detached`, `recorded_at` and `verified_at`.

**Reason:** which credentials may read a blob is `blobs/read-no-type`, `blobs/read-unreadable` and the rules about lending.

**Tests:** `compliance/blob-stores.test.ts › records a new blob's location as the disk store`, `compliance/blob-store-folders.test.ts › records a new blob's one location as the disk store, unverified`, `compliance/blob-rules.test.ts › replicates every blob to the object store and records the copies, and the link becomes the store's own`.

### `stores/locations-oldest-first`

When a credential that may read a blob sends `GET /blobs/{hash}/locations`, the server MUST answer its rows with the oldest `recorded_at` first.

**Tests:** `compliance/blob-rules.test.ts › replicates an upload on its own, each copy with its own recorded time`.

### `stores/upload-locates-disk`

When a credential that may upload sends `POST /blobs` and the server answers `201`, the server MUST list the disk store among the blob's locations, whether or not the server already held the bytes.

**Tests:** `compliance/blob-stores.test.ts › records a new blob's location as the disk store`, `compliance/blob-store-folders.test.ts › records a new blob's one location as the disk store, unverified`, `› keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/upload-one-location`

Where only the disk store is attached, when a credential that may upload sends `POST /blobs` with bytes the server does not yet hold, the server MUST record that one location and no other.

**Reason:** with an object store attached, an upload wakes replication, so a second location soon follows.

**Tests:** `compliance/blob-store-folders.test.ts › records a new blob's one location as the disk store, unverified`.

### `stores/location-unverified`

When the server records a copy that no check has yet found, the server MUST answer its `verified_at` as null.

**Tests:** `compliance/blob-store-folders.test.ts › records a new blob's one location as the disk store, unverified`.

### `stores/location-recorded-at`

When the server records a copy of a blob, the server MUST answer its `recorded_at` as the time it recorded that copy, so each store's copy has a time of its own.

**Tests:** `compliance/blob-rules.test.ts › replicates an upload on its own, each copy with its own recorded time`, `› replicates every blob to the object store and records the copies, and the link becomes the store's own`.

### `stores/reupload-keeps-times`

When a credential that may upload sends `POST /blobs` with bytes whose copy the log already holds, the server MUST keep that copy's `recorded_at` and `verified_at`.

**Tests:** `compliance/blob-store-folders.test.ts › keeps a copy's recorded and verified times when the same bytes are uploaded again`.

### `stores/no-location`

While the log holds no copy of a blob, the server MUST answer `GET /blobs/{hash}/locations` for it with `200` and no rows.

**Tests:** `compliance/blob-store-folders.test.ts › strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`.

### `stores/no-bytes-not-found`

While the location log records no copy of a registered blob in an attached store, the server MUST answer `GET /blobs/{hash}` and `HEAD /blobs/{hash}` for it, with no `Range` or with one the blob's size satisfies, with `404 blob_not_found`.

**Reason:** the bytes of a copy struck or dropped can stay in their store until a later run deletes them, and they are not the blob's.

**Tests:** `compliance/blob-store-folders.test.ts › strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`, `› answers HEAD as GET does for a blob that lost its last copy`.

## Links

A link to a blob's bytes names the instance or the object store as its host, and the lifetime and the signature are `blobs.md`'s.

### `stores/link-instance-until-stored`

While no attached object store holds a blob, the server MUST answer `GET /blobs/{hash}/url` with a `url` whose host is the instance's configured address and that serves the bytes byte-identical with no credential.

**Tests:** `compliance/blob-rules.test.ts › replicates every blob to the object store and records the copies, and the link becomes the store's own`, `compliance/blob-served.test.ts › refuses an instance link whose signature was altered with 401`.

### `stores/link-store-once-held`

Where an attached object store holds a blob, the server MUST answer `GET /blobs/{hash}/url` with a `url` whose host is the store's rather than the instance's and that serves the bytes byte-identical with no credential.

**Reason:** a link is made by the store that holds the bytes, so the bytes do not pass through the instance.

**Tests:** `compliance/blob-rules.test.ts › replicates every blob to the object store and records the copies, and the link becomes the store's own`, `› answers a dead store link with the store's own status, not the instance's`.

## Replication

The `blob-replicate` housekeeping job gives every attached store every blob, because every store's policy is `all`. The fixtures drive the housekeeping jobs through `POST /housekeeping/{name}/run` (`housekeeping/run-now`), so each rule is about a run rather than about a clock.

### `stores/replicate-every-store`

When `blob-replicate` has run to `remaining: 0`, the server MUST list a location for every attached store in the locations of each blob.

**Tests:** `compliance/blob-rules.test.ts › replicates every blob to the object store and records the copies, and the link becomes the store's own`, `› drops a copy while the minimum holds and refuses the drop that would break it`.

### `stores/replicate-from-any-store`

When a run of `blob-replicate` finds a blob that an attached store lacks and another attached store holds, the server MUST copy it from the store that holds it, whichever of the disk and the object store that is.

**Tests:** `compliance/blob-rules.test.ts › replicates every blob to the object store and records the copies, and the link becomes the store's own`, `› stamps a good copy and strikes a corrupt one, which replication then restores`, `› removes a dropped copy's bytes from its store`.

### `stores/replicate-verifies`

When a run of `blob-replicate` copies bytes that do not hash to the blob's name, the server MUST NOT record a location for the receiving store.

**Reason:** the receiving store hashes the bytes it is sent before it names them, so a corrupt copy in one store does not spread to another.

**Tests:** `compliance/blob-store-bounds.test.ts › records no copy for bytes that do not hash to the blob's name`.

### `stores/replicate-result`

When the operator key runs `blob-replicate`, the server MUST answer the run's `result` as `copied`, the number of blobs it placed, `bytes`, their total size, and `remaining`, the copies it left to make.

**Tests:** `compliance/blob-store-bounds.test.ts › copies at most the batch, answers what it did, and runs again on its own for the rest`, `› copies a blob larger than the bound when it is the run's first, and nothing more`, `› stops before the blob that would push the copied bytes past the bound`.

### `stores/replicate-count-bound`

When a run of `blob-replicate` has blobs to copy, the server MUST copy at most `MARFA_BLOB_REPLICATE_BATCH` of them.

**Tests:** `compliance/blob-store-bounds.test.ts › copies at most the batch, answers what it did, and runs again on its own for the rest`.

### `stores/replicate-byte-bound`

When a run of `blob-replicate` has copied a blob, the server MUST NOT copy another blob in that run whose size would push the bytes it copied past `MARFA_BLOB_REPLICATE_BATCH_BYTES`.

**Tests:** `compliance/blob-store-bounds.test.ts › stops before the blob that would push the copied bytes past the bound`.

### `stores/replicate-first-blob`

When a run of `blob-replicate` has a blob larger than `MARFA_BLOB_REPLICATE_BATCH_BYTES` to copy as its first, the server MUST copy it and no more.

**Tests:** `compliance/blob-store-bounds.test.ts › copies a blob larger than the bound when it is the run's first, and nothing more`.

### `stores/replicate-wakes-again`

When a run of `blob-replicate` copies at least one blob and leaves some it could not finish, the server MUST run it again without a request and without waiting for its interval.

**Tests:** `compliance/blob-store-bounds.test.ts › copies at most the batch, answers what it did, and runs again on its own for the rest`.

### `stores/replicate-upload-wakes`

When a credential that may upload sends `POST /blobs` and the server answers `201`, the server MUST replicate the blob to the other attached stores without a request and without waiting for the job's interval.

**Tests:** `compliance/blob-rules.test.ts › replicates an upload on its own, each copy with its own recorded time`.

### `stores/replicate-undoes-drop`

When a copy has been dropped through `DELETE /blobs/{hash}/locations/{store}`, the server MUST copy the blob back to that store on the next run of `blob-replicate`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `› removes a dropped copy's bytes from its store`.

## Minimum copies and dropping a copy

### `stores/drop-allowed`

When the operator key sends `DELETE /blobs/{hash}/locations/{store}` for a copy that an attached store holds, and at least `min_copies` live copies would remain, the server MUST answer `200`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `› answers the drop door's refusals in their order`.

### `stores/drop-removes-row`

When the server answers a drop with `200`, the server MUST remove the copy's row from the location log.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`.

### `stores/drop-removes-bytes`

When the server answers a drop with `200`, the server MUST remove the copy's bytes from its store.

**Tests:** `compliance/blob-rules.test.ts › removes a dropped copy's bytes from its store`.

### `stores/drop-below-minimum`

If the operator key sends `DELETE /blobs/{hash}/locations/{store}` and fewer than `min_copies` live copies would remain, then the server MUST answer `409 copies_below_minimum`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`.

### `stores/drop-below-minimum-keeps`

When the server refuses a drop with `409 copies_below_minimum`, the server MUST keep the copy's row in the log and its bytes in the store.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`.

### `stores/drop-below-minimum-details`

When the server answers a drop with `409 copies_below_minimum`, the server MUST name in `details` the `live` copies the blob holds and the `min_copies` it keeps.

**Tests:** `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/drop-no-copy`

If the operator key sends `DELETE /blobs/{hash}/locations/{store}` naming an attached store that holds no copy of the blob, then the server MUST answer `404 blob_location_not_found`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/drop-not-attached`

If the operator key sends `DELETE /blobs/{hash}/locations/{store}` naming a store that is not attached, an unknown id and a detached store among them, then the server MUST answer `404 blob_location_not_found`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/drop-operator-only`

If a credential other than the operator key sends `DELETE /blobs/{hash}/locations/{store}`, whether it is a working key or an app's access token, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `› answers the drop door's refusals in their order`, `compliance/blob-store-settings.test.ts › is refused the operator's operations on the stores, the report and the jobs, and the copy stays`, `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`.

### `stores/drop-operator-refused-keeps`

When the server refuses a drop to a credential other than the operator key, the server MUST keep the copy.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › is refused the operator's operations on the stores, the report and the jobs, and the copy stays`.

### `stores/drop-bare-hash`

When the operator key sends `DELETE /blobs/{hash}/locations/{store}` naming the blob by the 64 lowercase hexadecimal characters of its hash with no `sha256:`, the server MUST answer as it does for the same hash with the prefix.

**Tests:** `compliance/blob-rules.test.ts › answers the drop door's refusals in their order`.

### `stores/drop-order`

When `DELETE /blobs/{hash}/locations/{store}` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: no credential, `401 unauthorized`; a credential other than the operator key, `403 forbidden`; a malformed hash, `400 validation_error`; a hash no blob holds, `404 blob_not_found`; a store that is not attached or holds no copy, `404 blob_location_not_found`; fewer than `min_copies` live copies left, `409 copies_below_minimum`.

**Tests:** `compliance/blob-rules.test.ts › answers the drop door's refusals in their order`, `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`, `compliance/declared-refusals.test.ts › is refused 400 on the key and blob-location doors`.

### `stores/drop-concurrent`

While drops of every copy of one blob are in flight together, the server MUST answer each with `200` or `409 copies_below_minimum` and leave at least `min_copies` copies.

**Tests:** `compliance/blob-rules.test.ts › never lets two concurrent drops take both copies`.

## Checking the copies

The `blob-integrity` housekeeping job checks the copies the log claims.

### `stores/integrity-result`

When the operator key runs `blob-integrity`, the server MUST answer the run's `result` as `verified`, the copies it found intact, `struck`, the copies it struck, and `bytes`, the total size of the blobs whose copies it checked, counted once per copy whether it read the copy, asked the object store about it or found it missing.

**Tests:** `compliance/blob-store-folders.test.ts › stamps each intact copy with the time of the check, and moves the stamp on the next check`, `› strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`.

### `stores/integrity-stamps`

When a run of `blob-integrity` finds a copy present and intact, the server MUST set that copy's `verified_at` to the time of the check, and move it on the next check.

**Tests:** `compliance/blob-store-folders.test.ts › stamps each intact copy with the time of the check, and moves the stamp on the next check`, `compliance/blob-rules.test.ts › stamps a good copy and strikes a corrupt one, which replication then restores`.

### `stores/integrity-rehashes-disk`

When a run of `blob-integrity` checks a disk copy whose bytes are as long as the blob but do not hash to the blob's name, the server MUST strike the copy.

**Tests:** `compliance/blob-store-folders.test.ts › strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`, `compliance/blob-rules.test.ts › stamps a good copy and strikes a corrupt one, which replication then restores`.

### `stores/integrity-asks-object-store`

When a run of `blob-integrity` checks an object-store copy whose object is missing or not as long as the blob, the server MUST strike the copy.

**Reason:** the check asks the store for the object's size and fetches no bytes, so an object altered at the same length is not found.

**Tests:** `compliance/blob-store-bounds.test.ts › strikes an object-store copy that is missing or not as long as the blob`.

### `stores/integrity-strikes`

When a run of `blob-integrity` finds a copy missing or altered, the server MUST remove the copy from the location log.

**Tests:** `compliance/blob-store-folders.test.ts › strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`.

### `stores/integrity-strike-restored`

When a run of `blob-integrity` has struck a copy of a blob that another attached store holds, the server MUST copy the blob back to the struck store on the next run of `blob-replicate`.

**Tests:** `compliance/blob-rules.test.ts › stamps a good copy and strikes a corrupt one, which replication then restores`.

### `stores/integrity-order`

When a run of `blob-integrity` takes copies to check, the server MUST take first the copies never checked and then the least recently checked, breaking ties by hash and then by store id, across every store rather than one store after another.

**Tests:** `compliance/blob-store-bounds.test.ts › checks no more copies than the batch in one run, least recently checked first and across the stores`.

### `stores/integrity-count-bound`

When a run of `blob-integrity` has copies to check, the server MUST check at most `MARFA_BLOB_INTEGRITY_BATCH` of them.

**Tests:** `compliance/blob-store-bounds.test.ts › checks no more copies than the batch in one run, least recently checked first and across the stores`.

### `stores/integrity-byte-bound`

When a run of `blob-integrity` has copies to check, the server MUST stop before the copy whose blob's size would push the run's `bytes` past `MARFA_BLOB_INTEGRITY_BATCH_BYTES`.

**Tests:** `compliance/blob-store-bounds.test.ts › stops before the copy that would push the bytes read past the bound`.

### `stores/integrity-first-copy`

When a run of `blob-integrity` has a copy larger than `MARFA_BLOB_INTEGRITY_BATCH_BYTES` to check as its first, the server MUST check it and no more.

**Tests:** `compliance/blob-store-bounds.test.ts › checks a copy larger than the bound when it is the run's first, and nothing more`.

## The orphan report and the purge

The `blob-orphans` housekeeping job reports before it deletes. The referee boots its server with the grace at zero, so the run after a report purges.

### `stores/orphan-listing`

When the operator key sends `GET /blobs/orphans`, the server MUST answer `200` with the report, each row carrying a `hash`, `mime_type`, `size_bytes` and `reported_at`.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`.

### `stores/orphan-enqueue-lifts`

When an `update_properties` job whose patch names a blob's digest is enqueued through `POST /items/bulk-actions`, the server MUST take the blob off the orphan report.

**Reason:** the job's patch is a reference while the job is queued or in progress (`stores/reference-job-patch`), so the report is lifted at once, as an upload's and a write's are.

**Tests:** `compliance/blob-store-jobs.test.ts › lifts the report when an update_properties job naming the digest is enqueued`.

### `stores/orphan-listing-order`

When the operator key sends `GET /blobs/orphans`, the server MUST list the report's rows oldest `reported_at` first.

**Tests:** `compliance/blob-store-settings.test.ts › lists the orphan report oldest first`.

### `stores/orphan-operator-only`

When a credential other than the operator key sends `GET /blobs/orphans`, the server MUST answer `403 forbidden`, whether it is a working key or an app's access token.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `compliance/blob-store-settings.test.ts › is refused the operator's operations on the stores, the report and the jobs, and the copy stays`.

### `stores/orphan-reports`

When a run of `blob-orphans` finds a blob that nothing references, the server MUST add it to the report.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `› keeps a blob that only an item in the bin, an archived item, an extension or an earlier version names`.

### `stores/orphan-reported-at`

When a run of `blob-orphans` adds a blob to the report, the server MUST record `reported_at` as the time of that run.

**Tests:** `compliance/blob-rules.test.ts › records when a run first reported a blob`.

### `stores/orphan-reported-at-kept`

When a run of `blob-orphans` finds a blob that the report already names and that is still unreferenced, the server MUST NOT change its `reported_at`.

**Tests:** `compliance/blob-store-settings.test.ts › leaves a report's first time alone and purges only once the report is older than the grace`.

### `stores/orphan-result`

When the operator key runs `blob-orphans`, the server MUST answer the run's `result` as `reported`, the size of the report after the run, and `purged`, the number of blobs it purged.

**Tests:** `compliance/blob-store-settings.test.ts › leaves a report's first time alone and purges only once the report is older than the grace`, `compliance/blob-rules.test.ts › records when a run first reported a blob`.

### `stores/orphan-forgets`

When a blob in the report is referenced again before a run purges it, the server MUST take it out of the report.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `› lifts the report on a reference added and removed between runs`.

### `stores/orphan-keeps-referenced`

When a run of `blob-orphans` finds a blob that something references, the server MUST NOT purge it, whatever an earlier run reported.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`.

### `stores/orphan-purges-after-grace`

When a run of `blob-orphans` finds a blob reported by an earlier run longer ago than `MARFA_BLOB_CLEANUP_GRACE_MS` and still unreferenced, the server MUST purge it.

**Reason:** a report made by the run itself, or exactly that old, waits for the next run.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `compliance/blob-store-settings.test.ts › leaves a report's first time alone and purges only once the report is older than the grace`.

### `stores/orphan-keeps-within-grace`

While a blob's report is not older than `MARFA_BLOB_CLEANUP_GRACE_MS`, the server MUST NOT purge it.

**Tests:** `compliance/blob-store-settings.test.ts › leaves a report's first time alone and purges only once the report is older than the grace`, `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`.

### `stores/orphan-purge-not-found`

When a run of `blob-orphans` purges a blob, the server MUST answer the blob's reads with `404 blob_not_found`.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `› answers a link to a blob the sweep has purged as an unknown blob`, `compliance/blob-store-settings.test.ts › leaves a report's first time alone and purges only once the report is older than the grace`.

### `stores/orphan-purge-unreports`

When a run of `blob-orphans` purges a blob, the server MUST take it off the report.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `compliance/blob-store-settings.test.ts › leaves a report's first time alone and purges only once the report is older than the grace`.

### `stores/orphan-purge-bytes`

When a run of `blob-orphans` purges a blob, the server MUST remove its bytes from every attached store.

**Tests:** `compliance/blob-rules.test.ts › removes a purged blob's bytes from every store`.

### `stores/orphan-switched-off-unlisted`

Where `MARFA_BLOB_CLEANUP_INTERVAL_MS` is 0, the server MUST leave `blob-orphans` out of the housekeeping listing.

**Tests:** `compliance/blob-store-bounds.test.ts › leaves blob-orphans out of the listing and answers 404 for it when the sweep is switched off`.

### `stores/orphan-switched-off-not-run`

Where `MARFA_BLOB_CLEANUP_INTERVAL_MS` is 0, when the operator key asks to run `blob-orphans`, the server MUST answer `404 housekeeping_job_not_found`.

**Tests:** `compliance/blob-store-bounds.test.ts › leaves blob-orphans out of the listing and answers 404 for it when the sweep is switched off`.

### `stores/orphan-switched-off-report`

Where `MARFA_BLOB_CLEANUP_INTERVAL_MS` is 0 on an instance that has never run `blob-orphans`, when the operator key sends `GET /blobs/orphans`, the server MUST answer `200` with an empty report.

**Tests:** `compliance/blob-store-bounds.test.ts › leaves blob-orphans out of the listing and answers 404 for it when the sweep is switched off`.

### `stores/orphan-upload-lifts`

When a credential that may upload sends `POST /blobs` with bytes the orphan report names, the server MUST take the blob off `GET /blobs/orphans`.

**Reason:** bytes an upload was just told are stored are never the ones the sweep deletes, so the run that would have purged the earlier report reports them afresh and keeps them, and purges them only once the grace has passed since a report made after the upload.

**Tests:** `compliance/blob-rules.test.ts › lifts the report on an upload of the same bytes, so the next run keeps them`.

### `stores/orphan-reference-lifts`

When a write adds a reference to a blob the orphan report names, the server MUST take the blob off `GET /blobs/orphans` before any further run.

**Tests:** `compliance/blob-rules.test.ts › lifts the report on a reference added and removed between runs`.

### `stores/orphan-reference-removed`

When a write removes the last reference to a blob that an earlier report named, the server MUST purge the blob only once the grace has passed since a report made after the write.

**Tests:** `compliance/blob-rules.test.ts › lifts the report on a reference added and removed between runs`.

### `stores/orphan-upload-race`

While an upload of a blob the orphan report names is in flight with a run of `blob-orphans`, the server MUST answer the upload `201` and keep its bytes readable afterwards.

**Reason:** either order is allowed. The upload lands first and the run keeps the bytes, or the run purges them and the upload stores them again.

**Tests:** `compliance/blob-rules.test.ts › keeps the bytes of an upload that races the run that would purge them`.

### `stores/orphan-reference-race`

While a run of `blob-orphans` is under way, if a write that names a blob the run found unreferenced commits before the run purges the blob, then the server MUST keep the blob.

**Reason:** the run decides each purge again at the moment it purges, so a reference written after the run's walk still counts. A write that commits after the purge names bytes that are gone.

**Tests:** waiting on #1444.

### `stores/orphan-purge-cut-short`

If a purge is cut short after the blob left the registry and before its bytes are gone from every store, then the server MUST finish removing the bytes on the next run of `blob-orphans`.

**Tests:** waiting on #1444.

### `stores/orphan-purge-no-dangling`

If a purge is cut short, then the server MUST NOT leave a blob that is listed or linked with its bytes gone.

**Reason:** the server removes what lists or links the bytes before the bytes, so a purge cut short leaves nothing that names bytes that are gone.

**Tests:** waiting on #1444.

### `stores/orphan-restore-keeps`

While `POST /restore` of an archive that carries a blob the orphan report names is in flight with a run of `blob-orphans`, if the restore answers `200`, then the server MUST serve the blob's bytes once both have finished.

**Reason:** either order is allowed. The restore lands first and takes the blob off the report, or the run purges the blob and the restore stores its bytes again.

**Tests:** `compliance/blob-rules.test.ts › keeps the bytes a restore stores while a purge of them races it`.

## The audit log

### `stores/audit-strike`

When a run of `blob-integrity` strikes a copy, the server MUST write an audit entry with `action` `blob.copy_struck`, `resource_id` the blob's hash and `details` naming the `store_id` and the store's `kind`.

**Tests:** `compliance/blob-rules.test.ts › stamps a good copy and strikes a corrupt one, which replication then restores`, `compliance/blob-store-folders.test.ts › strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`, `compliance/blob-store-bounds.test.ts › strikes an object-store copy that is missing or not as long as the blob`.

### `stores/audit-replicate`

When a run of `blob-replicate` records a copy, the server MUST write an audit entry with `action` `blob.copy_replicated`, `resource_id` the blob's hash and `details` naming the store copied `from` and the receiving `store_id`.

**Tests:** `compliance/blob-rules.test.ts › records a drop, a replication and a purge in the audit log`.

### `stores/audit-drop`

When the operator key drops a copy, the server MUST write an audit entry with `action` `blob.copy_dropped`, `resource_id` the blob's hash and `details` naming the `store_id`.

**Tests:** `compliance/blob-rules.test.ts › records a drop, a replication and a purge in the audit log`.

### `stores/audit-purge`

When a run of `blob-orphans` purges a blob, the server MUST write an audit entry with `action` `blob.purge` and `resource_id` the blob's hash.

**Tests:** `compliance/blob-rules.test.ts › records a drop, a replication and a purge in the audit log`.

## What a run of the sweep keeps

### `stores/orphan-keeps-items`

When a run of `blob-orphans` finds a blob that an item in any lifecycle state references, the server MUST keep it.

**Tests:** `compliance/blob-rules.test.ts › keeps a blob that only an item in the bin, an archived item, an extension or an earlier version names`, `› keeps a blob a note links in its body after the file item naming it is purged`.

### `stores/orphan-keeps-extensions`

When a run of `blob-orphans` finds a blob that a metadata extension references, the server MUST keep it.

**Tests:** `compliance/blob-rules.test.ts › keeps a blob that only an item in the bin, an archived item, an extension or an earlier version names`.

### `stores/orphan-keeps-edges`

When a run of `blob-orphans` finds a blob that an edge's properties reference, as a whole value or inside text, the server MUST keep it.

**Tests:** `compliance/blob-rules.test.ts › keeps a blob named only in an edge's properties`.

### `stores/orphan-keeps-versions`

When a run of `blob-orphans` finds a blob that only an earlier version of an item references, the server MUST keep it.

**Tests:** `compliance/blob-rules.test.ts › keeps a blob only an earlier version of an item names, and purges one nothing names`, `› keeps a blob that only an item in the bin, an archived item, an extension or an earlier version names`.

### `stores/orphan-keeps-job-patch`

While a queued or in-progress `update_properties` job's patch holds a blob's digest, the server MUST keep the blob.

**Reason:** enqueueing such a job takes the blob off the report at once, and a run that was already walking the corpus cannot start or keep a report for it.

**Tests:** waiting on #1444.

### `stores/orphan-job-ended`

When an `update_properties` job ends `completed`, `canceled` or `failed`, the server MUST count none of its patch as a reference, so a blob nothing else references is reported afresh and a later run may purge it only after the grace.

**Tests:** `compliance/blob-store-jobs.test.ts › reports a blob afresh once the job whose patch named it ends`, `› reports a blob afresh once a queued job naming it is canceled`, `› reports a blob afresh once a queued job naming it fails`.

### `stores/job-patch-no-reach`

While a queued or in-progress `update_properties` job's patch names a blob's digest, the server MUST NOT serve the blob to a working key or an app's access token that never held the bytes.

**Reason:** retention grants no read.

**Tests:** waiting on #1444.

### `stores/job-patch-unknown-digest`

When a queued or in-progress `update_properties` job's patch names a digest no blob holds, the server MUST NOT fail the job for it.

**Tests:** `compliance/blob-store-jobs.test.ts › completes a job whose patch names a digest no blob holds`.

## What counts as a reference

### `stores/reference-digest-anywhere`

When a string in an item in any lifecycle state, a metadata extension, an edge's properties or a version snapshot holds a run of exactly 64 lowercase hexadecimal characters with no further lowercase hexadecimal character after it, and either no lowercase hexadecimal character before it or the escape `%3a` straight before it, the server MUST count the run as a reference to the blob `sha256:` and that run.

**Reason:** so a whole value, a `sha256:` link inside text such as a Markdown body, a URL-encoded one in capitals or in lowercase (`sha256%3A…`, `sha256%3a…`), an escaped one and the bare hex that `GET /blobs/{hash}` also serves are all references, whatever else stands beside the run.

**Tests:** `compliance/blob-rules.test.ts › counts a digest as a reference by its run of lowercase hex, whatever form it is written in`, `› keeps a blob a note links in its body after the file item naming it is purged`, `› keeps a blob named only in an edge's properties`.

### `stores/reference-run-exact`

When a string holds a run of lowercase hexadecimal characters that is 63 characters long, or 65, the server MUST NOT count it as a reference to a blob.

**Tests:** `compliance/blob-rules.test.ts › counts a digest as a reference by its run of lowercase hex, whatever form it is written in`.

### `stores/reference-job-patch`

When a queued or in-progress `update_properties` job's patch holds a string with a digest at any depth, the server MUST count it as a reference.

**Tests:** waiting on #1444.

### `stores/reference-job-inputs`

When a digest sits in the filter, the tags or another input of a queued or in-progress `update_properties` job and not in its patch, the server MUST NOT count it as a reference.

**Tests:** waiting on #1444.

## Keeping a copy's bytes removed

### `stores/cleanup-retried`

If a store cannot delete the bytes of a copy the server dropped, struck or purged, then the server MUST retry the deletion on a later run once the store can.

**Reason:** the copy left the location log when it was dropped, struck or purged, so only the retry removes bytes that nothing names.

**Tests:** waiting on #1444.

### `stores/cleanup-isolated`

If a store keeps failing to delete the bytes of one copy, then the server MUST go on deleting the bytes of other copies, including after a restart.

**Reason:** a run deletes a bounded number of copies, so a copy that always fails would otherwise fill every run and leave the bytes of every copy behind it in place.

**Tests:** waiting on #1444.
