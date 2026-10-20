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

## Confirming a stale sign-in

A change that needs a sign-in from the last five minutes is refused to an older browser session, and the page asks the owner to confirm it's them in a dialog and then sends the change once more. `POST /auth/confirm` is the one door that answers the dialog. It takes the owner's password or a passkey assertion and nothing else, because the account is the signed-in session's owner. It renews recency by replacing the session: the new session is created now, so a session is recent exactly when it was created in the last five minutes.

### `authentication/recent-refusal`

If a change that needs a sign-in from the last five minutes comes from an owner browser session created more than five minutes ago, then the server MUST answer `403 forbidden` with the message `Sign in again to perform this operation`.

**Reason:** A page recognises this refusal to open the dialog, so every door that needs a recent sign-in refuses in the same words.

**Tests:** `compliance/confirm-sign-in.test.ts › replaces a stale session with a new one, so the change that was refused runs`, `› refuses a passkey registration from a stale session`.

### `authentication/confirm-replaces`

When a signed-in owner's browser session sends `POST /auth/confirm` with the owner's password or with a passkey assertion of the owner, the server MUST answer `200` and set a browser session created at the moment of the confirmation.

**Reason:** Recency is the age of the session, so renewing it is making a new one. There is no second timestamp to disagree with the first.

**Tests:** `compliance/confirm-sign-in.test.ts › replaces a stale session with a new one, so the change that was refused runs`, `› dates the new session from the confirmation, so it goes stale five minutes after it`, `› replaces a stale session when the owner's passkey signs`.

### `authentication/confirm-ends-old`

When the server sets the session a confirmation made, the server MUST end the session that sent the confirmation in the same step.

**Tests:** `compliance/confirm-sign-in.test.ts › replaces a stale session with a new one, so the change that was refused runs`.

### `authentication/confirm-wrong-password`

If the password sent to `POST /auth/confirm` is wrong, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/confirm-sign-in.test.ts › answers a wrong password 401 and leaves the session as it was`.

### `authentication/confirm-lanes`

When a request to `POST /auth/confirm` carries a password, the server MUST count it against the attempt windows of a password sign-in to the owner's account from the same address.

**Reason:** The dialog would otherwise be a way round the lockout.

**Tests:** `compliance/confirm-sign-in.test.ts › counts a confirmation in the lane a password sign-in counts in, and answers the lockout with the wait`.

### `authentication/confirm-locked`

If the attempt windows `authentication/confirm-lanes` names are spent, then the server MUST answer `429 rate_limited` with the `Retry-After` a password sign-in would be given, without judging the password.

**Tests:** `compliance/confirm-sign-in.test.ts › counts a confirmation in the lane a password sign-in counts in, and answers the lockout with the wait`.

### `authentication/confirm-refused-keeps`

If the server refuses a confirmation, then the server MUST leave the session that sent it live, unchanged, and set no cookie.

**Tests:** `compliance/confirm-sign-in.test.ts › answers a wrong password 401 and leaves the session as it was`, `› counts a confirmation in the lane a password sign-in counts in, and answers the lockout with the wait`, `› refuses a passkey that is not registered to the signed-in owner, and leaves the session as it was`.

### `authentication/confirm-names-no-account`

If the body of `POST /auth/confirm` names an email, holds both a password and a passkey assertion, or holds neither, then the server MUST answer `400 validation_error` and set no session.

**Reason:** The account is the signed-in session's owner. A body cannot name another.

**Tests:** `compliance/confirm-sign-in.test.ts › refuses a body that names an email, both proofs, or neither`.

### `authentication/confirm-passkey-owner`

If a passkey assertion sent to `POST /auth/confirm` is not for a passkey registered to the signed-in session's user, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/confirm-sign-in.test.ts › refuses a passkey that is not registered to the signed-in owner, and leaves the session as it was`.

### `authentication/confirm-needs-session`

If a request to `POST /auth/confirm` carries no live owner browser session, or carries a bearer key, then the server MUST answer `401 unauthorized` and set no session.

**Tests:** `compliance/confirm-sign-in.test.ts › is refused with no cookie, with an ended session, and with a key`.

### `authentication/confirm-origin`

If a request to `POST /auth/confirm` comes from an origin other than the instance's, then the server MUST answer `403 forbidden` and set no session.

**Tests:** `compliance/confirm-sign-in.test.ts › is refused from another origin, and sets no session`.

### `authentication/passkey-register-recent`

If a browser session created more than five minutes ago asks for passkey registration options or submits a registration, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/confirm-sign-in.test.ts › refuses a passkey registration from a stale session`.
