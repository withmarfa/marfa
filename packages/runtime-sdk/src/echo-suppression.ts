/**
 * Echo-suppression and lag-window helpers — implements the bidi
 * positions declared in the Integration manifest's
 * `bidirectional_handling` block.
 *
 * Echo TTL: when the integration writes to an external service, the
 * service's webhook fires for the same change shortly after. Without
 * dedup, the inbound side re-ingests Marfa's own write. Mechanism:
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

/**
 * Key prefix for echo markers inside the per-Connection state map.
 *
 * Exported because the substrate has to recognise a marker at commit time
 * — see `settleEchoMarkers` below — and a prefix duplicated at the other
 * end of that seam is one that drifts.
 */
export const ECHO_MARKER_PREFIX = "pending_write:";

interface PendingWriteRecord {
  content_hash: string;
  /**
   * When this marker stops suppressing, epoch ms.
   *
   * **Provisional until the dispatch commits.** A handler runs in a worker
   * thread whose writes are journalled and applied by the substrate when
   * the dispatch returns, so a marker written at minute one of a
   * ten-minute run is not visible to anything until minute ten. Stamped
   * from the write clock it would arrive already expired, and the very
   * first inbound webhook — the echo it exists to suppress — would be let
   * through, having deleted the record on its way past.
   *
   * The substrate rebases this to the commit clock, which is the moment
   * the marker actually starts being readable.
   */
  expires_at_ms: number;
  /** How long the marker should live once visible. Kept so the rebase has
   *  something to add to the commit time. */
  ttl_ms: number;
}

/**
 * A marker as read back from storage.
 *
 * `ttl_ms` is optional here and required on write, because a record
 * written by an older build does not carry it. The read paths have to
 * cope with that; the write path must not produce it.
 */
type StoredWriteRecord = Omit<PendingWriteRecord, "ttl_ms"> &
  Partial<Pick<PendingWriteRecord, "ttl_ms">>;

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
   *  expiry so the storage partition stays bounded. */
  shouldSkipReactive(externalId: string, contentHash: string): Promise<boolean>;

  /** Returns true if there's an outstanding outbound write for the
   *  given external_id whose lag window hasn't elapsed. Caller should
   *  defer reactive reads of the corresponding Marfa item. Deletes the
   *  underlying record on expiry so cleanup happens on every access
   *  path, not just `shouldSkipReactive`. */
  inLagWindow(externalId: string): Promise<boolean>;
}

export function createEchoSuppression(
  storage: CursorStorageAdapter,
  config: EchoSuppressionConfig,
  now_ms: () => number = Date.now,
): EchoSuppression {
  const lagMs = (config.lag_window_seconds ?? config.echo_ttl_seconds) * 1000;
  const echoMs = config.echo_ttl_seconds * 1000;

  const key = (externalId: string): string =>
    `${ECHO_MARKER_PREFIX}${externalId}`;

  return {
    async trackOutboundWrite(
      externalId: string,
      contentHash: string,
    ): Promise<void> {
      const record: PendingWriteRecord = {
        content_hash: contentHash,
        // Provisional. `settleEchoMarkers` moves it to the commit clock;
        // this value only matters for a substrate that commits writes
        // immediately, where the two are the same instant.
        expires_at_ms: now_ms() + echoMs,
        ttl_ms: echoMs,
      };
      await storage.put(key(externalId), record);
    },

    async shouldSkipReactive(
      externalId: string,
      contentHash: string,
    ): Promise<boolean> {
      const raw = await storage.get(key(externalId));
      if (!raw) return false;
      const record = raw as StoredWriteRecord;
      if (record.expires_at_ms < now_ms()) {
        await storage.delete(key(externalId));
        return false;
      }
      return record.content_hash === contentHash;
    },

    async inLagWindow(externalId: string): Promise<boolean> {
      const raw = await storage.get(key(externalId));
      if (!raw) return false;
      const record = raw as StoredWriteRecord;
      // The lag window may be longer than the echo window, so the
      // deadline is reconstructed from when the marker became visible.
      // That origin is `expires_at_ms - ttl_ms`, and it has to come from
      // the record rather than from the live config: change a manifest's
      // `echo_ttl_seconds` and every marker already in flight would have
      // its origin recomputed against the new number, moving a window
      // that was set under the old one. `ttl_ms` is stored precisely so
      // this arithmetic has something stable to stand on.
      const originMs = record.expires_at_ms - (record.ttl_ms ?? echoMs);
      const lagDeadline = originMs + lagMs;
      const now = now_ms();
      if (lagDeadline <= now) {
        // Delete on expiry to close the second access path without a prune loop;
        // an integration that never calls shouldSkipReactive would otherwise leak.
        await storage.delete(key(externalId));
        return false;
      }
      return true;
    },
  };
}

