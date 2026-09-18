# Blobs

Content-addressed binary storage beside the items that reference it.

1. `POST /blobs` takes the raw bytes as the body with their `Content-Type`, and answers `201` with `hash` (`sha256:` plus 64 hex characters of the content's digest), `mime_type` as sent and `size` in bytes. `correctness/blob-correctness.test.ts › upload returns the sha256 hash, the mime type sent and the byte length`.
2. Uploading the same bytes again answers the same hash without error. `correctness/blob-correctness.test.ts › duplicate upload returns same hash without error`.
3. `GET /blobs/{hash}` returns the bytes unchanged with the content type they were uploaded under. `correctness/blob-correctness.test.ts › download returns byte-for-byte identical content`, `› content-type is preserved on download`.
4. An unknown hash answers `404 blob_not_found`. `correctness/blob-correctness.test.ts › download with an unknown hash returns 404`, `compliance/error-codes.test.ts › returns 404 for non-existent blob`.
5. A hash outside the `sha256:<64 hex>` form answers `400 validation_error`, and so does an empty upload. `correctness/blob-correctness.test.ts › refuses a malformed hash and an empty upload`.
6. A blob's hash is stored on an item as a property value (`blob_ref` on file types) and survives a read. `correctness/blob-correctness.test.ts › blob_ref in properties persists after upload`.
7. `GET /blobs/{hash}/url` answers `400 validation_error` for a known hash, an unknown hash and a malformed hash alike on the filesystem backend, which mints no presigned URLs; the door's success path belongs to a backend this server does not run with. `correctness/blob-correctness.test.ts › answers 400 for a presigned URL on the filesystem backend`.
8. A request body over the server's cap answers `413 request_too_large` before any handler runs. `compliance/adversarial.test.ts › refuses a request over the body cap with request_too_large`.
