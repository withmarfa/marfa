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

When a caller holding `config.manage` sends `POST /cloud/link` while no link is linking or linked, the server MUST answer `201` with `state` `linking` and, in `linking`, the `user_code` and `approval_url` Marfa Cloud gave and the link's `expires_at`.

**Reason:** the owner approves the link on Marfa Cloud with the code, at the address.

**Tests:** `compliance/cloud-link.test.ts › answers a start with the code and the address to approve it at, and sends the instance's id, name and the port of a listener of its own on 127.0.0.1`.

### `cloud/expires-own-clock`

When Marfa Cloud answers a start, the server MUST take as the link's `expires_at` the server's own time when it sent the start plus the `expires_in` seconds Marfa Cloud gave.

**Reason:** the host's clock and Marfa Cloud's can differ, and a link timed on one clock throughout neither lapses early nor waits on.

**Tests:** `compliance/cloud-link.test.ts › times a link on its own clock from the expires_in Marfa Cloud gave`.

### `cloud/start-sends`

When the server starts a link, the server MUST send Marfa Cloud the instance's `instance_id`, its `name` as `instance_name`, and as `origin_port` a port on `127.0.0.1` that no other program held as the link started, which the link keeps as long as it lasts.

**Reason:** Marfa Cloud's connector reaches the instance at that port on the machine it runs on, at the tunnel listener (`cloud/tunnel-listener-open`).

**Tests:** `compliance/cloud-link.test.ts › answers a start with the code and the address to approve it at, and sends the instance's id, name and the port of a listener of its own on 127.0.0.1`.

### `cloud/start-exists`

While a link is linking or linked, when a caller sends `POST /cloud/link`, the server MUST answer `409 cloud_link_exists` and send nothing to Marfa Cloud.

**Tests:** `compliance/cloud-link.test.ts › refuses a second start while a link is linking, and while it is linked`.

### `cloud/start-no-listener`

While the server runs with only its control socket (`MARFA_CONTROL_ONLY`), when a caller sends `POST /cloud/link`, the server MUST answer `409 no_public_listener` and send nothing to Marfa Cloud.

**Reason:** such a server runs no background work and serves nothing over the network, so it could neither follow a link nor serve the traffic Marfa Cloud carries.

**Tests:** `compliance/cloud-link.test.ts › refuses a start where the server has no public listener`.

### `cloud/start-any-listen-host`

When a caller sends `POST /cloud/link` while the public listener is bound to an address that `127.0.0.1` does not reach, the server MUST start the link as it would on any other address.

**Reason:** Marfa Cloud's connector reaches the tunnel listener on `127.0.0.1`, wherever the public listener is bound.

**Tests:** `compliance/cloud-link.test.ts › starts a link where the public listener is not reached at 127.0.0.1, and listens for the connector there`.

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

**Tests:** `compliance/cloud-link.test.ts › asks no sooner than the interval Marfa Cloud gives, and no sooner than a slow_down asks`, `› polls again no sooner than the interval when Marfa Cloud refuses the credential just after approving`, `› keeps a poll's answer when the write after it fails, and polls again no sooner than the interval it gave`.

### `cloud/refused-credential-polls`

When Marfa Cloud answers `401` with `error.code` `unauthorized` to the link credential of a link the server holds a poll secret for, the server MUST ask Marfa Cloud about the link again with the poll secret, no sooner than the `interval` of Marfa Cloud's last answer.

**Reason:** each approved answer replaces the credential before it, so a credential refused just after approval means a newer one waits, not that the link ended.

**Tests:** `compliance/cloud-link.test.ts › polls again no sooner than the interval when Marfa Cloud refuses the credential just after approving`, `› watches a link whose cancel Marfa Cloud did not take, and unlinks it if Marfa Cloud approves it later`.

### `cloud/failure-retried`

If a request or a write the server makes to follow a link fails, then the server MUST try it again within ten seconds of its first failure, or, where the `interval` of Marfa Cloud's last answer is longer, within that interval.

**Reason:** a passing failure, such as a busy database, would otherwise hold a link for minutes, and `cloud/poll-interval` sets how soon Marfa Cloud may be asked again.

**Tests:** `compliance/cloud-link.test.ts › keeps following a link after a write of it fails, and links soon after`, `› keeps a poll's answer when the write after it fails, and polls again no sooner than the interval it gave`.

### `cloud/answer-kept`

If the server fails to write what Marfa Cloud answered about a link that is linking, then the server MUST write that answer again before it asks Marfa Cloud about the link again.

**Reason:** asking again to make up for a failed write of the server's own would ask Marfa Cloud sooner than its interval, and a later answer may no longer say why a link ended.

