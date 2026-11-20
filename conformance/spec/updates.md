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

### `updates/check-host`

When the `release-check` housekeeping job asks for the newest release, the server MUST ask only `https://api.github.com/repos/withmarfa/marfa/releases/latest` and follow a redirect only to another address on `https://api.github.com`.

**Reason:** the answer names the programs the server may later run, so only GitHub's answer for Marfa's own repository counts.

**Tests:** `compliance/updates.test.ts › follows a redirect of the release check only on the address it asks, and asks no other host`.

### `updates/check-download-address`

If the newest release names the archive for the server's platform or its checksum file at any address but `https://github.com/withmarfa/marfa/releases/download/v<version>/<name>`, then the server MUST treat the check as failed and fetch nothing from that address.

**Reason:** a release is offered only when the files it names are Marfa's own release files, so the reading of the update never offers one the swap would refuse.

**Tests:** `compliance/updates.test.ts › refuses a release that names its files anywhere but Marfa's release address, and asks nothing of that address`.

### `updates/check-public-only`

When the server asks GitHub for a release or downloads a release's files, the server MUST connect only to a public address, whatever `allow_private_addresses` says.

**Reason:** `allow_private_addresses` lets an owner reach receivers on their own network, and gives no reason to fetch a program from one.

**Tests:** waiting on #3321.

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

### `updates/start-current-access`

If the credential that sent `POST /update` has been narrowed so that it no longer holds `instance.maintain` when the server decides whether the update starts, then the server MUST answer `403 forbidden` and start no update.

**Reason:** an update replaces the programs the server runs, so a key narrowed while the request waits must not start one.

**Tests:** `compliance/updates.test.ts › decides a start on the key as it stands when the update would begin, refusing one that lost instance.maintain or ended`.

### `updates/start-credential-ended`

If the credential that sent `POST /update` has been revoked or has expired when the server decides whether the update starts, then the server MUST answer `401 unauthorized` and start no update.

**Reason:** a credential that has ended is refused as any request bearing it is, and an update replaces the programs the server runs.

**Tests:** `compliance/updates.test.ts › decides a start on the key as it stands when the update would begin, refusing one that lost instance.maintain or ended`.

### `updates/start-audited`

When the server starts an update, the server MUST record an `instance.update.started` entry naming the release it runs and the release it moves to, in the write that decides the update starts.

**Reason:** an update replaces the programs the server runs, so the log says who started it, and a start whose entry cannot be recorded does not start.

**Tests:** waiting on #3177.

### `updates/start-once`

While an update runs, the server MUST answer another `POST /update` with the update that runs, and start no second one.

**Reason:** two swaps of the same programs would leave neither whole.

**Tests:** waiting on #3177.

## The swap

### `updates/swap-checked`

When the server is to replace its programs with a release's, the server MUST first check the downloaded archive against the release's checksum file, check that each new program runs and reports the release, check that the new `marfa` accepts the install with `marfa server run --dir <dir> --check`, and ask the new server program whether it accepts this instance's settings and opens its database.

**Reason:** a release that cannot start on the instance's settings or open its database would leave the instance down, and a new `marfa` that cannot run the install would leave the service unable to start once it takes the old one's place.

**Tests:** waiting on #3177.

### `updates/swap-refused-unchanged`

If a download fails, its checksum does not match, a new program will not run or reports another release, the new `marfa` will not run the install, the new server will not accept the settings or open the database, or the disk has too little room, then the server MUST leave the running programs as they were and report why in the last update.

**Tests:** waiting on #3177.

### `updates/swap-hosts`

When the server downloads a release's archive or checksum file, the server MUST fetch it only from `https://github.com/withmarfa/marfa/releases/download/v<version>/<name>`, where `<version>` is the release's and `<name>` is the file's.

**Reason:** a release that points elsewhere, even at another repository or another release on GitHub, must not make the server fetch and run a program from there.

**Tests:** waiting on #3177.

### `updates/swap-redirect-host`

When a download of a release's file is redirected, the server MUST follow the redirect only over HTTPS to `release-assets.githubusercontent.com`.

**Reason:** GitHub serves release files from that host, and from no other.

**Tests:** waiting on #3177.

### `updates/swap-staging-cleared`

When the server starts an update, the server MUST first remove each folder beside its programs whose name starts with `.marfa-update-`, and leave a link or a file under such a name as it is.

**Reason:** an update that stopped part way leaves its unpacked release behind, and nothing else would remove it.

**Tests:** waiting on #3177.

### `updates/swap-keeps-old`

When the server replaces its programs with a release's, the server MUST keep the old `marfa-server` beside the new one, as `.marfa-server.previous`, to put back.

