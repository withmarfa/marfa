CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"key_hash" text NOT NULL,
	"label" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"type_permissions" text DEFAULT '{"*":"write"}' NOT NULL,
	"extension_permissions" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text,
	"last_used_at" text,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" text NOT NULL,
	"key_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"details" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_types" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"schema" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"item_id" text NOT NULL,
	"tenant_id" text,
	"payload" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"type" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"properties" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"timestamp" text NOT NULL,
	"source" text,
	"source_id" text,
	"origin" text,
	"version" integer DEFAULT 1 NOT NULL,
	"schema_version" integer,
	"device_id" text,
	"parent_id" text,
	"thread_id" text,
	"capture_latitude" double precision,
	"capture_longitude" double precision
);
--> statement-breakpoint
CREATE TABLE "metadata" (
	"item_id" text PRIMARY KEY NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"about" text DEFAULT '[]' NOT NULL,
	"extensions" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_type" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"used_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version" integer NOT NULL,
	"properties" text NOT NULL,
	"created_at" text NOT NULL,
	"device_id" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"status_code" integer,
	"attempt" integer NOT NULL,
	"success" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	"next_attempt_at" text,
	"payload" text,
	"webhook_url" text,
	"webhook_secret" text,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text DEFAULT '[]' NOT NULL,
	"type_filter" text,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata" ADD CONSTRAINT "metadata_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_timestamp" ON "audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_audit_log_action" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_log_resource_type" ON "audit_log" USING btree ("resource_type");--> statement-breakpoint
CREATE INDEX "idx_event_log_created_at" ON "event_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_items_type" ON "items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_items_state" ON "items" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_items_thread_id" ON "items" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_items_parent_id" ON "items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_items_created_at" ON "items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_items_timestamp" ON "items" USING btree ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_items_source_dedup" ON "items" USING btree ("source","source_id") WHERE source IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_oauth_grants_client_id" ON "oauth_grants" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_grant_id" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_token_hash" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_provider" ON "users" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE INDEX "idx_versions_item_id" ON "versions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries" USING btree ("webhook_id");