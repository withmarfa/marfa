-- Workstream 1 close-out: add oauth_device_codes for the Device
-- Authorization Grant flow (RFC 8628). The CLI / Swift SDK device-flow
-- consumers post a JSON request to /auth/device, get back a user_code
-- + device_code, prompt the user to visit a verification URL, and poll
-- /auth/device/token until the user signs in and approves on the server.

CREATE TABLE `oauth_device_codes` (
  `id` text PRIMARY KEY NOT NULL,
  `device_code_hash` text NOT NULL,
  `user_code` text NOT NULL,
  `client_id` text NOT NULL,
  `scope` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `connection_item_id` text,
  `expires_at` text NOT NULL,
  `interval_seconds` integer DEFAULT 5 NOT NULL,
  `last_polled_at` text,
  `approved_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_device_codes_device_code_hash_unique` ON `oauth_device_codes` (`device_code_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_device_codes_user_code_unique` ON `oauth_device_codes` (`user_code`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_device_codes_user_code` ON `oauth_device_codes` (`user_code`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_device_codes_status` ON `oauth_device_codes` (`status`);