**Tests:** waiting on #3177.

### `updates/swap-server-first`

When the server replaces its programs with a release's, the server MUST leave the running `marfa` in place and put the new one beside it as `.marfa.next` until the update settles.

**Reason:** the service runs `marfa server run`, so the running release's `marfa` watches the new server's first starts and can put the old server back.

**Tests:** waiting on #3177.

### `updates/swap-waits-for-settle`

If an update starts while an earlier update of the same programs has not settled, then the server MUST leave the programs as they are and report why in the last update.

**Reason:** two installs can share one folder of programs, and a second swap would leave neither able to put its old release back.

**Tests:** waiting on #3177.

## Trying the new release

The service runs `marfa server run`, the CLI of the release that ran before the update, until the new release settles: once the new server has stayed up for 20 seconds, with its health not `down`, it settles the update. Until then the CLI counts each start of the new release, and ends a start that has not settled within 10 minutes. The time the new server spends upgrading the database is not part of those 10 minutes, and has a limit of 2 hours of its own.

### `updates/start-counted-before-run`

When `marfa server run` starts the new release of an update that has not settled, the CLI MUST count the start in the update's record before it runs any program of the new release.

**Reason:** a release that hangs or ends before it says which release it is is still counted, so it cannot keep the old release from coming back.

**Tests:** waiting on #3177.

### `updates/start-uncounted-not-run`

If the CLI cannot count a start of the new release in the update's record, then the CLI MUST end `marfa server run` with status 75 without running the new release.

**Reason:** a start that is not counted could fail again and again without the old release ever coming back.

**Tests:** waiting on #3177.

### `updates/record-folder-private`

When `marfa server run` makes the install's data folder, the `update` folder in it that holds the update's record, or a file in that `update` folder, the CLI MUST make it readable and writable by its own account alone, whatever umask it runs under.

**Reason:** a service manager may start `marfa server run` under a umask that opens new folders to the account's group, and the server refuses to start on a folder on the way to its database that another account can write to (`instance/files-way-guarded`).

**Tests:** waiting on #3177.

### `updates/run-files-private`

When `marfa server run` creates a file or a folder without a mode of its own, the CLI MUST give it no mode bits for group or others, whatever umask the CLI started under.

**Reason:** a service manager may start `marfa server run` under a umask that opens new files and folders to the account's group, and what the CLI makes in the install's folders is the owner's.

**Tests:** waiting on #3177.

### `updates/install-parents-guarded`

When `marfa server install` makes a folder above the install folder, the CLI MUST make it writable by its own account alone, whatever umask it runs under.

**Reason:** the server refuses to start on a folder on the way to its database that another account can write to (`instance/files-way-guarded`), and a folder made under a umask that opens new folders to the account's group is one.

**Tests:** waiting on #3177.

### `updates/start-waits-for-last-server`

If a server of the install still holds the lock on its database, its blob folder or its control socket 30 seconds after a start of the new release begins, then the CLI MUST end `marfa server run` with status 75, without counting the start or putting the old release back.

**Reason:** on macOS a server can outlive a `marfa server run` that was killed, and a start that fails on that server's locks is not the new release failing. The CLI waits for the lock first, because that server usually ends within seconds.

**Tests:** waiting on #3177.

### `updates/start-unsettled-limit`

If a start of the new release is not upgrading the database and its update has not settled within 10 minutes of the start, or of the end of the start's database upgrade, then the CLI MUST stop that server, keep the start counted, and end `marfa server run` with status 75.

**Reason:** a release that hangs, or whose health never rises above `down`, does not end by itself, so the old release would never come back.

**Tests:** waiting on #3177.

### `updates/start-upgrade-limit`

If a start of the new release has spent 2 hours upgrading the database and the upgrade has not ended, then the CLI MUST stop that server, keep the start counted, and end `marfa server run` with status 75.

**Reason:** an upgrade rewrites the database in one transaction that a stop undoes, so a large database on a slow disk must not be stopped while its upgrade makes progress, and an upgrade that hangs must still let the old release come back.

**Tests:** waiting on #3177.

### `updates/upgrade-began-marked`

When a start of the new release of an update that has not settled begins to upgrade the database, the server MUST write `began` to the update's `upgrade.json` before it changes the database.

**Reason:** `marfa server run` reads the mark to time the upgrade apart from the start.

**Tests:** waiting on #3177.

### `updates/upgrade-ended-marked`

When a start of the new release of an update that has not settled has committed its upgrade of the database, the server MUST write `ended` to the update's `upgrade.json`.

**Tests:** waiting on #3177.

### `updates/rollback-names-limit`

If a time limit ended a start of the new release and the old release is then put back, then the CLI MUST name that limit in the reason of the `rolled_back` update.

