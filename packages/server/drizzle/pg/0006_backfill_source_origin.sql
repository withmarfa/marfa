-- Backfill source and origin on existing items.
-- V0 spec declares both as system fields stamped on every item; PR 1
-- (Wave 2) tightened the runtime to always stamp source from the
-- credential and origin from the credential default. Wave-1-era rows
-- and any anomalies are normalised here so the tightened wire format
-- is honest about every row.
--
-- Sentinels: source = '<unknown>' (provenance unknowable post-hoc;
-- the angle brackets distinguish the sentinel from any real
-- credential display name). origin = 'user' (the conservative default
-- matching the credential-default convention).
UPDATE items SET source = '<unknown>' WHERE source IS NULL;
UPDATE items SET origin = 'user' WHERE origin IS NULL OR origin NOT IN ('user', 'ai', 'worker');
