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

**Tests:** `compliance/owner.test.ts › validates the password without consuming valid setup proof`, `› creates exactly one owner and reads it through the local command`.

### `instance-claim/owner-undeclared-key`

If `POST /owner` carries a top-level body key the operation does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields` without consuming valid setup proof.

**Reason:** a misspelled `password` or `name` would otherwise be dropped, and the one owner of the instance would be created from a request the caller did not make.

**Tests:** `compliance/owner.test.ts › refuses a key the claim does not declare without consuming valid setup proof`.

### `instance-claim/setup-undeclared-key`

If `POST /setup/exchange` or `POST /setup/claim`, with a JSON body or a form, carries a key the setup page's request does not declare, then the server MUST answer `400 validation_error` naming each such key in `details.unknown_body_fields` without consuming valid setup proof.

**Reason:** these two doors are the browser's way to the same claim as `POST /owner`, which refuses an undeclared key, so a key dropped here would be a claim half performed and answered as success.

**Tests:** `compliance/owner.test.ts › refuses a key the setup doors do not declare, in a JSON or a form body, without consuming valid setup proof`.

### `instance-claim/exchange-answer`

When `POST /setup/exchange`, sent as JSON, exchanges valid setup proof, the server MUST answer `200` with only `{"ok": true}`.

**Tests:** `compliance/owner.test.ts › answers an exchange sent as JSON with only ok, and the setup cookie`.

### `instance-claim/owner-created`

When valid setup proof claims an unclaimed instance with valid owner details, the server MUST answer `201` with the owner's `id`, lowercased `email`, `name`, and `created_at`.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and reads it through the local command`, `› answers the setup routes in snake_case and the claim as the public claim does`.

### `instance-claim/claim-signs-in`

When a valid claim that carries the instance's own origin in its `Origin` header creates the owner and the password sign-in that follows it succeeds, the server MUST set in the same answer the owner session cookie that password sign-in sets, so that `GET /owner/passkeys` with it answers `200` and the session counts as a sign-in within the last five minutes.

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

**Tests:** `compliance/owner.test.ts › answers the setup routes in snake_case and the claim as the public claim does`, `› creates exactly one owner and reads it through the local command`, `› keeps a completed claim and recovered password through restart`.

### `instance-claim/ticket-fields`

When the private local command requests browser setup, the server MUST answer the handoff `ticket`, its setup `url`, and `expires_at` as an ISO 8601 instant in UTC.

**Reason:** The expiry takes the same form as every other time field, so a script compares it with them without a conversion.

**Tests:** `compliance/owner.test.ts › answers the setup routes in snake_case and the claim as the public claim does`, `› expires a handoff after five minutes while its exchanged setup session remains usable`.

### `instance-claim/claim-closed`

While an instance has a completed owner claim, the server MUST refuse another claim or setup-code issuance with `409 owner_exists`.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and reads it through the local command`, `› recovers the existing owner and ends the old browser session`.

### `instance-claim/claim-address-stored`

Where `MARFA_CLAIM_ADDRESS` is set, when an instance with no owner starts, the server MUST store that address as its sign-in address.

**Reason:** An instance on a remote host may offer no shell on its machine, so its operator cannot set the sign-in address through the private socket before a claim from off the machine.

**Tests:** `compliance/remote-claim.test.ts › stores MARFA_CLAIM_ADDRESS as the sign-in address of an instance with no owner, and names the full setup address in the setup code's line`, `› leaves an owned instance's sign-in address as the owner set it, and logs at each start that MARFA_CLAIM_ADDRESS is ignored`.

### `instance-claim/claim-address-refused`

If `MARFA_CLAIM_ADDRESS` is not an origin that starts with `https://` or names `localhost`, `127.0.0.1` or `[::1]`, then the server MUST exit with status 1 instead of starting.

**Tests:** `compliance/remote-claim.test.ts › refuses to start on a MARFA_CLAIM_ADDRESS that is %s, naming the setting`.

### `instance-claim/claim-address-refused-line`

