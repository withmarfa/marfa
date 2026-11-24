-- What a subscription holds pending, kept by the triggers below so that no pass counts its rows,
-- and when every attempt since the last success began to fail.
ALTER TABLE webhooks ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhooks ADD COLUMN pending_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhooks ADD COLUMN failing_since TEXT;

UPDATE webhooks SET
    pending = (SELECT COUNT(*) FROM webhook_deliveries d
               WHERE d.webhook_id = webhooks.id AND d.status = 'pending'),
    pending_bytes = (SELECT COALESCE(SUM(octet_length(d.payload)), 0) FROM webhook_deliveries d
                     WHERE d.webhook_id = webhooks.id AND d.status = 'pending');

CREATE TRIGGER IF NOT EXISTS webhook_pending_added AFTER INSERT ON webhook_deliveries
WHEN new.status = 'pending' BEGIN
    UPDATE webhooks SET pending = pending + 1,
        pending_bytes = pending_bytes + COALESCE(octet_length(new.payload), 0)
    WHERE id = new.webhook_id;
END;

CREATE TRIGGER IF NOT EXISTS webhook_pending_changed AFTER UPDATE OF status, payload
ON webhook_deliveries WHEN old.status = 'pending' OR new.status = 'pending' BEGIN
    UPDATE webhooks SET
        pending = pending - (old.status = 'pending') + (new.status = 'pending'),
        pending_bytes = pending_bytes
            - CASE WHEN old.status = 'pending' THEN COALESCE(octet_length(old.payload), 0) ELSE 0 END
            + CASE WHEN new.status = 'pending' THEN COALESCE(octet_length(new.payload), 0) ELSE 0 END
    WHERE id = new.webhook_id;
END;

CREATE TRIGGER IF NOT EXISTS webhook_pending_removed AFTER DELETE ON webhook_deliveries
WHEN old.status = 'pending' BEGIN
    UPDATE webhooks SET pending = pending - 1,
        pending_bytes = pending_bytes - COALESCE(octet_length(old.payload), 0)
    WHERE id = old.webhook_id;
END;
