# Instance claim

## Claim authority

### `instance-claim/unclaimed-owner`

While an instance is unclaimed, the server MUST answer the private local command's `GET /owner` with `404 owner_not_found`.

**Tests:** `compliance/owner.test.ts › starts unclaimed with local authority and no public claim authority`.

### `instance-claim/unclaimed-sign-in`

While an instance is unclaimed, the server MUST refuse password sign-in with `401`.

**Tests:** `compliance/owner.test.ts › starts unclaimed with local authority and no public claim authority`.

### `instance-claim/public-control`

When a public HTTP request addresses a private `/_control` operation, the server MUST answer `404`.

**Reason:** Loopback addresses and request headers do not establish authority of the server's operating-system account.

**Tests:** `compliance/owner.test.ts › starts unclaimed with local authority and no public claim authority`.

### `instance-claim/claim-proof`

When a public request submits valid owner details without valid machine-issued setup proof, the server MUST refuse the claim with `401 unauthorized`.

**Tests:** `compliance/owner.test.ts › starts unclaimed with local authority and no public claim authority`, `› replaces setup proof and rejects the earlier code`.

### `instance-claim/replace-code`

When the private local command replaces an unclaimed instance's setup code, the server MUST refuse the earlier code with `401 unauthorized`.

**Tests:** `compliance/owner.test.ts › replaces setup proof and rejects the earlier code`.

### `instance-claim/replace-browser-proof`

When the private local command replaces an unclaimed instance's setup code, the server MUST refuse earlier handoff tickets and setup-only browser sessions with `401 unauthorized`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/invalid-owner-details`

When a claim submits a password outside the sign-in provider's length bounds, the server MUST answer `400 validation_error` without consuming the valid setup proof.

**Tests:** `compliance/owner.test.ts › validates the password without consuming valid setup proof`, `› creates exactly one owner and requires owner sign-in to read it`.

### `instance-claim/owner-created`

When valid setup proof claims an unclaimed instance with valid owner details, the server MUST answer `201` with the owner's `id`, lowercased `email`, `name`, and `created_at`.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and requires owner sign-in to read it`, `› answers the setup routes in snake_case and the claim as the public claim does`.

### `instance-claim/claim-closed`

While an instance has a completed owner claim, the server MUST refuse another claim or setup-code issuance with `409 owner_exists`.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and requires owner sign-in to read it`, `› recovers the existing owner and ends the old browser session`.

## Code attempts

### `instance-claim/address-attempt-limit`

When an address has submitted ten setup-code attempts in fifteen minutes, the server MUST refuse further setup-code attempts from that address with `429 rate_limited`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/no-instance-attempt-limit`

When other addresses exhaust their setup-code allowances, the server MUST continue accepting valid setup codes from an address with remaining allowance.

**Reason:** There is no instance-wide setup-code attempt cap that lets remote guessing prevent the owner from claiming the instance.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/handoff-bypasses-code-limit`

When an address has exhausted its setup-code allowance, the server MUST still accept a valid local-command-issued handoff ticket from that address.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

## Browser handoff

### `instance-claim/handoff-fragment`

When the private local command requests browser setup, the server MUST return a setup URL carrying its separate handoff ticket in `/setup#handoff=…`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/handoff-single-use`

When a handoff ticket has been exchanged successfully, the server MUST refuse another exchange of that ticket with `401 unauthorized`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/handoff-expiry`

When five minutes have elapsed since a handoff ticket was issued, the server MUST refuse its exchange with `401 unauthorized`.

**Tests:** `compliance/owner.test.ts › expires a handoff after five minutes while its exchanged setup session remains usable`.

### `instance-claim/setup-cookie`

When a handoff exchange succeeds on loopback HTTP, the server MUST issue an `HttpOnly` cookie with `SameSite=Strict` and `Max-Age=900`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/setup-only-session`

When a request presents only a setup browser session to `GET /owner`, the server MUST answer `401 unauthorized`.