If `MARFA_CLAIM_ADDRESS` is not an origin that starts with `https://` or names `localhost`, `127.0.0.1` or `[::1]`, then the server MUST log one refusal line that names `MARFA_CLAIM_ADDRESS`.

**Tests:** `compliance/remote-claim.test.ts › refuses to start on a MARFA_CLAIM_ADDRESS that is %s, naming the setting`.

### `instance-claim/claim-address-owned`

While an instance has an owner, the server MUST leave its stored sign-in address unchanged by `MARFA_CLAIM_ADDRESS`.

**Reason:** The owner moves the sign-in address through the private socket, and a setting left in a host's environment must not undo that move or a restored backup's address.

**Tests:** `compliance/remote-claim.test.ts › leaves an owned instance's sign-in address as the owner set it, and logs at each start that MARFA_CLAIM_ADDRESS is ignored`.

### `instance-claim/claim-address-ignored`

Where `MARFA_CLAIM_ADDRESS` names an address other than the stored sign-in address, when an instance with an owner starts, the server MUST log one line saying that `MARFA_CLAIM_ADDRESS` is ignored.

**Tests:** `compliance/remote-claim.test.ts › leaves an owned instance's sign-in address as the owner set it, and logs at each start that MARFA_CLAIM_ADDRESS is ignored`.

### `instance-claim/claim-address-not-request`

The server MUST NOT take its sign-in address from a request's `Host`, `X-Forwarded-Host` or client address header.

**Reason:** Anyone who reaches the public port chooses those headers, and the sign-in address decides where the owner's cookies and passkeys belong.

**Tests:** `compliance/remote-claim.test.ts › never takes the sign-in address from a request's Host, X-Forwarded-Host or client address header`.

### `instance-claim/claim-needs-address`

If a caller off the instance's machine asks to claim an instance that has no sign-in address, then the server MUST answer `403 forbidden`.

**Tests:** `compliance/remote-claim.test.ts › claims from a caller off this machine once MARFA_CLAIM_ADDRESS has stored the sign-in address, and refuses it 403 without`, `› never takes the sign-in address from a request's Host, X-Forwarded-Host or client address header`.

### `instance-claim/public-claim-address`

When a caller off the instance's machine claims, with a valid setup code, an instance whose sign-in address `MARFA_CLAIM_ADDRESS` stored, the server MUST create the owner.

**Tests:** `compliance/remote-claim.test.ts › claims from a caller off this machine once MARFA_CLAIM_ADDRESS has stored the sign-in address, and refuses it 403 without`.

### `instance-claim/setup-code-address`

When an instance with no owner and a stored sign-in address starts, the server MUST log its setup code with the setup page's full address, the sign-in address followed by `/setup`.

**Tests:** `compliance/remote-claim.test.ts › stores MARFA_CLAIM_ADDRESS as the sign-in address of an instance with no owner, and names the full setup address in the setup code's line`.

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

## Ownership and recovery

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

### `instance-claim/recovery-code-issued`

Where `MARFA_OWNER_RECOVERY` is on, when an instance with an owner starts, the server MUST print one recovery code to its log.

**Reason:** An instance on a remote host may offer no shell on its machine, so its log is the one place only the operator reads.

**Tests:** `compliance/remote-claim.test.ts › prints a recovery code at each start of an instance with an owner while MARFA_OWNER_RECOVERY is on, and ends it at a start with the setting off`.

### `instance-claim/recovery-code-off`

When an instance starts with `MARFA_OWNER_RECOVERY` off, the server MUST answer `POST /setup/exchange` with a recovery code an earlier start printed with `409 owner_exists`.

**Tests:** `compliance/remote-claim.test.ts › prints a recovery code at each start of an instance with an owner while MARFA_OWNER_RECOVERY is on, and ends it at a start with the setting off`.

### `instance-claim/recovery-code-off-recover`

When an instance starts with `MARFA_OWNER_RECOVERY` off, the server MUST answer `POST /setup/recover` with a recovery code an earlier start printed with `401 setup_proof_invalid`.

