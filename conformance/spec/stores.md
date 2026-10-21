# Stores

Where a blob's bytes live, and the rules that keep them. A store is a place bytes live: the disk every upload lands on, and an object store attached beside it when one is configured. The referee boots its server with both, so every rule about the object store is asserted against one rather than left to a deployment nobody runs.

## The stores

### `stores/list`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/stores`, the server MUST answer `200` with every store, each with its `id`, `kind`, `locator`, `policy`, `attached_at` and `detached_at`.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the management key`, `› lists each store with the time it was first attached`.

### `stores/list-disk-always`

The server MUST list the disk store on every instance, whatever its settings.

**Tests:** `compliance/blob-store-folders.test.ts › records a new blob's one location as the disk store, unverified`, `compliance/blob-stores.test.ts › lists the disk store and the object store to the management key`.

### `stores/list-kind`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/stores`, the server MUST answer each store's `kind` as `disk` or `s3`.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the management key`.

### `stores/list-locator`

Where an object store is attached, when a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/stores`, the server MUST answer its `locator` as `s3://<bucket>/<prefix>` and nothing else.

**Reason:** the locator is one a person can read, and an exact match leaves no room for a credential in it.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the management key`.

### `stores/list-attached-at`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/stores`, the server MUST answer each store's `attached_at` as the time the store was first attached, the same on every listing.

**Tests:** `compliance/blob-stores.test.ts › lists each store with the time it was first attached`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/policy-all`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/stores`, the server MUST answer every store's `policy` as `all`, which wants every blob.

**Reason:** `all` is the one policy this build defines.

**Tests:** `compliance/blob-stores.test.ts › lists the disk store and the object store to the management key`.

### `stores/list-operator-only`

When a key or app token lacking `instance.read` sends `GET /blobs/stores`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/blob-stores.test.ts › refuses the listing to a working key`, `compliance/blob-store-settings.test.ts › is refused the management operations on the stores, the report and the jobs, and the copy stays`, `compliance/management-grants.test.ts › instance.read grants reports to keys and apps without granting maintenance`.

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

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/stores`, the server MUST answer `min_copies` as the instance's `MARFA_BLOB_MIN_COPIES`, which is 1 unless set.

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

When a caller authorized by `instance.maintain` or direct owner or local authority runs `blob-replicate`, the server MUST answer the run's `result` as `copied`, the number of blobs it placed, `bytes`, their total size, and `remaining`, the copies it left to make.

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

### `stores/replicate-no-answer`

If an attached store leaves unanswered for 15 seconds a question from a run of `blob-replicate` whether it holds a blob, or a read of a blob's bytes, then the server MUST answer the run with the copy it was making counted in `remaining`.

**Reason:** a store that hangs would otherwise hold the run, and every run after it, without end. A later run makes the copy once the store answers.

**Tests:** `compliance/blob-store-silent.test.ts › finishes, copies nothing, counts the copy in remaining, and makes it once the stores answer`.

### `stores/replicate-write-no-answer`

If an attached store leaves a write of a blob's bytes from a run of `blob-replicate` unfinished for 15 seconds and one more second for each 256 KiB of the blob, then the server MUST answer the run with the copy it was making counted in `remaining`.

**Reason:** a write that hangs would otherwise hold the run without end. The time allowed grows with the blob, so a large copy over a slow link is not taken for one that hangs.

**Tests:** `compliance/blob-store-silent.test.ts › finishes the run, counts the copy in remaining, skips the blob in later runs without waiting, and refuses an upload of its bytes`.

### `stores/replicate-skips-unfinished`

While an attached store has not finished a write or a deletion of a blob's bytes that the server stopped waiting for, the server MUST count the blob's copy in `remaining` on each run of `blob-replicate` without asking any store to write or delete the blob.

**Reason:** the store can still carry out the write or the deletion after the server stops waiting. A copy made meanwhile could be removed by the late deletion with the location log still naming it, and a run that waited on the store would hang as the first did.

**Tests:** `compliance/blob-store-silent.test.ts › leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends`, `› finishes the run, counts the copy in remaining, skips the blob in later runs without waiting, and refuses an upload of its bytes`.

### `stores/replicate-after-unfinished`

