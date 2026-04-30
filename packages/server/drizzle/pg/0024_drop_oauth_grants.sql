-- PR 4 of workstream 1: oauth_grants dropped. Grants are now system.connection
-- items (kind: user-app-grant); oauth_codes / oauth_tokens reference items.id
-- via connection_item_id (FK with ON DELETE CASCADE).
--
-- Pre-launch: existing oauth_grants/oauth_codes/oauth_tokens rows are throwaway
-- in dev DBs, so the migration drops + recreates rather than rewriting in place.
-- Per the project rule "legacy data gets replaced, not migrated."

ALTER TABLE "oauth_codes" DROP CONSTRAINT IF EXISTS "oauth_codes_grant_id_oauth_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_tokens" DROP CONSTRAINT IF EXISTS "oauth_tokens_grant_id_oauth_grants_id_fk";
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_codes" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_tokens" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_grants" CASCADE;
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_item_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_type" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"used_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connection_item_id_items_id_fk" FOREIGN KEY ("connection_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_connection_item_id" ON "oauth_tokens" USING btree ("connection_item_id");
--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_token_hash" ON "oauth_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_item_id" text NOT NULL,
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
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_connection_item_id_items_id_fk" FOREIGN KEY ("connection_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