**Tests:** `compliance/remote-claim.test.ts › prints a recovery code at each start of an instance with an owner while MARFA_OWNER_RECOVERY is on, and ends it at a start with the setting off`.

### `instance-claim/recovery-code-unowned`

While an instance has no owner, the server MUST NOT print a recovery code.

**Tests:** `compliance/remote-claim.test.ts › prints no recovery code and creates no owner while the instance has none`, `› prints a recovery code at each start of an instance with an owner while MARFA_OWNER_RECOVERY is on, and ends it at a start with the setting off`.

### `instance-claim/recovery-no-owner`

While an instance has no owner, the server MUST answer `POST /setup/recover` with `404 owner_not_found`.

**Tests:** `compliance/remote-claim.test.ts › prints no recovery code and creates no owner while the instance has none`.

### `instance-claim/recovery-code-replaced`

When an instance starts again, the server MUST refuse the recovery code an earlier start printed with `401 setup_proof_invalid`.

**Tests:** `compliance/remote-claim.test.ts › replaces the recovery code at each start and refuses the replaced one`.

### `instance-claim/recovery-code-expiry`

If a recovery code is presented 60 minutes or more after the start that printed it, then the server MUST refuse it with `401 setup_proof_invalid`.

**Tests:** `compliance/remote-claim.test.ts › refuses a recovery code sixty minutes after the start that printed it`.

### `instance-claim/recovery-code-single-use`

When a recovery code has been accepted once, the server MUST refuse that code again with `401 setup_proof_invalid`.

**Tests:** `compliance/remote-claim.test.ts › spends a recovery code at its first use`.

### `instance-claim/recovery-page`

While an instance holds a recovery code that has not ended, the server MUST serve `GET /setup` as a page titled "Recover the owner" that takes the recovery code.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› refuses a recovery code sixty minutes after the start that printed it`.

### `instance-claim/recovery-password-form`

When `POST /setup/exchange` accepts a recovery code, the server MUST set a setup cookie with which `GET /setup` serves the form for the owner's new password.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`.

### `instance-claim/recovery-code-password`

When `POST /setup/recover` sets a new password with a recovery code or its setup cookie, the server MUST accept the new password at password sign-in.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› leaves after a recovery by code the state the private socket's recovery leaves`.

### `instance-claim/recovery-code-old-password`

When `POST /setup/recover` sets a new password with a recovery code or its setup cookie, the server MUST refuse the replaced password at password sign-in.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› leaves after a recovery by code the state the private socket's recovery leaves`.

### `instance-claim/recovery-code-same-owner`

When `POST /setup/recover` sets a new password, the server MUST retain the owner's identity.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› leaves after a recovery by code the state the private socket's recovery leaves`.

### `instance-claim/recovery-code-ends-browsers`

When `POST /setup/recover` sets a new password, the server MUST end every existing browser session.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› leaves after a recovery by code the state the private socket's recovery leaves`.

### `instance-claim/recovery-code-keeps-keys`

When `POST /setup/recover` sets a new password, the server MUST preserve existing ordinary keys.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› leaves after a recovery by code the state the private socket's recovery leaves`.

### `instance-claim/recovery-code-keeps-apps`

When `POST /setup/recover` sets a new password, the server MUST preserve connected apps' access tokens.

**Tests:** `compliance/remote-claim.test.ts › recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps`, `› leaves after a recovery by code the state the private socket's recovery leaves`.

### `instance-claim/recovery-password-rules`

If the new password sent to `POST /setup/recover` is shorter than 8 or longer than 128 characters, then the server MUST refuse it with `400 validation_error`.

**Tests:** `compliance/remote-claim.test.ts › refuses a new password the private socket's recovery refuses, and keeps the code for another try`.

### `instance-claim/recovery-refused-keeps-code`

When `POST /setup/recover` refuses a new password with `400 validation_error`, the server MUST keep the recovery code it was sent with.

**Tests:** `compliance/remote-claim.test.ts › refuses a new password the private socket's recovery refuses, and keeps the code for another try`.

### `instance-claim/recovery-attempt-limit`

