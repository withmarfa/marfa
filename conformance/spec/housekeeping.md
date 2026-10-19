# Housekeeping

The periodic jobs the server runs on itself, such as the trash purge, version thinning and the log cleanups. One scheduler runs them all. Listing uses `instance.read`; running a job uses `instance.maintain`.

## Registered jobs

The server registers the following jobs when their settings and required stores admit them. Settings are listed in [Settings](instance.md#settings).

<!-- housekeeping-table:start -->

| Job                           | What it does                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `event-log-cleanup`           | Removes expired event log entries and idempotency records.                       |
| `audit-cleanup`               | Removes expired audit entries and outbound webhook delivery history.             |
| `webhook-schedule`            | Schedules outbound webhook deliveries for new events.                            |
| `webhook-poll`                | Sends pending outbound webhook deliveries and retries failures.                  |
| `heartbeat`                   | Pings the configured liveness receiver.                                          |
| `version-thinning`            | Thins item versions according to the configured retention policy.                |
| `feed-expiry`                 | Moves expired feed items to the trash.                                           |
| `trash-purge`                 | Permanently removes items whose trash retention has elapsed.                     |
| `revoked-grant-purge`         | Removes revoked application grants after their retention window.                 |
| `grant-inactivity-retirement` | Revokes application grants that have not been used within the inactivity window. |
| `revoked-key-reap`            | Removes revoked or expired keys after the retention window.                      |
| `auth-session-cleanup`        | Removes expired authentication sessions.                                         |
| `rate-limit-cleanup`          | Removes expired rate limit windows.                                              |
| `inbound-delivery-cleanup`    | Removes inbound deliveries after their handled or pending retention window.      |
| `dcr-client-cleanup`          | Removes OAuth clients with no remaining grant after their retention window.      |
| `blob-replicate`              | Copies blobs to satisfy each attached store's replication policy.                |
| `blob-integrity`              | Checks blob copies and removes locations whose bytes are missing or altered.     |
| `blob-orphans`                | Reports unreferenced blobs and purges them after the grace period.               |
| `enrichment-sweep`            | Extracts searchable text and image dimensions from uploaded files.               |
| `bulk-action-gc`              | Removes completed bulk action jobs after their retention window.                 |

<!-- housekeeping-table:end -->

## The housekeeping jobs

### `housekeeping/list-jobs`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /housekeeping`, the server MUST answer with every housekeeping job it runs, each with its `name`, `interval_ms`, `next_run_at`, `running_since`, `last_started_at`, `last_finished_at`, `last_outcome`, `last_error` and `last_result`.

**Reason:** what runs, when it is next due and what its last run did are answered in one place.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the management key`, `compliance/management-grants.test.ts › instance.read grants reports to keys and apps without granting maintenance`.

### `housekeeping/list-operator-only`

When a key or app token lacking `instance.read` sends `GET /housekeeping`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/housekeeping.test.ts › refuses the listing to a working key`, `compliance/housekeeping-job-running.test.ts › refuses the listing and a run to an app's access token`, `compliance/management-grants.test.ts › instance.read grants reports to keys and apps without granting maintenance`.

### `housekeeping/always-listed`

The server MUST list `trash-purge`, `version-thinning`, `feed-expiry`, `event-log-cleanup`, `audit-cleanup`, `inbound-delivery-cleanup`, `auth-session-cleanup`, `rate-limit-cleanup`, `revoked-key-reap`, `webhook-schedule`, `webhook-poll`, `blob-replicate` and `blob-integrity` on every instance, whatever its settings and its `/config`.

**Reason:** these jobs have no off switch. A job whose retention `/config` can set still runs when that retention is 0, and keeps everything.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the management key`.

### `housekeeping/switched-off-not-listed`

Where a setting switches a housekeeping job off, the server MUST leave that job out of the listing.

**Tests:** `compliance/housekeeping.test.ts › leaves a job a setting switches off out of the listing, and answers 404 for it`, `compliance/enrichment-malformed-image.test.ts › lists the enrichment sweep on a server with enrichment on`.

### `housekeeping/last-outcome`

The server MUST answer a job's `last_outcome` as `null` until a run of it has finished, and as `ok` or `error` after.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the management key`.

### `housekeeping/running-since-set`

While a run of a housekeeping job is in progress, the server MUST answer that job's `running_since` with the time the run started.

**Tests:** `compliance/housekeeping-job-running.test.ts › runs another job while one is held, and lists when the held run started`, `compliance/housekeeping-job-running.test.ts › answers 409 housekeeping_job_running, and runs once the earlier run has ended`.

## Running a job now

What the server answers to a run asked for while the same job is running is `errors/job-running`.

### `housekeeping/run-now`

When a caller authorized by `instance.maintain` or direct owner or local authority sends `POST /housekeeping/{name}/run` naming a job the server runs, the server MUST run that job before it answers, and answer with the run's `name`, `started_at`, `finished_at`, `outcome`, `result` and `error`.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`.

### `housekeeping/run-recorded`

When a run finishes, the server MUST list its start, finish, outcome, error and result as the job's `last_started_at`, `last_finished_at`, `last_outcome`, `last_error` and `last_result`.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`.

### `housekeeping/running-since-cleared`

When a run finishes, the server MUST answer the job's `running_since` as `null`.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`, `compliance/housekeeping-job-running.test.ts › answers 409 housekeeping_job_running, and runs once the earlier run has ended`.

### `housekeeping/next-run-after-run`

When a run finishes, the server MUST hold the job's `next_run_at` later than the run's start and no later than one `interval_ms` after its finish.

**Reason:** a run ahead of schedule leaves the schedule where it was, and a run on schedule sets the next one.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`.

### `housekeeping/run-unknown-name`

When a caller authorized by `instance.maintain` or direct owner or local authority asks to run a name the server runs no job under, the server MUST answer `404 housekeeping_job_not_found`.

**Tests:** `compliance/housekeeping.test.ts › answers 404 for a name the instance does not run, where a listed one runs`.

### `housekeeping/switched-off-not-run`

Where a setting switches a housekeeping job off, when a caller authorized by `instance.maintain` or direct owner or local authority asks to run it, the server MUST answer `404 housekeeping_job_not_found`.

**Tests:** `compliance/housekeeping.test.ts › leaves a job a setting switches off out of the listing, and answers 404 for it`.

### `housekeeping/run-malformed-name`

When a caller authorized by `instance.maintain` or direct owner or local authority asks to run a name that does not match `^[a-z][a-z0-9-]*$`, the server MUST answer `400 validation_error`.

**Tests:** `compliance/housekeeping.test.ts › refuses a malformed name and a working key`.

### `housekeeping/run-operator-only`

When a key or app token lacking `instance.maintain` asks to run a housekeeping job, the server MUST answer `403 forbidden`.

**Tests:** `compliance/housekeeping.test.ts › refuses a malformed name and a working key`, `compliance/housekeeping-job-running.test.ts › refuses the listing and a run to an app's access token`, `compliance/management-grants.test.ts › instance.maintain grants maintenance to keys and apps without granting reports`.

### `housekeeping/runs-concurrent-across-jobs`

While a run of one housekeeping job is in progress, the server MUST run another job when it is due or asked for.

**Tests:** `compliance/housekeeping-job-running.test.ts › runs another job while one is held, and lists when the held run started`.

## The enrichment sweep

The `enrichment-sweep` job reads a file item's bytes and writes what it finds onto the item: an image's `width` and `height`, and a file's `extracted_text`. Enrichment is on unless a setting switches it off. OCR, which reads text from images, has a switch of its own.

### `housekeeping/enrichment-failure-counted`

Where enrichment and OCR are on, if an image file item's bytes are not an image, then the server MUST count the item as `failed` in the result of each `enrichment-sweep` run that offers it, until its attempts run out.

**Reason:** a file the sweep cannot read is a failure recorded against that file, never the end of the server.

**Tests:** `compliance/enrichment-malformed-image.test.ts › is recorded as a failed enrichment, and the server goes on answering`.

### `housekeeping/enrichment-failure-keeps-serving`

If the enrichment sweep cannot read a file, then the server MUST go on answering requests, the item's own included.

**Tests:** `compliance/enrichment-malformed-image.test.ts › is recorded as a failed enrichment, and the server goes on answering`.

### `housekeeping/enrichment-failure-invents-nothing`

If the enrichment sweep cannot read an image, then the server MUST NOT write a `width` or `height` onto its item.

**Tests:** `compliance/enrichment-malformed-image.test.ts › is recorded as a failed enrichment, and the server goes on answering`.

### `housekeeping/enrichment-document-inflated`

Where enrichment is on, if the parts of a document together inflate past `MARFA_ENRICHMENT_MAX_INFLATED_BYTES`, then the server MUST count the item as skipped in the result of the `enrichment-sweep` run.

**Reason:** an Office document is a zip file, and a few hundred kilobytes can inflate to a gigabyte. A skip is final until a limit changes, so the item does not take the same time and memory at every sweep.

**Tests:** `compliance/enrichment-document-bounds.test.ts › is skipped, writes no text, and leaves the server answering, beside a document that reads`.

### `housekeeping/enrichment-document-memory`

Where enrichment is on, if reading a document needs more memory than `MARFA_ENRICHMENT_MAX_MEMORY_BYTES`, then the server MUST count the item as skipped in the result of the `enrichment-sweep` run.

**Reason:** a document of many small parts can fill a heap without inflating far, so the inflated size alone does not bound it.

**Tests:** `compliance/enrichment-document-bounds.test.ts › is skipped, writes no text, and leaves the server answering, beside a document that reads`.

### `housekeeping/enrichment-text-whole`

Where enrichment is on, if the text of a file is longer than `MARFA_ENRICHMENT_MAX_TEXT_CHARS` UTF-16 code units, then the server MUST write an `extracted_text` that ends before any character the limit would cut in two.

**Reason:** a character outside the Basic Multilingual Plane takes two code units, and half of one is text that is not well-formed (`items/json-text-well-formed`).

**Tests:** `compliance/enrichment-text-cut.test.ts › cuts extracted text at the limit without cutting a character in two`.

### `housekeeping/enrichment-document-no-text`

If the enrichment sweep skips a document for a limit, then the server MUST NOT write an `extracted_text` onto its item.

**Tests:** `compliance/enrichment-document-bounds.test.ts › is skipped, writes no text, and leaves the server answering, beside a document that reads`.

### `housekeeping/enrichment-document-keeps-serving`

If the enrichment sweep meets a document that asks for more than extraction may use, then the server MUST go on answering requests.

**Tests:** `compliance/enrichment-document-bounds.test.ts › is skipped, writes no text, and leaves the server answering, beside a document that reads`.

### `housekeeping/enrichment-document-left`

If the enrichment sweep has skipped a document for a limit, then the server MUST NOT offer the document to the next sweep while both limits stand.

**Tests:** `compliance/enrichment-document-bounds.test.ts › is skipped, writes no text, and leaves the server answering, beside a document that reads`.

### `housekeeping/enrichment-document-limit-raised`

When `MARFA_ENRICHMENT_MAX_INFLATED_BYTES` or `MARFA_ENRICHMENT_MAX_MEMORY_BYTES` is raised to cover a document the sweep skipped for it, the server MUST write the document's `extracted_text` at the next `enrichment-sweep` run.

**Tests:** `compliance/enrichment-document-bounds.test.ts › is read once the limits are raised`.

### `housekeeping/enrichment-interrupted-counted`

If the server is stopped, as many times as `MARFA_ENRICHMENT_MAX_ATTEMPTS`, while the enrichment sweep extracts the text of an item, then the server MUST NOT offer that item to the next `enrichment-sweep` run.

**Reason:** an item that stops the server every time is otherwise offered again at every start, as if it had never been tried, and takes the server down each time.

**Tests:** `compliance/enrichment-interrupted.test.ts › is not offered to the next sweep once its attempts are used, beside an item that reads`.

### `housekeeping/enrichment-image-by-type`

Where enrichment is on, the server MUST write `width` and `height` from the image bytes of an item whose type inherits from `core.file.image`, whatever the type is named.

**Tests:** `compliance/enrichment-by-inheritance.test.ts › takes a type inheriting from a file type as that file, whatever its name`.

### `housekeeping/enrichment-text-by-type`

Where enrichment is on, the server MUST write the plain-text bytes of an item whose type inherits from `core.file` as its `extracted_text`, whatever the type is named.

**Tests:** `compliance/enrichment-by-inheritance.test.ts › takes a type inheriting from a file type as that file, whatever its name`.

### `housekeeping/enrichment-needs-file-type`

The server MUST NOT offer the enrichment sweep an item whose type inherits from no file type, even one whose type declares `blob_ref` and `mime_type` itself.

**Tests:** `compliance/enrichment-by-inheritance.test.ts › takes a type inheriting from a file type as that file, whatever its name`.

### `housekeeping/image-size-from-header`

Where enrichment is on and OCR is off, if an image item's bytes start with a GIF, JPEG or WebP signature over a malformed header, then the server MUST NOT write a `width` or `height` onto the item.

**Reason:** a size read from a broken header is a size made up.

**Tests:** `compliance/enrichment-image-headers.test.ts › gets no size from a GIF, JPEG or WebP signature over garbage`.

### `housekeeping/image-malformed-skipped`

Where enrichment is on and OCR is off, if an image item's bytes start with a GIF, JPEG or WebP signature over a malformed header, then the server MUST count the item as skipped in the `enrichment-sweep` result.

**Tests:** `compliance/enrichment-image-headers.test.ts › gets no size from a GIF, JPEG or WebP signature over garbage`.

### `housekeeping/image-size-formats`

Where enrichment is on, the server MUST write `width` and `height` for a well-formed GIF, JPEG or WebP image.

**Tests:** `compliance/enrichment-image-headers.test.ts › gets no size from a GIF, JPEG or WebP signature over garbage`.

## Retention

`PUT /config` sets how long the server keeps some records, and settings give the defaults. Settings alone set how long it keeps others, such as revoked grants and finished bulk-action jobs.

### `housekeeping/retention-days-range`

When `PUT /config` names `audit_retention_days`, `trash_retention_days`, `inbound_handled_retention_days` or `inbound_pending_retention_days` as anything but an integer from 0 through 36500, the server MUST answer `400 validation_error`.

**Tests:** `compliance/housekeeping.test.ts › refuses a retention beyond its range and keeps the stored one`.

### `housekeeping/retention-hours-range`

When `PUT /config` names `event_log_retention_hours` as anything but an integer from 0 through 876000, the server MUST answer `400 validation_error`.

**Tests:** `compliance/housekeeping.test.ts › refuses a retention beyond its range and keeps the stored one`.

### `housekeeping/retention-refusal-keeps-config`

When the server refuses a retention in `PUT /config`, the server MUST keep the stored configuration as it was.

**Tests:** `compliance/housekeeping.test.ts › refuses a retention beyond its range and keeps the stored one`.

### `housekeeping/retention-zero-keeps`

Where a retention is 0, the server MUST NOT expire records by age under it.

**Tests:** `compliance/housekeeping-retention.test.ts › keeps every record of each kind, however far the clock moves`.

### `housekeeping/retention-positive-expires`

Where a retention is positive, the server MUST expire the eligible records older than it.

**Tests:** `compliance/housekeeping-retention.test.ts › expires the records of each kind older than it, and keeps the newer`.

### `housekeeping/retention-trash-keeps-up`

While items in the bin are older than the trash retention and a run of `trash-purge` has removed some of them, the server MUST run `trash-purge` again without waiting for its interval.

**Reason:** a run removes a limited number of items, so a purge that ran once an interval could not keep up with an instance that bins more items in an interval than a run removes, and its backlog would grow without end.

**Tests:** `compliance/housekeeping-retention.test.ts › empties it without waiting the job's interval for each batch, and audits every run`.

### `housekeeping/retention-maximum-runs`

Where a retention `PUT /config` sets is at the largest value it accepts, the server MUST finish each cleanup job that reads that retention with `last_outcome` `ok`.

**Reason:** the largest window must still give a valid cutoff date.

**Tests:** `compliance/housekeeping.test.ts › runs each cleanup job at the largest retention it accepts`.

### `housekeeping/retention-setting-maximum-runs`

Where a retention setting is at the largest value it accepts, the server MUST finish each cleanup job that reads that setting with `last_outcome` `ok`.

**Tests:** `compliance/housekeeping-settings.test.ts › finishes each cleanup job that reads a retention setting at the largest value with last_outcome ok`.

### `housekeeping/retention-setting-days-range`

If `AUDIT_RETENTION_DAYS`, `TRASH_RETENTION_DAYS`, `MARFA_INBOUND_HANDLED_RETENTION_DAYS`, `MARFA_INBOUND_PENDING_RETENTION_DAYS`, `MARFA_REVOKED_GRANT_RETENTION_DAYS`, `MARFA_GRANT_INACTIVITY_DAYS` or `MARFA_DCR_CLIENT_RETENTION_DAYS` holds a value that is neither empty nor an integer from 0 through 36500 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** `compliance/housekeeping-settings.test.ts › refuses a value of the day settings that is not a whole number from 0 through 36500, and names the setting`, `› starts with each setting empty, and with each at its smallest`.

### `housekeeping/retention-setting-hours-range`

If `MARFA_EVENT_LOG_RETENTION_HOURS` holds a value that is neither empty nor an integer from 0 through 876000 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** `compliance/housekeeping-settings.test.ts › refuses MARFA_EVENT_LOG_RETENTION_HOURS outside 0 through 876000, and names the setting`, `› starts with each setting empty, and with each at its smallest`.

### `housekeeping/retention-setting-ms-range`

If `MARFA_BULK_ACTION_JOB_RETENTION_MS` holds a value that is neither empty nor an integer from 0 through 3153600000000 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** `compliance/housekeeping-settings.test.ts › refuses MARFA_BULK_ACTION_JOB_RETENTION_MS outside 0 through 3153600000000, and names the setting`, `› starts with each setting empty, and with each at its smallest`.

## Version thinning

The `version-thinning` job removes an item's older snapshots by its type's `version_policy` (`types/version-policy-values`).

### `housekeeping/thinning-policy`

When the `version-thinning` job thins an item's history, the server MUST keep the snapshots the effective `version_policy` of the item's type keeps, as `GET /types/{id}` answers it.

**Reason:** a policy read from the type alone would delete history the policy advertised for the type keeps.

**Tests:** `compliance/version-policy.test.ts › thins an item's history by the policy its type inherits`.

### `housekeeping/thinning-policy-defaults`

When no type in an item's type chain declares a field of `version_policy`, the server MUST take that field from the instance defaults when it thins the item.

**Tests:** `compliance/housekeeping-thinning.test.ts › takes recent_days from the instance default when no type in the chain declares it`, `› takes daily_snapshot_days from the instance default when no type in the chain declares it`, `› takes weekly_snapshot_days from the instance default when no type in the chain declares it`, `› takes max_versions from the instance default when no type in the chain declares it`.

### `housekeeping/thinning-minimum`

The server MUST NOT thin an item whose history holds two snapshots or fewer.

**Tests:** `compliance/version-policy.test.ts › never thins an item holding two versions or fewer`.

### `housekeeping/thinning-bin`

The server MUST thin an item in the bin as it thins a live one.

**Tests:** `compliance/version-policy.test.ts › thins an item in the bin as it thins a live one`.

### `housekeeping/thinning-unregistered`

When an item's type is no longer registered, the server MUST NOT thin the item by a `version_policy` the type held.

**Tests:** `compliance/version-policy.test.ts › does not thin an item whose type was force-deleted by the policy the type held`.

### `housekeeping/thinning-unregistered-defaults`

When an item's type is no longer registered, the server MUST thin the item by the instance defaults.

**Tests:** `compliance/housekeeping-thinning.test.ts › thins an item whose type is no longer registered by the instance defaults`.

### `housekeeping/thinning-race`

When a type is replaced while the `version-thinning` job thins its items, the server MUST thin each item by the policy as it stands when its snapshots are removed.

**Tests:** `compliance/housekeeping-thinning.test.ts › thins each item by the policy as it stands when its snapshots are removed`.

## Feed expiry

The `feed-expiry` job moves feed items to the bin by their type's `retention_policy` (`types/retention-policy-merge`). Its interval is `FEED_EXPIRY_INTERVAL_MS`. A moved item is in the bin as a deleted one is, and the `trash-purge` job removes it for good after the trash's own retention.

### `housekeeping/feed-expiry-window`

When the `feed-expiry` job runs, the server MUST move to the bin each active feed item once more than the resolved `feed_days` of its type has passed, in days, since the item's `created_at`.

**Reason:** a type of feed items that arrive in volume, such as a feed's entries, would otherwise grow without bound.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › moves a feed item to the bin once its type's days have passed since it arrived, and not before`.

### `housekeeping/feed-expiry-early`

While no more than the resolved `feed_days` of an item's type has passed, in days, since the item's `created_at`, the server MUST NOT move the item to the bin when the `feed-expiry` job runs.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › moves a feed item to the bin once its type's days have passed since it arrived, and not before`.

### `housekeeping/feed-expiry-arrival`

The server MUST count the age of a feed item for the `feed-expiry` job from the item's `created_at`, which a natural-key upsert of the item keeps.

**Reason:** a connector that refreshes an entry on every sync would otherwise keep resetting its clock.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › counts from arrival, which a natural-key upsert keeps`.

### `housekeeping/feed-expiry-tier-move`

When an item that arrived in the library is moved to the feed, the server MUST judge it at the next run of the `feed-expiry` job by its `created_at`.

**Reason:** a person who moves an old item to the feed has put it in the tier that expires, and the bin keeps it recoverable.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › judges an item moved from the library to the feed by its arrival, at the next run`.

### `housekeeping/feed-expiry-library`

The server MUST NOT move a library item to the bin when the `feed-expiry` job runs, whatever its age.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › keeps a library item past the window, and the feed item beside it goes`.

### `housekeeping/feed-expiry-no-window`

While the resolved `feed_days` of a type is absent or `null`, the server MUST NOT move an item of the type to the bin when the `feed-expiry` job runs.

**Reason:** a type that declares no window, and every type that existed before the policy did, keeps its items.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › keeps the items of a type whose window is absent or null, and a child's own window applies`.

### `housekeeping/feed-expiry-inherited`

When a type names no `feed_days` of its own, the server MUST expire its feed items by the `feed_days` its nearest ancestor naming one gives it, as `GET /types/{id}` answers it.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › takes a child's window from its parent, and a grandchild's from the chain`, `› keeps the items of a type whose window is absent or null, and a child's own window applies`.

### `housekeeping/feed-expiry-current-window`

When a type's `retention_policy` is replaced, the server MUST expire the type's feed items at the next run of the `feed-expiry` job by the window as it stands then.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › applies the window a type has at the next run when it is changed after the items arrived`.

### `housekeeping/feed-expiry-archived`

The server MUST NOT move an archived feed item to the bin when the `feed-expiry` job runs.

**Reason:** a feed item is transitory until it is promoted or archived, so a person who archived it has kept it.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › keeps a feed item a person archived, and the active one beside it goes`.

### `housekeeping/feed-expiry-in-bin`

The server MUST leave a feed item that is already in the bin where it is when the `feed-expiry` job runs, and announce nothing for it.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › leaves an item already in the bin where it is, with no second announcement`.

### `housekeeping/feed-expiry-restored`

The server MUST NOT move an item to the bin by the `feed-expiry` job after it has been brought back from the bin, by a restore or by a transition to `active`.

**Reason:** an expiry that a person undid by restoring would otherwise repeat at every run, and the item could never be kept.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › does not move an item again that was brought back from the bin, by restore or by transition`.

### `housekeeping/feed-expiry-restored-archive`

When an archive carries an item that had been brought back from the bin, and it is restored into an instance, the server MUST NOT move that item to the bin by the `feed-expiry` job.

**Reason:** the archive is how an instance moves to a new build, and the first run there would otherwise move every item a person rescued back to the bin.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › keeps an item brought back from the bin through an archive restored into a new instance`.

### `housekeeping/feed-expiry-unregistered`

While an item's type is not registered, the server MUST NOT move the item to the bin when the `feed-expiry` job runs.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › keeps the items of a type that was force-deleted, and judges them once it is registered again`.

### `housekeeping/feed-expiry-batch`

When more feed items have expired than one transaction moves, the server MUST move every one of them in the same run of the `feed-expiry` job.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › moves every expired item however many there are`.

### `housekeeping/feed-expiry-recoverable`

When the `feed-expiry` job moves an item to the bin, the server MUST keep it there so that `POST /items/{id}/restore` brings it back active.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › keeps an expired item in the bin, where a restore brings it back active`.

### `housekeeping/feed-expiry-announced`

When the `feed-expiry` job moves an item to the bin, the server MUST announce it as `item.deleted` on the event stream.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › announces item.deleted for an expired item`.

### `housekeeping/feed-expiry-audited`

When the `feed-expiry` job moves items to the bin, the server MUST record an audit entry with the action `items.feed_expired`, naming in its `details` the `type`, the number `moved` and the `item_ids`, those a cascade took with another included.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › records an audit entry naming the type and the items it moved`.

### `housekeeping/feed-expiry-promoted`

When the `feed-expiry` job moves a feed item to the bin, the server MUST leave a library item linked to it by a `derived-from` edge active and unchanged.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › leaves the library copy a feed item was promoted to active and unchanged`.

### `housekeeping/feed-expiry-cascade`

When every item an expired feed item's cascading edges reach is an expired feed item or already in the bin, the server MUST move the item to the bin with them when the `feed-expiry` job runs.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › takes a parent with its children when all of them are expired feed items`.

### `housekeeping/feed-expiry-cascade-held`

If an expired feed item's cascading edges reach an item that is not an expired feed item and is not in the bin, then the server MUST leave the item active when the `feed-expiry` job runs.

**Reason:** a delete by cascade would take a library item, an archived one or a feed item that has not yet expired, which no window gave up.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › holds back a parent whose children include an item that has not expired or is in the library`.

### `housekeeping/feed-expiry-blocked`

If an edge with `cascade_on_delete` of `block` refuses the delete of an expired feed item, then the server MUST leave the item active when the `feed-expiry` job runs.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › holds back an item whose delete an edge with cascade_on_delete block refuses`.

### `housekeeping/feed-expiry-report`

When a run of the `feed-expiry` job finishes, the server MUST report in its `result` the number of items it moved to the bin, those a cascade took with another included, as `moved` and the number it held back as `held`.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › reports the number of items it moved to the bin and the number it held back`.

### `housekeeping/feed-expiry-event-log`

The server MUST NOT shorten how long the event log keeps an event because of a type's `retention_policy`.

**Reason:** the event log keeps its own retention (`MARFA_EVENT_LOG_RETENTION_HOURS`), which a device that catches up depends on.

**Tests:** `compliance/housekeeping-feed-expiry.test.ts › is the event log's own, whatever window a type names`.

## Restarts and deadlines

The fixtures here restart the server, hold a run open and shorten its deadline through the target interface (`conformance/README.md`, "Target interface"): the adapter's `restart` command, and its `hold:housekeeping:<job>` and `deadline:<job>` faults.

### `housekeeping/schedule-survives-restart`

When the server restarts, the server MUST NOT move a job's `next_run_at` later than it was.

**Tests:** `compliance/housekeeping-restart.test.ts › does not move a job's next_run_at later than it was`.

### `housekeeping/unfinished-run-cleared`

When the server starts, the server MUST clear `running_since` from every run the previous process left unfinished.

**Tests:** `compliance/housekeeping-restart.test.ts › is cleared when the server starts, and the job runs again when asked`.

### `housekeeping/deadline-recorded`

If a run outlives its deadline, then the server MUST record the run with `last_outcome` `error` and a `last_error` saying it did not finish in time.

**Tests:** `compliance/housekeeping-restart.test.ts › is recorded with last_outcome error and a last_error saying it did not finish in time`.

### `housekeeping/deadline-frees-job`

If a run outlives its deadline, then the server MUST run that job again when asked, rather than answer `409 housekeeping_job_running`.

**Tests:** `compliance/housekeeping-restart.test.ts › frees the job, so it runs again when asked rather than answering 409 housekeeping_job_running`.

### `housekeeping/deadline-result-discarded`

If a run that outlived its deadline later finishes, then the server MUST NOT record what it finished with.

**Tests:** `compliance/housekeeping-restart.test.ts › does not record what the run finishes with if it later finishes`.
