# Authentication

## Owner passkeys

### `authentication/passkey-register`

When the owner submits a valid WebAuthn registration with user verification from the instance's origin with a browser session authenticated within five minutes, the server MUST register the passkey for that owner.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-list`

When the signed-in owner lists passkeys, the server MUST return each registered passkey with its ID and name.

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

When a caller without an owner browser session asks to list passkeys, the server MUST refuse it with `401`.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`.

### `authentication/passkey-origin`

When a foreign origin asks to remove an owner passkey, the server MUST refuse it with `403`.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`.
