-- What a write returned, so a client that lost the response can ask. See
-- pg/0099 for the design notes; SQLite has no RLS, so the role-and-policy
-- half of that note does not apply and access stays application-scoped
-- like every other ops table here.
--
-- The unique index is still the serializer, and COALESCE is still what
-- makes it cover the null-space bucket: SQLite treats NULLs as distinct
-- in a unique index exactly as Postgres does.
CREATE TABLE IF NOT EXISTS "idempotency_records" (
  "id" text PRIMARY KEY NOT NULL,
  "space_id" text,
  "idempotency_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "state" text NOT NULL,
  "response_status" integer,
  "response_content_type" text,
  "response_body" text,
  "created_at" text NOT NULL,
  "completed_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_idempotency_records_key"
  ON "idempotency_records" (COALESCE("space_id", ''), "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_idempotency_records_gc"
  ON "idempotency_records" ("space_id", "created_at");
