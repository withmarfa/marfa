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

When a public request submits valid owner details without valid machine-issued setup proof, the server MUST refuse the claim with `401 setup_proof_invalid`.

**Reason:** a command line that is told only `401 unauthorized` cannot tell a refused setup code, which a person fixes by asking for a new one, from a credential that is missing or ended.

**Tests:** `compliance/owner.test.ts › starts unclaimed with local authority and no public claim authority`, `› replaces setup proof and rejects the earlier code`.

### `instance-claim/replace-code`

When the private local command replaces an unclaimed instance's setup code, the server MUST refuse the earlier code with `401 setup_proof_invalid`.

**Tests:** `compliance/owner.test.ts › replaces setup proof and rejects the earlier code`.

### `instance-claim/replace-browser-proof`

When the private local command replaces an unclaimed instance's setup code, the server MUST refuse earlier handoff tickets and setup-only browser sessions with `401 setup_proof_invalid`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/invalid-owner-details`

When a claim submits a password outside the sign-in provider's length bounds, the server MUST answer `400 validation_error` without consuming the valid setup proof.

**Tests:** `compliance/owner.test.ts › validates the password without consuming valid setup proof`, `› creates exactly one owner and requires owner sign-in to read it`.

### `instance-claim/owner-undeclared-key`

If `POST /owner` carries a top-level body key the operation does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields` without consuming valid setup proof.

**Reason:** a misspelled `password` or `name` would otherwise be dropped, and the one owner of the instance would be created from a request the caller did not make.

**Tests:** `compliance/owner.test.ts › refuses a key the claim does not declare without consuming valid setup proof`.

### `instance-claim/setup-undeclared-key`

If `POST /setup/exchange` or `POST /setup/claim`, with a JSON body or a form, carries a key the setup page's request does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields` without consuming valid setup proof.

**Reason:** these two doors are the browser's way to the same claim as `POST /owner`, which refuses an undeclared key, so a key dropped here would be a claim half performed and answered as success.

**Tests:** `compliance/owner.test.ts › refuses a key the setup doors do not declare, in a JSON or a form body, without consuming valid setup proof`.

### `instance-claim/owner-created`

When valid setup proof claims an unclaimed instance with valid owner details, the server MUST answer `201` with the owner's `id`, lowercased `email`, `name`, and `created_at`.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and requires owner sign-in to read it`, `› answers the setup routes in snake_case and the claim as the public claim does`.

### `instance-claim/claim-signs-in`

When a valid claim that carries the instance's own origin in its `Origin` header creates the owner and the password sign-in that follows it succeeds, the server MUST set in the same answer the owner session cookie that password sign-in sets, so that `GET /owner` with it answers `200` and the session counts as a sign-in within the last five minutes.

**Reason:** A browser at the instance's own origin is the owner's browser, and the person has just chosen the password, so asking them to type it again at sign-in adds a step and proves nothing new. The session is a fresh sign-in so that adding a passkey, which needs authentication within five minutes, works without asking again.

**Tests:** `compliance/owner.test.ts › signs the owner in when a claim comes from the instance's own origin and refuses a session to a claim that fails`, `› signs the owner in when the setup page claims through its setup session`.

### `instance-claim/claim-sign-in-failure`

If the password sign-in that follows a valid claim carrying the instance's own origin in its `Origin` header is refused or fails, then the server MUST keep the owner the claim created and set no owner session cookie in the answer.

**Reason:** The claim has committed, and a sign-in that cannot be made, such as one from an address that has spent its password attempts, must not undo it or hide it from the person. They sign in at the page that follows.

**Tests:** `compliance/owner.test.ts › keeps the owner and sets no session when the sign-in that follows the claim is refused`.

### `instance-claim/claim-script-no-session`

When a valid claim that carries no `Origin` header creates the owner, the server MUST NOT set an owner session cookie in the answer.

**Reason:** A script that holds a setup code has no browser to keep a cookie, and a session it never asked for would be a standing credential it does not need. Only a request from the instance's own origin is a browser.

**Tests:** `compliance/owner.test.ts › leaves a script that claims with a setup code without a session`.

### `instance-claim/claim-refused-no-session`

If a claim is refused, then the server MUST NOT set an owner session cookie in the answer.

**Reason:** A wrong code, invalid details, a request from another origin and a second claim each prove nothing about who is asking, so none may leave a browser signed in.

