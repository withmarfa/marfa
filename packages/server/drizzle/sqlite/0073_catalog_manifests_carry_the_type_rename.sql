-- The type rename reached stored items, permission maps and OAuth scopes,
-- but not the catalog. A `system.integration` row freezes the manifest it
-- was registered with, and nothing updates it: `integration_ref` is set at
-- install and never moved, and registering a newer version creates a
-- sibling row rather than editing the existing one. So a rename that ships
-- in code leaves every installed connection resolving a manifest that still
-- declares the old target types.
--
-- That is not cosmetic. A runtime credential's `type_permissions` is
-- projected from the RESOLVED manifest's `target_types`, and the reserved-
-- root gate admits a `marfa.*` write only when the map carries that exact
-- literal. Left alone, the inbox integration is refused when it writes its
-- own type, and podcasts would be too on its next tick.
--
-- Rewriting the frozen blob is the repair that keeps `integration_ref`
-- valid. The identifiers need no JSON escaping, so a whole-document
-- replacement is exact, and it deliberately reaches the prose in `summary`
-- and `description` as well as the `target_types` members — a catalog entry
-- describing a type that no longer exists is wrong in the surface a person
-- reads, not only in the array the runtime reads.
--
-- `properties` holds SQLite's binary JSONB, so the replacement is done on
-- the rendered text (`json(...)`) and converted back (`jsonb(...)`). A
-- plain text replacement over the stored bytes would corrupt the document.
--
-- `manifest_name` is untouched here: the integration's own identifier moves
-- separately, under its own change. `withmarfa.podcast.show` and
-- `.episode` are matched with their suffixes so the integration named
-- `withmarfa.podcasts` is never caught by the podcast type replacement.
--
-- Idempotent: a second run matches nothing.
UPDATE items
SET properties = jsonb(
  replace(
    replace(
      replace(json(properties), 'withmarfa.captured_email', 'marfa.captured_email'),
      'withmarfa.podcast.show', 'marfa.podcast.show'
    ),
    'withmarfa.podcast.episode', 'marfa.podcast.episode'
  )
)
WHERE type = 'system.integration'
  AND (
    json(properties) LIKE '%withmarfa.captured_email%'
    OR json(properties) LIKE '%withmarfa.podcast.show%'
    OR json(properties) LIKE '%withmarfa.podcast.episode%'
  );