**Tests:** `compliance/cloud-link.test.ts › keeps a poll's answer when the write after it fails, and polls again no sooner than the interval it gave`.

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

### `cloud/late-approval`

While a link is linking and Marfa Cloud answers `pending`, the server MUST keep asking Marfa Cloud about it after its `expires_at`, until ten minutes after it.

**Reason:** Marfa Cloud answers an approved link for ten minutes after the approval, even past `expires_at`, and answers `pending` until the name is ready.

**Tests:** `compliance/cloud-link.test.ts › keeps asking past a link's time while Marfa Cloud answers pending, and links on the late approval`.

### `cloud/expires-unreached`

If ten minutes past the `expires_at` of a link that is linking pass while Marfa Cloud has not approved it, then the server MUST set `state` `failed` with `failure.reason` `expired`, though Marfa Cloud cannot be reached.

**Tests:** `compliance/cloud-link.test.ts › lets a link expire ten minutes past its time though Marfa Cloud cannot be reached`.

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

### `cloud/move-already-there`

While the sign-in address is already a link's `address`, the server MUST NOT write the configuration or record `cloud.sign_in_address_move` to carry out the move the start confirmed.

**Reason:** the move has nothing left to do, and trying it again and again would fill the audit log.

**Tests:** `compliance/cloud-link.test.ts › takes a confirmed move as done where the sign-in address is already the Cloud address, and writes and records nothing for it`.

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

### `cloud/move-lapses`

While a link is linked, when fifteen minutes have passed since Marfa Cloud approved it and the server has not moved the sign-in address that the start confirmed moving, the server MUST answer `sign_in_address.state` `waiting`.

**Reason:** the owner confirmed a move to a name that answers soon after approval, and a move long after it would sign everyone out unexpectedly.

**Tests:** `compliance/cloud-link.test.ts › lets a confirmed move wait for a person fifteen minutes after approval while the Cloud address does not answer`.

### `cloud/move-not-after-lapse`

If fifteen minutes have passed since Marfa Cloud approved a link when the server would write the move of the sign-in address that the start confirmed, then the server MUST NOT move the sign-in address.

**Reason:** the check that the address answers can take a while, and a move written after it lapses would sign everyone out unexpectedly.

**Tests:** `compliance/cloud-link.test.ts › does not move the sign-in address once fifteen minutes have passed since approval, though the Cloud address answers while the move is checked`.

### `cloud/move-waiting-step`

While a link is linked and its move of the sign-in address is waiting, the server MUST answer, in `sign_in_address.next_step`, the request that makes the move.

**Tests:** `compliance/cloud-link.test.ts › links on a start by a key, which cannot move the sign-in address, and leaves the move waiting with the next step`, `› lets a confirmed move wait for a person fifteen minutes after approval while the Cloud address does not answer`.

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

### `cloud/unlink-kept`

While Marfa Cloud has not been told of an unlink, the server MUST keep trying to tell it, across restarts and however long it takes, until Marfa Cloud answers `200`, or `401` with `error.code` `unauthorized`.

**Reason:** a link Marfa Cloud is never told of keeps the instance's name on the internet.

**Tests:** `compliance/cloud-link.test.ts › keeps an untold unlink past a day and a restart, and tells Marfa Cloud soon after the start`.

### `cloud/unlink-at-start`

When the server starts while Marfa Cloud has not been told of an unlink, the server MUST try to tell it within a minute.

**Tests:** `compliance/cloud-link.test.ts › keeps an untold unlink past a day and a restart, and tells Marfa Cloud soon after the start`.

### `cloud/unlink-untold-reported`

While Marfa Cloud has not been told of an unlink and no link is linking, linked or failed, when a caller sends `GET /cloud/link`, the server MUST answer `state` `not_linked` with `service_told` `false`.

**Tests:** `compliance/cloud-link.test.ts › unlinks while Marfa Cloud cannot be reached, says it was not told, and tells it once it can be`, `› keeps an untold unlink past a day and a restart, and tells Marfa Cloud soon after the start`.

### `cloud/unauthorized-only`

If Marfa Cloud answers a request made with a link credential with `401` and an `error.code` other than `unauthorized`, then the server MUST NOT end the link or take the answer as telling Marfa Cloud of an unlink.

**Reason:** only Marfa Cloud's own `unauthorized` says the credential is unknown; any other `401`, such as one from a proxy in the way, is a failure to try again.

**Tests:** `compliance/cloud-link.test.ts › keeps a link whose check Marfa Cloud answers 401 with a code other than unauthorized`.

### `cloud/unlink-puts-back`

