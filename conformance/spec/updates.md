# Updates

Whether a newer Marfa release is out, and how a server moves to it. The check is a housekeeping job (`housekeeping/switched-release-check`); reading it uses `instance.read` and starting an update uses `instance.maintain`. A server installed as a service by `marfa server install` can swap its own programs. Any other server names the step the owner takes on its host.

## The release check

### `updates/check-published-only`

When the `release-check` housekeeping job finds the newest release on GitHub, the server MUST keep only a published release that is neither a draft nor a prerelease.

**Reason:** an owner is offered a release only once it is public, and a draft or a prerelease can be withdrawn.

**Tests:** `compliance/updates.test.ts › keeps the last release found when a check fails, says why, and ends the run as succeeded`.

### `updates/check-keeps-last`

If a check for a release fails, because the host does not answer, answers with a failing status, or gives an answer that is not a published release, then the server MUST keep the last release it found and report why the check failed.

**Reason:** a slow or absent GitHub, or a rate limit, must not take away what an owner has already been told.

**Tests:** `compliance/updates.test.ts › keeps the last release found when a check fails, says why, and ends the run as succeeded`.

### `updates/check-run-succeeds`

If a check for a release fails, then the server MUST end the run of `release-check` as `succeeded`.

**Reason:** a server with no route to GitHub is not at fault, so the failed check is not listed in attention. The reading of the update names it.

**Tests:** `compliance/updates.test.ts › keeps the last release found when a check fails, says why, and ends the run as succeeded`.

### `updates/check-off-silent`

While the stored setting `update_check_enabled` is `false`, the server MUST make no request for a release.

**Reason:** an owner who turns the check off expects nothing to leave the machine for it.

**Tests:** `compliance/updates.test.ts › makes no request for a release while update_check_enabled is false, and lists no release-check job`.

### `updates/check-test-hooks-silent`

Where test hooks are on, the server MUST make no request for a release until a `release-feed` fault names the address to ask.

**Reason:** a test instance and the contract's fixtures never reach the network.

**Tests:** `compliance/updates.test.ts › asks nobody for a release until a fault names an address, and reads no release before a check has found one`.

## Reading the update

### `updates/read`

When a caller holding `instance.read` sends `GET /update`, the server MUST answer `200` with the running release, whether the check is on, when a check last found the newest release, why the latest check failed, the newest release found, whether it is newer than the running one, how this server moves to it, the update under way and how the last update ended.

**Tests:** `compliance/updates.test.ts › reads the running release, the newest published release a check found and whether it is newer, to a caller holding instance.read`, `› asks nobody for a release until a fault names an address, and reads no release before a check has found one`.

### `updates/read-needs-instance-read`

When a caller lacking `instance.read` sends `GET /update`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/updates.test.ts › refuses the read to a caller without instance.read and the start to one without instance.maintain`.

### `updates/available-newer`

The server MUST answer `available` as `true` only while the newest release found is newer than the running one.

**Reason:** a release equal to the running one, or older, is no update.

**Tests:** `compliance/updates.test.ts › reads no release as newer when the newest published release is the one running`, `› reads the running release, the newest published release a check found and whether it is newer, to a caller holding instance.read`.

### `updates/check-off-reads-none`

While the stored setting `update_check_enabled` is `false`, the server MUST answer `GET /update` with no newest release and `available` as `false`.

**Tests:** `compliance/updates.test.ts › makes no request for a release while update_check_enabled is false, and lists no release-check job`.

### `updates/step-for-manual`

Where a newer release is available and the server cannot update itself, the server MUST answer `GET /update` with `method` as `manual` and a `step` that names the release and what to do on the host.

**Reason:** a server in a container, or one the account that runs it cannot write programs for, is moved by the owner on its host.

**Tests:** `compliance/updates.test.ts › refuses an update on a server that cannot update itself with the step to take on its host, and changes nothing`.

## Starting an update

### `updates/start-needs-instance-maintain`

When a caller lacking `instance.maintain` sends `POST /update`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/updates.test.ts › refuses the read to a caller without instance.read and the start to one without instance.maintain`.

### `updates/start-not-ready`

If no release newer than the running one has been found, then the server MUST answer `POST /update` with `409 update_not_ready` and change nothing.

**Tests:** `compliance/updates.test.ts › reads no release as newer when the newest published release is the one running`, `› makes no request for a release while update_check_enabled is false, and lists no release-check job`.

### `updates/start-unavailable`

If a newer release is available and the server cannot update itself, then the server MUST answer `POST /update` with `409 update_unavailable`, name the step in `details.step`, and change nothing.

**Tests:** `compliance/updates.test.ts › refuses an update on a server that cannot update itself with the step to take on its host, and changes nothing`.

### `updates/start-once`

While an update runs, the server MUST answer another `POST /update` with the update that runs, and start no second one.

**Reason:** two swaps of the same programs would leave neither whole.

**Tests:** waiting on #3177.

## The swap

### `updates/swap-checked`

When the server is to replace its programs with a release's, the server MUST first check the downloaded archive against the release's checksum file, check that each new program runs and reports the release, and ask the new server program whether it accepts this instance's settings and opens its database.

**Reason:** a release that cannot start on the instance's settings or open its database would leave the instance down.

**Tests:** waiting on #3177.

### `updates/swap-refused-unchanged`

If a download fails, its checksum does not match, a new program will not run or reports another release, the new server will not accept the settings or open the database, or the disk has too little room, then the server MUST leave the running programs as they were and report why in the last update.

**Tests:** waiting on #3177.

### `updates/swap-hosts`

When the server downloads a release's archive or checksum file, the server MUST fetch it over HTTPS from `github.com` or the host GitHub redirects release files to, and from no other host.

**Reason:** a release that points elsewhere must not make the server fetch and run a program from there.

**Tests:** waiting on #3177.

### `updates/swap-keeps-old`

When the server replaces its programs with a release's, the server MUST keep the old programs beside the new ones to put back.

**Tests:** waiting on #3177.

### `updates/rollback`

If the new release does not stay up through its second start and the database is as it was before the swap, then the server MUST put the old programs back and report the update as rolled back.

**Reason:** a new release that cannot come up should not leave the owner with a server that is down.

**Tests:** waiting on #3177.
