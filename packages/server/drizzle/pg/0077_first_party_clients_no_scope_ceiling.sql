-- The first-party browser clients carried a frozen copy of the server's own
-- scope allowlist, written once at seed time and never refreshed. The OAuth
-- plugin resolves its validation set as `client.scopes ?? opts.scopes`, so a
-- non-null column wins outright and the live allowlist is never consulted.
-- Every type added or removed since the row was written therefore drifts it
-- further from what the platform actually advertises.
--
-- NULL restores the intent the seed script always had: these clients may
-- request the whole grammar, and the consent screen is where the user narrows.
--
-- Enumerated client ids ONLY. A broader predicate would sweep the
-- dynamically-registered clients too, and for those the stored array is not a
-- stale copy of ours — it is the ceiling that client registered for, and a
-- security boundary. Handing each of them the full allowlist is the opposite
-- of a fix.
UPDATE auth_oauth_client
SET scopes = NULL
WHERE client_id IN ('marfa-web', 'marfa-tickets');
