-- T-131: @better-auth/oauth-provider plugin tables.
-- Four tables owned by the OAuth Provider plugin: client registrations,
-- consent grants, opaque access tokens, opaque refresh tokens.
-- Naming matches the auth_* convention; the plugin's model→table mapping
-- is wired in `auth/instance.ts` via the `schema` override.
--
-- Cross-table foreign keys on `client_id` (the unique business key, not
-- the PK `id`) are application-enforced — the plugin's own queries
-- maintain integrity. FKs on user_id / session_id reference PKs.
--
-- Token columns store the OUTPUT of `storeTokens.hash` — wired in
-- `auth/instance.ts` to `hashApiKey(token, salt)` so bearer middleware
-- can compute the same value at lookup time.

CREATE TABLE "auth_oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text,
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text,
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text NOT NULL,
	"post_logout_redirect_uris" text,
	"token_endpoint_auth_method" text,
	"grant_types" text,
	"response_types" text,
	"public" boolean,
	"type" text,
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "auth_oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "auth_oauth_client" ADD CONSTRAINT "auth_oauth_client_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_auth_oauth_client_client_id" ON "auth_oauth_client" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_client_user_id" ON "auth_oauth_client" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_client_reference_id" ON "auth_oauth_client" USING btree ("reference_id");
--> statement-breakpoint
CREATE TABLE "auth_oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"auth_time" timestamp,
	"scopes" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_oauth_refresh_token" ADD CONSTRAINT "auth_oauth_refresh_token_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_oauth_refresh_token" ADD CONSTRAINT "auth_oauth_refresh_token_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_refresh_token_token" ON "auth_oauth_refresh_token" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_refresh_token_client_id" ON "auth_oauth_refresh_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_refresh_token_user_id" ON "auth_oauth_refresh_token" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "auth_oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"refresh_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"scopes" text NOT NULL,
	CONSTRAINT "auth_oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_session_id_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_session"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_refresh_id_auth_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."auth_oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_auth_oauth_access_token_token" ON "auth_oauth_access_token" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_access_token_client_id" ON "auth_oauth_access_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_access_token_user_id" ON "auth_oauth_access_token" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "auth_oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"scopes" text NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_consent_user_client" ON "auth_oauth_consent" USING btree ("user_id","client_id");
--> statement-breakpoint
CREATE INDEX "idx_auth_oauth_consent_reference_id" ON "auth_oauth_consent" USING btree ("reference_id");
