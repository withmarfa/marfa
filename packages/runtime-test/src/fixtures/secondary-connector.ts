/**
 * Secondary-connector fixture for the e2e flow test (T-023).
 *
 * The e2e test composes two connectors in a chain: a primary that runs
 * a webhook handler and "publishes" a reactive item-event, and this
 * secondary connector which subscribes to the item-event and writes a
 * cursor marker proving the chain crossed every seam (control plane →
 * queue → first handler → reactive event → second handler → storage).
 *
 * Living the fixture in a separate file keeps the e2e test readable —
 * the test asserts seam-crossings, not handler internals.
 */
import {
  registerItemEventHandler,
  type ItemEventHandler,
} from "@withmarfa/runtime-sdk";

/** Stable name for the secondary integration. The e2e test installs a
 *  harness with this `integrationName` to pick up its messages off the
 *  shared queue (the consumer's envelope filter — T-009 — is what
 *  routes per-integration). */
export const SECONDARY_INTEGRATION_NAME = "marfa.e2e-secondary";

/** Cursor key the secondary handler writes its marker to. The test
 *  reads it back to confirm the chain ran. */
export const SECONDARY_CURSOR_KEY = "e2e:secondary-marker";

/** Marker shape — captures the seam state the test asserts on. */
export interface SecondaryMarker {
  /** id of the item the reactive event referenced. */
  item_id: string;
  /** Cycle hop_count as observed by the secondary handler. The bridge
   *  increments hop_count on republish (`nextHopMetadata`); a
   *  secondary connector seeing hop_count > 0 proves it received the
   *  event from the chain rather than as the originator. */
  hop_count: number;
  /** Originating connection id from the cycle metadata — proves the
   *  chain provenance threads through. */
  originating_connection_id: string | null;
}

/**
 * Register the secondary integration's item-event handler. Called by the
 * e2e test after switching the harness to the secondary's
 * integrationName so consumeBatch routes the queued event here.
 *
 * The handler is intentionally trivial: write a marker. Real connectors
 * do work; the e2e test cares about seam-crossings, not work.
 */
export function registerSecondaryHandler(): void {
  const handler: ItemEventHandler = async (ctx, message) => {
    const marker: SecondaryMarker = {
      item_id: message.item_id,
      hop_count: message.cycle.hop_count,
      originating_connection_id: message.cycle.originating_connection_id,
    };
    await ctx.cursor.write(SECONDARY_CURSOR_KEY, marker);
    return { ok: true };
  };
  registerItemEventHandler(handler);
}