When an attached store finishes a write or a deletion of a blob's bytes that the server stopped waiting for, the server MUST make the copy the blob lacks on a later run of `blob-replicate`.

**Tests:** `compliance/blob-store-silent.test.ts › leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends`, `› finishes the run, counts the copy in remaining, skips the blob in later runs without waiting, and refuses an upload of its bytes`.

### `stores/upload-unfinished`

While an attached store has not finished a write or a deletion of a blob's bytes that the server stopped waiting for, the server MUST answer `POST /blobs` with those bytes with `503 blob_store_unavailable` and store nothing.

**Reason:** a late deletion could remove the bytes the upload would register, and waiting would hang the request on a store that may never answer. The caller still holds the bytes and can send them again.

**Tests:** `compliance/blob-store-silent.test.ts › leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends`, `› finishes the run, counts the copy in remaining, skips the blob in later runs without waiting, and refuses an upload of its bytes`, `› answers 503 blob_store_unavailable, and stores the bytes once the disk answers`.

## Minimum copies and dropping a copy

### `stores/drop-allowed`

When a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}` for a copy that an attached store holds, and at least `min_copies` live copies would remain, the server MUST answer `200`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `› answers the drop door's refusals in their order`.

### `stores/drop-removes-row`

When the server answers a drop with `200`, the server MUST remove the copy's row from the location log.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`.

### `stores/drop-removes-bytes`

When the server answers a drop with `200`, the server MUST remove the copy's bytes from its store.

**Tests:** `compliance/blob-rules.test.ts › removes a dropped copy's bytes from its store`.

### `stores/drop-below-minimum`

If a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}` and fewer than `min_copies` live copies would remain, then the server MUST answer `409 copies_below_minimum`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`.

### `stores/drop-below-minimum-keeps`

When the server refuses a drop with `409 copies_below_minimum`, the server MUST keep the copy's row in the log and its bytes in the store.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`.

### `stores/drop-below-minimum-details`

When the server answers a drop with `409 copies_below_minimum`, the server MUST name in `details` the `live` copies the blob holds and the `min_copies` it keeps.

**Tests:** `compliance/blob-store-settings.test.ts › reports the minimum beside the stores and refuses a drop that would leave fewer copies`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/drop-confirms-copies`

If a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}`, and fewer than `min_copies` of the other live copies are confirmed by their stores, each asked within 15 seconds, then the server MUST answer `409 copies_below_minimum`.

**Reason:** the location log can name a copy its store no longer holds, such as one that a store's late deletion removed after the server stopped waiting for it. A drop that trusted the log could remove the last copy that holds the bytes. A store that fails or does not answer confirms nothing.

**Tests:** `compliance/blob-rules.test.ts › refuses a drop the log allows when the other copy is gone from its store, and keeps the copy`.

### `stores/drop-no-copy`

If a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}` naming an attached store that holds no copy of the blob, then the server MUST answer `404 blob_location_not_found`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/drop-not-attached`

If a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}` naming a store that is not attached, an unknown id and a detached store among them, then the server MUST answer `404 blob_location_not_found`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-folders.test.ts › keeps one store through a folder that holds its marker, and detaches it for a fresh folder`.

### `stores/drop-operator-only`

If a key or app token lacking `blobs.manage` sends `DELETE /blobs/{hash}/locations/{store}`, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `› answers the drop door's refusals in their order`, `compliance/blob-store-settings.test.ts › is refused the management operations on the stores, the report and the jobs, and the copy stays`, `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`, `compliance/management-grants.test.ts › blobs.manage grants unreferenced bytes to keys and apps while preserving copy and restore boundaries`.

### `stores/drop-operator-refused-keeps`

When the server refuses a drop to a key or app token lacking `blobs.manage`, the server MUST keep the copy.

**Tests:** `compliance/blob-rules.test.ts › drops a copy while the minimum holds and refuses the drop that would break it`, `compliance/blob-store-settings.test.ts › is refused the management operations on the stores, the report and the jobs, and the copy stays`.

### `stores/drop-bare-hash`

When a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}` naming the blob by the 64 lowercase hexadecimal characters of its hash with no `sha256:`, the server MUST answer as it does for the same hash with the prefix.

**Tests:** `compliance/blob-rules.test.ts › answers the drop door's refusals in their order`.

### `stores/drop-order`

