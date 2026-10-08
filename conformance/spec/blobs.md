# Blobs

Content-addressed binary storage beside the items that reference it. A blob is bytes stored under the digest of their content, and an item references one by naming that digest. Where the bytes live, and the rules that keep them, are `stores.md`'s.

A blob is read through `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` and `GET /blobs/{hash}/locations`, and is uploaded through `POST /blobs`.

## Uploading a blob

### `blobs/upload-created`

When a credential that may upload sends `POST /blobs` with a body of one byte or more under any `Content-Type` but `multipart/form-data`, the server MUST answer `201`.

**Tests:** `correctness/blob-correctness.test.ts › upload returns the sha256 hash, the mime type sent and the byte length`, `› stores a body of any non-multipart type as the bytes it is`.

### `blobs/upload-hash`

When a credential that may upload sends `POST /blobs` with a body, the server MUST answer the `hash` as `sha256:` and the 64 lowercase hexadecimal characters of the SHA-256 digest of the whole body.

**Tests:** `correctness/blob-correctness.test.ts › upload returns the sha256 hash, the mime type sent and the byte length`, `› stores a body far larger than the JSON cap, whole`.

### `blobs/upload-size`

When a credential that may upload sends `POST /blobs` with a body, the server MUST answer `size_bytes` as the length of the body in bytes.

**Tests:** `correctness/blob-correctness.test.ts › upload returns the sha256 hash, the mime type sent and the byte length`, `› stores a body far larger than the JSON cap, whole`.

### `blobs/upload-unlimited`

When a credential that may upload sends `POST /blobs` with a body larger than the cap on the body of a JSON write, the server MUST store the whole body.

**Reason:** an upload has no size cap, so the cap on a JSON write does not apply to it. The room on the volume is its only bound (`blobs/upload-reserve`). The hash of every byte, and a download at the full length, are what show the body arrived whole.

**Tests:** `correctness/blob-correctness.test.ts › stores a body far larger than the JSON cap, whole`.

### `blobs/upload-type`

When a credential that may upload sends `POST /blobs` with bytes the server does not yet hold, the server MUST record, and answer as `mime_type`, the media type of the `Content-Type` it sent without its parameters.

**Tests:** `correctness/blob-correctness.test.ts › records the media type without its parameters, keeps its case and takes octet-stream where none is sent`, `› upload returns the sha256 hash, the mime type sent and the byte length`.

### `blobs/upload-type-case`

When a credential that may upload sends `POST /blobs` with bytes the server does not yet hold, the server MUST record the media type in the case it was sent in.

**Tests:** `correctness/blob-correctness.test.ts › records the media type without its parameters, keeps its case and takes octet-stream where none is sent`.

### `blobs/upload-type-default`

When a credential that may upload sends `POST /blobs` with bytes the server does not yet hold and no `Content-Type`, the server MUST record the type `application/octet-stream`.

**Tests:** `correctness/blob-correctness.test.ts › records the media type without its parameters, keeps its case and takes octet-stream where none is sent`.

### `blobs/upload-type-fixed`

When a credential that may upload sends `POST /blobs` with bytes the server already holds under another media type, the server MUST answer `201` with the `mime_type` recorded first.

**Reason:** the type is the uploader's word, so the first upload fixes it and no later upload changes what the bytes are served as.

**Tests:** `compliance/blob-served.test.ts › answers a second upload under another type with the type the first fixed, on every link`, `› answers a HEAD, a ranged read and a link with the type the first upload fixed`.

### `blobs/upload-repeat`

When a credential that may upload sends `POST /blobs` with bytes the server already holds, the server MUST answer `201` with the hash it answered before.

**Tests:** `correctness/blob-correctness.test.ts › duplicate upload returns same hash without error`, `compliance/blob-served.test.ts › answers a second upload under another type with the type the first fixed, on every link`.

### `blobs/upload-concurrent`

While several uploads of the same bytes, each from a credential that may upload, are in flight together, the server MUST answer each with `201`, the one hash and the one recorded `mime_type`.

**Tests:** `correctness/blob-correctness.test.ts › answers every upload of the same bytes sent together with the one hash and the one type`.

### `blobs/upload-multipart`

If a credential that may upload sends `POST /blobs` with a `Content-Type` of `multipart/form-data`, then the server MUST answer `400 validation_error`.

**Reason:** the raw body is the only form an upload takes, and the same bytes sent raw are stored.

**Tests:** `correctness/blob-correctness.test.ts › refuses a multipart body and takes the same bytes raw`.

### `blobs/upload-empty`

