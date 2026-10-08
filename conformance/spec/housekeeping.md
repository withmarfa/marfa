# Housekeeping

The periodic jobs the server runs on itself, such as the trash purge, version thinning and the log cleanups. One scheduler runs them all. Listing uses `instance.read`; running a job uses `instance.maintain`.

## The housekeeping jobs

### `housekeeping/list-jobs`

When a caller authorized by `instance.read` or direct owner or local authority sends `GET /housekeeping`, the server MUST answer with every housekeeping job it runs, each with its `name`, `interval_ms`, `next_run_at`, `running_since`, `last_started_at`, `last_finished_at`, `last_outcome`, `last_error` and `last_result`.

**Reason:** what runs, when it is next due and what its last run did are answered in one place.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the management key`, `compliance/management-grants.test.ts › instance.read grants reports to keys and apps without granting maintenance`.

### `housekeeping/list-operator-only`

When a key or app token lacking `instance.read` sends `GET /housekeeping`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/housekeeping.test.ts › refuses the listing to a working key`, `compliance/housekeeping-job-running.test.ts › refuses the listing and a run to an app's access token`, `compliance/management-grants.test.ts › instance.read grants reports to keys and apps without granting maintenance`.

### `housekeeping/always-listed`

The server MUST list `trash-purge`, `version-thinning`, `event-log-cleanup`, `audit-cleanup`, `inbound-delivery-cleanup`, `auth-session-cleanup`, `rate-limit-cleanup`, `revoked-key-reap`, `webhook-schedule`, `webhook-poll`, `blob-replicate` and `blob-integrity` on every instance, whatever its settings and its `/config`.

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

**Tests:** waiting on #1444.

### `housekeeping/retention-positive-expires`

Where a retention is positive, the server MUST expire the eligible records older than it.

**Tests:** waiting on #1444.

### `housekeeping/retention-maximum-runs`

Where a retention `PUT /config` sets is at the largest value it accepts, the server MUST finish each cleanup job that reads that retention with `last_outcome` `ok`.

**Reason:** the largest window must still give a valid cutoff date.

**Tests:** `compliance/housekeeping.test.ts › runs each cleanup job at the largest retention it accepts`.

### `housekeeping/retention-setting-maximum-runs`

Where a retention setting is at the largest value it accepts, the server MUST finish each cleanup job that reads that setting with `last_outcome` `ok`.

**Tests:** waiting on #1444.

### `housekeeping/retention-setting-days-range`

If `AUDIT_RETENTION_DAYS`, `TRASH_RETENTION_DAYS`, `MARFA_INBOUND_HANDLED_RETENTION_DAYS`, `MARFA_INBOUND_PENDING_RETENTION_DAYS`, `MARFA_REVOKED_GRANT_RETENTION_DAYS`, `MARFA_GRANT_INACTIVITY_DAYS` or `MARFA_DCR_CLIENT_RETENTION_DAYS` holds a value that is neither empty nor an integer from 0 through 36500 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** waiting on #1444.

### `housekeeping/retention-setting-hours-range`

If `MARFA_EVENT_LOG_RETENTION_HOURS` holds a value that is neither empty nor an integer from 0 through 876000 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** waiting on #1444.

### `housekeeping/retention-setting-ms-range`

If `MARFA_BULK_ACTION_JOB_RETENTION_MS` holds a value that is neither empty nor an integer from 0 through 3153600000000 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** waiting on #1444.

## Version thinning

The `version-thinning` job removes an item's older snapshots by its type's `version_policy` (`types/version-policy-values`).

### `housekeeping/thinning-policy`

When the `version-thinning` job thins an item's history, the server MUST keep the snapshots the effective `version_policy` of the item's type keeps, as `GET /types/{id}` answers it.

**Reason:** a policy read from the type alone would delete history the policy advertised for the type keeps.

**Tests:** `compliance/version-policy.test.ts › thins an item's history by the policy its type inherits`.

### `housekeeping/thinning-policy-defaults`

When no type in an item's type chain declares a field of `version_policy`, the server MUST take that field from the instance defaults when it thins the item.

**Tests:** waiting on #1444.

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

**Tests:** waiting on #1444.

### `housekeeping/thinning-race`

When a type is replaced while the `version-thinning` job thins its items, the server MUST thin each item by the policy as it stands when its snapshots are removed.

**Tests:** waiting on #1444.

## Restarts and deadlines

No fixture can restart the server yet. Nor can one hold a run past its deadline: the heartbeat and the webhook poll stop waiting for their receivers after 10 seconds, before their deadlines.

### `housekeeping/schedule-survives-restart`

When the server restarts, the server MUST NOT move a job's `next_run_at` later than it was.

**Tests:** waiting on #1444.

### `housekeeping/unfinished-run-cleared`

When the server starts, the server MUST clear `running_since` from every run the previous process left unfinished.

**Tests:** waiting on #1444.

### `housekeeping/deadline-recorded`

If a run outlives its deadline, then the server MUST record the run with `last_outcome` `error` and a `last_error` saying it did not finish in time.

**Tests:** waiting on #1444.

### `housekeeping/deadline-frees-job`

If a run outlives its deadline, then the server MUST run that job again when asked, rather than answer `409 housekeeping_job_running`.

**Tests:** waiting on #1444.

### `housekeeping/deadline-result-discarded`

If a run that outlived its deadline later finishes, then the server MUST NOT record what it finished with.

**Tests:** waiting on #1444.
