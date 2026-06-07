-- Enforce one OAuth consent row per (client_id, user_id) pair.
--
-- The OAuth Provider plugin's consent endpoint resolves a prior grant
-- before writing, but it keys that lookup on (client_id, user_id,
-- reference_id). A re-consent that resolves a different reference_id
-- slips past the dedup and inserts a second row, leaving duplicate
-- consent records for one user-client relationship. The application
-- layer now upserts on (client_id, user_id); this unique index is the
-- backstop.
--
-- Dedup MUST run before the unique index is created, or the index
-- creation fails on the existing duplicates. The DELETE is scoped
-- strictly to auth_oauth_consent and removes only duplicate rows,
-- keeping the freshest per pair (newest updated_at, then created_at,
-- then ctid). No other table or row is touched.
DELETE FROM "auth_oauth_consent"
WHERE "ctid" IN (
  SELECT "ctid" FROM (
    SELECT
      "ctid",
      ROW_NUMBER() OVER (
        PARTITION BY "client_id", "user_id"
        ORDER BY "updated_at" DESC NULLS LAST,
                 "created_at" DESC NULLS LAST,
                 "id" DESC
      ) AS rn
    FROM "auth_oauth_consent"
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_auth_oauth_consent_user_client";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_auth_oauth_consent_client_user"
  ON "auth_oauth_consent" ("client_id", "user_id");
