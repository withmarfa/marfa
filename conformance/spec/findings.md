# Findings

Where the server contradicts its own OpenAPI document, where its document describes something a caller cannot observe, where it contradicts the device half of this specification, or where two doors that answer the same question answer it differently. Each entry names the operation, what the document says, what the server does, and the fixture that shows it. The fixtures assert what the server does; nothing here is fixed on the suite's side, and nothing is a proposal. This file is the channel to the server's maintainers. One entry carries no fixture, and says why.

**An entry goes when the behavior it recorded changes, never because the contract softened.** Once the server answers as the document says, or the document says what the server does, the entry has nothing left to record, and the fixtures that asserted the old answer assert the new one.

## 1. The natural key is scoped by the credential, so two devices cannot share one

`folders.md` 10 requires that the same file on two separately enrolled machines is one item. The natural key is `(source, source_id)` (`items.md` 5), `source` is stamped from the credential and a value in the body is ignored (`items.md` 4), and a second key naming a `source` already in use is refused `409 conflict` (`keys-and-oauth.md` 7). Two devices with their own keys therefore cannot present the same natural key, and the same file becomes two items on the same server with nothing recording that they are the same file.

Nothing here is a contradiction of the OpenAPI document; it is the server contradicting the device half of the contract. The recommended fix is to let a folder, or any caller writing on behalf of one, name the `source` its rows are keyed by, bounded by what the credential is allowed to claim, so that the key identifies the folder rather than the credential. Until then a folder carries the item id in the file as its own identity record (`folders.md` 11), which binds a second device only for files that already have one.

Out of milestone one, which has one folder and one keyed process.

## 2. Client registration answers 500 when the write lock is held

`POST /auth/oauth2/register` declares `201` and `400`. While another connection holds the database's write lock, it answers `500`, which it does not declare, where every door this server writes through its own storage layer answers `503 write_contention` (`errors.md` 10). The registration is written by the sign-in library, whose writes do not pass through the storage layer's busy budget. The recommended fix is to route the library's database handle through the same budget, so the door answers `503 write_contention` and declares it. `compliance/write-contention.test.ts › answers 500 at client registration, which the sign-in library writes`.
