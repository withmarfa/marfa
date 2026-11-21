# Cloud

Linking an instance to Marfa Cloud, the optional service that gives it a public name. The owner starts a link with `POST /cloud/link`, approves it on Marfa Cloud, reads it with `GET /cloud/link` and ends it with `DELETE /cloud/link`; each needs `config.manage`. Marfa Cloud is at the origin the start-only setting `MARFA_CLOUD_URL` names.

## Who may link

### `cloud/permission`

When a caller that does not hold `config.manage` sends `POST /cloud/link`, `GET /cloud/link` or `DELETE /cloud/link`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/cloud-link.test.ts › refuses each door to a key that does not hold config.manage`.

## What the server sends

### `cloud/nothing-sent`

While no link has been started, the server MUST NOT send any request to the origin `MARFA_CLOUD_URL` names.

**Reason:** Marfa sends nothing about itself until its owner asks, and a link is the owner's ask.

**Tests:** `compliance/cloud-link.test.ts › sends nothing to Marfa Cloud until a link is started, across a restart, and then sends the start`.

### `cloud/url-origin`

If `MARFA_CLOUD_URL` is not an origin, or is an `http` origin on a name other than `localhost`, `127.0.0.1` or `[::1]`, then the server MUST refuse to start and name the setting.

**Reason:** a link carries the secrets that put the instance on the internet, so it is sent only over `https`, or to a Marfa Cloud on the same machine.

**Tests:** `compliance/cloud-link.test.ts › refuses to start with a MARFA_CLOUD_URL that is not an origin, or is plain http beyond loopback`.

## Starting a link

### `cloud/start-answers-code`

When a caller holding `config.manage` sends `POST /cloud/link` while no link is linking or linked, the server MUST answer `201` with `state` `linking` and, in `linking`, the `user_code`, `approval_url` and `expires_at` Marfa Cloud gave.

**Reason:** the owner approves the link on Marfa Cloud with the code, at the address.

**Tests:** `compliance/cloud-link.test.ts › answers a start with the code and the address to approve it at, and sends the instance's id, name and public port`.

### `cloud/start-sends`

When the server starts a link, the server MUST send Marfa Cloud the instance's `instance_id`, its `name` as `instance_name`, and the port of its public listener as `origin_port`.

**Reason:** Marfa Cloud's connector reaches the instance at that port on the machine it runs on.

**Tests:** `compliance/cloud-link.test.ts › answers a start with the code and the address to approve it at, and sends the instance's id, name and public port`.

### `cloud/start-exists`

While a link is linking or linked, when a caller sends `POST /cloud/link`, the server MUST answer `409 cloud_link_exists` and send nothing to Marfa Cloud.

**Tests:** `compliance/cloud-link.test.ts › refuses a second start while a link is linking, and while it is linked`.

### `cloud/start-no-listener`

While the server runs with no public listener, when a caller sends `POST /cloud/link`, the server MUST answer `409 no_public_listener` and send nothing to Marfa Cloud.

**Reason:** Marfa Cloud reaches the instance only through its public listener.

**Tests:** `compliance/cloud-link.test.ts › refuses a start where the server has no public listener`.

### `cloud/start-unavailable`

If Marfa Cloud cannot be reached, does not answer in time, or answers a start other than with `201`, then the server MUST answer `503 cloud_unavailable` and keep no link.

**Tests:** `compliance/cloud-link.test.ts › answers 503 cloud_unavailable and keeps no link when Marfa Cloud cannot be reached`.

### `cloud/start-move-unconfirmed`

Where an instance has an owner, when a caller that may move the sign-in address sends `POST /cloud/link` with `sign_in_address` `move`, or without `sign_in_address`, and without `confirm_sign_in_address_change` `true`, the server MUST answer `409 sign_in_address_change_unconfirmed` with `details.consequences`, and send nothing to Marfa Cloud.

**Reason:** a link moves the sign-in address by default, which signs everyone out, so the owner confirms it as they would a change in `/config`.

**Tests:** `compliance/cloud-link.test.ts › refuses a start that moves the sign-in address without confirming it, names the consequences, and sends nothing`.

### `cloud/start-move-waiting`

When a caller that cannot move the sign-in address, such as a key, sends `POST /cloud/link` with `sign_in_address` `move`, the server MUST start the link and answer `sign_in_address.state` `waiting`.

**Reason:** a key may link the instance, but only a recent sign-in may move the sign-in address, so the move waits for one.

**Tests:** `compliance/cloud-link.test.ts › links on a start by a key, which cannot move the sign-in address, and leaves the move waiting with the next step`.

## While a link is linking

### `cloud/poll-interval`

While a link is linking, the server MUST NOT ask Marfa Cloud about it sooner than the `interval` of Marfa Cloud's last answer, including an answer of `slow_down`.