When a caller that may move the sign-in address sends `DELETE /cloud/link` with `confirm_sign_in_address_change=true` while the sign-in address is the link's `address`, the server MUST move the sign-in address to the address `cloud/put-back-target` names.

**Tests:** `compliance/cloud-link.test.ts › puts back the sign-in address the link moved only with a recent sign-in and confirmation, and otherwise unlinks nothing`, `› puts back the sign-in address in force just before the sign-in address last became the Cloud address`, `› puts back an address left in addresses on an unlink where the link found the sign-in address already at its Cloud address`, `› puts back an address left in addresses on an unlink where the owner removed the one in force before the move`.

### `cloud/put-back-target`

When the server moves the sign-in address back from a link's `address` as the link ends, the server MUST choose, on the settings the write commits, the sign-in address that was in force just before the sign-in address last became the link's `address` if `addresses` without the link's `address` is empty or holds it, otherwise the first `https` address left in `addresses`, otherwise the first address left in `addresses`.

**Reason:** a stored `addresses` list always holds the sign-in address in force (`instance/addresses-hold-sign-in`), so the sign-in address goes back only where the list allows. The sign-in address in force before the move can be the default, which a link that found the sign-in address already at its `address` puts back.

**Tests:** `compliance/cloud-link.test.ts › puts back the sign-in address in force just before the sign-in address last became the Cloud address`, `› puts back an address left in addresses on an unlink where the link found the sign-in address already at its Cloud address`, `› puts back an address left in addresses on an unlink where the owner removed the one in force before the move`, `› puts back an address left in addresses on an end by Marfa Cloud where the link found the sign-in address already at its Cloud address`, `› puts back the first https address left in addresses on an end by Marfa Cloud where the address in force before the move is not among them`.

### `cloud/put-back-drops-address`

When the server moves the sign-in address back from a link's `address` as the link ends, the server MUST remove the link's `address` from `addresses`.

**Tests:** `compliance/cloud-link.test.ts › puts back an address left in addresses on an unlink where the link found the sign-in address already at its Cloud address`, `› puts back an address left in addresses on an unlink where the owner removed the one in force before the move`, `› puts back an address left in addresses on an end by Marfa Cloud where the link found the sign-in address already at its Cloud address`, `› puts back the first https address left in addresses on an end by Marfa Cloud where the address in force before the move is not among them`.

### `cloud/unlink-move-refused`

While the sign-in address that an unlink's write finds is a link's `address`, when a caller sends `DELETE /cloud/link` that `PATCH /config` would refuse for moving the sign-in address back, the server MUST refuse it in the same way and unlink nothing.

**Reason:** putting the sign-in address back signs everyone out, as any move does.

**Tests:** `compliance/cloud-link.test.ts › puts back the sign-in address the link moved only with a recent sign-in and confirmation, and otherwise unlinks nothing`, `› decides an unlink on the sign-in address its write finds, after a move commits first`.

### `cloud/unlink-not-linked`

While no link is linking, linked or failed, when a caller sends `DELETE /cloud/link`, the server MUST answer `200` with `state` `not_linked`.

**Tests:** `compliance/cloud-link.test.ts › answers not_linked to an unlink when nothing is linked`.

### `cloud/cancel`

When a caller sends `DELETE /cloud/link` while a link is linking and the server holds no link credential for it, the server MUST send Marfa Cloud `POST /link/cancel` with the link's `link_id` and `poll_secret`.

**Tests:** `compliance/cloud-link.test.ts › cancels a link waiting for approval on Marfa Cloud`.

### `cloud/cancel-told`

When the server cancels a link that is linking, the server MUST answer `200` with `state` `not_linked` and with `service_told` `true` if Marfa Cloud answered the cancel with `200` or `404`, or `false` if it did not.

**Reason:** `404` says Marfa Cloud holds no such link waiting, so there is nothing left to cancel.

**Tests:** `compliance/cloud-link.test.ts › cancels a link waiting for approval on Marfa Cloud`, `› watches a link whose cancel Marfa Cloud did not take, and unlinks it if Marfa Cloud approves it later`.

### `cloud/cancel-fallback`

If Marfa Cloud does not answer a cancel with `200` or `404`, then the server MUST tell Marfa Cloud to unlink the link if Marfa Cloud approves it before it expires.

**Reason:** a cancel lost on the way would otherwise leave the owner's approval, made later, putting the instance on the internet.

**Tests:** `compliance/cloud-link.test.ts › watches a link whose cancel Marfa Cloud did not take, and unlinks it if Marfa Cloud approves it later`.

## A link ended on Marfa Cloud

### `cloud/ended-by-service`

When Marfa Cloud no longer accepts the link credential of a link that is linked, the server MUST end the link and answer `state` `not_linked` with `ended.reason` `unlinked_by_service`.

