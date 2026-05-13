-- T-117: operator-controlled tenant status. `'active'` (default) allows
-- writes; `'suspended'` blocks them at the auth middleware. Reads pass
-- through regardless. Existing rows default to `'active'` — no data
-- revision needed.
ALTER TABLE "tenants" ADD COLUMN "status" text NOT NULL DEFAULT 'active';