If a credential that may upload sends `POST /blobs` with an empty body, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/blob-correctness.test.ts › refuses a malformed hash and an empty upload`.

### `blobs/type-served`

The server MUST serve a blob's bytes under the media type recorded first, on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, a ranged read and the blob's links.

**Tests:** `compliance/blob-served.test.ts › answers a second upload under another type with the type the first fixed, on every link`, `› answers a HEAD, a ranged read and a link with the type the first upload fixed`, `› serves an image as a download and never inline, on every instance door`, `correctness/blob-correctness.test.ts › stores a body of any non-multipart type as the bytes it is`, `› content-type is preserved on download`.

### `blobs/upload-reserve`

Where an instance keeps a reserve of free space, if a `POST /blobs` declares a body that would leave less free on the volume that holds the disk store's folder than the reserve, then the server MUST answer `507 insufficient_storage`.

**Reason:** an upload has no size cap, and the shipped image puts the database on the same volume, so one body can take the room every other write needs. Every write then meets `errors/storage-full`. The reserve is that room, and the instance's `MARFA_DISK_RESERVE_BYTES` sets it.

**Tests:** `compliance/disk-reserve.test.ts › refuses an upload 507 insufficient_storage, naming the reserve and the room, and stores nothing`, `› takes the same upload and the same restore once the instance holds no reserve`.

### `blobs/upload-reserve-streamed`

Where an instance keeps a reserve of free space, if a `POST /blobs` body that declares no length takes the volume that holds the disk store's folder below the reserve as it arrives, then the server MUST answer `507 insufficient_storage`.

**Reason:** a chunked body declares no length, so only the room it takes as it arrives can refuse it.

**Tests:** waiting on #1444.

### `blobs/upload-reserve-nothing-kept`

When the server answers `POST /blobs` with `507 insufficient_storage`, the server MUST NOT serve the blob on `GET /blobs/{hash}`.

**Tests:** `compliance/disk-reserve.test.ts › refuses an upload 507 insufficient_storage, naming the reserve and the room, and stores nothing`, `› takes the same upload and the same restore once the instance holds no reserve`.

## Who may upload a blob

### `blobs/upload-needs-write`

If a working key or an app's access token that holds write on no registered type outside `system.*` sends `POST /blobs`, then the server MUST answer `403 type_not_permitted`.

**Reason:** a grant on a pattern that no registered type falls under writes nothing, and neither does a grant on a `system.*` type alone.

**Tests:** `compliance/blob-reach.test.ts › refuses an upload to a key that may write no registered type, and takes one from a key that writes one`, `› refuses an upload under a grant that names no registered type, and takes one once a type is registered under it`, `› answers a key whose type map names only an unregistered type as it answers an unknown blob, and refuses it the upload`, `› refuses every blob door to a key whose type map reaches no type, and stores nothing it sends`, `compliance/blob-reach-app.test.ts › is held to its granted type scopes: it reads a note's blob, not a file's, and uploads nothing`.

### `blobs/upload-grant-registered-later`

When a type is registered under a pattern that a working key holds write on, the server MUST take that key's uploads from then on.

**Tests:** `compliance/blob-reach.test.ts › refuses an upload under a grant that names no registered type, and takes one once a type is registered under it`.

### `blobs/upload-refused-stores-nothing`

If a credential that may not upload sends `POST /blobs`, then the server MUST store none of the bytes it sent.

**Tests:** `compliance/blob-reach.test.ts › refuses every blob door to a key whose type map reaches no type, and stores nothing it sends`, `› refuses an upload under a grant that names no registered type, and takes one once a type is registered under it`.

### `blobs/upload-refused-first`

If a credential that may not upload sends `POST /blobs`, then the server MUST answer `403 type_not_permitted` whatever the body is, a `multipart/form-data` body and an empty body included.

**Reason:** the refusal comes before the body is judged, so a credential that may not upload learns nothing about the body it sent.

**Tests:** `compliance/blob-reach.test.ts › refuses a key that may not upload before it reads the body it sent`.

### `blobs/upload-app-grant`

When an app's access token sends `POST /blobs` and the server takes the upload, the server MUST credit the upload to the app's grant, so that every access token issued under that grant holds the proof of the bytes.

**Reason:** a refresh replaces the token, and a digest the app names after one would otherwise stop lending.

**Tests:** `compliance/blob-reach-app.test.ts › are credited to its grant, so a digest it names after a refresh lends`.

### `blobs/upload-operator-key`

When the operator key sends `POST /blobs` with a body the server takes, the server MUST answer `201`.

**Tests:** `compliance/blob-reach.test.ts › serves the operator key every blob and takes its uploads`.

## Downloading a blob

### `blobs/download-bytes`

When a credential that may read a blob sends `GET /blobs/{hash}`, the server MUST answer `200` with the bytes the blob was uploaded as, unchanged.

**Tests:** `correctness/blob-correctness.test.ts › download returns byte-for-byte identical content`, `› stores a body far larger than the JSON cap, whole`.

### `blobs/download-headers`

When a credential that may read a blob sends `GET /blobs/{hash}`, the server MUST answer with the `Content-Type` the blob is served under, a `Content-Length` of its size, `Accept-Ranges: bytes` and an `ETag` of its hash in quotes.

**Tests:** `compliance/blob-served.test.ts › answers a plain GET with every header of the bytes`.

### `blobs/head`

When a credential that may read a blob sends `HEAD /blobs/{hash}`, the server MUST answer `200` with the headers `GET /blobs/{hash}` carries for it and no body.

**Tests:** `correctness/blob-correctness.test.ts › answers HEAD with the headers of the bytes`, `compliance/blob-served.test.ts › serves an image as a download and never inline, on every instance door`.

### `blobs/download-attachment`

The server MUST send every answer that carries a blob's bytes, on `GET` and `HEAD /blobs/{hash}` and on the link the instance serves, with `Content-Disposition: attachment; filename="<hex>"`, the hex being the hash's 64 characters, whatever the blob's type.

**Reason:** the type is the uploader's word, so an HTML or SVG blob shown inline would run as a page of the origin that served it. No type is shown inline, images included, because an image embedded in a page is drawn whatever the disposition says and one rule for every type leaves none to get wrong. The name holds nothing an uploader chose.

**Tests:** `compliance/blob-served.test.ts › serves an HTML blob as a sandboxed download on every instance door`, `› serves an image as a download and never inline, on every instance door`, `› serves a ranged answer as the same sandboxed download, on every instance door`, `› answers a plain GET with every header of the bytes`.

### `blobs/download-sandbox`

The server MUST send every answer that carries a blob's bytes, on `GET` and `HEAD /blobs/{hash}` and on the link the instance serves, with `Content-Security-Policy: sandbox; default-src 'none'`.

**Reason:** bytes a browser renders anyway run in an opaque origin with nothing loaded.

**Tests:** `compliance/blob-served.test.ts › serves an HTML blob as a sandboxed download on every instance door`, `› serves an image as a download and never inline, on every instance door`, `› serves a ranged answer as the same sandboxed download, on every instance door`.

### `blobs/download-nosniff`

The server MUST send every answer that carries a blob's bytes, on `GET` and `HEAD /blobs/{hash}` and on the link the instance serves, with `X-Content-Type-Options: nosniff`.

**Tests:** `compliance/blob-served.test.ts › serves an HTML blob as a sandboxed download on every instance door`, `› serves an image as a download and never inline, on every instance door`, `› serves a ranged answer as the same sandboxed download, on every instance door`.

### `blobs/store-link-attachment`

Where an object store holds a blob, when a credential that may read it asks for its link, the server MUST give a link that serves the bytes under the recorded type and `Content-Disposition: attachment; filename="<hex>"`.

**Reason:** a signed link cannot carry the policy or `nosniff`, so it is safe only because the store serves it from its own origin, which `deploy/README.md` tells an operator to put on a different site from the instance.

**Tests:** `compliance/blob-served.test.ts › answers a second upload under another type with the type the first fixed, on every link`.

## Ranges

In these rules, a read of a blob is `GET` or `HEAD /blobs/{hash}`, or a `GET` or `HEAD` of the link the instance serves.

### `blobs/range-closed`

When a read of a blob carries `Range: bytes=<first>-<last>` with `<first>` inside the blob, the server MUST answer `206` with exactly the bytes from `<first>` through `<last>`.

**Tests:** `correctness/blob-correctness.test.ts › serves one byte range with 206, and 416 outside the blob`, `› serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-open`

When a read of a blob carries `Range: bytes=<first>-` with `<first>` inside the blob, the server MUST answer `206` with the bytes from `<first>` through the last byte.

**Tests:** `correctness/blob-correctness.test.ts › serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-clamped`

When a read of a blob carries a range whose `<last>` lies at or past the end of the blob, the server MUST answer `206` through the last byte.

**Tests:** `correctness/blob-correctness.test.ts › serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-content-range`

When the server answers a read of a blob with `206`, the server MUST send `Content-Range: bytes <first>-<last>/<size>` naming the bytes it answered and the blob's size.

**Tests:** `correctness/blob-correctness.test.ts › serves one byte range with 206, and 416 outside the blob`, `› serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-unsatisfiable`

If a read of a blob carries a range that starts at or past the end of the blob or ends before it starts, then the server MUST answer `416 range_not_satisfiable`.

**Tests:** `correctness/blob-correctness.test.ts › serves one byte range with 206, and 416 outside the blob`, `› serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-unsatisfiable-header`

When the server answers a read of a blob with `416`, the server MUST send `Content-Range: bytes */<size>`.

**Tests:** `correctness/blob-correctness.test.ts › serves one byte range with 206, and 416 outside the blob`, `› serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-unsatisfiable-size`

When the server answers `GET /blobs/{hash}` or a `GET` of the link the instance serves with `416`, the server MUST name the blob's size in `details.size_bytes`.

**Tests:** `correctness/blob-correctness.test.ts › serves a range open at the end or running past it, and refuses one that starts past the end or ends before it starts`, `compliance/blob-served.test.ts › answers an unsatisfiable range on an instance link with the size in details`.

### `blobs/range-unread`

If a read of a blob carries a `Range` the server does not read, a suffix range, several ranges, another unit, a malformed range or a bound past the safe integer, then the server MUST answer `200` with the whole blob and no `Content-Range`.

**Tests:** `correctness/blob-correctness.test.ts › serves the whole blob for a Range it does not read`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/range-head`

