-- Passkey credentials (one per registered authenticator).
-- Required by the @better-auth/passkey plugin (PR 2 of workstream 1).

CREATE TABLE "auth_passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
ALTER TABLE "auth_passkey" ADD CONSTRAINT "auth_passkey_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_auth_passkey_user_id" ON "auth_passkey" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_auth_passkey_credential_id" ON "auth_passkey" USING btree ("credential_id");
