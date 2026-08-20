-- Inbound-webhook subscriptions and leased tokens created by a
-- platform (space-less) caller were stamped with the caller's absent
-- space instead of the connection's. A NULL-space row on a space-scoped
-- connection is invisible to every space-fenced lookup: the webhook
-- receipt route never matches the subscription, the owning space cannot
-- list or revoke either row, and the uninstall pipeline's sweeps skip
-- both. The create paths now stamp the connection's space; this brings
-- existing rows in line. Rows whose connection is itself space-less
-- (single-space self-hosts) are untouched.
UPDATE inbound_webhooks
   SET space_id = i.space_id
  FROM items i
 WHERE i.id = inbound_webhooks.connection_id
   AND inbound_webhooks.space_id IS NULL
   AND i.space_id IS NOT NULL;
--> statement-breakpoint
UPDATE connection_leased_tokens
   SET space_id = i.space_id
  FROM items i
 WHERE i.id = connection_leased_tokens.connection_id
   AND connection_leased_tokens.space_id IS NULL
   AND i.space_id IS NOT NULL;
--> statement-breakpoint
-- The OAuth-token rows are the worst of the three: they hold the
-- encrypted upstream access and refresh tokens, their RLS policy's
-- NULL-allowance makes a NULL-space row readable from every space's
-- session, and the uninstall pipeline's space-fenced fetch deletes
-- nothing, so the secrets outlive the connection. The write sites were
-- fixed to stamp the connection's space some time ago; rows from before
-- that fix have never been backfilled until now.
UPDATE connection_oauth_tokens
   SET space_id = i.space_id
  FROM items i
 WHERE i.id = connection_oauth_tokens.connection_id
   AND connection_oauth_tokens.space_id IS NULL
   AND i.space_id IS NOT NULL;
