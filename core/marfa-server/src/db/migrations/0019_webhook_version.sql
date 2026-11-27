-- Counts the changes to what an owner configures, so two writers can tell one changed it first.
ALTER TABLE webhooks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