**Tests:** `compliance/owner.test.ts › signs the owner in when a claim comes from the instance's own origin and refuses a session to a claim that fails`.

### `instance-claim/status-fields`

When the private local command reads the claim status, the server MUST answer `claimed`, `owner_id` and `generation`, where `owner_id` is the owner's `id` once claimed and otherwise `null`, and `generation` is a string while unclaimed and `null` once claimed.

**Reason:** Every field in an answer is snake_case, so a script reading the status finds the same names the public owner answer uses.

**Tests:** `compliance/owner.test.ts › answers the setup routes in snake_case and the claim as the public claim does`, `› creates exactly one owner and requires owner sign-in to read it`, `› keeps a completed claim and recovered password through restart`.

### `instance-claim/ticket-fields`

When the private local command requests browser setup, the server MUST answer the handoff `ticket`, its setup `url`, and `expires_at` as an ISO 8601 instant in UTC.

**Reason:** The expiry takes the same form as every other time field, so a script compares it with them without a conversion.

**Tests:** `compliance/owner.test.ts › answers the setup routes in snake_case and the claim as the public claim does`, `› expires a handoff after five minutes while its exchanged setup session remains usable`.

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

When a handoff ticket has been exchanged successfully, the server MUST refuse another exchange of that ticket with `401 setup_proof_invalid`.

**Tests:** `compliance/owner.test.ts › limits code guesses per address without an instance-wide cap and accepts handoffs past the limit`.

### `instance-claim/handoff-expiry`

When five minutes have elapsed since a handoff ticket was issued, the server MUST refuse its exchange with `401 setup_proof_invalid`.

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

When an unclaimed instance restarts, the server MUST refuse its previous setup code with `401 setup_proof_invalid`.

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

## Owner and delegated profile changes

### `instance-claim/profile-owner-unavailable`

If the persisted owner is unavailable, then the server MUST answer `PATCH /owner` and `PATCH /profile` with `404 owner_not_found` without creating an owner.

**Reason:** An update cannot replace the owner's existing identity or reopen a completed claim.

**Tests:** `compliance/profile.test.ts › refuses owner and profile updates without recreating an unavailable persisted owner`.

### `instance-claim/owner-update`

When a direct owner authenticated within the last five minutes or the private local command submits a valid nonempty `PATCH /owner` with `email`, `name`, `avatar` set to `null`, or any combination of them, the server MUST return the updated owner.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`, `compliance/owner-picture.test.ts › removes the picture through either PATCH door and leaves the other fields as they were`, `compliance/profile.test.ts › requires a recent direct owner and refuses explicit email-write grants`.

### `instance-claim/owner-avatar`

When `PATCH /owner` receives `avatar` set to `null`, the server MUST remove the owner's picture and answer `avatar` as `null` at `GET /owner` and `PATCH /owner`.

**Reason:** A picture is set by sending its bytes, so the one value `avatar` takes in an update is the one that removes it.

**Tests:** `compliance/owner-picture.test.ts › removes the picture through either PATCH door and leaves the other fields as they were`.

### `instance-claim/owner-update-authority`

If `PATCH /owner` lacks private local authority or a live direct owner sign-in authenticated at most five minutes ago, then the server MUST refuse the request.

**Reason:** Email determines the owner's password sign-in identity, and the other fields are the owner's visible profile.

**Tests:** `compliance/profile.test.ts › requires a recent direct owner and refuses explicit email-write grants`.

### `instance-claim/owner-update-identity`

When `PATCH /owner` changes email, name, or avatar, the server MUST preserve the owner's ID, password, passkeys, sessions, ordinary keys, and app grants.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/owner-update-email`

When `PATCH /owner` changes email, the server MUST store the lowercase address without requiring email confirmation.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/profile-input`

If an owner or delegated profile update contains no field, an unknown field, an invalid email address, an empty trimmed name, a name longer than 200 Unicode code points, a name containing a control or bidirectional control character before trimming, or an avatar other than null, a web address included, then the server MUST refuse the whole update with `400 validation_error`.

**Reason:** An address names a picture that lives somewhere else, and the owner's picture is held by the instance.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`, `compliance/owner-picture.test.ts › refuses a web address as the avatar and changes nothing`.

### `instance-claim/delegated-profile-update`

When a key or app submits a valid nonempty `PATCH /profile` containing only `name`, `avatar` set to `null`, or both and holds current profile write permission for every submitted field, the server MUST return only `{ "ok": true }` after changing those fields.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`.

### `instance-claim/delegated-profile-atomic`

If any submitted profile field lacks current write permission when the transaction commits, then the server MUST preserve every submitted field's previous value.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`.

