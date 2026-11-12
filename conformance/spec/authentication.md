# Authentication

## Owner passkeys

### `authentication/passkey-register`

When the owner submits a valid WebAuthn registration with user verification from the instance's origin with a browser session authenticated within five minutes, the server MUST register the passkey for that owner.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-options-post`

The server MUST serve passkey options only to `POST /auth/passkeys/registration/options` and `POST /auth/passkeys/sign-in/options`.

**Reason:** Asking for options stores a challenge, so it is not a read.

**Tests:** `compliance/passkeys.test.ts › gives passkey options only to a POST, answers a registration 201 with the passkey, and a passkey sign-in with only ok and its session cookie`.

### `authentication/passkey-register-answer`

When `POST /auth/passkeys/registration` registers a passkey, the server MUST answer `201` with only the passkey's `id`, `name`, `created_at` and `last_used_at`.

**Tests:** `compliance/passkeys.test.ts › gives passkey options only to a POST, answers a registration 201 with the passkey, and a passkey sign-in with only ok and its session cookie`.

### `authentication/passkey-sign-in-answer`

When `POST /auth/passkeys/sign-in` signs the owner in, the server MUST answer `200` with only `{"ok": true}`.

**Tests:** `compliance/passkeys.test.ts › gives passkey options only to a POST, answers a registration 201 with the passkey, and a passkey sign-in with only ok and its session cookie`.

### `authentication/passkey-list`

When the owner or private local process lists `GET /owner/passkeys`, the server MUST return every registered owner passkey with only `id`, nullable `name`, UTC `created_at` and nullable UTC `last_used_at`, oldest first, with `next_cursor: null`.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-session`

When a registered owner passkey verifies a fresh challenge for the configured origin and relying party with user verification, the server MUST issue an owner browser session.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-last-used`

When a registered owner passkey signs the owner in, the server MUST set that passkey's `last_used_at` to the time of the sign-in.

**Tests:** `compliance/passkeys.test.ts › records the last use of only the passkey that signed in, and only when it signed in`.

### `authentication/passkey-last-used-refused`

If a passkey assertion is refused, then the server MUST leave the `last_used_at` of every passkey unchanged.

**Tests:** `compliance/passkeys.test.ts › records the last use of only the passkey that signed in, and only when it signed in`.

### `authentication/passkey-refused`

When a passkey assertion has an invalid signature or names an unregistered credential, the server MUST refuse it without issuing a browser session.

**Tests:** `compliance/passkeys.test.ts › refuses wrong credentials and keeps password attempts independent`.

### `authentication/passkey-challenge-once`

When a passkey authentication challenge has already been consumed by an accepted or refused assertion, the server MUST refuse another assertion using that challenge.

**Tests:** `compliance/passkeys.test.ts › refuses wrong credentials and keeps password attempts independent`.

### `authentication/passkey-challenge-limit`

Where `rate_limit_enabled` is `true`, if one address has sent thirty `POST /auth/passkeys/sign-in/options` requests in a minute, then the server MUST answer its next one `429` with `Retry-After`.

**Reason:** A challenge needs no credential, and each one is stored until it is used or ends.

**Tests:** `compliance/sign-in-door-limits.test.ts › answers the thirty-first passkey sign-in challenge from one address in a minute 429`.

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

When the server renders the owner's Password and passkeys page, the server MUST explain the secure HTTPS address requirement and the localhost development exception.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-duplicate`

When a registration names a credential ID already registered on the instance, the server MUST refuse it with `409`.

**Tests:** `compliance/passkeys.test.ts › registers and lists independent owner credentials`.

### `authentication/passkey-owner-only`

When a caller without an owner browser session or private local authority asks to manage passkeys, the server MUST refuse the request with `401` if unauthenticated or `403` if using an app token or API key.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`, `compliance/owner-sign-ins.test.ts › refuses a key and an app's token 403 on every passkey door, and no credential 401`.

### `authentication/passkey-origin`

When a foreign origin asks to remove an owner passkey, the server MUST refuse it with `403`.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`, `compliance/owner-sign-ins.test.ts › refuses a key and an app's token 403 on every passkey door, and no credential 401`.

### `authentication/passkey-recent-management`

