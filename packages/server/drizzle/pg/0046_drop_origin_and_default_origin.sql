-- T-110: drop `origin` from items and `default_origin` from api_keys.
--
-- The `Origin` enum (`user | ai | worker | system`) was structurally
-- present but no live consumer filtered on it across any canonical repo.
-- The integration / automation provenance question it tried to answer is
-- already covered by `source` (Spotify-integration items carry
-- `source: withmarfa.spotify`; manually-created items carry whatever the
-- credential's source is). Re-introducing later via a single nullable
-- column is cheap if a real consumer appears.
--
-- Existing column data is discarded (pre-release, no consumer reads it).

ALTER TABLE "items" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "default_origin";