When a credential that may read a blob sends `HEAD /blobs/{hash}` with a `Range`, the server MUST answer with the status and headers `GET /blobs/{hash}` gives that range, and no body.

**Tests:** `correctness/blob-correctness.test.ts › answers HEAD with a Range as GET would, headers only`, `compliance/blob-served.test.ts › serves a ranged answer as the same sandboxed download, on every instance door`.

## Hashes

A hash is `sha256:` and the 64 lowercase hexadecimal characters of a digest. The hash operations are the four reads, and the link the instance serves.

### `blobs/hash-bare`

When a credential names a blob by the 64 lowercase hexadecimal characters of its hash with no `sha256:` on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` or `GET /blobs/{hash}/locations`, the server MUST answer as it does for the same hash with the prefix.

**Tests:** `correctness/blob-correctness.test.ts › takes a bare 64-character hash on every hash operation and refuses any other malformed one`.

### `blobs/hash-bare-link`

When a request to the instance's link names the blob by the 64 lowercase hexadecimal characters of its hash with no `sha256:`, the server MUST serve the bytes as it does for the hash with the prefix.

**Tests:** `compliance/blob-served.test.ts › serves an instance link under a bare hash and refuses a malformed hash or a stray key on it`.

### `blobs/hash-malformed`

If a credential names a blob on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` or `GET /blobs/{hash}/locations` by anything but a hash with its `sha256:` or its bare 64 lowercase hexadecimal characters, a hash in capitals, another prefix and a hash of 63 or 65 characters among them, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/blob-correctness.test.ts › takes a bare 64-character hash on every hash operation and refuses any other malformed one`, `› refuses a malformed hash and an empty upload`, `› answers 404 for a link to an unknown hash and 400 for a malformed one`, `compliance/blob-stores.test.ts › answers 404 for the locations of an unknown hash and 400 for a malformed one`.

### `blobs/hash-malformed-link`

If a request to the instance's link names a blob by a malformed hash, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/blob-served.test.ts › serves an instance link under a bare hash and refuses a malformed hash or a stray key on it`.

### `blobs/hash-unknown`

If the operator key, or a working key or an access token whose type map reaches a type, names a well-formed hash that no blob holds on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` or `GET /blobs/{hash}/locations`, then the server MUST answer `404 blob_not_found`.

**Tests:** `correctness/blob-correctness.test.ts › download with an unknown hash returns 404`, `› answers 404 for a link to an unknown hash and 400 for a malformed one`, `compliance/error-codes.test.ts › returns 404 for non-existent blob`, `compliance/blob-stores.test.ts › answers 404 for the locations of an unknown hash and 400 for a malformed one`, `compliance/blob-reach.test.ts › serves the operator key the blob doors although it holds no type map`.

## Query keys

### `blobs/query-key-refused`

If a request to `POST /blobs`, `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url`, `GET /blobs/{hash}/locations` or the instance's link carries a query key the operation does not declare and that does not start with an underscore, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/blob-correctness.test.ts › refuses a query key a blob operation does not declare and ignores one that starts with an underscore`, `compliance/blob-served.test.ts › serves an instance link under a bare hash and refuses a malformed hash or a stray key on it`, `compliance/declared-refusals.test.ts › is refused 400 and named on every published door, the event stream included`.

### `blobs/query-key-named`

When the server refuses a query key on `POST /blobs`, `GET /blobs/{hash}`, `GET /blobs/{hash}/url`, `GET /blobs/{hash}/locations` or the instance's link, the server MUST name each such key in `details.unknown_parameters`.

**Reason:** a `HEAD` answer has no body to carry the names.

**Tests:** `correctness/blob-correctness.test.ts › refuses a query key a blob operation does not declare and ignores one that starts with an underscore`, `compliance/blob-served.test.ts › serves an instance link under a bare hash and refuses a malformed hash or a stray key on it`.

### `blobs/query-key-stores-nothing`

If the server refuses an upload for a query key, then the server MUST store none of the bytes it sent.

**Tests:** `correctness/blob-correctness.test.ts › refuses a query key a blob operation does not declare and ignores one that starts with an underscore`.

### `blobs/query-key-underscore`

When a request to a blob operation carries a query key that starts with an underscore, the server MUST answer as it does without the key.

**Tests:** `correctness/blob-correctness.test.ts › refuses a query key a blob operation does not declare and ignores one that starts with an underscore`, `compliance/blob-served.test.ts › serves an instance link under a bare hash and refuses a malformed hash or a stray key on it`.

## Links