### `instance-claim/owner-picture-upload`

When a direct owner authenticated within the last five minutes or the private local command sends `PUT /owner/picture` with the bytes of a PNG, JPEG or WebP picture, the server MUST store them as the owner's picture and return the updated owner.

**Tests:** `compliance/owner-picture.test.ts › stores a picture sent to the owner door and returns the owner`, `› stores a picture sent through the private local command`.

### `instance-claim/profile-picture-upload`

When a key or app that holds current profile write permission for `avatar` sends `PUT /profile/picture` with the bytes of a PNG, JPEG or WebP picture, the server MUST store them as the owner's picture and return only `{ "ok": true }`.

**Tests:** `compliance/owner-picture.test.ts › stores a picture sent to the profile door by a credential that may write the avatar`.

### `instance-claim/owner-picture-authority`

If `PUT /owner/picture` lacks private local authority or a live direct owner sign-in authenticated at most five minutes ago, then the server MUST refuse the request and keep the previous picture.

**Tests:** `compliance/owner-picture.test.ts › refuses a picture from a caller the door does not admit, and keeps the previous one`.

### `instance-claim/profile-picture-authority`

If a credential sending `PUT /profile/picture` lacks current profile write permission for `avatar`, then the server MUST refuse the request with `403 forbidden` and keep the previous picture.

**Tests:** `compliance/owner-picture.test.ts › refuses a picture from a caller the door does not admit, and keeps the previous one`.

### `instance-claim/picture-kind-from-bytes`

When the server stores a picture, the server MUST decide the picture's kind from the bytes alone, whatever the `Content-Type` and the file name of the request claim.

**Reason:** A claimed type or name is chosen by the sender, and the kind decides how a browser treats the bytes when it is served.

**Tests:** `compliance/owner-picture.test.ts › decides the kind from the bytes and not from what the request claims`.

### `instance-claim/picture-kind-refused`

If the body of a picture upload is not a PNG, a JPEG or a WebP, a GIF, an AVIF, an SVG, a page and a text file included, then the server MUST refuse it with `400 validation_error` and keep the previous picture.

**Reason:** An SVG or a page can carry script, and the other kinds are not yet drawn by every app that reads the picture.

**Tests:** `compliance/owner-picture.test.ts › refuses a body that is not a PNG, JPEG or WebP, whatever the request claims`.

### `instance-claim/picture-empty`

If the body of a picture upload is empty, then the server MUST refuse it with `400 validation_error` and keep the previous picture.

**Tests:** `compliance/owner-picture.test.ts › refuses an empty body and a picture cut short, and keeps the previous one`.

### `instance-claim/picture-damaged`

If the body of a picture upload begins as a PNG, a JPEG or a WebP and ends before the header that gives its width and height, then the server MUST refuse it with `400 validation_error` and keep the previous picture.

**Tests:** `compliance/owner-picture.test.ts › refuses an empty body and a picture cut short, and keeps the previous one`.

### `instance-claim/picture-dimensions`

If the header of a picture gives a width or a height of zero or of more than 4096 pixels, then the server MUST refuse the upload with `400 validation_error` and keep the previous picture.

**Tests:** `compliance/owner-picture.test.ts › accepts 4096 pixels on a side and refuses none and 4097`.

### `instance-claim/picture-size`

If the body of a picture upload is larger than 2097152 bytes, then the server MUST refuse it with `413 request_too_large` and keep the previous picture.

**Reason:** The picture is held in the instance's database and read again on every page that shows it.

**Tests:** `compliance/owner-picture.test.ts › accepts a picture of exactly 2097152 bytes and refuses one byte more`.

### `instance-claim/picture-size-early`

When the bytes of a picture upload pass 2097152, whether or not the sender declared a length, the server MUST answer `413 request_too_large` before the sender has finished the body.

**Reason:** A server that read the rest first would hold, or wait on, a body it has already decided to refuse.

**Tests:** `compliance/owner-picture.test.ts › refuses an oversize body as soon as it passes the limit, declared or not`.

### `instance-claim/picture-interrupted`

If a picture upload ends before its body is whole, then the server MUST store nothing and keep the previous picture.

**Tests:** `compliance/owner-picture.test.ts › keeps the previous picture when an upload is cut off, and replaces it when one finishes`.

