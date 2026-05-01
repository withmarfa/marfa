-- Workstream 1 close-out: add oauth_device_codes for the Device
-- Authorization Grant flow (RFC 8628). See sibling migration in
-- drizzle/sqlite/0026_oauth_device_codes.sql for the full description.

CREATE TABLE "oauth_device_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "device_code_hash" text NOT NULL,
  "user_code" text NOT NULL,
  "client_id" text NOT NULL,
  "scope" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "connection_item_id" text,
  "expires_at" text NOT NULL,
  "interval_seconds" integer DEFAULT 5 NOT NULL,
  "last_polled_at" text,
  "approved_at" text,
  "created_at" text NOT NULL,
  CONSTRAINT "oauth_device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
  CONSTRAINT "oauth_device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_connection_item_id_items_id_fk" FOREIGN KEY ("connection_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_oauth_device_codes_user_code" ON "oauth_device_codes" USING btree ("user_code");
--> statement-breakpoint
CREATE INDEX "idx_oauth_device_codes_status" ON "oauth_device_codes" USING btree ("status");