**Reason:** an owner whose release was put back for its time sees why, and is not left to guess at a crash.

**Tests:** waiting on #3177.

### `updates/failed-start-restarts`

If a start of the new release ends before its update settles and no stop was asked of the service, then the CLI MUST end `marfa server run` with status 75, whatever status the server ended with.

**Reason:** launchd and systemd start a service again only after a failed exit, so a new release that exits with status 0 would otherwise leave the server down.

**Tests:** waiting on #3177.

### `updates/clean-stop-not-counted`

If a stop asked of the service ends a start of the new release before its update settles, then the CLI MUST NOT count that start toward putting the old release back.

**Reason:** a stop, or the machine shutting down, is not the new release failing.

**Tests:** waiting on #3177.

### `updates/rollback`

If two starts of the new release have ended before its update settled and the old server opens the database with the schema it had before the swap, then the CLI MUST put the old programs back at the next start of `marfa server run` and report the update as `rolled_back`.

**Reason:** a new release that cannot come up should not leave the owner with a server that is down.

**Tests:** waiting on #3177.

### `updates/rollback-refused-at-once`

If the new release ends with status 78 before its update settles and the old server opens the database with the schema it had before the swap, then the CLI MUST put the old programs back before the service starts again and report the update as `rolled_back`.

**Reason:** status 78 says the release refused the database or the settings, which another start does not change.

**Tests:** waiting on #3177.

### `updates/rollback-impossible`

If the new release is to be put back and the old server will not open the database or the database's schema has changed since the swap, then the CLI MUST report the update as `failed`, saying why the old release cannot be put back.

**Tests:** waiting on #3177.

### `updates/rollback-put-back-fails`

If the old `marfa-server` is to be put back and cannot be moved into place, then the CLI MUST put the new `marfa` in place beside the new `marfa-server`, report the update as `failed` with the error, and run the new release at the next start.

**Reason:** an install left with nothing it can start would leave the owner's server down.

**Tests:** waiting on #3177.

### `updates/rollback-impossible-whole`

If the new release is to be put back and the old server will not open the database or the database's schema has changed since the swap, then the CLI MUST put the new `marfa` in place beside the new `marfa-server`.

**Reason:** `marfa server run` refuses to start a `marfa-server` of another release, so a half-swapped install would not start again.

**Tests:** waiting on #3177.

### `updates/forward-marfa-fails`

If the new release is to stay because the old one cannot be put back, and the new `marfa` cannot be put in place, then the CLI MUST report the update as `failed` with the step to install the new release on the host, and keep the update's record, so that the old `marfa` goes on starting the new `marfa-server` and counts none of its starts.

**Reason:** the update has ended, and the server must still start until the owner installs the release whole.

**Tests:** waiting on #3177.

### `updates/outcome-per-attempt`

If an update to a release ends after an earlier update to the same release has ended, then the server MUST report the later update's own outcome as the last update.

**Reason:** a release put back once can be tried again, and the second try's outcome must not be taken for the first's.

**Tests:** waiting on #3177.

## Settling

### `updates/settle-both-programs`

When the new release has stayed up for 20 seconds, the server MUST put the new `marfa` in place and report the update as `succeeded` only once both `marfa` and `marfa-server` in its programs folder report the new release.

**Reason:** the server's own release proves only that the server program was swapped.

**Tests:** waiting on #3177.

### `updates/settle-half-put-back`

If the new release has stayed up for 20 seconds, a program in its folder does not report the new release, and the old server opens the database with the schema it had before the swap, then the server MUST put the old programs back and report the update as `rolled_back`, naming what each program reports.

**Tests:** waiting on #3177.

### `updates/settle-half-failed`

If the new release has stayed up for 20 seconds, a program in its folder does not report the new release, and the old server will not open the database or the database's schema has changed since the swap, then the server MUST report the update as `failed` with the step to install the new release on the host.

**Reason:** the old release cannot run on a database it does not open, so the new release keeps running.

**Tests:** waiting on #3177.

### `updates/settle-half-failed-marfa`

If the new release has stayed up for 20 seconds, the old release cannot be put back, and the new `marfa` that was put in place does not report the new release, then the server MUST put the old `marfa` back.

**Reason:** the service's `marfa server run` starts the new server again after a restart, which a `marfa` that does not run cannot do.

**Tests:** waiting on #3177.

### `updates/settle-after-ended`

If an update has already ended as `failed` with its record kept, then the server MUST NOT put the old server back when the new release has stayed up for 20 seconds.

**Reason:** the update ended because the old release could not come back, and a put-back would leave a server that refuses the database.

**Tests:** waiting on #3177.
