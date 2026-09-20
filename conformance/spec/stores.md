# Stores

Where a blob's bytes live, and the rules that keep them. A store is a place bytes live: the disk every upload lands on, and an object store attached beside it when one is configured. The referee boots its server with both, so every statement about the object store is asserted against one rather than left to a deployment nobody runs.

## The stores and the log

1. An instance keeps bytes in a disk store and, when one is configured, an object store. `GET /blobs/stores` lists them to the operator key, each with an `id`, a `kind` of `disk` or `s3`, a `locator` a person can read that carries no credential, a `policy`, and `attached_at`; a working key is refused `403 forbidden`. `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`, `› refuses the listing to a working key`.
2. Every store's policy is `all`, the one policy this build defines: the store wants every blob. The set is open, and the presets a store that wants less will need are named by the first such store. `compliance/blob-stores.test.ts › lists the disk store and the object store to the operator key`.
3. The location log records which stores hold which blob. `GET /blobs/{hash}/locations` answers it for one blob: each row names a store, whether it is `detached`, when the copy was `recorded_at` and when a check last found it present and intact (`verified_at`, `null` until one has). A new upload's one location is the disk store, unverified. `compliance/blob-stores.test.ts › records a new blob's location as the disk store`.
4. The locations of an unknown hash answer `404 blob_not_found`, of a malformed one `400 validation_error`. `compliance/blob-stores.test.ts › answers 404 for the locations of an unknown hash and 400 for a malformed one`.

A store's id is its own: it is read from a marker the store holds, not from the configuration that named it, so a fresh folder or bucket is a fresh store with no copies claimed. A store the configuration no longer names stays listed with `detached_at` set, and its copies stop counting. Neither is observable over HTTP against a server the referee booted once, so neither is a statement here; the server's own suite proves both, in `packages/server/src/storage/blob-store.test.ts` and `blob-layer.test.ts`.

## The direct link

A link to a blob's bytes never passes them through a relay. `GET /blobs/{hash}/url` answers the object store's own signed link once that store holds the blob, and a link the instance serves until then; either fetches the bytes with no credential (`blobs.md` 11). Nothing yet puts a blob in the object store, so the preference for its link is not a statement here.