`GET /blobs/{hash}/url` answers a link. When the instance serves the link, its target is `GET /blobs/{hash}/fetch` with the signature in the query, an operation the document does not publish (`coverage.md`). When an object store holds the blob, the target is that store's own signed link, and `stores/link-instance-until-stored` and `stores/link-store-once-held` say which is answered.

### `blobs/link-minted`

When a credential that may read a blob sends `GET /blobs/{hash}/url`, the server MUST answer `200` with a `url` and an `expires_in`, whether or not an object store holds the blob.

**Tests:** `correctness/blob-correctness.test.ts › mints a link that fetches the bytes without a credential`, `compliance/blob-served.test.ts › refuses an instance link after its one second lifetime with 401`.

### `blobs/link-no-credential`

When a credential that may read a blob sends `GET /blobs/{hash}/url`, the server MUST answer a `url` that serves the blob's bytes to a request carrying no credential.

**Tests:** `correctness/blob-correctness.test.ts › mints a link that fetches the bytes without a credential`, `compliance/blob-reach.test.ts › keeps a minted link working after the key that minted it is revoked`.

### `blobs/link-range`

When a credential that may read a blob sends `GET /blobs/{hash}/url`, the server MUST answer a `url` that serves a `Range: bytes=<first>-<last>` inside the blob as `206` with exactly those bytes.

**Tests:** `correctness/blob-correctness.test.ts › mints a link that fetches the bytes without a credential`, `compliance/blob-served.test.ts › applies the range rules to an instance link`.

### `blobs/link-ttl`

When a credential that may read a blob sends `GET /blobs/{hash}/url` with a `ttl` that is a whole number of seconds from 1 through 604800, the server MUST answer `expires_in` as that number.

**Tests:** `correctness/blob-correctness.test.ts › gives a link an hour when no ttl is asked for, takes every whole number of seconds up to the cap and refuses any other`, `› mints a link that fetches the bytes without a credential`.

### `blobs/link-ttl-default`

When a credential that may read a blob sends `GET /blobs/{hash}/url` with no `ttl`, the server MUST answer `expires_in` as 3600.

**Tests:** `correctness/blob-correctness.test.ts › gives a link an hour when no ttl is asked for, takes every whole number of seconds up to the cap and refuses any other`.

### `blobs/link-ttl-cap`

When a credential that may read a blob sends `GET /blobs/{hash}/url` with a `ttl` above 604800, the server MUST answer `expires_in` as 604800, the seven days that cap a lifetime, rather than the lifetime asked for.

**Tests:** `correctness/blob-correctness.test.ts › caps a link's lifetime at seven days`, `› gives a link an hour when no ttl is asked for, takes every whole number of seconds up to the cap and refuses any other`.

### `blobs/link-ttl-invalid`

If a credential that may read a blob sends `GET /blobs/{hash}/url` with a `ttl` that is not a whole number of at least 1, then the server MUST answer `400 validation_error`.

**Tests:** `correctness/blob-correctness.test.ts › gives a link an hour when no ttl is asked for, takes every whole number of seconds up to the cap and refuses any other`.

### `blobs/link-expired`

If a link is fetched after its lifetime has run out, then the server MUST answer a status outside 2xx and none of the blob's bytes, whichever signer signed the link.

**Reason:** a link as minted fetched the bytes while it lived. The status is the signer's own, so a caller reading the status alone learns which signer refused it, not which fault the link had.

**Tests:** `correctness/blob-correctness.test.ts › refuses a link that has expired or was altered`.

### `blobs/link-altered`

If a link is fetched with its signature altered, then the server MUST answer a status outside 2xx and none of the blob's bytes, whichever signer signed the link.

**Tests:** `correctness/blob-correctness.test.ts › refuses a link that has expired or was altered`.

### `blobs/link-instance-altered`

Where the instance serves a link, if the link is fetched with its signature altered, then the server MUST answer `401 unauthorized`, on `GET` and on `HEAD`.

**Tests:** `compliance/blob-served.test.ts › refuses an instance link whose signature was altered with 401`.

### `blobs/link-instance-expired`

Where the instance serves a link, if the link is fetched after its lifetime has run out, then the server MUST answer `401 unauthorized`, on `GET` and on `HEAD`.

**Tests:** `compliance/blob-served.test.ts › refuses an instance link after its one second lifetime with 401`.

### `blobs/link-store-altered`

Where an object store holds a blob, the server MUST give a link that the store answers `403` when its signature is altered.

**Tests:** `compliance/blob-rules.test.ts › answers a dead store link with the store's own status, not the instance's`.

### `blobs/link-instance-lifetime`

Where the instance serves a link, the server MUST keep it working for at least its `expires_in` seconds, except at the cap.

**Reason:** a signer counts a lifetime in whole seconds, so a store's own link, counted from the second it was signed in, may stop up to a second sooner.

**Tests:** waiting on #1444.

### `blobs/link-cap-from-answer`

The server MUST NOT give a link that works for more than seven days from the answer that gave it.

**Tests:** waiting on #1444.

### `blobs/link-outlives-key`

When the key that minted a link is revoked, the server MUST go on serving the bytes at the link for the rest of its lifetime.

**Reason:** a link is checked when it is minted, not when it is fetched.

**Tests:** `compliance/blob-reach.test.ts › keeps a minted link working after the key that minted it is revoked`.

### `blobs/link-outlives-narrowing`

When the key that minted a link is narrowed until it no longer reaches the blob, the server MUST go on serving the bytes at the link for the rest of its lifetime.

**Tests:** `compliance/blob-reach.test.ts › keeps a minted link working after its key is narrowed and after the rows that referenced the bytes are gone`.

### `blobs/link-outlives-references`

When the rows that referenced a blob are purged, the server MUST go on serving the bytes at a link minted before, for the rest of its lifetime, until the orphan sweep purges the blob.

**Tests:** `compliance/blob-reach.test.ts › keeps a minted link working after its key is narrowed and after the rows that referenced the bytes are gone`.

### `blobs/link-purged-blob`

When a link the instance serves is fetched after the orphan sweep has purged its blob, the server MUST answer `404 blob_not_found`.

**Tests:** `compliance/blob-rules.test.ts › answers a link to a blob the sweep has purged as an unknown blob`.

## Who may read a blob

A reference is a digest anywhere in a string, as `stores/reference-digest-anywhere` counts one. Whether a reference lends its read is set when a write names the digest, under "How a write gives a reference its standing".

### `blobs/read-no-type`

If a working key or an app's access token whose type map reaches no type sends `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` or `GET /blobs/{hash}/locations`, then the server MUST answer `403 type_not_permitted`, whether the hash names a held blob or an unknown one, or is malformed.