**Reason:** the owner can unlink on the Marfa Cloud account page while the instance is offline, and the name then no longer reaches the instance.

**Tests:** `compliance/cloud-link.test.ts › notices a link ended on Marfa Cloud, puts back the sign-in address the link moved, and says why`.

### `cloud/ended-puts-back`

When the server ends a link that Marfa Cloud ended while the sign-in address is the link's `address`, the server MUST move the sign-in address to the address `cloud/put-back-target` names, as a confirmed move in `/config` does.

**Reason:** the link's address no longer reaches the instance, so leaving it would lock the owner out.

**Tests:** `compliance/cloud-link.test.ts › notices a link ended on Marfa Cloud, puts back the sign-in address the link moved, and says why`, `› puts back an address left in addresses on an end by Marfa Cloud where the link found the sign-in address already at its Cloud address`, `› puts back the first https address left in addresses on an end by Marfa Cloud where the address in force before the move is not among them`.

### `cloud/ended-not-put-back`

If the write that moves the sign-in address back fails three times as the server ends a link that Marfa Cloud ended, and fails again on the next try for a reason other than `conflict` or `write_contention`, then the server MUST end the link and leave the sign-in address as it is.

**Reason:** a link Marfa Cloud ended does not come back, so a server that kept it until the sign-in address moved would hold a dead link and try again forever. A write that fails for a while, such as on a full disk, puts the sign-in address back once it works again.

**Tests:** `compliance/cloud-link.test.ts › ends a link Marfa Cloud ended though the sign-in address cannot be put back, keeps the sign-in address, and says why`, `› puts back the sign-in address on an end by Marfa Cloud once a write that failed three times works again`.

### `cloud/not-put-back-status`

While the last link has ended and the sign-in address is still its `address`, the server MUST answer `GET /cloud/link` with `sign_in_address.state` `not_put_back`.

**Tests:** `compliance/cloud-link.test.ts › ends a link Marfa Cloud ended though the sign-in address cannot be put back, keeps the sign-in address, and says why`.

### `cloud/not-put-back-next-step`

While the last link has ended, the sign-in address is still its `address` and `addresses` reads, the server MUST answer, in `sign_in_address.next_step` of `GET /cloud/link`, the request that moves the sign-in address to the address `cloud/put-back-target` names.

**Reason:** the stored address in force before the move may not read, and the owner still needs a way back.

**Tests:** `compliance/cloud-link.test.ts › says how to move a sign-in address an end by Marfa Cloud did not put back where the address the link moved does not read`.

### `cloud/not-put-back-failure`

While the sign-in address is still the `address` of a link the server ended as `cloud/ended-not-put-back` says, the server MUST answer `GET /cloud/link` with the error code of the failed write in `sign_in_address.failure.reason`.

**Tests:** `compliance/cloud-link.test.ts › ends a link Marfa Cloud ended though the sign-in address cannot be put back, keeps the sign-in address, and says why`.

### `cloud/not-put-back-audited`

When the server ends a link as `cloud/ended-not-put-back` says while the sign-in address is the link's `address`, the server MUST record `details.sign_in_address` `not_put_back` and the error code of the failed write in `details.put_back_failure` in the audit entry of the unlink.

**Tests:** `compliance/cloud-link.test.ts › ends a link Marfa Cloud ended though the sign-in address cannot be put back, keeps the sign-in address, and says why`.

### `cloud/ended-audited`

When the server ends a link that Marfa Cloud ended, the server MUST record `details.reason` `unlinked_by_service` in the audit entry of the unlink.

**Tests:** `compliance/cloud-link.test.ts › notices a link ended on Marfa Cloud, puts back the sign-in address the link moved, and says why`.

### `cloud/ended-checked`

While a link is linked, the server MUST ask Marfa Cloud whether it still stands when the server starts and at least once an hour.

**Tests:** `compliance/cloud-link.test.ts › notices a link ended on Marfa Cloud, puts back the sign-in address the link moved, and says why`, `› checks a linked link as it starts again, and notices it was ended on Marfa Cloud while it was stopped`.

## The tunnel listener

While a link is linking or linked, the server listens on `127.0.0.1` at the port the start sent as `origin_port`, beside its public listener. This is the tunnel listener, which Marfa Cloud's connector reaches, and it serves the same API as the public listener.

### `cloud/tunnel-listener-open`

While a link is linking or linked, the server MUST serve, on `127.0.0.1` at the link's `origin_port`, every request the public listener serves, event streams included.

**Reason:** Marfa Cloud's connector carries the instance's traffic to that port.