When `DELETE /blobs/{hash}/locations/{store}` meets more than one of the answers this chapter gives it, the server MUST give the first in this order: no credential, `401 unauthorized`; a key or app token lacking `blobs.manage`, `403 forbidden`; a malformed hash, `400 validation_error`; a hash no blob holds, `404 blob_not_found`; a store that has not finished a write or a deletion of the blob's bytes (`stores/drop-unfinished`), `503 blob_store_unavailable`; a store that is not attached or holds no copy, `404 blob_location_not_found`; fewer than `min_copies` live copies left, or fewer confirmed by their stores (`stores/drop-confirms-copies`), `409 copies_below_minimum`.

**Reason:** the location log is read before any store is asked, so a drop that the log alone refuses is answered without waiting on a store. A store's unfinished write or deletion comes before the log's answers because it can still change what the log says, so a store that is not attached is also answered `503` while one is out.

**Tests:** `compliance/blob-rules.test.ts › answers the drop door's refusals in their order`, `compliance/key-management.test.ts › refuses a key that may not use a door 403 before it reads the request`, `compliance/declared-refusals.test.ts › is refused 400 on the key and blob-location doors`, `compliance/blob-store-silent.test.ts › answers 503 blob_store_unavailable at once, keeps the copy, and drops it once the store answers`.

### `stores/drop-unfinished`

While an attached store has not finished a write or a deletion of a blob's bytes that the server stopped waiting for, if a caller authorized by `blobs.manage` or direct owner or local authority sends `DELETE /blobs/{hash}/locations/{store}` for that blob, then the server MUST answer `503 blob_store_unavailable` without changing any copy.

**Reason:** the late write or deletion can still change which copies the blob has, so neither the location log nor the stores can yet say whether enough copies would remain. Waiting would hang the request on a store that may never answer. The drop can be sent again once the store answers.

**Tests:** `compliance/blob-store-silent.test.ts › answers 503 blob_store_unavailable at once, keeps the copy, and drops it once the store answers`.

### `stores/drop-concurrent`

While drops of every copy of one blob are in flight together, the server MUST answer each with `200` or `409 copies_below_minimum` and leave at least `min_copies` copies.

**Tests:** `compliance/blob-rules.test.ts › never lets two concurrent drops take both copies`.

## Checking the copies

The `blob-integrity` housekeeping job checks the copies the log claims.

### `stores/integrity-result`

When a caller authorized by `instance.maintain` or direct owner or local authority runs `blob-integrity`, the server MUST answer the run's `result` as `verified`, the copies it found intact, `struck`, the copies it struck, `bytes`, the total size of the blobs whose copies it checked, counted once per copy whether it read the copy, asked the object store about it or found it missing, and `unreachable`, the attached stores it could not reach.

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

When a run of `blob-integrity` finds a copy altered, or missing from a store it can reach, the server MUST remove the copy from the location log.

**Reason:** a store that cannot be reached is not evidence that its copies are missing (`stores/integrity-unreachable-keeps`).

**Tests:** `compliance/blob-store-folders.test.ts › strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with no location`, `› still strikes a copy missing from a folder that is there`.

### `stores/integrity-unreachable-keeps`

When a run of `blob-integrity` cannot reach a store, such as a disk store whose folder or `.marfa-store` marker is missing, the server MUST leave every copy the location log names in that store as it was.

**Reason:** a store that cannot be reached is not evidence that its copies are missing. A folder that went away, a drive that did not mount and a mount point left empty each answer that every name is absent. Striking those copies would leave the blobs unreadable through the server after the store returns, with nothing to bring them back.

**Tests:** `compliance/blob-store-folders.test.ts › strikes nothing, answers 503 for the blob while no store can, and serves it again when the folder returns`, `› strikes nothing while an empty folder stands where the store was, as a mount point does without its drive`, `compliance/blob-store-silent.test.ts › finishes, counts each silent store as unreachable, strikes nothing, and checks the copies once the stores answer`.

### `stores/integrity-unreachable-reported`

When a run of `blob-integrity` cannot reach a store, the server MUST count the store in the run's `unreachable`.

**Tests:** `compliance/blob-store-folders.test.ts › strikes nothing, answers 503 for the blob while no store can, and serves it again when the folder returns`.

