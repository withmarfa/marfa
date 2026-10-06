# Housekeeping

The periodic jobs the server runs on itself, such as the trash purge, version thinning and the log cleanups. `GLOSSARY.md` lists them. One scheduler runs every job from one table, so the operator can see what runs, when each job is next due and what its last run did, and can run any job now.

## The housekeeping jobs

### `housekeeping/list-jobs`

When the operator key sends `GET /housekeeping`, the server MUST answer with every housekeeping job it runs, each with its `name`, `interval_ms`, `next_run_at`, `running_since`, `last_started_at`, `last_finished_at`, `last_outcome`, `last_error` and `last_result`.

**Reason:** what runs, when it is next due and what its last run did are answered in one place.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the operator key`.

### `housekeeping/list-refuses-working-key`

When a working key sends `GET /housekeeping`, the server MUST answer `403 forbidden`.

**Tests:** `compliance/housekeeping.test.ts › refuses the listing to a working key`.

### `housekeeping/always-listed`

The server MUST list `trash-purge`, `version-thinning`, `event-log-cleanup`, `audit-cleanup`, `rate-limit-cleanup`, `revoked-key-reap`, `webhook-schedule` and `webhook-poll` on every instance, whatever its settings and its `/config`.

**Reason:** a job whose retention `/config` can set is still a job the instance runs when that retention is zero.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the operator key`.

### `housekeeping/switched-off-not-listed`

Where a setting switches a housekeeping job off, the server MUST leave that job out of the listing.

**Tests:** `compliance/housekeeping.test.ts › leaves a job a setting switches off out of the listing, and answers 404 for it`, `compliance/enrichment-malformed-image.test.ts › is recorded as a failed enrichment, and the server goes on answering`.

### `housekeeping/last-outcome`

The server MUST answer a job's `last_outcome` as `null` until a run of it has finished, and as `ok` or `error` after.

**Tests:** `compliance/housekeeping.test.ts › lists the housekeeping jobs to the operator key`.

### `housekeeping/running-since-set`

While a run of a housekeeping job is in progress, the server MUST answer that job's `running_since` with the time the run started.

**Tests:** waiting on #1444.

## Running a job now

A run asked for while the same job is running is refused `409 housekeeping_job_running`, which `errors.md` 23 states.

### `housekeeping/run-now`

When the operator key sends `POST /housekeeping/{name}/run` naming a job the server runs, the server MUST run that job before it answers, and answer with the run's `name`, `started_at`, `finished_at`, `outcome`, `result` and `error`.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`.

### `housekeeping/run-recorded`

When a run finishes, the server MUST list it as the job's last run, with `last_started_at`, `last_finished_at`, `last_outcome` and `last_result` as the run answered them, and `running_since` back to `null`.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`.

### `housekeeping/next-run-after-run`

When a run finishes, the server MUST hold the job's `next_run_at` later than the run's start and no later than one `interval_ms` after its finish.

**Reason:** a run ahead of schedule leaves the schedule where it was, and a run on schedule sets the next one.

**Tests:** `compliance/housekeeping.test.ts › runs a housekeeping job on demand and the listing records the run`.

### `housekeeping/run-unknown-name`

When the operator key asks to run a name the server runs no job under, the server MUST answer `404 housekeeping_job_not_found`.

**Tests:** `compliance/housekeeping.test.ts › answers 404 for a name the instance does not run, where a listed one runs`.

### `housekeeping/switched-off-not-run`

Where a setting switches a housekeeping job off, the server MUST answer a request to run it `404 housekeeping_job_not_found`.

**Tests:** `compliance/housekeeping.test.ts › leaves a job a setting switches off out of the listing, and answers 404 for it`.

### `housekeeping/run-malformed-name`

When the operator key asks to run a name that does not match `^[a-z][a-z0-9-]*$`, the server MUST answer `400 validation_error`.

**Tests:** `compliance/housekeeping.test.ts › refuses a malformed name and a working key`.

### `housekeeping/run-refuses-working-key`

When a working key asks to run a housekeeping job, the server MUST answer `403 forbidden`.

**Tests:** `compliance/housekeeping.test.ts › refuses a malformed name and a working key`.

