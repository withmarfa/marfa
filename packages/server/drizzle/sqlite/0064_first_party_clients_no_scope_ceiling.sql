-- See the Postgres sibling for the full rationale. In short: the first-party
-- browser clients held a frozen copy of the server's scope allowlist, and the
-- plugin's `client.scopes ?? opts.scopes` means a non-null value wins over the
-- live set, so the copy rots silently as the type registry moves.
--
-- Enumerated client ids ONLY — a dynamically-registered client's stored array
-- is its own registered ceiling, not a stale copy of ours, and must not be
-- widened by a migration.
UPDATE auth_oauth_client
SET scopes = NULL
WHERE client_id IN ('marfa-web', 'marfa-tickets');