### `instance-claim/picture-replace`

When the server stores a new picture, the server MUST keep only the bytes of the new picture.

**Reason:** The owner has one picture, and the bytes of a replaced one are no longer wanted.

**Tests:** `compliance/owner-picture.test.ts › holds one picture, the last one stored`.

### `instance-claim/owner-avatar-address`

While the owner has a picture, the server MUST answer `avatar` in the owner as the instance's own address followed by `/owner/picture`, and while the owner has none as `null`.

**Tests:** `compliance/owner-picture.test.ts › stores a picture sent to the owner door and returns the owner`, `› removes the picture through either PATCH door and leaves the other fields as they were`.

### `instance-claim/picture-claim`

While the owner has a picture, the server MUST give the OIDC `picture` claim of an app that may read the avatar, in its ID token and at userinfo, as the address of `instance-claim/owner-avatar-address`.

**Tests:** `compliance/owner-picture.test.ts › gives an app that may read the avatar the picture's address, and no claim when there is none`.

### `instance-claim/picture-claim-none`

While the owner has no picture, the server MUST NOT give the OIDC `picture` claim in an ID token or at userinfo.

**Tests:** `compliance/owner-picture.test.ts › gives an app that may read the avatar the picture's address, and no claim when there is none`.

### `instance-claim/picture-served`

When a caller admitted by `instance-claim/picture-read-authority` sends `GET /owner/picture`, the server MUST return the stored bytes with the `Content-Type` decided when they were stored.

**Tests:** `compliance/owner-picture.test.ts › serves the stored bytes under the kind decided from them`.

### `instance-claim/picture-served-headers`

The server MUST send with every answer that carries the picture's bytes `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition: attachment; filename="picture"` and `Cache-Control: private, no-cache`.

**Reason:** The bytes are chosen by the sender and served from the instance's own origin, so they carry the safeguards of `blobs/download-sandbox`. A cache may keep the picture but must ask again before showing it.

**Tests:** `compliance/owner-picture.test.ts › serves the picture with the headers that keep its bytes from running`.

### `instance-claim/picture-validators`

When a caller sends `GET /owner/picture` with an `If-None-Match` that names the picture's `ETag`, the server MUST answer `304` with no body.

**Tests:** `compliance/owner-picture.test.ts › answers 304 to a validator that still matches, and sends the picture when it does not`.

### `instance-claim/picture-etag`

The server MUST send with the picture, as its `ETag`, the quoted SHA-256 of the picture's bytes in lowercase hexadecimal.

**Tests:** `compliance/owner-picture.test.ts › answers 304 to a validator that still matches, and sends the picture when it does not`.

### `instance-claim/picture-read-authority`

If a caller of `GET /owner/picture` is neither the signed-in owner nor a credential that holds profile read permission for `avatar`, then the server MUST refuse the request with `403 forbidden`.

**Reason:** The profile page tells the owner an app sees the picture only if the owner lets it.

**Tests:** `compliance/owner-picture.test.ts › serves the picture only to the owner and to a credential that may read the avatar`.

### `instance-claim/picture-none`

If the owner has no picture, then the server MUST answer `GET /owner/picture` from an admitted caller with `404 not_found`.

**Tests:** `compliance/owner-picture.test.ts › answers 404 when there is no picture, and again after it is removed`.

### `instance-claim/profile-email-owner-only`

When a credential holds wildcard or stored explicit profile write permission, the server MUST refuse email changes through `PATCH /profile`.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`.

### `instance-claim/profile-grant-closed`

If a key grant names a profile field outside `*`, `name`, `email`, and `avatar`, or requests write on `email`, then the server MUST refuse the grant.

**Tests:** `compliance/profile.test.ts › requires a recent direct owner and refuses explicit email-write grants`.

### `instance-claim/owner-update-email-unverified`

When `PATCH /owner` changes the stored email address, the server MUST clear email verification for that address.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/owner-update-password-identity`

If a password sign-in's submitted email no longer matches the owner's address when its session is created, then the server MUST refuse that sign-in.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/profile-email-write-scope`

If an OAuth registration, authorization, device initiation, consent decision, or token exchange explicitly names `profile.email:write`, then the server MUST refuse that request without granting a narrowed scope.

**Reason:** Apps can read the sign-in address but cannot change it.

**Tests:** `compliance/profile.test.ts › refuses explicit email-write OAuth scopes`.
