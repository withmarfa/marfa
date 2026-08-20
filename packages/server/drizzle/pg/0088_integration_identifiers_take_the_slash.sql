-- Integration identifiers move from the dot form to `<handle>/<name>`, and
-- three stored places carry the old spelling. All three move together or the
-- rename half-lands in a way nothing reports.
--
--   1. `system.integration.properties.manifest_name` — the catalog's own key.
--   2. `properties.manifest.name` inside the frozen manifest on the same row,
--      which is what a connection actually resolves and what dispatch routes
--      by. Rewriting only the first would leave dispatch on the old name.
--   3. `items.source` (`integration:<name>`) on every row an integration owns.
--      This is half the `(source, source_id)` upsert natural key AND what the
--      mirror write-door compares a runtime credential's `item_source`
--      against, so a row left behind is both re-created as a duplicate on the
--      next sync and locked against its own owner.
--
-- Safe to run because the tolerant build shipped first: dispatch resolves an
-- integration by either spelling, so the window between this migration and the
-- roll that follows it dispatches normally rather than silently stopping.
--
-- Exact-match replacement per name, never a pattern. `withmarfa.podcasts` and
-- `withmarfa.podcast.show` share a prefix, one is an integration and the other
-- a type, and a `LIKE 'withmarfa.%'` sweep would take both.
--
-- Idempotent: a second run matches nothing.
UPDATE "items"
SET "properties" = jsonb_set(
      jsonb_set(
        "properties",
        '{manifest_name}',
        to_jsonb(m.new_name)
      ),
      '{manifest,name}',
      to_jsonb(m.new_name)
    )
FROM (VALUES
  ('withmarfa.podcasts',          'marfa/podcasts'),
  ('withmarfa.rss-watcher',       'marfa/rss-watcher'),
  ('withmarfa.github-webhooks',   'marfa/github-webhooks'),
  ('withmarfa.task-auto-archive', 'marfa/task-auto-archive'),
  ('withmarfa.inbox',             'marfa/inbox'),
  ('withmarfa.sync',              'marfa/sync'),
  ('google.calendar',             'google/calendar'),
  ('google.tasks',                'google/tasks'),
  ('google.drive',                'google/drive'),
  ('google.contacts',             'google/contacts'),
  ('google.youtube',              'google/youtube'),
  ('todoist.tasks',               'todoist/tasks'),
  ('readwise.highlights',         'readwise/highlights'),
  ('readwise.reader',             'readwise/reader'),
  ('raindrop.bookmarks',          'raindrop/bookmarks')
) AS m(old_name, new_name)
WHERE "items"."type" = 'system.integration'
  AND "items"."properties" ->> 'manifest_name' = m.old_name;
--> statement-breakpoint
-- Provenance on every owned row. `api_keys.item_source` is deliberately NOT
-- rewritten: runtime credentials are short-lived and the next mint derives the
-- value from the resolved manifest, which this migration has just moved.
UPDATE "items"
SET "source" = 'integration:' || m.new_name
FROM (VALUES
  ('withmarfa.podcasts',          'marfa/podcasts'),
  ('withmarfa.rss-watcher',       'marfa/rss-watcher'),
  ('withmarfa.github-webhooks',   'marfa/github-webhooks'),
  ('withmarfa.task-auto-archive', 'marfa/task-auto-archive'),
  ('withmarfa.inbox',             'marfa/inbox'),
  ('withmarfa.sync',              'marfa/sync'),
  ('google.calendar',             'google/calendar'),
  ('google.tasks',                'google/tasks'),
  ('google.drive',                'google/drive'),
  ('google.contacts',             'google/contacts'),
  ('google.youtube',              'google/youtube'),
  ('todoist.tasks',               'todoist/tasks'),
  ('readwise.highlights',         'readwise/highlights'),
  ('readwise.reader',             'readwise/reader'),
  ('raindrop.bookmarks',          'raindrop/bookmarks')
) AS m(old_name, new_name)
WHERE "items"."source" = 'integration:' || m.old_name;
