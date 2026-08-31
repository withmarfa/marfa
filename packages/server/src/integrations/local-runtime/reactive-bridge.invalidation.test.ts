/**
 * Pause reaches the bridge's CACHE, not just storage.
 *
 * The drainer holds an in-memory subscription map and only re-evaluates
 * an entry when a `system.connection` event arrives on the pubsub. The
 * pause pipeline's write is a plain storage update, so the route has to
 * publish the status flip — without that event, pause returned 200 and
 * the warm map kept fanning item events to the paused connection until
 * the next restart or re-election. This suite drives the real routes
 * against a live bridge and fails on that shape.
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

const INTEGRATION = "acme/bridge-pause";

function manifest(): IntegrationManifest {
  return {
    name: INTEGRATION,
    version: "1.0.0",
    publisher: "acme",
    description: "bridge invalidation fixture",
    direction: "read",
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

describe("the live bridge honors pause and resume", () => {
  it("drops a paused connection from fanout and picks it back up on resume", async () => {
    const space = await ctx.storage.spaces!.create("bridge-pause");
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

    // A space-bound writer: the probe event must carry the connection's
    // space or the cross-space gate refuses it before the map is even
    // consulted.
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: "bridge-probe",
          source: "bridge-probe",
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

    // A probe write through the real route: publishes a core.note event
    // the warm map fans out to our connection.
    const probe = async (): Promise<void> => {
      const res = await request(ctx.app, "POST", "/items", {
        key: spaceKey,
        body: {
          type: "core.note",
          properties: { body: `probe ${Math.random().toString(36).slice(2)}` },
        },
      });
      expect(res.status).toBe(201);
    };

    try {
      // Warm path proven first: the map holds the entry and fanout works.
      await vi.waitFor(
        async () => {
          if (enqueued.length === 0) await probe();
          expect(enqueued.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );

      // Pause through the real route. The route's published event is the
      // only thing that can reach the warm map.
      const paused = await request(
        ctx.app,
        "POST",
        `/connections/${connection.id}/pause`,
        { key: spaceKey },
      );
      expect(paused.status).toBe(200);

      // Probes keep flowing until the invalidation lands; once it has,
      // a probe followed by a settle window produces no new enqueue.
      // Pre-fix (no published event) the map stays warm, every probe
      // enqueues, the inner assertion never holds, and waitFor times out.
      await vi.waitFor(
        async () => {
          const before = enqueued.length;
          await probe();
          await new Promise((r) => setTimeout(r, 50));
          expect(enqueued.length).toBe(before);
        },
        { timeout: 10_000 },
      );

      // Resume restores fanout through the same event path — a positive
      // signal, so a slow invalidation cannot fake a pass above without
      // failing here.
      const resumed = await request(
        ctx.app,
        "POST",
        `/connections/${connection.id}/resume`,
        { key: spaceKey },
      );
      expect(resumed.status).toBe(200);
      const afterResume = enqueued.length;
      await vi.waitFor(
        async () => {
          await probe();
          await new Promise((r) => setTimeout(r, 25));
          expect(enqueued.length).toBeGreaterThan(afterResume);
          expect(enqueued[enqueued.length - 1]?.message.connection_id).toBe(
            connection.id,
          );
        },
        { timeout: 10_000 },
      );
    } finally {
      await bridge.stop();
    }
  });
});
