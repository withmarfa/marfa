-- T-218: async substrate for POST /items/bulk_action. See pg/0060 for
-- design notes. SQLite has no RLS — tenant scoping is enforced in the
-- application layer like every other ops table.
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
