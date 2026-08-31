/**
 * A delete reaches a subscribed integration.
 *
 * The drainer dropped `deleted` events one line above the shared dispatch
 * gate, so on the only live substrate a bidirectional integration declaring
 * `tombstone_mapping` could never hear a Marfa-side delete: its
 * delete-upstream path was unreachable code. The skip was never parity with
 * anything — the hosted bridge it claimed to match fanned deletes out like
 * any other event — and the type guard four lines below it admits `deleted`,
 * so the two contradicted each other.
 *
 * Nothing pinned the behaviour in either direction, which is how it survived
 * three passes over this file. This does.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { IntegrationManifest } from "@withmarfa/shared";
import { createTestContext, request } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { createLocalReactiveBridge } from "./reactive-bridge.js";
import type { LocalRuntime, SchedulerEnvelope } from "./types.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterAll(async () => {
  await ctx.cleanup();
});

const INTEGRATION = "acme/bridge-delete";

function manifest(): IntegrationManifest {
  return {
    name: INTEGRATION,
    version: "1.0.0",
    publisher: "acme",
    description: "bridge delete fixture",
    direction: "both",
    triggers: [{ type: "item-event" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      // The declaration that was unreachable: a delete has to arrive for
      // the handler to have anything to map.
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    permissions: {},
  };
}

describe("the live bridge fans out deletes", () => {
  it("dispatches an item delete to a subscribed bidirectional integration", async () => {
    const space = await ctx.storage.spaces!.create("bridge-delete");
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

    // Space-bound writer: the event must carry the connection's space or
    // the cross-space gate refuses it before target types are consulted.
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: "bridge-delete-probe",
          source: "bridge-delete-probe",
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
      // Create first, and wait for its event: that proves the map is warm
      // and the connection is subscribed, so a missing delete afterwards
      // is the delete's absence rather than a cold bridge.
      let itemId = "";
      await vi.waitFor(
        async () => {
          if (enqueued.length === 0) {
            const res = await request(ctx.app, "POST", "/items", {
              key: spaceKey,
              body: {
                type: "core.note",
                properties: { body: "to be deleted" },
              },
            });
            expect(res.status).toBe(201);
            itemId = ((await res.json()) as { item: { id: string } }).item.id;
          }
          expect(enqueued.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      expect(itemId).not.toBe("");

      const afterCreate = enqueued.length;

      const deleted = await request(ctx.app, "DELETE", `/items/${itemId}`, {
        key: spaceKey,
      });
      expect(deleted.status).toBeLessThan(300);

      await vi.waitFor(
        () => {
          expect(enqueued.length).toBeGreaterThan(afterCreate);
          const last = enqueued[enqueued.length - 1];
          expect(last?.message.connection_id).toBe(connection.id);
          expect(last?.integration_name).toBe(INTEGRATION);
          const message = last?.message as { event_type?: string } | undefined;
          expect(message?.event_type).toBe("item.deleted");
        },
        { timeout: 10_000 },
      );
    } finally {
      await bridge.stop();
    }
  });
});
