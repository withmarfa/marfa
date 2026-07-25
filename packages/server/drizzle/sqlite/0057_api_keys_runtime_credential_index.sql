-- Index the runtime-credential slice of api_keys.
--
-- The retention reaper filters on `is_runtime_credential` in all three of its
-- passes, and the operator metrics counter does the same on every cache miss.
-- Without an index each of those is a sequential scan over a table that holds
-- a week of dispatch volume. Partial on true: nothing scans this column for
-- human-minted keys, so indexing only the machine slice keeps it small.
CREATE INDEX IF NOT EXISTS `idx_api_keys_runtime_credential`
  ON `api_keys` (`is_runtime_credential`)
  WHERE `is_runtime_credential`;