If an address has made ten recovery code attempts in fifteen minutes, then the server MUST refuse its next attempt with `429 rate_limited`.

**Tests:** `compliance/remote-claim.test.ts › limits recovery code attempts to ten per address in fifteen minutes`.

### `instance-claim/recovery-code-concurrent`

When two requests with the same recovery code arrive at once, the server MUST accept only one of them and refuse the other with `401 setup_proof_invalid`.

**Tests:** `compliance/remote-claim.test.ts › accepts only one of two uses of a recovery code sent at once, to recover and to exchange`.

### `instance-claim/recovery-code-private`

The server MUST NOT write a recovery code to its request log or to its health answer.

**Tests:** `compliance/remote-claim.test.ts › leaves the recovery code out of the request log and the health answer`.

## Durability

### `instance-claim/unclaimed-restart-proof`

When an unclaimed instance restarts, the server MUST refuse its previous setup code with `401 setup_proof_invalid`.

**Tests:** `compliance/owner.test.ts › replaces unclaimed setup proof on restart`.

### `instance-claim/concurrent-claim`

When valid claims compete for an unclaimed instance, the server MUST commit exactly one owner claim and one corresponding `owner.claimed` audit record.

**Tests:** `compliance/owner.test.ts › creates exactly one owner and reads it through the local command`.

### `instance-claim/claimed-restart`

When a claimed instance restarts, the server MUST retain its completed claim and owner identity.

**Tests:** `compliance/owner.test.ts › keeps a completed claim and recovered password through restart`.

### `instance-claim/recovery-clears-sign-in-lock`

When the private local command recovers the owner's password, the server MUST permit password sign-in from any address despite every password sign-in limit spent before the recovery.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`.

### `instance-claim/recovery-keeps-keys`

When the private local command recovers the owner's password, the server MUST preserve existing ordinary keys.

**Tests:** `compliance/owner.test.ts › recovers the existing owner and ends the old browser session`, `› keeps a completed claim and recovered password through restart`.

### `instance-claim/management-metrics`

When a credential with `instance.read` requests `GET /metrics`, the server MUST return its instance-wide counters using the schema published for that operation.

**Tests:** `compliance/metrics.test.ts › reports documented instance-wide counters with instance.read`.

### `instance-claim/management-metrics-resources`

When a credential with `instance.read` requests `GET /metrics`, the server MUST include a `process` block holding its `version` and the memory and CPU its process uses, each figure but the version a number, or `null` where the server cannot read it.

**Tests:** `compliance/metrics.test.ts › reports documented instance-wide counters with instance.read`.

### `instance-claim/management-metrics-storage`

When a credential with `instance.read` requests `GET /metrics`, the server MUST include a `storage` block holding the size of its database, the size of its write-ahead log and the row counts of its largest tables, each a number, or `null` where the server cannot read it.

**Tests:** `compliance/metrics.test.ts › reports documented instance-wide counters with instance.read`.

### `instance-claim/management-metrics-current`

When a credential with `instance.read` requests `GET /metrics`, the server MUST count the items, blobs, types, keys, webhooks and storage rows from the database as it stands when the request is read, the first request included.

**Reason:** A count kept for a while and reported later is a figure about the past, and an owner looks at `GET /metrics` to see the instance now.

**Tests:** `compliance/metrics.test.ts › counts the instance as it stands when asked, with the first request as with any other`.

### `instance-claim/control-only-recovery`

Where control-only mode is enabled, when another process holds the configured public HTTP port, the server MUST allow local password recovery through its private control connection.

**Tests:** `compliance/instance-lifecycle.test.ts › recovers the existing owner in control-only mode while the public port is taken`.

## Owner and delegated profile changes

### `instance-claim/profile-owner-unavailable`

While the instance is unclaimed, the server MUST answer the private local command's `PATCH /owner` and `PUT /owner/avatar` with `404 owner_not_found` without creating an owner or storing an avatar.

**Reason:** An update or an upload cannot stand in for the claim that creates the owner.