### `stores/integrity-unreachable-others`

When a run of `blob-integrity` cannot reach one store, the server MUST still check the copies in the stores it can reach.

**Reason:** the unreachable store's copies are never stamped, so they would otherwise stay first in the order and fill every run's `MARFA_BLOB_INTEGRITY_BATCH` copies.

**Tests:** `compliance/blob-store-bounds.test.ts › checks the copies of a store that can answer when another cannot be reached`.

### `stores/integrity-no-answer`

If an attached store leaves unanswered for 15 seconds a question from a run of `blob-integrity` whether it holds a blob, or a read of a blob's bytes, then the server MUST count the store in the run's `unreachable`.

**Reason:** a store that hangs is one the run cannot reach, so its copies are left as they were (`stores/integrity-unreachable-keeps`) and the run ends rather than waiting on it.

**Tests:** `compliance/blob-store-silent.test.ts › finishes, counts each silent store as unreachable, strikes nothing, and checks the copies once the stores answer`.

### `stores/integrity-delete-no-answer`

If an attached store leaves a deletion of a dropped or struck copy's bytes from a run of `blob-integrity` unfinished for 15 seconds, then the server MUST count the store in the run's `unreachable`.

**Reason:** the run finishes the deletions a drop or a strike left before it checks the copies, and removes the bytes of a copy it strikes. A store that hangs on one is a store the run cannot reach, so the run asks it nothing more. The deletion stays queued for a later run, and a struck copy stays struck.

**Tests:** `compliance/blob-store-silent.test.ts › leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends`, `› counts the store as unreachable, asks it nothing more in the run, and keeps the copy struck`.

### `stores/unreachable-read`

When `GET /blobs/{hash}` or a link the instance serves reads the bytes of a blob, and no store that holds a recorded copy of it can be reached or begins to answer the read within 15 seconds, the server MUST answer `503 blob_store_unavailable`.

**Reason:** a store that cannot answer says nothing of the bytes, so `404 blob_not_found` would claim they are gone.

**Tests:** `compliance/blob-store-folders.test.ts › strikes nothing, answers 503 for the blob while no store can, and serves it again when the folder returns`, `› strikes nothing while an empty folder stands where the store was, as a mount point does without its drive`, `compliance/blob-store-silent.test.ts › answers 503 blob_store_unavailable when no store opens the bytes, and serves them from a store that does`.

### `stores/read-no-answer`

If a store that holds a recorded copy of a blob does not begin to answer a read of the bytes for `GET /blobs/{hash}` or a link the instance serves within 15 seconds, then the server MUST read the bytes from another attached store that holds a recorded copy.

**Reason:** the bound is on the first byte, not the whole body, so a large blob read over a slow link is not cut off.

**Tests:** `compliance/blob-store-silent.test.ts › answers 503 blob_store_unavailable when no store opens the bytes, and serves them from a store that does`.

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

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/orphans`, the server MUST answer `200` with the report, each row carrying a `hash`, `mime_type`, `size_bytes` and `reported_at`.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`.

### `stores/orphan-enqueue-lifts`

When an `update_properties` job whose patch names a blob's digest is enqueued through `POST /items/bulk-actions`, the server MUST take the blob off the orphan report.

**Reason:** the job's patch is a reference while the job is queued or in progress (`stores/reference-job-patch`), so the report is lifted at once, as an upload's and a write's are.

**Tests:** `compliance/blob-store-jobs.test.ts › lifts the report when an update_properties job naming the digest is enqueued`.

### `stores/orphan-listing-order`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/orphans`, the server MUST list the report's rows oldest `reported_at` first.

**Tests:** `compliance/blob-store-settings.test.ts › lists the orphan report oldest first`.

### `stores/orphan-operator-only`