**Tests:** `compliance/cloud-link.test.ts › answers a start with the code and the address to approve it at, and sends the instance's id, name and the port of a listener of its own on 127.0.0.1`, `compliance/cloud-connector.test.ts › listens on 127.0.0.1 at a port of its own while linked, and serves an event stream through it`.

### `cloud/tunnel-listener-port-kept`

When the server starts again while a link is linking or linked, the server MUST listen for the connector at the `origin_port` the link started with.

**Reason:** Marfa Cloud sends the link's traffic to the port the start sent, and has no way to be told another.

**Tests:** `compliance/cloud-connector.test.ts › listens at the port the link started with when the server starts again`.

### `cloud/tunnel-listener-port-taken`

While a link is linked and another program holds the link's `origin_port` on `127.0.0.1`, the server MUST report the connector as `failed` with `reason` `port_taken` and not run it.

**Reason:** the connector would carry the instance's traffic to the other program. The owner can unlink and link again for another port.

**Tests:** `compliance/cloud-connector.test.ts › reports the connector as failed with reason port_taken while another program holds the tunnel listener's port, and runs it once the port is free`.

### `cloud/tunnel-listener-port-freed`

When the link's `origin_port` is free again after another program held it, the server MUST listen there and run the connector.

**Tests:** `compliance/cloud-connector.test.ts › reports the connector as failed with reason port_taken while another program holds the tunnel listener's port, and runs it once the port is free`.

### `cloud/tunnel-listener-closed-unlink`

When a link is unlinked, the server MUST stop listening at its `origin_port` once the connector has stopped.

**Tests:** `compliance/cloud-connector.test.ts › stops listening once the connector has stopped, when the link is unlinked and when Marfa Cloud ends it`.

### `cloud/tunnel-listener-closed-ended`

When Marfa Cloud ends a link, the server MUST stop listening at its `origin_port` once the connector has stopped.

**Tests:** `compliance/cloud-connector.test.ts › stops listening once the connector has stopped, when the link is unlinked and when Marfa Cloud ends it`.

### `cloud/tunnel-connections-total`

The server MUST count each connection the tunnel listener holds open in the one total that `MARFA_MAX_CONNECTIONS` caps for the public listener, as `instance/connections-listener-cap` says.

**Reason:** every connection takes a file descriptor, and the caps are what the server's open-file limit leaves room for.

**Tests:** `compliance/cloud-connector.test.ts › holds the tunnel listener's connections in the public listener's cap, and counts a loopback peer by its address on the public listener alone`.

### `cloud/tunnel-connections-per-address`

The server MUST NOT count a connection to the tunnel listener against `MARFA_MAX_CONNECTIONS_PER_ADDRESS`.

**Reason:** every connection to it comes from the connector, which carries many callers.

**Tests:** `compliance/cloud-connector.test.ts › holds the tunnel listener's connections in the public listener's cap, and counts a loopback peer by its address on the public listener alone`.

### `cloud/public-connections-per-address`

While no trusted proxy setting includes a connection's peer, the server MUST count a connection to the public listener against `MARFA_MAX_CONNECTIONS_PER_ADDRESS` by its peer's address, whether or not a link is linked.

**Tests:** `compliance/cloud-connector.test.ts › holds the tunnel listener's connections in the public listener's cap, and counts a loopback peer by its address on the public listener alone`.

## The connector

While a link is linked, the server runs the tunnel connector `cloudflared`, which carries the instance's traffic from its name on Marfa Cloud to the tunnel listener, and supervises it. The connector's state is in `GET /cloud/link` as `connector`.

### `cloud/connector-path-absolute`

If `MARFA_CLOUDFLARED` is set and is not an absolute path, then the server MUST refuse to start and name the setting.

**Reason:** a path with no folder in it is looked for on `PATH`, where another program can stand in for the connector.

**Tests:** `compliance/cloud-connector.test.ts › refuses to start with a MARFA_CLOUDFLARED that is not an absolute path`.

### `cloud/connector-setting`

While a link is linked, the server MUST run the connector from the file the start-only setting `MARFA_CLOUDFLARED` names.

**Tests:** `compliance/cloud-connector.test.ts › runs the connector from the file MARFA_CLOUDFLARED names, with the arguments the contract gives`.

### `cloud/connector-beside`

While a link is linked and `MARFA_CLOUDFLARED` is not set, the server MUST run the connector from the file `cloudflared` in the folder that holds the server's own executable, once every link to that executable is followed.

**Reason:** a package manager can link `bin/marfa-server` to a program in another folder, and the connector is installed beside that program.

**Tests:** `compliance/cloud-connector.test.ts › runs the connector from beside the server's own executable, found through a link, and never from PATH`.

### `cloud/connector-no-path`

