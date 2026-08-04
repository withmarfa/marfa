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
-- Cascades from `items` so a deleted item takes its bookkeeping with it.
-- No index beyond the primary key: the candidate query drives off `items`
-- and reaches this table by `item_id`, which the PK already covers.
CREATE TABLE IF NOT EXISTS "enrichment_state" (
  "item_id" TEXT PRIMARY KEY NOT NULL REFERENCES "items"("id") ON DELETE CASCADE,
  "space_id" TEXT,
  "blob_ref" TEXT NOT NULL,
  "extractor_version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "updated_at" TEXT NOT NULL
);
