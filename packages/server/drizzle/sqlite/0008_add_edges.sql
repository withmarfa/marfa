CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_edges_source` ON `edges` (`tenant_id`,`source_id`,`edge_type`);--> statement-breakpoint
CREATE INDEX `idx_edges_target` ON `edges` (`tenant_id`,`target_id`,`edge_type`);
