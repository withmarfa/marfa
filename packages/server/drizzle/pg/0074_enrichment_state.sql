-- Bookkeeping for deterministic text extraction from file blobs.
--
-- One row per file item the sweeper has looked at. The row is the whole
-- trigger mechanism: the candidate query is an anti-join against this
-- table, so extraction is driven by state rather than by events and the
-- write it performs can never schedule the next sweep.
--
-- `blob_ref` and `extractor_version` are what make re-extraction happen:
-- a replaced blob or a bumped extractor makes the row stale and the item
-- becomes a candidate again. `attempts` caps the retry of a file that
-- cannot be parsed at all.
--
-- Deliberately not granted to `marfa_app` and so deliberately unpoliced:
-- the sweeper is a background job on the owner connection and no request
-- path reads this table. A grant with no policy is the shape that has bitten
-- before, so the table stays off the role entirely rather than gaining both.
--
-- Cascades from `items` so a deleted item takes its bookkeeping with it.
-- No index beyond the primary key: the candidate query drives off `items`
-- and reaches this table by `item_id`, which the PK already covers.
CREATE TABLE IF NOT EXISTS "enrichment_state" (
  "item_id" text PRIMARY KEY NOT NULL REFERENCES "items"("id") ON DELETE CASCADE,
  "space_id" text,
  "blob_ref" text NOT NULL,
  "extractor_version" integer NOT NULL,
  "status" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "error" text,
  "updated_at" text NOT NULL
);
