# The instance

What one deployment says about itself. The credential chapters state what a key may reach and the registry chapters state what the data plane holds; this one states the fact that is true of the deployment rather than of anything inside it.

## Identity

1. An instance holds an `instance_id`, a UUIDv7. It is shown at the root route without a credential, at `GET /config`, and in the `manifest.json` of a `format=archive` export, and the three are the same value. `compliance/instance.test.ts › names itself the same way at the root, at /config and in an archive`, `› describes itself at the root`.
2. The identity is not configuration and no door sets it. `PUT /config` takes it back as read, so a body taken from `GET /config` round trips, and refuses one naming a different instance with `400 validation_error` and `details.errors[0].path` of `instance_id`, leaving the configuration untouched. A `PUT` that omits it still answers with it, and the wholesale clear does not remove it. `compliance/schema-enforcement.test.ts › takes a body back as read, and refuses one addressed elsewhere`, `› PUT replaces the configuration wholesale and GET reads it back`.

**That the value is minted once and survives a restart is not stated here, because nothing over HTTP can see it.** Both halves — a mint that answers the same value to every caller of a fresh database, and a value that a reopen of the same database returns — are properties of the server's own storage, asserted in `packages/server/src/storage/instance-id.test.ts`. A fixture run against an already-booted server reads whatever that server holds and cannot tell a durable id from one minted at the start of the run.

What the identity is _not_ — never a prefix on an identifier, never a permission or a permission root, never a column on an item — is a decision about vocabulary rather than an observable behavior, so it is stated in `GLOSSARY.md` and carries no statement here.
