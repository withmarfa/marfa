# The instance

What one deployment says about itself. The credential chapters state what a key may reach and the registry chapters state what the data plane holds; this one states the fact that is true of the deployment rather than of anything inside it.

## Identity

1. An instance holds an `instance_id`, a UUIDv7. It is shown at the root route without a credential, at `GET /config`, and in the `manifest.json` of a `format=archive` export, and the three are the same value. `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`, `› describes itself at the root`.
2. The identity is not configuration and no door sets it. `PUT /config` takes it back as read, so a body taken from `GET /config` round trips, and refuses one naming a different instance with `400 validation_error` and `details.errors[0].path` of `instance_id`, leaving the configuration untouched. A `PUT` that omits it still answers with it, and the wholesale clear does not remove it. `compliance/schema-enforcement.test.ts › takes a body back as read, and refuses one addressed elsewhere`, `› PUT replaces the configuration wholesale and GET reads it back`.

## What it advertises

3. The root's `features` array names a surface this deployment serves, and every entry has a route: a request at the door each one names is answered by something other than `404 not_found`, which is what the server gives a path it does not serve. `inbound-webhooks` is absent from the array and its door answers `404 not_found`, so both halves of an advertisement that was withdrawn are held. Entries are lower_snake_case. `compliance/instance.test.ts › serves a route for every feature it advertises`, `› advertises no inbound webhook feature, and serves no inbound door`, `› names every advertised feature in one convention`.

**That the value is minted once and survives a restart is not stated here, because nothing over HTTP can see it.** Both halves — a mint that answers the same value to every caller of a fresh database, and a value that a reopen of the same database returns — are properties of the server's own storage, asserted in `packages/server/src/storage/instance-id.test.ts`. A fixture run against an already-booted server reads whatever that server holds and cannot tell a durable id from one minted at the start of the run.

What the identity is _not_ — never a prefix on an identifier, never a permission or a permission root, never a column on an item — is a decision about vocabulary rather than an observable behavior, so it is stated in `GLOSSARY.md` and carries no statement here.

## The contract

4. **The root and the document carry one contract version**: the root answers it as `contract`, a positive integer, and the document's `info.version` is the same number. It is not the build, which the root answers as `version`. `compliance/instance.test.ts › carries one contract version at the root and in its document`, `› describes itself at the root`.

5. **Every answer carries the contract version** as `X-Marfa-Contract`, the same number the root answers as `contract`: a read, a refusal, a request with no credential and a path the server does not serve alike, so a client checks the answer it is about to read without reading the root first. `compliance/instance.test.ts › sends its contract version on every answer, a refusal included`.

**When the number moves is not stated here, because no fixture can see a change it was not shown.** The rule is written beside the number in `packages/server/src/contract.ts`: it moves when a client generated for the old number cannot read the new answers.