/**
 * Move a dispatch's echo markers onto the commit clock.
 *
 * Called by the substrate with the journalled writes and the instant they
 * are becoming durable, immediately before they are applied. Mutates the
 * map in place, because it is the substrate's own scratch object and
 * copying it would only invite one half being applied.
 *
 * **Why this exists at all.** Markers are written through the same
 * non-credentialed, journal-and-commit path as cursors, and that is the
 * right place for them: a marker is only ever written *after* its
 * outbound call has already succeeded, so a marker that could fail
 * independently would mean a real write with nothing recording it, and
 * the next sweep re-ingesting the integration's own change as though it
 * were the user's. Putting markers on the credentialed path would buy
 * nothing and add exactly that failure, on the hot path, against a
 * credential with an expiry.
 *
 * What the deferred path does cost is visibility, and that is what this
 * repairs. Nothing else touches a Connection between a dispatch's first
 * write and its commit — the per-Connection advisory lock sees to that —
 * so a marker is unreadable for the length of the run and then, stamped
 * from the write clock, arrives expired. Rebasing here makes the TTL mean
 * "this long after anyone could see it", which is what it was always
 * supposed to mean.
 */
export function settleEchoMarkers(
  updates: Record<string, unknown>,
  commitAtMs: number,
): void {
  for (const [key, value] of Object.entries(updates)) {
    if (!key.startsWith(ECHO_MARKER_PREFIX)) continue;
    const record = value as Partial<PendingWriteRecord> | null;
    // A marker written by an older build carries no `ttl_ms`. Leaving its
    // provisional stamp alone is the conservative reading: it expires
    // early rather than never, so the failure is a missed suppression
    // rather than an item silently skipped forever.
    if (
      record == null ||
      typeof record.ttl_ms !== "number" ||
      typeof record.content_hash !== "string"
    ) {
      continue;
    }
    updates[key] = {
      content_hash: record.content_hash,
      ttl_ms: record.ttl_ms,
      expires_at_ms: commitAtMs + record.ttl_ms,
    } satisfies PendingWriteRecord;
  }
}

/**
 * Markers in the committed state that have expired and can be dropped.
 *
 * Both read paths already delete a marker they find expired, which bounds
 * anything an integration keeps asking about. It does not bound what it
 * stops asking about: an external id written once and never seen again
 * leaves a record nothing will ever read, and therefore nothing will ever
 * delete. Sweeping at commit is what keeps a long-lived Connection's
 * state from growing by one key per outbound write, forever.
 */
export function expiredEchoMarkerKeys(
  cursors: Record<string, unknown>,
  nowMs: number,
): string[] {
  const expired: string[] = [];
  for (const [key, value] of Object.entries(cursors)) {
    if (!key.startsWith(ECHO_MARKER_PREFIX)) continue;
    const record = value as Partial<PendingWriteRecord> | null;
    if (record == null || typeof record.expires_at_ms !== "number") continue;
    if (record.expires_at_ms < nowMs) expired.push(key);
  }
  return expired;
}
