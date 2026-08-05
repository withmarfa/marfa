-- Item content moves into a native jsonb column, so property filters read
-- structured data in place instead of casting text per row, and expression
-- indexes over properties become possible. The USING cast rewrites every row
-- under an ACCESS EXCLUSIVE lock, which is fine at current data sizes; jsonb
-- normalizes key order and duplicate keys, which matches the object-level
-- equivalence the API already guarantees for property payloads.
ALTER TABLE "items" ALTER COLUMN "properties" TYPE jsonb USING "properties"::jsonb;
