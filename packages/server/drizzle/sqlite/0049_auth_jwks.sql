-- T-131: JWT signing keys for the better-auth jwt plugin. The
-- oauth-provider plugin needs id_token signing capability; HS256-with-
-- client-secret is the alternative but breaks PKCE public clients
-- (which have no secret). The jwt plugin auto-rotates by inserting new
-- rows; expired rows linger until cleanup.

CREATE TABLE `auth_jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
