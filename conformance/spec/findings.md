# Findings

Where the server contradicts its own OpenAPI document, where its document describes something a caller cannot observe, where it contradicts the device half of this specification, or where two doors that answer the same question answer it differently. Each entry names the operation, what the document says, what the server does, and the fixture that shows it. The fixtures assert what the server does; nothing here is fixed on the suite's side, and nothing is a proposal. This file is the channel to the server's maintainers.

**An entry goes when the behavior it recorded changes, never because the contract softened.** Once the server answers as the document says, or the document says what the server does, the entry has nothing left to record, and the fixtures that asserted the old answer assert the new one.

## 1. Client registration answers 500 when the write lock is held

`POST /auth/oauth2/register` declares `201` and `400`. While another connection holds the database's write lock, it answers `500`, which it does not declare, where every door this server writes through its own storage layer answers `503 write_contention` (`errors.md` 10). The registration is written by the sign-in library, whose writes do not pass through the storage layer's busy budget. The recommended fix is to route the library's database handle through the same budget, so the door answers `503 write_contention` and declares it. `compliance/write-contention.test.ts › answers 500 at client registration, which the sign-in library writes`.