The server MUST NOT search `PATH` for the connector.

**Reason:** the connector carries every request to the instance, so only a file the owner or the installation put in place is run.

**Tests:** `compliance/cloud-connector.test.ts › runs the connector from beside the server's own executable, found through a link, and never from PATH`.

### `cloud/connector-missing`

If the file the connector is to run from is missing or cannot be run, then the server MUST report the connector as `failed` with `reason` `missing`.

**Reason:** an instance without its connector is still an instance: it keeps serving and keeps its link, and the owner reads in the link what is wrong.

**Tests:** `compliance/cloud-connector.test.ts › reports a connector that cannot be run as failed, keeps serving, and runs it once it can be`.

### `cloud/connector-restart`

While a link is linked, if the connector ends or cannot be run, then the server MUST run it again after one second, and after each further failure in a row wait twice as long as before, up to one minute.

**Reason:** a connector that cannot stay up should not be started in a tight loop, and one that was missing starts once it is put in place.

**Tests:** `compliance/cloud-connector.test.ts › runs the connector again after each failure, waiting twice as long each time`, `› reports a connector that cannot be run as failed, keeps serving, and runs it once it can be`.

### `cloud/connector-args`

When the server runs the connector, the server MUST give it the arguments `tunnel --no-autoupdate --metrics 127.0.0.1:<port> run --token-file <file>`, where `<port>` is a port that was free and `<file>` is the file of the tunnel token.

**Reason:** the origin the connector sends to is set on Marfa Cloud, so the server gives it none, and the metrics address is the one the server reads its readiness from.

**Tests:** `compliance/cloud-connector.test.ts › runs the connector from the file MARFA_CLOUDFLARED names, with the arguments the contract gives`.

### `cloud/connector-token-file`

When the server runs the connector, the server MUST give it the tunnel token in a file that only the server's account can read.

**Tests:** `compliance/cloud-connector.test.ts › runs the connector from the file MARFA_CLOUDFLARED names, with the arguments the contract gives`.

### `cloud/connector-token-hidden`

The server MUST NOT put the tunnel token in an argument or in the environment of the connector.

**Reason:** any account on the machine can read another process's arguments, and the token puts the instance on the internet under its name.

**Tests:** `compliance/cloud-connector.test.ts › keeps the tunnel token and the server's secrets from the connector's arguments and environment, and out of the log`.

### `cloud/connector-environment`

When the server runs the connector, the server MUST give it no variable of its own environment other than `HOME`, `TMPDIR`, `TZ`, `SSL_CERT_FILE` and `SSL_CERT_DIR`.

**Reason:** the server's environment holds its keys and secrets, which the connector has no use for.

**Tests:** `compliance/cloud-connector.test.ts › keeps the tunnel token and the server's secrets from the connector's arguments and environment, and out of the log`.

### `cloud/connector-token-removed`

When the connector stops, the server MUST remove the file that held the tunnel token.

**Tests:** `compliance/cloud-connector.test.ts › stops the connector when the link is unlinked, and removes the file of the token`.

### `cloud/connector-stop-unlink`

When a link that is linked is unlinked, the server MUST stop the connector and leave no process of it running.

**Tests:** `compliance/cloud-connector.test.ts › stops the connector when the link is unlinked, and removes the file of the token`.

### `cloud/connector-stop-ended`

When the server ends a link that Marfa Cloud ended, the server MUST stop the connector and leave no process of it running.

**Tests:** `compliance/cloud-connector.test.ts › stops the connector when Marfa Cloud ends the link`.

### `cloud/connector-stop-shutdown`

When the server stops, the server MUST stop the connector and leave no process of it running.

**Tests:** `compliance/cloud-connector.test.ts › stops the connector when the server stops`.

### `cloud/connector-connected`

When the connector's `/ready` on its metrics address answers `200`, the server MUST report the connector as `connected`.

**Reason:** `/ready` says whether the connector can carry traffic now, and unlike a line in its output it says so again when that changes.

**Tests:** `compliance/cloud-connector.test.ts › reports the connector as starting, connected and reconnecting as it says it is ready, and tells the stream`.

### `cloud/connector-reconnecting`

When the connector is running and its `/ready` stops answering `200` after it did, the server MUST report the connector as `reconnecting`.

**Tests:** `compliance/cloud-connector.test.ts › reports the connector as starting, connected and reconnecting as it says it is ready, and tells the stream`.

### `cloud/connector-output`

While the connector runs, the server MUST write each line it prints to the server's log.

**Tests:** `compliance/cloud-connector.test.ts › keeps the tunnel token and the server's secrets from the connector's arguments and environment, and out of the log`.

### `cloud/connector-log-token`

