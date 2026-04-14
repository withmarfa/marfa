CREATE TABLE IF NOT EXISTS "edges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"edge_type" text NOT NULL,
	"properties" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_edges_source" ON "edges" ("tenant_id","source_id","edge_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_edges_target" ON "edges" ("tenant_id","target_id","edge_type");