**Tests:** `compliance/profile.test.ts › refuses an owner update and an avatar upload from the local command while the instance is unclaimed`.

### `instance-claim/owner-update`

When the private local command submits a valid nonempty `PATCH /owner` with `email`, `name`, `avatar` set to `null`, or any combination of them, the server MUST return the updated owner.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`, `compliance/owner-avatar.test.ts › removes the avatar through either PATCH door and leaves the other fields as they were`, `compliance/profile.test.ts › requires the private local command and refuses explicit email-write grants`.

### `instance-claim/owner-avatar`

When `PATCH /owner` receives `avatar` set to `null`, the server MUST remove the owner's avatar and answer `avatar` as `null` at `GET /owner` and `PATCH /owner`.

**Reason:** An avatar is set by sending its bytes, so the one value `avatar` takes in an update is the one that removes it.

**Tests:** `compliance/owner-avatar.test.ts › removes the avatar through either PATCH door and leaves the other fields as they were`.

### `instance-claim/owner-update-authority`

If `PATCH /owner` lacks private local authority, then the server MUST refuse the request.

**Reason:** Email determines the owner's password sign-in identity, and the other fields are the owner's visible profile.

**Tests:** `compliance/profile.test.ts › requires the private local command and refuses explicit email-write grants`.

### `instance-claim/owner-update-identity`

When `PATCH /owner` changes email, name, or avatar, the server MUST preserve the owner's ID, password, passkeys, sessions, ordinary keys, and app grants.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/owner-update-email`

When `PATCH /owner` changes email, the server MUST store the lowercase address without requiring email confirmation.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/profile-input`

If an owner or delegated profile update contains no field, an unknown field, an invalid email address, an empty trimmed name, a name longer than 200 Unicode code points, a name containing a control or bidirectional control character before trimming, or an avatar other than null, a web address included, then the server MUST refuse the whole update with `400 validation_error`.

**Reason:** An address names an avatar that lives somewhere else, and the owner's avatar is held by the instance.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`, `compliance/owner-avatar.test.ts › refuses a web address as the avatar and changes nothing`.

### `instance-claim/delegated-profile-update`

When a key or app submits a valid nonempty `PATCH /profile` containing only `name`, `avatar` set to `null`, or both and holds current profile write permission for every submitted field, the server MUST change those fields and return the profile fields the credential may read, as `GET /profile` answers them.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`.

### `instance-claim/delegated-profile-atomic`

If a key or app submits `PATCH /profile` with a field it lacks current write permission for, or loses write permission for before the server stores the change, then the server MUST refuse the request with `403` and leave every submitted field as it was.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`, `› refuses a name change when the key loses its permission after the request was admitted, and makes it when the key does not`.

### `instance-claim/owner-avatar-upload`

When the private local command sends `PUT /owner/avatar` with the bytes of a PNG, JPEG or WebP avatar, the server MUST store them as the owner's avatar and return the updated owner.

**Tests:** `compliance/owner-avatar.test.ts › stores an avatar sent to the owner door and returns the owner`, `› stores an avatar sent through the private local command`.

### `instance-claim/profile-avatar-upload`

When a key or app that holds current profile write permission for `avatar` sends `PUT /profile/avatar` with the bytes of a PNG, JPEG or WebP avatar, the server MUST store them as the owner's avatar and return the profile fields the credential may read, as `GET /profile` answers them.

**Tests:** `compliance/owner-avatar.test.ts › stores an avatar sent to the profile door by a credential that may write the avatar`.

### `instance-claim/owner-avatar-authority`

If `PUT /owner/avatar` lacks private local authority, then the server MUST refuse the request and keep the previous avatar.

**Tests:** `compliance/owner-avatar.test.ts › refuses an avatar from a caller the door does not admit, and keeps the previous one`.

### `instance-claim/profile-avatar-authority`

If a credential sending `PUT /profile/avatar` lacks current profile write permission for `avatar`, then the server MUST refuse the request with `403 forbidden` and keep the previous avatar.

**Tests:** `compliance/owner-avatar.test.ts › refuses an avatar from a caller the door does not admit, and keeps the previous one`.

