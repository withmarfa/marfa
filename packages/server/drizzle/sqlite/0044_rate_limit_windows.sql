-- T-026: cluster-shared rate-limit + per-email throttle counters. See pg/0051.
CREATE TABLE IF NOT EXISTS `rate_limit_windows` (
  `family` text NOT NULL,
  `window_key` text NOT NULL,
  `count` integer NOT NULL,
  `expires_at` text NOT NULL,
  PRIMARY KEY(`family`, `window_key`)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rate_limit_windows_expires_at`
  ON `rate_limit_windows` (`expires_at`);
