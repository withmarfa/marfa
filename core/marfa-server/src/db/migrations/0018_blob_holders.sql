-- Finds the items of the types a caller may list that hold a hash, never walking the others.
CREATE INDEX IF NOT EXISTS blob_references_holders ON blob_references (hash, kind, item_type);
