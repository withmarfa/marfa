-- T-015: backfill the materialised search_vector for every existing
-- row. Pre-T-015 deployments have NULL on every items row; without
-- this step those rows would be invisible to search until the next
-- write touched them. The backfill uses the same field set as the
-- write-time indexer (`extractSearchableText` in storage/search-text.ts):
-- the four core fields (title, body, description, name) plus a long
-- tail of any other string-typed property values.
--
-- The migration intentionally does NOT consult per-type
-- `searchable: false` opt-outs — those are TypeScript-side metadata and
-- only respected at write time. A subsequent UPDATE on any opted-out
-- item via the application will rewrite the search_vector with the
-- correct field set; pre-existing rows surface a slightly broader
-- vector than their type metadata implies, but never narrower. Trade-
-- off accepted to keep the backfill SQL-only.

UPDATE items
SET search_vector = to_tsvector(
  'english',
  coalesce(properties::json->>'title', '') || ' ' ||
  coalesce(properties::json->>'body', '') || ' ' ||
  coalesce(properties::json->>'description', '') || ' ' ||
  coalesce(properties::json->>'name', '') || ' ' ||
  coalesce(
    (
      SELECT string_agg(value, ' ')
      FROM json_each_text(properties::json)
      WHERE key NOT IN ('title', 'body', 'description', 'name')
    ),
    ''
  )
)
WHERE search_vector IS NULL;