**Reason:** a credential that reaches no type is not one with nothing to see (`keys-and-oauth.md` 1), and the refusal comes before the hash is looked at. A `HEAD` answer has no body, so only its status shows.

**Tests:** `compliance/blob-reach.test.ts › refuses every blob door to a key whose type map reaches no type, and stores nothing it sends`, `› refuses a key reaching no type the code on every blob door and the status on HEAD, for an unknown and a malformed hash alike`, `compliance/blob-reach-app.test.ts › is refused every blob door as a key reaching no type is`.

### `blobs/read-operator-key`

When the operator key sends `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` or `GET /blobs/{hash}/locations`, the server MUST serve every blob it holds, referenced or not, although the key holds no type map.

**Tests:** `compliance/blob-reach.test.ts › serves the operator key every blob and takes its uploads`, `› serves the operator key the blob doors although it holds no type map`.

### `blobs/read-unregistered-map`

If a working key or an app's access token whose type map names only a type nothing registers sends a blob read for a blob that no row it may read references, then the server MUST answer `404 blob_not_found`, as it does any credential that may not read the blob.

**Reason:** a pattern is a pattern whether or not a type matches it, so the key reaches a type and is not refused under `blobs/read-no-type`.

**Tests:** `compliance/blob-reach.test.ts › answers a key whose type map names only an unregistered type as it answers an unknown blob, and refuses it the upload`, `compliance/blob-reach-app.test.ts › answers a blob as unknown to an app whose scopes reach no registered type`.

### `blobs/read-unreferenced`

While no row references a blob, the server MUST answer `404 blob_not_found` to every working key and app's access token that reads it on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` and `GET /blobs/{hash}/locations`, the credential that uploaded it included.

**Reason:** an upload's answer carries the hash, the type and the size, and the uploader holds the bytes already, so the blob is read only once a row that lends names it.

**Tests:** `compliance/blob-reach.test.ts › answers a blob nothing references as an unknown one, to the key that uploaded it too`, `compliance/blob-reach-app.test.ts › answers a blob nothing references as an unknown one to the app that uploaded it`.

### `blobs/read-unreadable`

If a working key or an access token reads a blob that only rows it may not read reference, then the server MUST answer `404 blob_not_found` with the message an unknown hash gets.

**Reason:** the answer says nothing of whether the instance holds the bytes, as an item the credential may not read answers as a missing one (`keys-and-oauth.md` 20).

**Tests:** `compliance/blob-reach.test.ts › answers a blob only an item of a type the key may not read references as an unknown one`, `compliance/blob-reach-app.test.ts › is held to its granted type scopes: it reads a note's blob, not a file's, and uploads nothing`.

### `blobs/lend-item`

While an item of a type a working key or an access token may read references a blob through a reference that lends, in any lifecycle state, the server MUST serve the blob to that credential on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` and `GET /blobs/{hash}/locations`.

**Tests:** `compliance/blob-reach.test.ts › serves a blob to a key that may read an item referencing it, in any lifecycle state`, `› lends through a digest written by a key that could read the blob`, `compliance/blob-reach-app.test.ts › is held to its granted type scopes: it reads a note's blob, not a file's, and uploads nothing`.

### `blobs/lend-earlier-version`

While only an earlier version of an item references a blob, the server MUST answer a working key or an app's access token `404 blob_not_found` on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` and `GET /blobs/{hash}/locations`.

**Reason:** the `blob-orphans` housekeeping job keeps such a blob (`stores/orphan-keeps-versions`), so only the read is withheld.

**Tests:** `compliance/blob-reach.test.ts › does not serve a blob through an earlier version`, `compliance/blob-reach-app.test.ts › is not served a blob only an earlier version of an item names`.

### `blobs/lend-withdrawn`

When a row stops naming a digest, because an item, an edge or an extension namespace was rewritten without it, the edge or the namespace was deleted, or the item was purged with its edges and namespaces, the server MUST stop serving the blob to a credential that read it only through that row.

**Tests:** `compliance/blob-reach.test.ts › does not serve a blob through an earlier version`, `› serves a blob named only in an edge's properties to a key that reads the edge, and to no other`, `› serves a blob named only in an extension to a key that reads the namespace, and to no other`, `› serves a blob an edge names through a source in the bin, and stops once the source is purged`, `› serves a blob an extension names through an item in the bin, and stops once the item is purged`.

### `blobs/lend-edge`

While a working key or an app's access token may read an edge's type by its edge map and may read the type of the edge's source item, in any lifecycle state, the server MUST serve it each blob the edge's properties reference through a reference that lends, on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` and `GET /blobs/{hash}/locations`.

**Reason:** otherwise no working credential can read a blob named only in an edge's properties, and a working key's export archive would leave its bytes out. The target's type is not asked.

**Tests:** `compliance/blob-reach.test.ts › serves a blob named only in an edge's properties to a key that reads the edge, and to no other`, `compliance/blob-reach-app.test.ts › serves a blob named only in an edge's properties to an app that reads the edge, and to no other`.

### `blobs/lend-edge-unread`

If a working key or an app's access token may not read an edge's type by its edge map, or may not read the type of the edge's source item, then the server MUST answer `404 blob_not_found` for a blob that only that edge references.

**Tests:** `compliance/blob-reach.test.ts › serves a blob named only in an edge's properties to a key that reads the edge, and to no other`, `compliance/blob-reach-app.test.ts › serves a blob named only in an edge's properties to an app that reads the edge, and to no other`, `› does not serve a blob named only in an edge's properties to an app that holds no edge scope`.

### `blobs/lend-edge-bin`

While the source item of an edge is in the bin, the server MUST go on serving a working key that may read the edge the blobs its properties reference through a reference that lends.

**Tests:** `compliance/blob-reach.test.ts › serves a blob an edge names through a source in the bin, and stops once the source is purged`.

### `blobs/lend-extension`

While a working key may read an extension namespace by its extension map and may read the type of the item it sits on, in any lifecycle state, the server MUST serve it each blob the namespace references through a reference that lends, on `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` and `GET /blobs/{hash}/locations`.

**Reason:** otherwise no working credential can read a blob named only in an extension, and a working key's export archive would leave its bytes out.

**Tests:** `compliance/blob-reach.test.ts › serves a blob named only in an extension to a key that reads the namespace, and to no other`, `› serves a blob an extension names through an item in the bin, and stops once the item is purged`.

### `blobs/lend-extension-unread`