When the owner renames or removes a passkey through `PATCH` or `DELETE /owner/passkeys/{id}`, the server MUST require a live owner browser session authenticated within five minutes or private local authority.

**Tests:** `compliance/passkeys.test.ts › requires owner authority and the instance origin for passkey management`, `compliance/confirm-sign-in.test.ts › refuses a rename and a removal from a session created more than five minutes ago, and a recent session makes both`.

### `authentication/passkey-rename`

When an authorized caller submits a passkey name, the server MUST trim its ends and accept it only when it is nonempty, at most 200 characters, and free of control and bidirectional formatting characters, with no other body fields.

**Tests:** `compliance/passkeys.test.ts › renames safely through owner and private local authority`.

### `authentication/passkey-registration-name`

When an authorized caller registers a passkey with a name that `authentication/passkey-rename` would refuse, the server MUST return `400` with `validation_error` before it stores the passkey.

**Tests:** `compliance/passkeys.test.ts › refuses a passkey name at registration by the rename rule`.

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

If the server refuses a confirmation, then the server MUST leave the session that sent it live with its sign-in time unchanged.

**Reason:** Using a session renews its idle expiry and may send its own cookie again, but a refusal never makes a newer session, so a stale session stays stale.

**Tests:** `compliance/confirm-sign-in.test.ts › answers a wrong password 401 and leaves the session as it was`, `› counts a confirmation in the lane a password sign-in counts in, and answers the lockout with the wait`, `› refuses a passkey that is not registered to the signed-in owner, and leaves the session as it was`.

### `authentication/confirm-names-no-account`

If a request carrying a live owner browser session sends `POST /auth/confirm` with a body that names an email, holds both a password and a passkey assertion, or holds neither, then the server MUST answer `400 validation_error` without replacing that session.

**Reason:** The account is the signed-in session's owner. A body cannot name another.

**Tests:** `compliance/confirm-sign-in.test.ts › refuses a body that names an email, both proofs, or neither, and replaces nothing`.

### `authentication/confirm-passkey-owner`

If a passkey assertion sent to `POST /auth/confirm` is not for a passkey registered to the signed-in session's user, then the server MUST answer `401 unauthorized`.

**Tests:** `compliance/confirm-sign-in.test.ts › refuses a passkey that is not registered to the signed-in owner, and leaves the session as it was`.

### `authentication/confirm-needs-session`

If a request to `POST /auth/confirm` carries no live owner browser session, whatever its body, or carries a bearer key, then the server MUST answer `401 unauthorized` without making a session.

**Tests:** `compliance/confirm-sign-in.test.ts › is refused with no cookie, with an ended session, and with a key`.

### `authentication/confirm-origin`

If a request to `POST /auth/confirm` comes from an origin other than the instance's, then the server MUST answer `403 forbidden` without making a session.

**Tests:** `compliance/confirm-sign-in.test.ts › is refused from another origin, and sets no session`.

### `authentication/passkey-register-recent`

If a browser session created more than five minutes ago asks for passkey registration options or submits a registration, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/confirm-sign-in.test.ts › refuses a passkey registration from a stale session`.

## Where a browser session counts

The owner's browser session is the caller of the sign-in pages and of what they post: setup and its claim (`/setup`, `/setup/exchange` and `/setup/claim`), sign-in (`/auth/sign-in`), `POST /auth/sign-out`, the confirmation dialog's `POST /auth/confirm`, the consent screen (`/auth/oauth2/authorize`, `/auth/authorize` and `/auth/authorize/decision`), device approval (`/auth/device` and `/auth/device/consent`), and the passkey page (`/auth/owner/passkeys`, the doors under `/auth/passkeys/` and `/owner/passkeys`). Every other operation is reached with a key, an app's access token or the private local command.

### `authentication/session-pages-only`

When a request to an operation other than those of the sign-in pages carries the owner's live browser session and no other credential, the server MUST answer it as a request that carries no credential.

**Reason:** Marfa has no owner console, so a session is good only for signing in and approving. A browser left signed in, a copied cookie or a page that rides on the owner's cookie reaches no data and no management operation.

**Tests:** `compliance/browser-sessions.test.ts › answers the owner's live session on every door but the sign-in pages' own as a request with no credential`, `compliance/folder-status.test.ts › ignores an owner's browser session on every folder door`.
