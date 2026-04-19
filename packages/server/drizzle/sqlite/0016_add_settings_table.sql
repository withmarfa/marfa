-- Generic single-row-per-key settings table for workspace-wide flags.
-- First use: persistent `bootstrapped` sentinel so bootstrap mode does
-- not re-open when all API keys are revoked.
--
-- Backfill: if any non-revoked API key already exists at migration
-- time, mark the workspace bootstrapped so existing installs don't
-- silently relock into a state the operator can't exit.

CREATE TABLE `settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`)
SELECT 'bootstrapped', 'true'
WHERE EXISTS (SELECT 1 FROM `api_keys` WHERE `revoked_at` IS NULL);