If a working key or an app's access token may not read an extension namespace by its extension map, or may not read the type of the item it sits on, then the server MUST answer `404 blob_not_found` for a blob that only that namespace references.

**Reason:** a key's label names no namespace, and an app holds no extension map, since no scope names a namespace (`keys-and-oauth.md` 21).

**Tests:** `compliance/blob-reach.test.ts › serves a blob named only in an extension to a key that reads the namespace, and to no other`, `› does not serve a blob an extension names to a key whose label is the namespace and whose extension map does not reach it`, `compliance/blob-reach-app.test.ts › is not served a blob named only in an extension, since no scope reaches a namespace`.

### `blobs/lend-copy-edges`

When a stale write that keeps both copies of an item copies the item's edges, the server MUST give each digest in a copied edge's properties the standing it had on the edge copied.

**Reason:** the copy is written for no credential, so without this every digest that lent on the edge would stop lending on its copy, and a digest that did not would start.

**Tests:** `compliance/blob-reach.test.ts › gives each digest on a keep-both copy's edges the standing it had on the edge copied`.

## How a write gives a reference its standing

### `blobs/proof-item`

When a working key or an app's access token writes an item through `POST /items`, `POST /items/bulk`, `PATCH /items/{id}` as a plain update, a stale merge, a keep-both write or a retype, or `POST /items/bulk-actions` with `update_properties`, an upsert onto a natural key included, and the write names a digest the item did not name before and, for a write made against an earlier version, that version did not name, the server MUST make the reference lend if and only if the credential had uploaded the bytes or could read the blob as it wrote.

**Reason:** a credential that may write an item could otherwise read any blob whose hash it knows by naming it there, which is as good as downloading and uploading the bytes again.

**Tests:** `compliance/blob-reach.test.ts › lends a digest named by a new item only when its writer sent the bytes`, `› lends a digest named by an upsert onto a natural key only when its writer sent the bytes`, `› lends a digest named by a patch at the current version only when its writer sent the bytes`, `› lends a digest new to the base of a stale merge only when its writer sent the bytes`, `› lends a digest named by a keep-both write only when its writer sent the bytes`, `› lends a digest named by a retype only when its writer sent the bytes`, `› lends a digest named by a bulk create only when its writer sent the bytes`, `› lends a digest named by a bulk update only when its writer sent the bytes`, `› lends a digest named by a bulk action only when its writer sent the bytes`, `› lends no reach through a digest written by a key that never sent the bytes`, `› lends through a digest written by a key that could read the blob`, `compliance/blob-reach-app.test.ts › are credited to its grant, so a digest it names after a refresh lends`.

### `blobs/proof-folder`

When a working key or an app's access token writes a digest a folder's settings did not name before through `POST /folders` or `PATCH /folders/{id}`, the server MUST make the reference lend if and only if the credential had uploaded the bytes or could read the blob as it wrote.

**Reason:** folder settings are a `system.folder`'s properties and count like any other, but a key whose only write is `system.folder` cannot upload (`blobs/upload-needs-write`).

**Tests:** `compliance/blob-reach.test.ts › lends a digest named in a folder's settings only when its writer could read the blob`.

### `blobs/proof-edge`

When a working key or an app's access token writes an edge's properties through `POST /edges`, `POST /edges/bulk` or `PATCH /edges/{id}` and names a digest the edge did not name before, the server MUST make the reference lend if and only if the credential had uploaded the bytes or could read the blob as it wrote.

**Reason:** a credential that may write an edge could otherwise read any blob whose hash it knows by naming it there.

**Tests:** `compliance/blob-reach.test.ts › lends through an edge or an extension only a digest its writer proved`, `› lends a digest named by a bulk edge create only when its writer sent the bytes`, `› lends a digest named by a bulk edge update only when its writer sent the bytes`, `compliance/blob-reach-app.test.ts › lends through an edge only a digest the app proved`.

### `blobs/proof-extension`

When a working key writes an extension namespace through `PUT /items/{id}/extensions/{namespace}` and names a digest the namespace did not name before, the server MUST make the reference lend if and only if the credential had uploaded the bytes or could read the blob as it wrote.

**Tests:** `compliance/blob-reach.test.ts › lends through an edge or an extension only a digest its writer proved`.

### `blobs/proof-dead-stays`

While an item, an edge or an extension namespace keeps naming a digest that does not lend, the server MUST NOT make that reference lend by a later write, whoever makes it and whatever it holds.

**Reason:** a key that may read every blob would otherwise vouch for a hash someone else put there, by editing beside it or rewriting the whole row.

**Tests:** `compliance/blob-reach.test.ts › keeps a planted digest dead when a key holding every blob edits the note`, `› lends no reach through a digest written by a key that never sent the bytes`, `› lends through an edge or an extension only a digest its writer proved`, `› keeps a planted digest dead through an export, a purge and a restore`.

### `blobs/proof-lending-stays`

While an item, an edge or an extension namespace keeps naming a digest through a reference that lends, the server MUST keep that reference lending through every later write, whoever makes it.

**Reason:** a write that keeps a digest decides nothing about it, so no later write, one made for no credential included, withdraws what another proved.

**Tests:** `compliance/blob-reach.test.ts › keeps a lending digest lending through later writes by a key that never sent the bytes`, `› keeps a lending digest on an edge lending through later writes by a key that never sent the bytes`, `› keeps a lending digest in an extension lending through later writes by a key that never sent the bytes`, `compliance/enrichment-reach.test.ts › keeps a lending blob_ref lending after the sweep writes onto the file`.

### `blobs/proof-repair`

When a row that names a digest that does not lend is written without it, and a later write names it again with the proof, the server MUST make the reference lend.

**Reason:** this is the one repair for a reference that does not lend, a restored one included.

**Tests:** `compliance/blob-reach.test.ts › lends no reach through a digest written by a key that never sent the bytes`, `› lends through an edge or an extension only a digest its writer proved`, `› restores a row's reach only for the digests its archive line says lent`.

### `blobs/proof-stale`

When a write made against an earlier version names a digest that version already held, the server MUST NOT credit the writer's proof to that digest, whether the write lands on the item or in a keep-both copy.

**Reason:** a digest the base held was put there by whoever wrote it and may since have been removed, so sending it back is not sending it.

**Tests:** `compliance/blob-reach.test.ts › credits a stale write only for digests its base version lacked`.

### `blobs/proof-copy-as-stood`

When a stale write that keeps both copies of an item writes the copy, the server MUST give each digest the copy names that the item still names the standing it has on the item.