When a key or app token lacking `instance.read` sends `GET /blobs/orphans`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/blob-rules.test.ts › reports an unreferenced blob on one run and purges it on the next, never one an item names`, `compliance/blob-store-settings.test.ts › is refused the management operations on the stores, the report and the jobs, and the copy stays`, `compliance/management-grants.test.ts › instance.read grants reports to keys and apps without granting maintenance`.

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

When a caller authorized by `instance.maintain` or direct owner or local authority runs `blob-orphans`, the server MUST answer the run's `result` as `reported`, the size of the report after the run, and `purged`, the number of blobs it purged.

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

Where `MARFA_BLOB_CLEANUP_INTERVAL_MS` is 0, when a caller authorized by `instance.maintain` or direct owner or local authority asks to run `blob-orphans`, the server MUST answer `404 housekeeping_job_not_found`.

**Tests:** `compliance/blob-store-bounds.test.ts › leaves blob-orphans out of the listing and answers 404 for it when the sweep is switched off`.

### `stores/orphan-switched-off-report`

Where `MARFA_BLOB_CLEANUP_INTERVAL_MS` is 0 on an instance that has never run `blob-orphans`, when a caller authorized by `instance.read` or direct owner or local authority sends `GET /blobs/orphans`, the server MUST answer `200` with an empty report.

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

**Tests:** `compliance/blob-purge-faults.test.ts › keeps the blob when a write that names it commits after the run chose it and before the run purges it`, `› purges a blob that nothing names by the time the run reaches it, which is the witness for the case below`.

### `stores/orphan-purge-cut-short`

If a purge is cut short after the blob left the registry and before its bytes are gone from every store, then the server MUST finish removing the bytes on the next run of `blob-orphans`.

**Tests:** `compliance/blob-purge-faults.test.ts › finishes removing the bytes on the next run, and answers the run that was cut short ok`, `› does not take the bytes of a blob an upload has stored again since`.

### `stores/orphan-purge-no-dangling`

If a purge is cut short, then the server MUST NOT leave a blob that is listed or linked with its bytes gone.

**Reason:** the server removes what lists or links the bytes before the bytes, so a purge cut short leaves nothing that names bytes that are gone.

**Tests:** `compliance/blob-purge-faults.test.ts › leaves no blob listed or linked with its bytes gone, whether it is cut before the registry lets go or after`.

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

When a caller authorized by `blobs.manage` or direct owner or local authority drops a copy, the server MUST write an audit entry with `action` `blob.copy_dropped`, `resource_id` the blob's hash and `details` naming the `store_id`.

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

**Tests:** `compliance/blob-store-jobs.test.ts › keeps a blob the patch names as %s`.

### `stores/orphan-job-ended`

When an `update_properties` job ends `completed`, `canceled` or `failed`, the server MUST count none of its patch as a reference, so a blob nothing else references is reported afresh and a later run may purge it only after the grace.

**Tests:** `compliance/blob-store-jobs.test.ts › reports a blob afresh once the job whose patch named it ends`, `› reports a blob afresh once a queued job naming it is canceled`, `› reports a blob afresh once a queued job naming it fails`.

### `stores/job-patch-no-reach`

While a queued or in-progress `update_properties` job's patch names a blob's digest, the server MUST NOT serve the blob to a key or app token lacking `blobs.manage` that never held the bytes.

**Reason:** retention grants no read.

**Tests:** `compliance/blob-store-jobs.test.ts › serves the blob its patch names to no key that did not already hold the bytes`.

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

**Tests:** `compliance/blob-store-jobs.test.ts › keeps a blob the patch names as %s`.

### `stores/reference-job-inputs`

When a digest sits in the filter, the tags or another input of a queued or in-progress `update_properties` job and not in its patch, the server MUST NOT count it as a reference.

**Tests:** `compliance/blob-store-jobs.test.ts › does not count a digest in %s as a reference`.

## Keeping a copy's bytes removed

### `stores/cleanup-retried`

If a store cannot delete the bytes of a copy the server dropped, struck or purged, then the server MUST retry the deletion on a later run once the store can.

**Reason:** the copy left the location log when it was dropped, struck or purged, so only the retry removes bytes that nothing names.

**Tests:** `compliance/blob-cleanup-faults.test.ts › are deleted on a later run once the store can, when it could not delete them at the drop`.

### `stores/cleanup-isolated`

If a store keeps failing to delete the bytes of one copy, then the server MUST go on deleting the bytes of other copies, including after a restart.

**Reason:** a run deletes a bounded number of copies, so a copy that always fails would otherwise fill every run and leave the bytes of every copy behind it in place.

**Tests:** `compliance/blob-cleanup-faults.test.ts › are deleted by the runs that follow, each run taking one copy, including after a restart`.
