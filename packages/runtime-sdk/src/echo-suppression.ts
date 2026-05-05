/**
 * Echo-suppression and lag-window helpers — implements the bidi
 * positions declared in the Integration manifest's
 * `bidirectional_handling` block.
 *
 * Echo TTL: when the connector writes to an external service, the
 * service's webhook fires for the same change shortly after. Without
 * dedup, the inbound side re-ingests Myme's own write. Mechanism:
 * a short-lived `pending_writes` set keyed by
 * `(external_id, content_hash)` with a per-Integration TTL.
 *
 * Lag window: same `pending_writes` window blocks reactive reads of
 * items recently written by the same Connection — some external
 * services return 200 on a write before the change is visible to
 * other readers, so reactive code that fires immediately can read
 * stale state.
 */
import type { CursorStorageAdapter } from "./cursor-store.js";

const PENDING_PREFIX = "pending_write:";

interface PendingWriteRecord {
  content_hash: string;
  expires_at_ms: number;
}

export interface EchoSuppressionConfig {
  /** Manifest-declared `bidirectional_handling.echo_ttl_seconds`.
   *  Default per design doc is 60 seconds. */
  echo_ttl_seconds: number;
  /** Manifest-declared `bidirectional_handling.lag_window_seconds`.
   *  Defaults to echo_ttl_seconds when not declared. */
  lag_window_seconds?: number;
}

export interface EchoSuppression {
  /** Mark a write to an external system. The next inbound webhook
   *  carrying the same `(external_id, content_hash)` within the TTL
   *  is suppressed via `shouldSkipReactive`. */
  trackOutboundWrite(externalId: string, contentHash: string): Promise<void>;

  /** Returns true if this incoming change matches a recent outbound
   *  write — caller should skip it. Deletes the underlying record on
   *  expiry so the storage partition stays bounded (T-016). */
  shouldSkipReactive(externalId: string, contentHash: string): Promise<boolean>;

  /** Returns true if there's an outstanding outbound write for the
   *  given external_id whose lag window hasn't elapsed. Caller should
   *  defer reactive reads of the corresponding Myme item. Deletes the
   *  underlying record on expiry so cleanup happens on every access
   *  path, not just `shouldSkipReactive` (T-016). */
  inLagWindow(externalId: string): Promise<boolean>;
}

export function createEchoSuppression(
  storage: CursorStorageAdapter,
  config: EchoSuppressionConfig,
  now_ms: () => number = Date.now,
): EchoSuppression {
  const lagMs = (config.lag_window_seconds ?? config.echo_ttl_seconds) * 1000;
  const echoMs = config.echo_ttl_seconds * 1000;

  const key = (externalId: string): string => `${PENDING_PREFIX}${externalId}`;

  return {
    async trackOutboundWrite(
      externalId: string,
      contentHash: string,
    ): Promise<void> {
      const record: PendingWriteRecord = {
        content_hash: contentHash,
        expires_at_ms: now_ms() + echoMs,
      };
      await storage.put(key(externalId), record);
    },

    async shouldSkipReactive(
      externalId: string,
      contentHash: string,
    ): Promise<boolean> {
      const raw = await storage.get(key(externalId));
      if (!raw) return false;
      const record = raw as PendingWriteRecord;
      if (record.expires_at_ms < now_ms()) {
        await storage.delete(key(externalId));
        return false;
      }
      return record.content_hash === contentHash;
    },

    async inLagWindow(externalId: string): Promise<boolean> {
      const raw = await storage.get(key(externalId));
      if (!raw) return false;
      const record = raw as PendingWriteRecord;
      // Lag window may exceed echo window; both check against the
      // same record but the lag check uses a distinct deadline.
      const lagDeadline = record.expires_at_ms - echoMs + lagMs;
      const now = now_ms();
      if (lagDeadline <= now) {
        // T-016: delete on expiry so a connector that writes to
        // `external_id` and never reads it back doesn't leak DO
        // storage. `shouldSkipReactive` already does this on its own
        // path; mirroring it here closes the second access path
        // without introducing a periodic prune.
        await storage.delete(key(externalId));
        return false;
      }
      return true;
    },
  };
}