### `instance-claim/avatar-kind-from-bytes`

When the server stores an avatar, the server MUST decide the avatar's kind from the bytes alone, whatever the `Content-Type` and the file name of the request claim.

**Reason:** A claimed type or name is chosen by the sender, and the kind decides how a browser treats the bytes when it is served.

**Tests:** `compliance/owner-avatar.test.ts › decides the kind from the bytes and not from what the request claims`.

### `instance-claim/avatar-kind-refused`

If the body of an avatar upload is not a PNG, a JPEG or a WebP, a GIF, an AVIF, an SVG, a page and a text file included, then the server MUST refuse it with `400 validation_error` and keep the previous avatar.

**Reason:** An SVG or a page can carry script, and the other kinds are not yet drawn by every app that reads the avatar.

**Tests:** `compliance/owner-avatar.test.ts › refuses a body that is not a PNG, JPEG or WebP, whatever the request claims`.

### `instance-claim/avatar-empty`

If the body of an avatar upload is empty, then the server MUST refuse it with `400 validation_error` and keep the previous avatar.

**Tests:** `compliance/owner-avatar.test.ts › refuses an empty body and an avatar cut short, and keeps the previous one`.

### `instance-claim/avatar-damaged`

If the body of an avatar upload begins as a PNG, a JPEG or a WebP and is cut short or damaged, then the server MUST refuse it with `400 validation_error` and keep the previous avatar.

**Reason:** An avatar that stops short draws as a broken image on every page that shows it. The server judges a file whole by the marks that end it, not by decoding it: a PNG is a chain of chunks that ends in `IEND` as its last twelve bytes and holds an `IDAT`, a WebP declares in its `RIFF` header a size equal to the file's size less eight, and a JPEG is a baseline, extended sequential or progressive frame whose first scan is followed by the end-of-image marker. A file that has more or less than it declares is damaged.

**Tests:** `compliance/owner-avatar.test.ts › refuses an empty body and an avatar cut short, and keeps the previous one`.

### `instance-claim/avatar-dimensions`

If the header of an avatar gives a width or a height of zero or of more than 4096 pixels, then the server MUST refuse the upload with `400 validation_error` and keep the previous avatar.

**Tests:** `compliance/owner-avatar.test.ts › accepts 4096 pixels on a side and refuses none and 4097`.

### `instance-claim/avatar-size`

If the body of an avatar upload is larger than 2097152 bytes, then the server MUST refuse it with `413 request_too_large` and keep the previous avatar.

**Reason:** The avatar is held in the instance's database and read again on every page that shows it.

**Tests:** `compliance/owner-avatar.test.ts › accepts an avatar of exactly 2097152 bytes and refuses one byte more`.

### `instance-claim/avatar-size-early`

When the bytes of an avatar upload pass 2097152, whether or not the sender declared a length, the server MUST answer `413 request_too_large` before the sender has finished the body.

**Reason:** A server that read the rest first would hold, or wait on, a body it has already decided to refuse.

**Tests:** `compliance/owner-avatar.test.ts › refuses an oversize body as soon as it passes the limit, declared or not`.

### `instance-claim/avatar-interrupted`

If an avatar upload ends before its body is whole, then the server MUST store nothing and keep the previous avatar.

**Tests:** `compliance/owner-avatar.test.ts › keeps the previous avatar when an upload is cut off, and replaces it when one finishes`.

### `instance-claim/avatar-replace`

When the server has stored several avatars in turn, the server MUST serve at `GET /owner/avatar` no avatar but the last of them, including once that one is removed.

**Reason:** The owner has one avatar, and a replaced one is never served again.

**Tests:** `compliance/owner-avatar.test.ts › holds one avatar, the last one stored`.

### `instance-claim/owner-avatar-address`

While the owner has an avatar, the server MUST answer `avatar` in the owner as the instance's own address followed by `/owner/avatar`, and while the owner has none as `null`.

**Tests:** `compliance/owner-avatar.test.ts › stores an avatar sent to the owner door and returns the owner`, `› removes the avatar through either PATCH door and leaves the other fields as they were`.

