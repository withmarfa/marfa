-- T-131: JWT signing keys for the better-auth jwt plugin. See
-- sqlite/0049_auth_jwks.sql for the rationale.

CREATE TABLE "auth_jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp
);