**Reason:** Setup proof authorizes initial claim, not the owner's administration or an app's data access.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/setup-refresh`

When a browser refreshes `/setup` with a live setup session, the server MUST present the owner-details form without another handoff exchange.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`, `› expires a handoff after five minutes while its exchanged setup session remains usable`.

### `instance-claim/exchange-origin`

When a setup exchange has no origin or an origin different from the instance's origin, the server MUST answer `403 forbidden` without spending the ticket.

**Tests:** `compliance/owner.test.ts › refuses cross-origin exchange without consuming a handoff`.

### `instance-claim/request-log-secrets`

When the server logs setup exchange requests, the server MUST omit submitted setup codes, handoff tickets and passwords from those request logs.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

## Direct ownership and recovery

### `instance-claim/management-is-not-owner`

When an ordinary credential holding all twelve permissions requests `GET /owner`, including with an accompanying owner cookie, the server MUST answer `403 forbidden`.

**Tests:** `compliance/owner.test.ts › ordinary full management access cannot become the owner`.

### `instance-claim/recover-existing-owner`

When the private local command recovers the owner's password, the server MUST retain that owner's identity.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`.

### `instance-claim/recovered-password`

When the private local command recovers the owner's password, the server MUST accept the new password and refuse the replaced password at password sign-in.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`.

### `instance-claim/recovery-ends-browsers`

When the private local command recovers the owner's password, the server MUST end every existing browser session.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`, `compliance/browser-sessions.test.ts › local recovery revokes browser sessions and keeps apps connected`.

### `instance-claim/recovery-keeps-apps`

When the private local command recovers the owner's password, the server MUST preserve connected apps' access tokens, refresh grants and consent.

**Tests:** `compliance/browser-sessions.test.ts › local recovery revokes browser sessions and keeps apps connected`.

### `instance-claim/password-change-sessions`

When the owner changes their password through their signed-in browser, the server MUST retain that browser's session while ending every other browser session.

**Tests:** `compliance/browser-sessions.test.ts › through a password change that ends the other sessions leaves every app connected`.

## Durability

### `instance-claim/attempt-counter-restart`

When an unclaimed instance restarts, the server MUST retain an address's exhausted setup-code allowance until its window ends.

**Tests:** `compliance/owner.test.ts › keeps code-attempt counters through restart and replaces unclaimed setup proof`.

### `instance-claim/unclaimed-restart-proof`

When an unclaimed instance restarts, the server MUST refuse its previous setup code with `401 unauthorized`.

**Tests:** `compliance/owner.test.ts › keeps code-attempt counters through restart and replaces unclaimed setup proof`.

### `instance-claim/concurrent-claim`

When valid claims compete for an unclaimed instance, the server MUST commit exactly one owner claim and one corresponding `owner.claimed` audit record.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and requires owner sign-in to read it`.

### `instance-claim/claimed-restart`

When a claimed instance restarts, the server MUST retain its completed claim and owner identity.

**Tests:** `compliance/owner.test.ts › keeps a completed claim and recovered password through restart`.

### `instance-claim/recovery-clears-sign-in-lock`

When the private local command recovers the owner's password, the server MUST permit password sign-in despite the owner's previous sign-in lock.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`.

### `instance-claim/recovery-keeps-keys`

When the private local command recovers the owner's password, the server MUST preserve existing ordinary keys.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`, `› keeps a completed claim and recovered password through restart`.

### `instance-claim/management-metrics`

When a credential with `instance.read` requests `GET /metrics`, the server MUST return its instance-wide counters using the schema published for that operation.

**Tests:** `compliance/instance.test.ts › reports documented instance-wide counters with instance.read`.

### `instance-claim/control-only-recovery`

Where control-only mode is enabled, when another process holds the configured public HTTP port, the server MUST allow local password recovery through its private control connection.

**Tests:** `compliance/instance-lifecycle.test.ts › recovers the existing owner in control-only mode while the public port is taken`.
