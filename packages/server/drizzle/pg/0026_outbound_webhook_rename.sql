-- Workstream 2 PR 1: rename outbound webhook tables for symmetry with the
-- inbound webhook subsystem landing in WS2 PR 5. Mechanical rename only —
-- no semantic change, no schema change beyond table and index identifiers.
-- ALTER TABLE RENAME preserves rows; ALTER INDEX RENAME preserves the
-- index (postgres renames automatically when the table renames, but the
-- index name itself still carries the old prefix).

ALTER TABLE webhooks RENAME TO outbound_webhooks;--> statement-breakpoint
ALTER TABLE webhook_deliveries RENAME TO outbound_webhook_deliveries;--> statement-breakpoint
ALTER INDEX idx_webhook_deliveries_webhook_id RENAME TO idx_outbound_webhook_deliveries_webhook_id;--> statement-breakpoint
ALTER INDEX idx_webhook_deliveries_pending RENAME TO idx_outbound_webhook_deliveries_pending;