**Reason:** a digest the item holds was proved, or not, by whoever wrote it there, and copying it proves nothing. A digest the base version named that the item no longer names is held to `blobs/proof-stale`.

**Tests:** `compliance/blob-reach.test.ts › keeps each digest on a keep-both copy as it stood on the item`.

### `blobs/proof-retype-as-stood`

When an item is retyped through `PATCH /items/{id}` and the retype keeps a digest the item named before it, the server MUST keep that reference's standing.

**Tests:** `compliance/blob-reach.test.ts › keeps each digest on a retyped item as it stood before the retype`.

### `blobs/proof-sweep`

When the enrichment sweep writes onto a file item, the server MUST NOT make a digest the sweep writes lend.

**Reason:** a write made for no credential proves nothing.

**Tests:** `compliance/enrichment-reach.test.ts › keeps a digest the sweep wrote dead after a full key rewrites the file`.

## Order of refusals

### `blobs/read-order`

If a request to `GET /blobs/{hash}`, `HEAD /blobs/{hash}`, `GET /blobs/{hash}/url` or `GET /blobs/{hash}/locations` meets more than one refusal, then the server MUST answer the first in this order: no credential, or one it does not hold, `401 unauthorized`; a working key or an app's access token whose type map reaches no type, `403 type_not_permitted`; a query key the operation does not declare, `400 validation_error`; on `GET /blobs/{hash}/url`, a `ttl` that is not a whole number of at least 1, `400 validation_error`; a malformed hash, `400 validation_error`; a blob the credential may not read, or an unknown one, `404 blob_not_found`.

**Reason:** a blob the credential may not read and an unknown one answer alike, so their order cannot be told.

**Tests:** `compliance/blob-order.test.ts › answers a missing credential before a stray query key`, `› refuses a key that reaches no type before a stray query key`, `› answers a stray query key before an unknown hash`, `› answers a stray query key before a malformed hash`, `› answers a stray query key before a malformed ttl`, `› answers a malformed ttl before an unknown hash`, `› answers a malformed ttl before a malformed hash`, `› answers a malformed ttl before a blob the key may not read`.

### `blobs/upload-order`

If a request to `POST /blobs` meets more than one refusal, then the server MUST answer the first in this order: no credential, or one it does not hold, `401 unauthorized`; a credential that may not upload, `403 type_not_permitted`; a query key the operation does not declare, `400 validation_error`; a `multipart/form-data` or empty body, `400 validation_error`.

**Tests:** `compliance/blob-order.test.ts › refuses an upload a key may not make before a stray query key`, `› answers a stray query key on an upload before the body it carries`, `compliance/blob-reach.test.ts › refuses a key that may not upload before it reads the body it sent`.

### `blobs/link-instance-order`

Where the instance serves a link, if a fetch of it meets more than one refusal, then the server MUST answer the first in this order: a query key the link does not declare, `400 validation_error`; a missing `expires` or `signature`, `400 missing_required_field`; a malformed hash, `400 validation_error`; a signature that does not verify or a lifetime that has run out, `401 unauthorized`; a blob the instance no longer holds, `404 blob_not_found`.

**Tests:** `compliance/blob-order.test.ts › answers a stray key on an instance link before a missing query value`, `› answers a missing query value on an instance link before a malformed hash`, `› answers a stray key on an instance link before a malformed hash`, `› answers a malformed hash on an instance link before its signature`, `› answers a stray key on an instance link before its signature`, `› answers an altered signature on an instance link before a blob the sweep has purged`.

## Export and restore

### `blobs/export-operator-refused`

If the operator key sends `GET /export`, then the server MUST answer `403 type_not_permitted`, whether it asks for `ndjson` or for the archive.

**Reason:** the operator key holds no type map, so the exporter is always a working key or an access token.

**Tests:** `compliance/blob-reach.test.ts › refuses the operator key an export and takes a working key's`.

### `blobs/export-carries-served`

When a working key sends `GET /export?format=archive`, the server MUST carry a blob's bytes in the archive, as `blobs/<hash>`, only where the blob reads would serve them to that key.

**Reason:** a digest in a reference that does not lend, in an edge or an extension namespace the key may not read, or only in an earlier version, carries no bytes unless another row the key reads lends it.

**Tests:** `compliance/blob-reach.test.ts › carries in an export archive only the bytes the blob doors would serve`, `› leaves out of an export archive a digest a property names without lending it, and one only an earlier version names`, `› leaves out of an export archive the bytes an edge or an extension lends to a key that may not read them`, `› carries the bytes an edge and an extension lend, and restores the same answers`.

### `blobs/export-manifest-served`

When a working key sends `GET /export?format=archive`, the server MUST name a blob in the archive's manifest only where the blob reads would serve it to that key.

**Tests:** `compliance/blob-reach.test.ts › carries in an export archive only the bytes the blob doors would serve`, `› leaves out of an export archive a digest a property names without lending it, and one only an earlier version names`.

### `blobs/export-download-name`

When a working key sends `GET /export?format=archive`, the server MUST answer as a download named `marfa-export-<date>.tar.gz`, whatever blobs the archive carries.

**Reason:** the name is not a blob's hash, so a download of the archive is not taken for a download of a blob.

**Tests:** `compliance/blob-served.test.ts › sends an export archive as a download under its own name, whatever blobs it carries`.

### `blobs/export-line-lending`

When a working key sends `GET /export?format=archive`, the server MUST list on each item line, in `lending_blobs`, the digests in that row's properties that lend.

**Tests:** `compliance/blob-reach.test.ts › writes on each export line the digests that lend, and no namespace that lends none`.

### `blobs/export-line-extensions`

When a working key sends `GET /export?format=archive`, the server MUST list on each item line, in `lending_extensions`, each extension namespace of the line that holds a digest that lends, with those digests, and no namespace that lends none.

**Tests:** `compliance/blob-reach.test.ts › writes on each export line the digests that lend, and no namespace that lends none`.

### `blobs/export-edge-line-lending`

When a working key sends `GET /export?format=archive`, the server MUST list on each edge line, in `lending_blobs`, the digests in that edge's properties that lend.

**Tests:** `compliance/blob-reach.test.ts › writes on each export line the digests that lend, and no namespace that lends none`.

### `blobs/restore-standing`

When the operator key sends `POST /restore`, the server MUST make each digest in a restored item, edge or extension lend exactly when its archive line lists it as lending.

**Reason:** every other digest the line names restores as one that does not lend, and `blobs/proof-repair` is how it is repaired.