**Tests:** `compliance/cloud-link.test.ts › asks no sooner than the interval Marfa Cloud gives, and no sooner than a slow_down asks`.

### `cloud/approved-linked`

When Marfa Cloud answers that a link is approved, the server MUST set `state` `linked`, with the `name` and `address` Marfa Cloud gave and the `linked_at` it gives for them.

**Tests:** `compliance/cloud-link.test.ts › links once Marfa Cloud approves, with the name and address it gave, and keeps the sign-in address the start keeps`.

### `cloud/latest-credential`

When Marfa Cloud answers that a link is approved more than once, the server MUST use the link credential of the latest answer it read.

**Reason:** each answer replaces the credential before it, so an answer lost on the way leaves only a later one that works.

**Tests:** `compliance/cloud-link.test.ts › uses the credential of the latest approved answer when an earlier one is lost on the way`.

### `cloud/failed-reason`

When Marfa Cloud answers that a link is `denied`, `expired` or `refused`, the server MUST set `state` `failed` with that word as `failure.reason`, and with Marfa Cloud's message as `failure.message` for a refusal.

**Tests:** `compliance/cloud-link.test.ts › fails a link Marfa Cloud denies, lets expire or refuses, and says why`.

### `cloud/expires-unreached`

If the `expires_at` of a link that is linking passes while Marfa Cloud cannot be reached, then the server MUST set `state` `failed` with `failure.reason` `expired`.

**Tests:** `compliance/cloud-link.test.ts › lets a link expire at its time though Marfa Cloud cannot be reached`.

### `cloud/restart-resumes`

When the server starts again while a link is linking, the server MUST ask Marfa Cloud about it again.

**Tests:** `compliance/cloud-link.test.ts › asks about a link again after a restart while it is linking, and stays linked after a restart while it is linked`.

### `cloud/restart-linked`

When the server starts again while a link is linked, the server MUST answer the link as linked, with the same `name` and `address`.

**Tests:** `compliance/cloud-link.test.ts › asks about a link again after a restart while it is linking, and stays linked after a restart while it is linked`.

### `cloud/unreadable`

If a secret the server keeps for a link no longer opens, then the server MUST report `state` `failed` with `failure.reason` `unreadable`.

**Reason:** a stored value that does not read is reported, never quietly taken as none.

**Tests:** `compliance/cloud-link.test.ts › reports a link whose secrets no longer open as failed and unreadable`.

## The secrets of a link

### `cloud/secrets-unseen`

The server MUST NOT put a link's poll secret, tunnel token or link credential in an answer, an event or the audit log.

**Reason:** the tunnel token and the link credential put the instance on the internet under its name.

**Tests:** `compliance/cloud-link.test.ts › puts no secret of a link in an answer, an event, the audit log or an archive`.

## The sign-in address

### `cloud/move-after-approval`

Where a link was started with `sign_in_address` `move`, by a caller that may move the sign-in address and confirmed it, when the link is linked, the server MUST move `sign_in_address` to the link's `address`.

**Reason:** the owner confirmed the move when they started the link, and the address is not known until Marfa Cloud approves it.

**Tests:** `compliance/cloud-link.test.ts › moves the sign-in address to the Cloud address once linked, as the start confirmed, and ends the sessions`.

### `cloud/move-ends-sessions`

When the server moves the sign-in address to a link's `address`, the server MUST end every browser session and every app's sign-in, as a confirmed move in `/config` does.

**Tests:** `compliance/cloud-link.test.ts › moves the sign-in address to the Cloud address once linked, as the start confirmed, and ends the sessions`.

### `cloud/move-checked`

While a link's `address` does not answer as this instance, the server MUST NOT move the sign-in address to it.

**Reason:** a sign-in address that does not reach the instance would lock its owner out.

**Tests:** `compliance/cloud-link.test.ts › holds a move pending while the Cloud address does not answer as this instance`.

### `cloud/move-pending`

While the server holds back a move of the sign-in address to a link's `address` that the start confirmed, the server MUST answer `sign_in_address.state` `pending`.

**Tests:** `compliance/cloud-link.test.ts › holds a move pending while the Cloud address does not answer as this instance`.

### `cloud/move-waiting-step`

While a link is linked and its move of the sign-in address is waiting, the server MUST answer, in `sign_in_address.next_step`, the request that makes the move.

**Tests:** `compliance/cloud-link.test.ts › links on a start by a key, which cannot move the sign-in address, and leaves the move waiting with the next step`.

### `cloud/keep`

Where a link was started with `sign_in_address` `keep`, the server MUST NOT move the sign-in address.