### `instance-claim/profile-read`

When a credential sends `GET /profile`, the server MUST answer `200` with the owner's `name`, `email` and `avatar`, each only where the credential holds profile read permission for that field.

**Reason:** An app learns whom it acts for from the profile the owner let it read. `avatar` is the address `instance-claim/owner-avatar-address` names.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`, `compliance/owner-avatar.test.ts › gives an app that may read the avatar the avatar's address at its profile, and null when there is none`.

### `instance-claim/avatar-served`

When a caller admitted by `instance-claim/avatar-read-authority` sends `GET /owner/avatar`, the server MUST return the stored bytes with the `Content-Type` decided when they were stored.

**Tests:** `compliance/owner-avatar.test.ts › serves the stored bytes under the kind decided from them`.

### `instance-claim/avatar-served-headers`

The server MUST send with every answer over HTTP that carries the avatar's bytes `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition: attachment; filename="avatar"` and `Cache-Control: private, no-cache`.

**Reason:** The bytes are chosen by the sender and served from the instance's own origin, so they carry the safeguards of `blobs/download-sandbox`. A cache may keep the avatar but must ask again before showing it. The private local socket answers `Cache-Control: no-store`, as it answers everything.

**Tests:** `compliance/owner-avatar.test.ts › serves the avatar with the headers that keep its bytes from running`.

### `instance-claim/avatar-validators`

When a caller sends `GET /owner/avatar` with an `If-None-Match` that names the avatar's `ETag`, the server MUST answer `304` with no body.

**Tests:** `compliance/owner-avatar.test.ts › answers 304 to a validator that still matches, and sends the avatar when it does not`.

### `instance-claim/avatar-etag`

The server MUST send with the avatar, as its `ETag`, the quoted SHA-256 of the avatar's bytes in lowercase hexadecimal.

**Tests:** `compliance/owner-avatar.test.ts › answers 304 to a validator that still matches, and sends the avatar when it does not`.

### `instance-claim/avatar-read-authority`

If an authenticated caller of `GET /owner/avatar` is neither the private local command nor a credential that holds profile read permission for `avatar`, then the server MUST refuse the request with `403 forbidden`.

**Reason:** An app sees the owner's avatar only if the owner lets it. A request with no credential is answered `401 unauthorized` by `keys-and-oauth/no-credential`.

**Tests:** `compliance/owner-avatar.test.ts › serves the avatar only to the owner and to a credential that may read the avatar`, `compliance/unauthenticated.test.ts › answers 401 unauthorized on each of them`.

### `instance-claim/avatar-none`

If the owner has no avatar, then the server MUST answer `GET /owner/avatar` from an admitted caller with `404 not_found`.

**Tests:** `compliance/owner-avatar.test.ts › answers 404 when there is no avatar, and again after it is removed`.

### `instance-claim/profile-email-owner-only`

When a credential holds wildcard or stored explicit profile write permission, the server MUST refuse email changes through `PATCH /profile`.

**Tests:** `compliance/profile.test.ts › validates fields and limits credential writes to approved name and avatar`.

### `instance-claim/profile-grant-closed`

If a key grant names a profile field outside `*`, `name`, `email`, and `avatar`, or requests write on `email`, then the server MUST refuse the grant.

**Tests:** `compliance/profile.test.ts › requires the private local command and refuses explicit email-write grants`.

### `instance-claim/owner-update-password-identity`

If a password sign-in's submitted email no longer matches the owner's address when its session is created, then the server MUST refuse that sign-in.

**Tests:** `compliance/profile.test.ts › updates the existing owner and preserves credentials and sessions`.

### `instance-claim/profile-email-write-scope`

If an OAuth registration, authorization, device initiation, consent decision, or token exchange explicitly names `profile.email:write`, then the server MUST refuse that request without granting a narrowed scope.

**Reason:** Apps can read the sign-in address but cannot change it.

**Tests:** `compliance/profile.test.ts › refuses explicit email-write OAuth scopes`.
