-- T-218: async substrate for POST /items/bulk_action. Each row is a
-- single user-initiated bulk job; the in-process worker picks it up via
-- SELECT ... FOR UPDATE SKIP LOCKED, runs the action in chunks, writes
-- progress, and lands a terminal status with the result envelope.
--
-- `matched_ids` is frozen at create-time so the worker doesn't re-run
-- the filter. `input` carries the original BulkActionInput for replay /
-- audit / debugging.
--
-- Idempotency: optional `Idempotency-Key` header is stored verbatim;
-- partial unique index on (tenant_id, idempotency_key) lets replayed
-- POSTs resolve to the same job row.
--
-- GC: completed / failed / cancelled rows expire after
-- BULK_ACTION_JOB_RETENTION_MS (default 7 days) via a sweep keyed on
-- (status, finished_at).
CREATE TABLE IF NOT EXISTS "bulk_action_jobs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "tenant_id" TEXT,
  "api_key_id" TEXT,
  "status" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "input" TEXT NOT NULL,
  "matched_ids" TEXT NOT NULL,
  "matched_count" INTEGER NOT NULL DEFAULT 0,
  "processed_count" INTEGER NOT NULL DEFAULT 0,
  "succeeded_count" INTEGER NOT NULL DEFAULT 0,
  "errored_count" INTEGER NOT NULL DEFAULT 0,
  "result" TEXT,
  "error" TEXT,
  "worker_id" TEXT,
  "worker_heartbeat_at" TEXT,
  "idempotency_key" TEXT,
  "created_at" TEXT NOT NULL,
  "started_at" TEXT,
  "finished_at" TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bulk_action_jobs_status"
  ON "bulk_action_jobs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bulk_action_jobs_tenant_id"
  ON "bulk_action_jobs" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bulk_action_jobs_gc"
  ON "bulk_action_jobs" ("status", "finished_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_bulk_action_jobs_idempotency"
  ON "bulk_action_jobs" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- T-025 RLS: tenant_isolation policy + myme_app grants. NULL tenant_id
-- is allowed through for platform / bootstrap-admin operations (mirrors
-- audit_log + items conventions).
GRANT SELECT, INSERT, UPDATE, DELETE ON "bulk_action_jobs" TO "myme_app";
--> statement-breakpoint
ALTER TABLE "bulk_action_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "bulk_action_jobs_tenant_isolation" ON "bulk_action_jobs";
--> statement-breakpoint
CREATE POLICY "bulk_action_jobs_tenant_isolation" ON "bulk_action_jobs"
  FOR ALL TO "myme_app"
  USING (tenant_id = current_setting('myme.tenant_id', true)
         OR tenant_id IS NULL);