The server MUST NOT write the tunnel token in its log.

**Reason:** the connector's output is the server's to log, and a line that carries the token is not.

**Tests:** `compliance/cloud-connector.test.ts › keeps the tunnel token and the server's secrets from the connector's arguments and environment, and out of the log`.

### `cloud/connector-no-ingress`

When the connector prints that no ingress rules were defined, the server MUST NOT treat it as a fault.

**Reason:** the connector says so at every start, because the origin is set on Marfa Cloud.

**Tests:** `compliance/cloud-connector.test.ts › reports the connector as starting, connected and reconnecting as it says it is ready, and tells the stream`.

### `cloud/connector-refused`

When the connector's output says that its tunnel token is refused (`Unauthorized: Invalid tunnel secret`) or that there is no tunnel to get for it (`Failed to get tunnel`), the server MUST ask Marfa Cloud for the link's current tunnel token with `POST /link/token` and its link credential.

**Reason:** Marfa Cloud can give the link a new tunnel token, after which the connector is refused for the old one. The connector does not end on either refusal: it retries with the same token until it is stopped.

**Tests:** `compliance/cloud-connector.test.ts › asks for the current tunnel token when the connector is refused, and runs it with the new one`, `compliance/cloud-connector.test.ts › asks for the current tunnel token when the edge has no tunnel for the connector's token`.

### `cloud/connector-rotated`

When Marfa Cloud gives a tunnel token other than the one the connector was refused for, the server MUST keep the new token sealed in place of the old and run the connector with it at once.

**Tests:** `compliance/cloud-connector.test.ts › asks for the current tunnel token when the connector is refused, and runs it with the new one`.

### `cloud/connector-refused-same`

If Marfa Cloud gives the tunnel token the connector was refused for, then the server MUST report the connector as `failed` with `reason` `refused`.

**Reason:** the server cannot mend a refusal Marfa Cloud does not, and it keeps trying at the pace of the restart rule.

**Tests:** `compliance/cloud-connector.test.ts › reports a connector refused for the token Marfa Cloud still gives as failed, and asks again no faster than it restarts`.

### `cloud/connector-token-wait`

When Marfa Cloud answers the request for the link's tunnel token with `429` or `503`, the server MUST NOT run the connector or send another request for the token until the seconds in `Retry-After` have passed, or 60 seconds when it gives none.

**Reason:** Marfa Cloud lets each link read its tunnel token once a minute and says how long to wait, so a refused connector that asked more often would only be refused again.

**Tests:** `compliance/cloud-connector.test.ts › keeps a refused connector stopped until Retry-After is over, then asks once and runs the token it gets`, `compliance/cloud-connector.test.ts › keeps a refused connector stopped for the 60 seconds Marfa Cloud asks for when it cannot answer`.

### `cloud/connector-token-wait-failed`

While the server waits to ask for the link's tunnel token again, the server MUST report the connector as `failed` with `reason` `refused`.

**Tests:** `compliance/cloud-connector.test.ts › keeps a refused connector stopped until Retry-After is over, then asks once and runs the token it gets`, `compliance/cloud-connector.test.ts › keeps a refused connector stopped for the 60 seconds Marfa Cloud asks for when it cannot answer`.

### `cloud/connector-token-after-wait`

When the wait that Marfa Cloud's `Retry-After` set is over, the server MUST send one request for the link's tunnel token before it runs the connector again, and run the connector with the token it gets.

**Tests:** `compliance/cloud-connector.test.ts › keeps a refused connector stopped until Retry-After is over, then asks once and runs the token it gets`.

### `cloud/connector-token-gone`

When Marfa Cloud answers the request for the link's tunnel token with `401` and the error code `unauthorized`, the server MUST end the link as `cloud/ended-by-service` does.

**Tests:** `compliance/cloud-connector.test.ts › ends the link when Marfa Cloud no longer accepts the credential that asks for a new tunnel token`.

### `cloud/connector-token-kept`

When the answer to the request for the link's tunnel token is a `401` with any other error code, or none, the server MUST keep the link `linked`.

**Reason:** a proxy or a gateway on the way can answer `401` in its own words, and only Marfa Cloud's own answer says the link is gone.

**Tests:** `compliance/cloud-connector.test.ts › keeps the link when the answer to the request for a new tunnel token is a 401 that is not Marfa Cloud's own`.

### `cloud/caller-address-tunnel`

When a request reaches the tunnel listener from a loopback peer, the server MUST read the caller's address from its `CF-Connecting-IP` header, whatever the trusted proxy settings say.

**Reason:** the connector runs on the instance's machine and writes the address of the caller it carries into that header. The trusted proxy settings describe the routes to the public listener.

