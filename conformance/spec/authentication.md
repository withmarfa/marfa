# Authentication

## Owner passkeys

### `authentication/passkey-register`

When the owner submits a valid WebAuthn registration with user verification from the instance's origin with a browser session authenticated within five minutes, the server MUST register the passkey for that owner.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-list`

When the owner or private local process lists `GET /owner/passkeys`, the server MUST return every registered owner passkey with only `id`, nullable `name`, and UTC `created_at`, oldest first, with `next_cursor: null`.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-session`

When a registered owner passkey verifies a fresh challenge for the configured origin and relying party with user verification, the server MUST issue an owner browser session.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-refused`

When a passkey assertion has an invalid signature or names an unregistered credential, the server MUST refuse it without issuing a browser session.

**Tests:** `compliance/passkeys.test.ts › refuses wrong credentials and keeps password attempts independent`.

### `authentication/passkey-challenge-once`

When a passkey authentication challenge has already been consumed by an accepted or refused assertion, the server MUST refuse another assertion using that challenge.

**Tests:** `compliance/passkeys.test.ts › refuses wrong credentials and keeps password attempts independent`.

### `authentication/passkey-password-counters`

When a caller attempts passkey authentication, the server MUST leave password-attempt counters unchanged.

**Tests:** `compliance/passkeys.test.ts › refuses wrong credentials and keeps password attempts independent`.

### `authentication/passkey-password-lock`

While password attempts are locked, the server MUST accept valid owner passkey authentication independently of that lock.

**Tests:** `compliance/passkeys.test.ts › refuses wrong credentials and keeps password attempts independent`.

### `authentication/passkey-removal`

When the owner removes an individual passkey, the server MUST refuse subsequent authentication with that passkey while preserving the owner's other passkeys.

**Tests:** `compliance/passkeys.test.ts › preserves individual removal and other passkeys across restart`.

### `authentication/passkey-restart`

When the server restarts, the server MUST preserve registered passkeys and their removal state.

**Tests:** `compliance/passkeys.test.ts › preserves individual removal and other passkeys across restart`.

### `authentication/passkey-address`

When the server renders the owner's passkey setup page, the server MUST explain the secure HTTPS address requirement and the localhost development exception.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-duplicate`

When a registration names a credential ID already registered on the instance, the server MUST refuse it with `409`.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-owner-only`

When a caller without an owner browser session or private local authority asks to manage passkeys, the server MUST refuse the request with `401` if unauthenticated or `403` if using an app token or API key.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`.

### `authentication/passkey-origin`

When a foreign origin asks to remove an owner passkey, the server MUST refuse it with `403`.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`.

### `authentication/passkey-recent-management`

When the owner renames or removes a passkey through `PATCH` or `DELETE /owner/passkeys/{id}`, the server MUST require a live owner browser session authenticated within five minutes or private local authority.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`.

### `authentication/passkey-rename`

When an authorized caller submits a passkey name, the server MUST trim its ends and accept it only when it is nonempty, at most 200 characters, and free of control and bidirectional formatting characters, with no other body fields.

**Tests:** `compliance/passkeys.test.ts › renames safely through owner and private local authority`.

### `authentication/passkey-management-not-found`

When an authorized caller renames or removes a missing, foreign, or removed passkey ID, the server MUST return `404` with `passkey_not_found`.

**Tests:** `compliance/passkeys.test.ts › renames safely through owner and private local authority`.

### `authentication/passkey-management-atomic`

When the server renames or removes a passkey, the server MUST check ownership and commit only that credential change with its audit record in one transaction.

**Tests:** `compliance/passkeys.test.ts › renames safely through owner and private local authority`.

### `authentication/passkey-add-url`

When the private local process requests `GET /_control/owner/passkeys/add-url`, the server MUST return the configured-origin sign-in URL with `prompt=login` and `return_to=/auth/owner/passkeys` without issuing credentials or setup proof.

**Tests:** `compliance/passkeys.test.ts › renames safely through owner and private local authority`.
