/**
 * A declined fan-out survives replication.
 *
 * The bulk doors publish every row they write, so the event log holds them,
 * and decline outbound work by default, so one call writing thousands of
 * rows does not become thousands of deliveries and reactions.
 *
 * That instruction used to travel only on the in-memory event. It is enough
 * for webhook delivery, whose consumer skips replicated events and so only
 * ever sees the publishing process's own copy. It is not enough for this
 * bridge: its drainer is elected across the cluster and treats a replicated
 * event exactly like a local one, so on a deployment running web and worker
 * as separate containers the process that reacts is routinely not the
 * process that wrote — and it rebuilds the event from the row.
 *
 * So the assertion has to arrive by replication. An in-process test cannot
 * substitute for it: in-process the object still carries the field, and the
 * gap is precisely that the object is gone by then.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { createTestContext, request } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { createLocalReactiveBridge } from "./reactive-bridge.js";
import { handleAnnouncement } from "../../event-replication.js";
import type { LocalRuntime, SchedulerEnvelope } from "./types.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

const INTEGRATION = "acme/bridge-fanout";

function manifest(): IntegrationManifest {
  return {
    name: INTEGRATION,
    version: "1.0.0",
    publisher: "acme",
    description: "bridge fan-out fixture",
    direction: "both",
    triggers: [{ type: "item-event" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    permissions: {},
  };
}

describe("a replicated event carries the writer's fan-out decision", () => {
  it("enqueues no reaction for a declined event, and still does for an ordinary one", async () => {
    const space = await ctx.storage.spaces!.create("bridge-fanout");
    const integration = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: INTEGRATION,
          manifest_version: "1.0.0",
          publisher: "acme",
          manifest: manifest(),
          registered_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          runtime_status: "healthy",
          granted_at: new Date().toISOString(),
          integration_ref: integration.id,
        },
      },
      space.id,
    );

    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: "bridge-fanout-probe",
          source: "bridge-fanout-probe",
          role: "space_admin",
          default_tier: "library",
          type_permissions: { "*": "write" },
        },
      },
    );
    expect(keyRes.status).toBe(201);
    const spaceKey = ((await keyRes.json()) as { key: string }).key;

    const enqueued: SchedulerEnvelope[] = [];
    const runtime = {
      enqueue: (envelope: SchedulerEnvelope) => {
        enqueued.push(envelope);
        return Promise.resolve();
      },
      getRegistration: (name: string) =>
        name === INTEGRATION ? ({ name } as never) : undefined,
    } as unknown as LocalRuntime;

    const bridge = createLocalReactiveBridge(ctx.storage, runtime, {
      disableCoordinationLock: true,
    });
    await bridge.start();

    try {
      // Warm the map with an ordinary write, so a later absence is the
      // event's own doing rather than a bridge that never subscribed.
      let item: Item | null = null;
      await vi.waitFor(
        async () => {
          if (enqueued.length === 0) {
            const res = await request(ctx.app, "POST", "/items", {
              key: spaceKey,
              body: { type: "core.note", properties: { body: "warm" } },
            });
            expect(res.status).toBe(201);
            item = ((await res.json()) as { item: Item }).item;
          }
          expect(enqueued.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      const warm = item as Item | null;
      expect(warm).not.toBeNull();

      /** Append a row and deliver it the way a sibling process's would arrive. */
      const replicate = async (enableFanout: boolean): Promise<void> => {
        const eventId = await ctx.storage.eventLog.append({
          event_type: "updated",
          item_id: warm!.id,
          space_id: space.id,
          payload: JSON.stringify({ type: "item.updated", item: warm }),
          enable_fanout: enableFanout,
        });
        // A foreign origin, so this takes the hydrate-and-re-emit path a
        // notification from another process takes. The default `ownOrigin`
        // is this process's, which any other string differs from.
        await handleAnnouncement(
          JSON.stringify({ i: String(eventId), o: "another-process" }),
          ctx.storage.eventLog,
        );
      };

      const beforeDeclined = enqueued.length;
      await replicate(false);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(enqueued.length).toBe(beforeDeclined);

      // The control. Without it a bridge that had simply stopped reacting
      // to replicated events would satisfy the assertion above.
      await replicate(true);
      await vi.waitFor(
        () => {
          expect(enqueued.length).toBeGreaterThan(beforeDeclined);
          const last = enqueued[enqueued.length - 1];
          expect(last?.message.connection_id).toBe(connection.id);
        },
        { timeout: 10_000 },
      );
    } finally {
      await bridge.stop();
    }
  });
});
