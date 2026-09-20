# Housekeeping

The periodic jobs the server runs on itself: the trash purge, version thinning, the event-log and audit cleanups, the sweeps that bound the smaller tables, the unreferenced-blob sweep, the enrichment sweep, the webhook retry poll and the liveness heartbeat. One scheduler runs them all from one table, so what runs, when it is next due and what its last run did are answerable at one door, and any of them can be run on demand.

## The jobs

1. `GET /housekeeping` lists every housekeeping job the instance runs to the operator key, each with its `name`, `interval_ms`, `next_run_at`, `running_since` (set while a run holds it), `last_started_at`, `last_finished_at`, `last_outcome` (`ok` or `error`), `last_error` and `last_result` (whatever the run reported); a working key is refused `403 forbidden`. `compliance/housekeeping.test.ts › lists the jobs to the operator key`, `› refuses the listing to a working key`.
2. The listing names the server's own sweeps: `trash-purge`, `version-thinning`, `event-log-cleanup`, `audit-cleanup`, `rate-limit-cleanup`, `revoked-key-reap` and `webhook-poll` are among them on any instance. A job disabled by configuration is not listed, which is why the enrichment sweep, switched off for a run, is not asserted here. `compliance/housekeeping.test.ts › lists the jobs to the operator key`.
3. `POST /housekeeping/{name}/run` runs the job now, inline, and answers `{name, started_at, finished_at, outcome, result, error}`; the listing then shows that run as the job's last, with `running_since` back to null. `compliance/housekeeping.test.ts › runs a job on demand and the listing records the run`.
4. A name the instance runs no job under answers `404 housekeeping_job_not_found`, and one outside the grammar (lowercase, digits and hyphens) `400 validation_error`; a working key is refused `403 forbidden`. `compliance/housekeeping.test.ts › answers 404 for a job the instance does not run, where a known one runs`, `› refuses a malformed name and a working key`.

A job never overlaps itself: a run started while another holds the job answers `409 housekeeping_job_running`. Every run through the door is inline and the referee cannot hold one open, so the refusal is not a statement here; the server's own suite produces it (`packages/server/src/routes/housekeeping.test.ts`).

## What is not observable over HTTP

The schedule survives a restart, a run left unfinished by a process that died is cleared at the next boot with a log line, and jobs run concurrently across names. None of it is observable against a server the referee booted once, so none is a statement here; the server's own suite proves each (`packages/server/src/housekeeping/scheduler.test.ts`).