## The enrichment sweep

The `enrichment-sweep` job reads a file item's bytes and writes what it finds onto the item: an image's `width` and `height`, and a file's `extracted_text`. It runs only where a setting switches enrichment on, and reads text from images only where OCR is on too.

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

Where enrichment is on and OCR is off, if an image item's bytes start with a GIF, JPEG or WebP signature over a malformed header, then the server MUST count the item as skipped in the `enrichment-sweep` result and write no `width` or `height`.

**Reason:** a size read from a broken header is a size made up.

**Tests:** `compliance/enrichment-image-headers.test.ts › gets no size from a GIF, JPEG or WebP signature over garbage`.

### `housekeeping/image-size-formats`

Where enrichment is on, the server MUST write `width` and `height` for a well-formed GIF, JPEG or WebP image.

**Tests:** `compliance/enrichment-image-headers.test.ts › gets no size from a GIF, JPEG or WebP signature over garbage`.

## Retention

`PUT /config` sets how long some records are kept: `audit_retention_days`, `trash_retention_days`, `inbound_handled_retention_days`, `inbound_pending_retention_days` and `event_log_retention_hours`. Settings give the defaults, and set the retention of other records, such as revoked grants and finished bulk-action jobs.

### `housekeeping/retention-days-range`

When `PUT /config` names `audit_retention_days`, `trash_retention_days`, `inbound_handled_retention_days` or `inbound_pending_retention_days` outside 0 through 36500, the server MUST answer `400 validation_error` and keep the stored configuration.

**Tests:** `compliance/housekeeping.test.ts › refuses a retention beyond its range and keeps the stored one`.

### `housekeeping/retention-hours-range`

When `PUT /config` names `event_log_retention_hours` outside 0 through 876000, the server MUST answer `400 validation_error` and keep the stored configuration.

**Tests:** `compliance/housekeeping.test.ts › refuses a retention beyond its range and keeps the stored one`.

### `housekeeping/retention-zero-keeps`

Where a retention is 0, the server MUST NOT expire records by age under it.

**Tests:** waiting on #1444.

### `housekeeping/retention-positive-expires`

Where a retention is positive, the server MUST expire the eligible records older than it.

**Tests:** waiting on #1444.

### `housekeeping/retention-maximum-runs`

Where a retention is at the largest value the server accepts, the server MUST finish each cleanup job that reads it with `last_outcome` `ok`.

**Reason:** the largest window must still give a valid cutoff date.

**Tests:** waiting on #1444.

### `housekeeping/retention-setting-days-range`

If `AUDIT_RETENTION_DAYS`, `TRASH_RETENTION_DAYS`, `MARFA_INBOUND_HANDLED_RETENTION_DAYS`, `MARFA_INBOUND_PENDING_RETENTION_DAYS`, `MARFA_REVOKED_GRANT_RETENTION_DAYS`, `MARFA_GRANT_INACTIVITY_DAYS` or `MARFA_DCR_CLIENT_RETENTION_DAYS` is outside 0 through 36500 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** waiting on #1444.

### `housekeeping/retention-setting-hours-range`

If `MARFA_EVENT_LOG_RETENTION_HOURS` is outside 0 through 876000 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** waiting on #1444.

### `housekeeping/retention-setting-ms-range`

If `MARFA_BULK_ACTION_JOB_RETENTION_MS` is outside 0 through 3153600000000 when the server starts, then the server MUST refuse to start and name the setting.

**Tests:** waiting on #1444.

## What is not observable over HTTP

These rules hold, but the referee boots one server once and no housekeeping job hangs on demand, so no fixture can assert them yet.

### `housekeeping/schedule-survives-restart`

When the server restarts, the server MUST keep each job's `next_run_at` as it was.

**Tests:** waiting on #1444.

### `housekeeping/unfinished-run-cleared`

When the server starts, the server MUST clear `running_since` from every run the previous process left unfinished.

**Tests:** waiting on #1444.

### `housekeeping/runs-concurrent-across-jobs`

While a run of one housekeeping job is in progress, the server MUST run another job when it is due or asked for.

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
