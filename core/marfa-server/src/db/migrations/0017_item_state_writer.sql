-- The sign-in whose request made the item's last state move. No value for an item that has never
-- moved, one a server job moved, or one that moved before this column.
ALTER TABLE items ADD COLUMN state_writer_kind TEXT;
ALTER TABLE items ADD COLUMN state_writer_id TEXT;
ALTER TABLE items ADD COLUMN state_writer_name TEXT;
