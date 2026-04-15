-- Drop the legacy `threads` table.
-- The V0 spec treats threads as implicit: a thread is whatever item a bunch of
-- items are connected to by `in-thread` edges. No dedicated table or item
-- type. This migration removes the vestigial first-class storage that
-- predated edges-as-first-class (Wave 2 PR 4).

DROP POLICY IF EXISTS "tenant_isolation_threads" ON "threads";
DROP TABLE IF EXISTS "threads";
