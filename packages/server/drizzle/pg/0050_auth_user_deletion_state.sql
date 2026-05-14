-- T-116: account-lifecycle state on auth_user. `deletion_state = 'active'`
-- (default) is the normal state; `'pending_deletion'` is set on confirm of
-- a delete-account request and triggers the `PendingDeletePurger` sweep
-- after the grace window elapses. `pending_deletion_at` is the ISO
-- timestamp stamped on confirm (NULL while active). Existing rows default
-- to `'active'` — no data revision needed.
ALTER TABLE "auth_user" ADD COLUMN "deletion_state" text NOT NULL DEFAULT 'active';
ALTER TABLE "auth_user" ADD COLUMN "pending_deletion_at" text;
