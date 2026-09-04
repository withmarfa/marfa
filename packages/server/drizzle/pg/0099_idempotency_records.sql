-- What a write returned, so a client that lost the response can ask.
--
-- A client retrying after a lost response has no way to find out whether
-- its first attempt landed. Asking the door again does not answer it: a
-- repeated create collides with itself, a repeated update conflicts
-- against its own change, and a repeated delete is not found. All three
-- are correct answers about the second ask and none is an answer about
-- the first. A row here is claimed before the write runs and completed
-- with the status and body that went back, so the repeat is answered
-- from what happened rather than from what would happen now.
--
-- The unique index is the serializer. A claim is an INSERT, so exactly
-- one of two simultaneous arrivals holds the key and the other is told
-- the request is in flight; nothing in the application decides it.
-- COALESCE rather than a plain (space_id, idempotency_key) composite,
-- mirroring idx_items_source_dedup: space_id is nullable and NULL never
-- equals NULL in a unique index, so the plain shape would stop deduping
-- the null-space bucket entirely -- every request on a single-space
-- self-host and every platform-admin request anywhere.
--
-- `response_body` is NULL on a completed row when the response was above
-- the store bound. The repeat still performs no second write and still
-- learns the status; it is only the body it cannot be handed.
--
-- Deliberately not granted to `marfa_app` and so deliberately unpoliced,
-- the same posture as `enrichment_state`: every access is on the owner
-- connection. The middleware runs outside the per-request RLS wrapper by
-- construction -- the claim has to commit whether or not the write's own
-- transaction does -- and the retention sweep is a background job. A
-- grant with no policy is the shape that has bitten before, so the table
-- stays off the role entirely rather than gaining both.
--
-- Rows age out on the event-log retention sweep rather than through a
-- sweeper of their own. That window is also the promise: a repeat is
-- answered for at least as long as an event stays replayable.
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
