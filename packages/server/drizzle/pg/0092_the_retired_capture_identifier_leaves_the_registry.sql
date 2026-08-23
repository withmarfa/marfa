-- `withmarfa.captured_email` was superseded by `marfa.captured_email` in the
-- type rename and deliberately left registered so rows and grants written
-- before the rename kept resolving. That reason has expired: both deployments
-- hold zero items of the identifier, and every migrated row is the new one.
--
-- What changed underneath the decision is the part that makes this a
-- migration rather than a file deletion. The platform vocabulary used to be a
-- compiled array, so removing the JSON removed the type. It is now seeded
-- into `custom_types` at boot and the in-memory registry is filled from those
-- rows, and the seed is an upsert with no prune. So deleting the JSON alone
-- leaves the row on every existing instance, re-read at every start, with the
-- immutability gate refusing to delete it because it is marked `platform`.
-- The identifier would outlive the code that shipped it, permanently.
--
-- Guarded on the item count rather than run unconditionally. An instance that
-- does hold rows of this type SHOULD keep it registered: the row is what
-- makes those items resolve and stay readable, and orphaning somebody's data
-- to tidy a registry is the wrong trade. Such an instance keeps a type the
-- build no longer ships, which is the correct outcome until its rows move.
--
-- Scoped to `origin = 'platform'` so nothing else that ever carried the id is
-- caught. Idempotent: a second run matches nothing.
DELETE FROM "custom_types"
WHERE "id" = 'withmarfa.captured_email'
  AND "origin" = 'platform'
  AND NOT EXISTS (
    SELECT 1 FROM "items" WHERE "type" = 'withmarfa.captured_email'
  );