**Tests:** `compliance/cloud-connector.test.ts › reads CF-Connecting-IP on the tunnel listener alone, and never on the public listener, linked or not`, `compliance/cloud-connector.test.ts › keeps the trusted proxy settings an owner gave to the public listener, and the tunnel listener to its own`, `compliance/cloud-connector.test.ts › counts tunnel callers by their own address while a trusted proxy setting names another route`.

### `cloud/caller-address-public`

While no trusted proxy setting includes a request's peer, the server MUST use the peer's address as the caller's address of a request to the public listener, whatever `CF-Connecting-IP` holds and whether or not a link is linked.

**Tests:** `compliance/cloud-connector.test.ts › reads CF-Connecting-IP on the tunnel listener alone, and never on the public listener, linked or not`.

### `cloud/caller-address-configured`

When `MARFA_TRUSTED_PROXY_CIDRS` includes the peer of a request to the public listener, the server MUST read the caller's address as `instance/proxy-header-trusted-peer` and `instance/proxy-forwarded-walk` say, whether or not a link is linked.

**Tests:** `compliance/cloud-connector.test.ts › keeps the trusted proxy settings an owner gave to the public listener, and the tunnel listener to its own`.

### `cloud/caller-address-until-stopped`

When a link ends, the server MUST keep reading a caller's address from the `CF-Connecting-IP` header of a request to the tunnel listener until the connector has stopped.

**Reason:** the connector still carries requests while it stops, and read as loopback they would count against the owner's own address.

**Tests:** `compliance/cloud-connector.test.ts › keeps reading the tunnel's header until the connector has stopped when the link ends`.

### `cloud/caller-address-limits`

When requests reach the tunnel listener, the server MUST count the sign-in attempts and the other limits of each caller against the address in `CF-Connecting-IP` and not against loopback.

**Reason:** every caller then shares the loopback address, so one stranger's wrong passwords would lock the owner out.

**Tests:** `compliance/cloud-connector.test.ts › counts a stranger's wrong passwords through the tunnel against the stranger's address, not loopback`.

### `cloud/limits-public-peer`

While no trusted proxy setting includes a request's peer, the server MUST count the sign-in attempts and the other limits of a request to the public listener against the peer's address, whatever `CF-Connecting-IP` holds.

**Tests:** `compliance/cloud-connector.test.ts › counts wrong passwords sent to the public listener against their peer, never against the address a CF-Connecting-IP header names`.

## Reading a link

### `cloud/status-not-linked`

While no link has been started, when a caller sends `GET /cloud/link`, the server MUST answer `200` with `state` `not_linked` and no other field.

**Tests:** `compliance/cloud-link.test.ts › sends nothing to Marfa Cloud until a link is started, across a restart, and then sends the start`.

### `cloud/status-connector`

While a link is linked, the server MUST answer, in `connector`, the `state` of the connector that carries the instance's traffic, which is `stopped`, `starting`, `connected`, `reconnecting` or `failed`, with `since` when it took that state and, for `failed`, the `reason`.

**Tests:** `compliance/cloud-link.test.ts › links once Marfa Cloud approves, with the name and address it gave, and keeps the sign-in address the start keeps`, `compliance/cloud-connector.test.ts › reports the connector as starting, connected and reconnecting as it says it is ready, and tells the stream`.

## Events and the audit log

### `cloud/event`

When a link's `state`, its `sign_in_address.state` or its `connector.state` changes, the server MUST announce one `cloud_link.changed` event carrying the link as `GET /cloud/link` answers it, in `cloud_link`.

**Reason:** an app shows a link's progress from the stream rather than reading it again and again.

**Tests:** `compliance/cloud-link.test.ts › announces each change of a link on the stream of a credential holding config.manage, and on no other`, `compliance/cloud-connector.test.ts › reports the connector as starting, connected and reconnecting as it says it is ready, and tells the stream`.

### `cloud/event-reader`

The server MUST send a `cloud_link.changed` event only on a stream whose credential holds `config.manage`, that names no `type` and is not a copy stream.

**Tests:** `compliance/cloud-link.test.ts › announces each change of a link on the stream of a credential holding config.manage, and on no other`.

### `cloud/audited`

When a link is started, linked, failed or unlinked, or the server moves the sign-in address to or back from a link's `address`, the server MUST record it in the audit log with the action `cloud.link_start`, `cloud.linked`, `cloud.link_failed`, `cloud.unlink` or `cloud.sign_in_address_move`.

**Tests:** `compliance/cloud-link.test.ts › records the start, the link, the move of the sign-in address and the unlink in the audit log`, `› fails a link Marfa Cloud denies, lets expire or refuses, and says why`.