**Tests:** `compliance/blob-reach.test.ts › restores a row's reach only for the digests its archive line says lent`, `› restores an edge's and an extension's reach only for the digests their archive lines say lent`, `› carries the bytes an edge and an extension lend, and restores the same answers`, `› keeps a planted digest dead through an export, a purge and a restore`.

### `blobs/restore-unlisted`

When the operator key sends `POST /restore` with a line that lists no lending digests, or lists them as anything but a list, the server MUST make no digest of that line lend.

**Tests:** `compliance/blob-reach.test.ts › restores a row's reach only for the digests its archive line says lent`, `› restores an edge's and an extension's reach only for the digests their archive lines say lent`.

### `blobs/restore-reserve`

Where an instance keeps a reserve of free space, if the operator key sends `POST /restore` with a body that would leave less free on the volume that holds the disk store's folder than the reserve, then the server MUST answer `507 insufficient_storage`.

**Tests:** `compliance/disk-reserve.test.ts › refuses a restore 507 insufficient_storage, and writes no row, no type and no blob`, `› takes the same upload and the same restore once the instance holds no reserve`.

### `blobs/restore-reserve-inflated`

Where an instance keeps a reserve of free space, if an entry of the archive in a `POST /restore` takes the volume that holds the disk store's folder below the reserve as it is read, then the server MUST answer `507 insufficient_storage`.

**Reason:** a compressed archive says nothing of the size it expands to, so a body that fits can still inflate past the volume.

**Tests:** waiting on #1444.

### `blobs/restore-reserve-nothing-written`

When the server answers `POST /restore` with `507 insufficient_storage`, the server MUST NOT write any item, type registration or blob of the archive.

**Tests:** `compliance/disk-reserve.test.ts › refuses a restore 507 insufficient_storage, and writes no row, no type and no blob`, `› takes the same upload and the same restore once the instance holds no reserve`.

## The enrichment sweep

### `blobs/enrichment-lent-only`

Where enrichment is on, the server MUST NOT write `extracted_text`, `width`, `height` or `duration` onto a file item from bytes its own `blob_ref` names through a reference that does not lend.

**Reason:** a file naming a hash its writer never proved it holds would otherwise gain what the bytes say, which tells that writer what the blob holds.

**Tests:** `compliance/enrichment-reach.test.ts › extracts only from bytes the file's own reference lends`, `› reads the width, height and duration only of bytes the file's own reference lends`.

## A file item's size

A file item is an item of `core.file` or of a type that inherits from it.

### `blobs/file-size-set`

When an item of `core.file`, or of a type that inherits from it, is created or updated through `POST /items`, `PATCH /items/{id}` in either properties mode, `POST /items/bulk`, `POST /items/bulk-actions` with `update_properties`, a retype into a file type, a stale write and the keep-both copy it makes, or `POST /restore`, and its `blob_ref` is a whole `sha256:` hash whose reference lends, the server MUST store `size_bytes` as the stored length of that blob in bytes, whatever size the write carried and none included.

**Reason:** an app lists files from the items it holds, offline included, and cannot ask the server about each blob to show how big it is. The server measured the bytes when they were uploaded, so every writer, a connector over HTTP included, gets the size with no code of its own, and no write can store a size that disagrees with the bytes. A lending reference means the writer uploaded the bytes or could read them, so the instance holds them whenever a size is set.

**Tests:** `compliance/file-size.test.ts › is set on a create that names none, and on one that names another`, `› follows an update that names other bytes, and survives one that clears it`, `› holds for every file type`, `› is set on a bulk upsert's create and on its update`, `› follows an update that replaces the properties, and is gone once they name no blob`, `› is set by a bulk action's property patch, whatever size the patch carried`, `› is set on a restore from an archive that carries another size, and none where the line lent nothing`, `› is set on a retype into a file type`, `› is set on a stale write and on the keep-both copy it makes`.

### `blobs/file-size-none`

When an item of `core.file`, or of a type that inherits from it, is created or updated and its `blob_ref` is not a whole `sha256:` hash whose reference lends, the server MUST store no `size_bytes`, whatever size the write carried.

**Reason:** a size set from the bytes would tell a writer that never proved it holds them that the instance does, and a size kept from the write would be a number nobody measured. A hash the instance does not hold lends nothing, and the size is read only from a whole hash, so a `blob_ref` written without its prefix gets none even where its reference lends the read.

**Tests:** `compliance/file-size.test.ts › carries none for bytes its writer never sent, where the writer that sent them is told`, `› carries none for bytes not yet uploaded, and has it once the digest is written again with them`, `› carries none for a reference that names no blob the instance could lend, on a create and an update`, `› carries none for bytes its writer never sent, whatever an update of the file says`, `› is set on a restore from an archive that carries another size, and none where the line lent nothing`, `› follows an update that replaces the properties, and is gone once they name no blob`.

### `blobs/file-size-repair`

When a file item whose `blob_ref` did not lend is written again with the digest and the writer's proof, the server MUST store `size_bytes` as the stored length of that blob.

**Tests:** `compliance/file-size.test.ts › carries none for bytes not yet uploaded, and has it once the digest is written again with them`.

### `blobs/file-size-wrong-shape`

If a write to a file item names `size_bytes` as anything but an integer or null, then the server MUST answer `400 invalid_properties`, on a create, on an update and on a stale write that meets no collision.

**Tests:** `compliance/file-size.test.ts › refuses a size of another shape on a create, an update and a stale write`.

### `blobs/file-size-stale-no-collision`

When a write made against an earlier version of a file item carries `size_bytes` as an integer or null, the server MUST NOT name a conflict on `size_bytes`.

**Reason:** the size is the server's to set, so a value the write sent is not the writer's edit. Counted as one, a write built from the writer's own fields would be refused whenever another writer had replaced the bytes since, though the writer changed nothing the other did.

**Tests:** `compliance/file-size.test.ts › does not collide on a size it carries as a whole number or null, and merges the rest`.

### `blobs/file-size-stale-replace`

When a write made against an earlier version of a file item replaces the properties and leaves out `size_bytes`, the server MUST NOT count it as a cleared property.

**Tests:** `compliance/file-size.test.ts › does not count a size it leaves out of a whole replacement as a cleared property`.

### `blobs/file-size-stale-merges`

When a write made against an earlier version of a file item carries `size_bytes` as an integer or null, the server MUST merge the rest of the write as it would without the size.

**Tests:** `compliance/file-size.test.ts › does not collide on a size it carries as a whole number or null, and merges the rest`, `› does not count a size it leaves out of a whole replacement as a cleared property`.
