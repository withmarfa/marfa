-- T-107: drop the email_suppressions table. The prior backend
-- mirrored hard bounces + complaints from inbound webhooks into
-- this table for the pre-send check. Cloudflare Email Service
-- maintains its own internal suppression list across the account,
-- so the parallel server-side surface is removed.
--
-- Idempotent: IF EXISTS guards re-runs and the fresh-DB bootstrap
-- path (which no longer creates the table).
DROP INDEX IF EXISTS idx_email_suppressions_email;--> statement-breakpoint
DROP TABLE IF EXISTS email_suppressions;
