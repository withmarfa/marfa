/**
 * End-to-end Connections runtime flow (T-023).
 *
 * Composes the runtime-test harness with the runtime-sdk consumer to
 * exercise a chain of two connectors crossing every seam from the queue
 * inwards:
 *
 *   1. A webhook envelope arrives on the queue (mirroring what the
 *      runtime-control plane stamps in production after verifying an
 *      inbound delivery — see runtime-control/src/webhook-flow.test.ts
 *      for the verify+enqueue side, including the T-009 integration_name
 *      and base64 envelope assertions). The envelope is constructed
 *      here with `integration_name` populated to the **primary**
 *      integration's name.
 *   2. consumeBatch picks the message up, invokes the primary's
 *      registered webhook handler, decoding `body_base64` to ArrayBuffer
 *      at the seam (T-009). The handler "publishes a reactive event"
 *      — in production this would post into Myme via the runtime
 *      credential, the server's reactive-run bridge would fan out to
 *      subscribers, and a downstream item-event message would land on
 *      the queue. The e2e test simulates that bridge by enqueuing an
 *      item-event message with `cycle.hop_count` incremented and the
 *      `originating_connection_id` set to the primary's connection.
 *   3. The harness is switched to the secondary integration's
 *      `integrationName`. The handler registry is reset and the
 *      secondary's item-event handler registered (one handler per kind
 *      per integration — see runtime-sdk/handlers.ts). consumeBatch
 *      runs against the secondary harness; the queue's envelope filter
 *      (T-009) routes the item-event through the secondary's handler.
 *   4. The secondary handler writes a marker to its per-Connection
 *      cursor storage capturing the cycle metadata it received. The
 *      test reads the marker back and asserts every field threaded
 *      correctly: item_id matches, hop_count matches what the bridge
 *      simulation set, originating_connection_id matches the primary.
 *
 * What this catches if reverted:
 *   - **T-009 integration_name regression** — if the integration_name
 *     on the primary's webhook envelope is empty, the consumer's
 *     envelope filter (queue-consumer.ts:190) acks-and-skips the
 *     message and the primary's handler never runs; `primaryRan`
 *     stays false. Reverting the integration_name stamp on the
 *     bridge or control plane is the same shape of regression.
 *   - **T-009 base64 decoding regression** — if the dispatcher stops
 *     decoding `body_base64` to ArrayBuffer at the seam, the primary
 *     handler's body assertion fails or throws. The handler's `body`
 *     would be `undefined` or the wrong type.
 *   - **Cycle metadata threading regression** — if the bridge stops
 *     stamping `originating_connection_id` or stops incrementing
 *     `hop_count`, the secondary marker reads `null` / `0` instead of
 *     the expected provenance.
 *
 * To prove these manually: revert the matching production fix on a
 * scratch branch, run `pnpm test packages/runtime-test/src/e2e-flow.test.ts`,
 * see the failures.
 *
 * The control-plane verify+enqueue side (T-009 part (a) — stamping
 * `integration_name` from `subscription.integration_ref`) is pinned by
 * `packages/runtime-control/src/webhook-flow.test.ts`; this file picks
 * up where that one leaves off (queue → handler → reactive → handler).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerWebhookHandler,
  _resetHandlers,
  nextHopMetadata,
  type ItemEventMessage,
  type WebhookMessage,
} from "@mymehq/runtime-sdk";
import { createTestHarness } from "./harness.js";
import {
  SECONDARY_INTEGRATION_NAME,
  SECONDARY_CURSOR_KEY,
  registerSecondaryHandler,
  type SecondaryMarker,
} from "./fixtures/secondary-connector.js";

const PRIMARY_INTEGRATION_NAME = "myme.e2e-primary";
const PRIMARY_CONNECTION_ID = "conn_primary";
const SECONDARY_CONNECTION_ID = "conn_secondary";

/** Encode a UTF-8 string as base64 — mirrors the wire-format the
 *  control plane emits (`body_base64`). The runtime-sdk dispatcher
 *  decodes it back to ArrayBuffer at the seam (T-009). */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

