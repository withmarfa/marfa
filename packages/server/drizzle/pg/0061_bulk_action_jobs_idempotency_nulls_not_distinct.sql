-- T-218 follow-up: rebuild the bulk_action_jobs idempotency index with
-- NULLS NOT DISTINCT (PG 15+). Original migration 0060 declared the
-- partial unique index on (tenant_id, idempotency_key) without this
-- flag, so two replays from a tenant-less admin credential
-- (tenant_id IS NULL) didn't conflict on the (NULL, key) pair and the
-- ON CONFLICT clause in BulkActionJobStore.create silently fell
-- through, double-firing the job.
--
-- Surfaced by the T-218 conformance test
-- "Idempotency-Key returns the same job id on replay" running against
-- the admin key on :8601.
--
-- Drizzle 0.45.2's `uniqueIndex().where()` builder doesn't expose
-- .nullsNotDistinct(), so this stays as a hand-written migration and
-- the schema.ts declaration carries a comment pointing here.

DROP INDEX IF EXISTS "idx_bulk_action_jobs_idempotency";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bulk_action_jobs_idempotency"
  ON "bulk_action_jobs" ("tenant_id", "idempotency_key") NULLS NOT DISTINCT
  WHERE "idempotency_key" IS NOT NULL;