**Tests:** `compliance/cloud-link.test.ts › links once Marfa Cloud approves, with the name and address it gave, and keeps the sign-in address the start keeps`.

### `cloud/keep-reported`

While the sign-in address is not a link's `address` and the server does not hold back or wait to move it there, the server MUST answer `sign_in_address.state` `kept`.

**Tests:** `compliance/cloud-link.test.ts › links once Marfa Cloud approves, with the name and address it gave, and keeps the sign-in address the start keeps`.

## Unlinking

### `cloud/unlink-tells`

When a caller sends `DELETE /cloud/link` while a link is linked, the server MUST tell Marfa Cloud to unlink it and answer `200` with `state` `not_linked` and `service_told` `true`.

**Tests:** `compliance/cloud-link.test.ts › tells Marfa Cloud as it unlinks, and answers not_linked`.

### `cloud/unlink-untold`

If Marfa Cloud cannot be reached when a caller unlinks, then the server MUST answer `200` with `state` `not_linked` and `service_told` `false`, and tell Marfa Cloud once it can be reached.

**Reason:** the owner can always end a link, and Marfa Cloud then takes down the name.

**Tests:** `compliance/cloud-link.test.ts › unlinks while Marfa Cloud cannot be reached, says it was not told, and tells it once it can be`.

### `cloud/unlink-puts-back`

When a caller that may move the sign-in address sends `DELETE /cloud/link` with `confirm_sign_in_address_change=true` while the sign-in address is the link's `address`, the server MUST put back the sign-in address that was in force before the link moved it.

**Tests:** `compliance/cloud-link.test.ts › puts back the sign-in address the link moved only with a recent sign-in and confirmation, and otherwise unlinks nothing`.

### `cloud/unlink-move-refused`

While the sign-in address is a link's `address`, when a caller sends `DELETE /cloud/link` that `PATCH /config` would refuse for moving the sign-in address back, the server MUST refuse it in the same way and unlink nothing.

**Reason:** putting the sign-in address back signs everyone out, as any move does.

**Tests:** `compliance/cloud-link.test.ts › puts back the sign-in address the link moved only with a recent sign-in and confirmation, and otherwise unlinks nothing`.

### `cloud/unlink-not-linked`

While no link is linking, linked or failed, when a caller sends `DELETE /cloud/link`, the server MUST answer `200` with `state` `not_linked`.

**Tests:** `compliance/cloud-link.test.ts › answers not_linked to an unlink when nothing is linked`.

### `cloud/cancel`

When a caller sends `DELETE /cloud/link` while a link is linking, the server MUST answer `200` with `state` `not_linked`, and tell Marfa Cloud to unlink it if Marfa Cloud approves it before it expires.

**Reason:** Marfa Cloud has no request that withdraws a link waiting for approval, so the server watches it until it expires.

**Tests:** `compliance/cloud-link.test.ts › cancels a link waiting for approval, and unlinks it if Marfa Cloud approves it later`.

## Reading a link

### `cloud/status-not-linked`

While no link has been started, when a caller sends `GET /cloud/link`, the server MUST answer `200` with `state` `not_linked` and no other field.

**Tests:** `compliance/cloud-link.test.ts › sends nothing to Marfa Cloud until a link is started, across a restart, and then sends the start`.

### `cloud/status-connector`

While a link is linked, the server MUST answer, in `connector`, the `state` of the connector that carries the instance's traffic and `since` when it took that state.

**Tests:** `compliance/cloud-link.test.ts › links once Marfa Cloud approves, with the name and address it gave, and keeps the sign-in address the start keeps`.

## Events and the audit log

### `cloud/event`

When a link's `state` or its `sign_in_address.state` changes, the server MUST announce one `cloud_link.changed` event carrying the link as `GET /cloud/link` answers it, in `cloud_link`.

**Reason:** an app shows a link's progress from the stream rather than reading it again and again.

**Tests:** `compliance/cloud-link.test.ts › announces each change of a link on the stream of a credential holding config.manage, and on no other`.

### `cloud/event-reader`

The server MUST send a `cloud_link.changed` event only on a stream whose credential holds `config.manage`, that names no `type` and is not a copy stream.

**Tests:** `compliance/cloud-link.test.ts › announces each change of a link on the stream of a credential holding config.manage, and on no other`.

### `cloud/audited`

When a link is started, linked, failed or unlinked, or the server moves the sign-in address to a link's `address`, the server MUST record it in the audit log with the action `cloud.link_start`, `cloud.linked`, `cloud.link_failed`, `cloud.unlink` or `cloud.sign_in_address_move`.

**Tests:** `compliance/cloud-link.test.ts › records the start, the link, the move of the sign-in address and the unlink in the audit log`, `› fails a link Marfa Cloud denies, lets expire or refuses, and says why`.