describe("e2e — primary webhook → reactive event → secondary item-event", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  it("threads integration_name, body, and cycle metadata across the chain", async () => {
    // ----- Primary harness -----
    const primary = createTestHarness({
      integrationName: PRIMARY_INTEGRATION_NAME,
    });

    // ----- Secondary harness (kept separate so we can run two
    // consumeBatch passes without the queue draining contention) -----
    const secondary = createTestHarness({
      integrationName: SECONDARY_INTEGRATION_NAME,
    });

    // Capture what the primary handler observed, so the assertions
    // below can introspect what crossed the seam.
    let primaryRan = false;
    let primaryBodyText = "";
    let primaryBodyType = "";

    // Register the primary handler. On invocation it:
    //   - records the integration_name + decoded body it received
    //     (proving T-009's integration_name filter and base64 decode)
    //   - "publishes" a reactive event by enqueuing an item-event
    //     onto the secondary harness's queue, with a child cycle
    //     (hop_count incremented, originating_connection_id stamped).
    //
    // In production, steps (b) and (c) would happen via the server's
    // reactive-run bridge: the handler would call into Myme, the
    // server would publish, the bridge would fan out, the
    // per-Integration Worker for the secondary would consume the
    // item-event. The e2e test simulates the bridge — reactive-run
    // bridge mechanics (parallel fanout, tenant gate, hop budget) are
    // pinned separately in reactive-run-bridge.test.ts /
    // reactive-run-bridge-registry.test.ts.
    registerWebhookHandler((ctx, input) => {
      primaryRan = true;
      primaryBodyType = input.body.constructor.name;
      primaryBodyText = new TextDecoder().decode(input.body);

      // Bridge-simulation: enqueue the chained item-event.
      const reactiveEvent: ItemEventMessage = {
        kind: "item-event",
        integration_name: SECONDARY_INTEGRATION_NAME,
        connection_id: SECONDARY_CONNECTION_ID,
        event_type: "item.created",
        item_id: "itm_chained_42",
        cycle: nextHopMetadata(
          // Primary kicked off the chain — parent has hop_count 0 and
          // no prior origin; nextHopMetadata stamps originating to
          // the current connection and increments hop_count to 1.
          { originating_connection_id: null, hop_count: 0 },
          ctx.connection_id,
        ),
        payload: { item: { id: "itm_chained_42" } },
      };
      void secondary.connection(SECONDARY_CONNECTION_ID).send(reactiveEvent);
      return Promise.resolve({ ok: true });
    });

    // ----- Drive the primary: enqueue a webhook message with
    // integration_name properly stamped (the T-009 fix) and a base64
    // body the dispatcher must decode at the seam.
    const webhookEnvelope: WebhookMessage = {
      kind: "webhook",
      integration_name: PRIMARY_INTEGRATION_NAME,
      connection_id: PRIMARY_CONNECTION_ID,
      delivery_id: "d_e2e_1",
      headers: { "content-type": "application/json" },
      body_base64: utf8ToBase64('{"event":"push"}'),
      verified_at_ms: Date.now(),
    };
    await primary.connection(PRIMARY_CONNECTION_ID).send(webhookEnvelope);

    const primaryOutcome = await primary.consume();
    expect(primaryOutcome).toEqual({ acked: 1, retried: 0, failed: 0 });
    expect(primaryRan).toBe(true);
    // T-009 (b): the consumer routed by integration_name. If the
    // primary's envelope had an empty integration_name, this assertion
    // would fail — the message would be ack-skipped without invoking
    // the handler.
    expect(primaryBodyType).toBe("ArrayBuffer");
    // T-009 (c): the body_base64 round-trip decoded successfully at
    // the seam.
    expect(primaryBodyText).toBe('{"event":"push"}');

    // ----- Pivot to the secondary: register its handler and run
    // consumeBatch against the second harness. _resetHandlers() before
    // re-registering — registry is module-global (handlers.ts) and
    // one handler per kind per process.
    _resetHandlers();
    registerSecondaryHandler();

    const secondaryOutcome = await secondary.consume();
    expect(secondaryOutcome).toEqual({ acked: 1, retried: 0, failed: 0 });

    // ----- Read the secondary's marker — the cursor write inside the
    // secondary handler is the only side-effect we asserted on, and
    // it carries every cycle metadata field we want to verify.
    const marker = (await secondary
      .connection(SECONDARY_CONNECTION_ID)
      .storage.get(`cursor:${SECONDARY_CURSOR_KEY}`)) as SecondaryMarker | null;

    expect(marker).not.toBeNull();
    expect(marker?.item_id).toBe("itm_chained_42");
    // nextHopMetadata increments parent's hop_count by 1.
    expect(marker?.hop_count).toBe(1);
    // Provenance threads through: the secondary saw the primary as
    // the originator.
    expect(marker?.originating_connection_id).toBe(PRIMARY_CONNECTION_ID);
  });
});
