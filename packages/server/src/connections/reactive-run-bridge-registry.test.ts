/**
 * Tests for the reactive-run bridge's subscription registry — Layer 2 PR 3.
 *
 * The structural tests in reactive-run-bridge.test.ts cover env-var
 * gating. These exercise:
 *   - loadSubscriptions: walks system.connection items, resolves each
 *     via integration_ref → system.integration → manifest, and filters
 *     to connections whose manifest declares an item-event trigger.
 *   - buildEntryForConnection: per-connection logic — kind gate, status
 *     gate, missing integration_ref, missing integration item, missing
 *     item-event trigger.
 *   - end-to-end fanout: a real bridge with mocked fetch, an event
 *     published through the in-process pubsub, and assertion that the
 *     queue receives one message per subscribing connection (and zero
 *     for connections that don't subscribe).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  tryStartReactiveRunBridge,
  __test_internals,
} from "./reactive-run-bridge.js";
import type { IntegrationManifest } from "@mymehq/shared";
import { publish } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const { loadSubscriptions, buildEntryForConnection } = __test_internals;

function manifest(
  overrides?: Partial<IntegrationManifest>,
): IntegrationManifest {
  return {
    name: "acme.bridge-test",
    version: "1.0.0",
    publisher: "Acme",
    description: "bridge subscription test",
    direction: "read",
    triggers: [{ type: "item-event" }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
    ...overrides,
  };
}

async function createIntegration(
  m: IntegrationManifest = manifest(),
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version,
        publisher: m.publisher,
        direction: m.direction,
        runtime_compatibility: m.runtime_compatibility,
        manifest: m as unknown as Record<string, unknown>,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function createConnection(opts: {
  integrationRef?: string;
  kind?: string;
  status?: string;
  tenantId?: string;
}): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: opts.kind ?? "integration",
        status: opts.status ?? "active",
        granted_at: new Date().toISOString(),
        integration_ref: opts.integrationRef,
      },
    },
    opts.tenantId,
  );
  return item.id;
}

describe("buildEntryForConnection", () => {
  it("returns an entry when the manifest declares an item-event trigger", async () => {
    const intId = await createIntegration();
    const connId = await createConnection({ integrationRef: intId });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: item.properties,
    });
    expect(entry).not.toBeNull();
    expect(entry?.connection_id).toBe(connId);
    expect(entry?.integration_name).toBe("acme.bridge-test");
  });

  it("returns null when the manifest has no item-event trigger", async () => {
    const intId = await createIntegration(
      manifest({
        name: "acme.no-item-event",
        triggers: [{ type: "manual" }],
      }),
    );
    const connId = await createConnection({ integrationRef: intId });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: item.properties,
    });
    expect(entry).toBeNull();
  });

  it("returns null when kind is not integration", async () => {
    const intId = await createIntegration(manifest({ name: "acme.kind-skip" }));
    const connId = await createConnection({
      integrationRef: intId,
      kind: "app",
    });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: item.properties,
    });
    expect(entry).toBeNull();
  });

  it("returns null when status is revoked", async () => {
    const intId = await createIntegration(
      manifest({ name: "acme.revoked-skip" }),
    );
    const connId = await createConnection({
      integrationRef: intId,
      status: "revoked",
    });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: item.properties,
    });
    expect(entry).toBeNull();
  });

  it("returns null when integration_ref is unset", async () => {
    const connId = await createConnection({ integrationRef: undefined });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: item.properties,
    });
    expect(entry).toBeNull();
  });

  it("returns null when integration_ref points at a missing item", async () => {
    const connId = await createConnection({
      integrationRef: "itm_does_not_exist",
    });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: item.properties,
    });
    expect(entry).toBeNull();
  });
});

describe("loadSubscriptions", () => {
  it("returns only connections that subscribe to item events", async () => {
    const subscribingInt = await createIntegration(
      manifest({ name: "acme.load-subs-yes" }),
    );
    const nonSubscribingInt = await createIntegration(
      manifest({
        name: "acme.load-subs-no",
        triggers: [{ type: "schedule", config: { cron: "* * * * *" } }],
      }),
    );
    const subscribingConn = await createConnection({
      integrationRef: subscribingInt,
    });
    await createConnection({ integrationRef: nonSubscribingInt });

    const map = await loadSubscriptions(ctx.storage);
    expect(map.has(subscribingConn)).toBe(true);
    expect(map.get(subscribingConn)?.integration_name).toBe(
      "acme.load-subs-yes",
    );
  });

  it("paginates past the first 200 connections (T-013)", async () => {
    // Pre-T-013 the loader did one storage.items.list with limit=200;
    // any tenant's 201st+ connection silently dropped from the
    // subscription map. Seed 250 subscribing connections and assert
    // every one is in the map after load.
    const integrationId = await createIntegration(
      manifest({ name: "acme.load-subs-paginate" }),
    );
    const N = 250;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = await createConnection({ integrationRef: integrationId });
      ids.push(id);
    }

    const map = await loadSubscriptions(ctx.storage);
    for (const id of ids) {
      expect(map.has(id)).toBe(true);
    }
  });
});

describe("bridge fanout via in-process pubsub", () => {
  it("fans out one queue message per subscribing connection and skips self-originating events", async () => {
    const intA = await createIntegration(manifest({ name: "acme.fanout-a" }));
    const intB = await createIntegration(manifest({ name: "acme.fanout-b" }));
    const connA = await createConnection({ integrationRef: intA });
    const connB = await createConnection({ integrationRef: intB });

    interface Captured {
      url: string;
      body: { body: { integration_name: string; connection_id: string } };
    }
    const captured: Captured[] = [];
    const stubFetch: typeof fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      captured.push({
        url,
        body: JSON.parse(init?.body as string) as Captured["body"],
      });
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as typeof fetch;

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      queueUrl: "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: stubFetch,
      maxAttempts: 1,
    });
    expect(bridge).not.toBeNull();
    await bridge!.start();
    // Yield so the eager-load + invalidation subscriber spin up.
    await new Promise((r) => setTimeout(r, 20));

    // Publish an event from a third (unrelated) connection so neither
    // A nor B is the originator.
    const unrelated = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "hi" } },
      undefined,
    );
    await publish({
      type: "created",
      item: unrelated,
      originatingConnectionId: "itm_unrelated_origin",
    });
    await new Promise((r) => setTimeout(r, 20));

    const fanoutMessages = captured.filter((c) =>
      c.body.body.integration_name.startsWith("acme.fanout-"),
    );
    expect(fanoutMessages.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(fanoutMessages.map((c) => c.body.body.connection_id));
    expect(ids.has(connA)).toBe(true);
    expect(ids.has(connB)).toBe(true);

    // Self-event suppression: an event whose originator is connA
    // should NOT fan out back to connA.
    captured.length = 0;
    await publish({
      type: "updated",
      item: unrelated,
      originatingConnectionId: connA,
    });
    await new Promise((r) => setTimeout(r, 20));
    const selfFiltered = captured.filter(
      (c) => c.body.body.connection_id === connA,
    );
    expect(selfFiltered.length).toBe(0);

    await bridge!.stop();
  });

  it("a slow subscriber doesn't stall fanout to others (T-013)", async () => {
    const intSlow = await createIntegration(
      manifest({ name: "acme.fanout-slow" }),
    );
    const intFast = await createIntegration(
      manifest({ name: "acme.fanout-fast" }),
    );
    const connSlow = await createConnection({ integrationRef: intSlow });
    const connFast = await createConnection({ integrationRef: intFast });

    const fastDeliveries: string[] = [];
    let slowAttempts = 0;
    const stubFetch: typeof fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      const body = JSON.parse(init?.body as string) as {
        body: { integration_name: string; connection_id: string };
      };
      const integrationName = body.body.integration_name;
      if (integrationName === "acme.fanout-slow") {
        slowAttempts++;
        // Hang until the AbortController fires from the per-fetch timeout.
        // Reject when aborted so the bridge surfaces the failure path.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      }
      fastDeliveries.push(body.body.connection_id);
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as typeof fetch;

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      queueUrl: "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: stubFetch,
      maxAttempts: 1,
      // Tight timeout so the test finishes quickly.
      sendTimeoutMs: 100,
    });
    expect(bridge).not.toBeNull();
    await bridge!.start();
    // The bridge spins up `coordination.withJobLock` + the subscribe()
    // iterator on a fire-and-forget async path; PG storage adds a real
    // round-trip per setup step. Give it a generous head-start so the
    // subscribe() listener is actually live before we publish.
    await new Promise((r) => setTimeout(r, 200));

    const unrelated = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "slow-test" } },
      undefined,
    );
    await publish({
      type: "created",
      item: unrelated,
      originatingConnectionId: "itm_slow_origin",
    });
    // Slow timeout (100ms) + first backoff (100ms) + tail-of-fanout
    // wait. Generous on PG to absorb test-container jitter.
    await new Promise((r) => setTimeout(r, 1500));

    expect(slowAttempts).toBeGreaterThan(0);
    expect(fastDeliveries).toContain(connFast);
    // Slow subscriber's connection id should NOT appear in fast deliveries.
    expect(fastDeliveries).not.toContain(connSlow);

    await bridge!.stop();
  });

  it("does not fan out cross-tenant — events for tenant A skip subscribers in tenant B (T-042)", async () => {
    // Pre-T-042: every subscribing connection received every event
    // regardless of tenant; the cross-tenant guard relied on the
    // downstream Worker's per-Connection runtime credential failing the
    // API permission gate. The bridge now drops cross-tenant fanout
    // ahead of the queue producer.
    //
    // `items.tenant_id` is nullable with no FK in this codebase (the
    // `tenants` table FK exists on `users` and api keys but not on items),
    // so the test can use arbitrary tenant ids without first minting a
    // `Tenant` row. Avoids the "tenants store only available under
    // authMode=hosted" coupling.
    const tenantAId = `tenant-a-${Math.random().toString(36).slice(2, 8)}`;
    const tenantBId = `tenant-b-${Math.random().toString(36).slice(2, 8)}`;

    const intA = await createIntegration(
      manifest({ name: "acme.tenant-a-int" }),
    );
    const intB = await createIntegration(
      manifest({ name: "acme.tenant-b-int" }),
    );
    const connA = await createConnection({
      integrationRef: intA,
      tenantId: tenantAId,
    });
    const connB = await createConnection({
      integrationRef: intB,
      tenantId: tenantBId,
    });

    interface Captured {
      url: string;
      body: { body: { integration_name: string; connection_id: string } };
    }
    const captured: Captured[] = [];
    const stubFetch: typeof fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      captured.push({
        url,
        body: JSON.parse(init?.body as string) as Captured["body"],
      });
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as typeof fetch;

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      queueUrl: "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: stubFetch,
      maxAttempts: 1,
    });
    expect(bridge).not.toBeNull();
    await bridge!.start();
    await new Promise((r) => setTimeout(r, 20));

    // Publish an event scoped to tenant A. Only connA (tenant A) should
    // receive a queue message; connB (tenant B) must not.
    const eventItemA = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "tenant-a event" } },
      tenantAId,
    );
    await publish({
      type: "created",
      item: eventItemA,
      tenantId: tenantAId,
      originatingConnectionId: "itm_unrelated_a",
    });
    await new Promise((r) => setTimeout(r, 20));

    const tenantAFanout = captured.filter(
      (c) => c.body.body.integration_name === "acme.tenant-a-int",
    );
    const tenantBFanout = captured.filter(
      (c) => c.body.body.integration_name === "acme.tenant-b-int",
    );
    expect(tenantAFanout.length).toBeGreaterThanOrEqual(1);
    expect(tenantAFanout.some((c) => c.body.body.connection_id === connA)).toBe(
      true,
    );
    expect(tenantBFanout.length).toBe(0);

    // Symmetric: an event for tenant B reaches connB but not connA.
    captured.length = 0;
    const eventItemB = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "tenant-b event" } },
      tenantBId,
    );
    await publish({
      type: "created",
      item: eventItemB,
      tenantId: tenantBId,
      originatingConnectionId: "itm_unrelated_b",
    });
    await new Promise((r) => setTimeout(r, 20));

    const reverseA = captured.filter(
      (c) => c.body.body.integration_name === "acme.tenant-a-int",
    );
    const reverseB = captured.filter(
      (c) => c.body.body.integration_name === "acme.tenant-b-int",
    );
    expect(reverseB.length).toBeGreaterThanOrEqual(1);
    expect(reverseB.some((c) => c.body.body.connection_id === connB)).toBe(
      true,
    );
    expect(reverseA.length).toBe(0);

    await bridge!.stop();
  });

  it("fans out to fast subscribers in parallel — they don't wait on a wedged subscriber's timeout (T-036)", async () => {
    // Tighter than the T-013 test: this asserts ten healthy
    // subscribers all complete *while* the wedged subscriber is still
    // in its 200ms timeout window. That's only true if fanout is
    // concurrent. Pre-T-036 sequential fanout would gate the
    // healthy subscribers behind the wedged subscriber's full
    // timeout — fast latency would be ≥ 200ms instead of ≪ 100ms.
    const intSlow = await createIntegration(
      manifest({ name: "acme.par-slow" }),
    );
    const FAST_COUNT = 10;
    const fastConnIds: string[] = [];
    for (let i = 0; i < FAST_COUNT; i++) {
      const intFast = await createIntegration(
        manifest({ name: `acme.par-fast-${String(i)}` }),
      );
      fastConnIds.push(await createConnection({ integrationRef: intFast }));
    }
    const connSlow = await createConnection({ integrationRef: intSlow });

    // Captured by the stub fetch closure; explicitly typed to avoid
    // TS narrowing the vars to `null` at the read site.
    const captured: {
      slowResolveAt: number | null;
      fastDeliverAt: Map<string, number>;
    } = {
      slowResolveAt: null,
      fastDeliverAt: new Map<string, number>(),
    };

    const stubFetch: typeof fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      const body = JSON.parse(init?.body as string) as {
        body: { integration_name: string; connection_id: string };
      };
      const integrationName = body.body.integration_name;
      if (integrationName === "acme.par-slow") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            captured.slowResolveAt = Date.now();
            reject(new Error("aborted"));
          });
        });
      }
      if (fastConnIds.includes(body.body.connection_id)) {
        captured.fastDeliverAt.set(body.body.connection_id, Date.now());
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as typeof fetch;

    const SLOW_TIMEOUT_MS = 200;
    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      queueUrl: "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: stubFetch,
      maxAttempts: 1,
      sendTimeoutMs: SLOW_TIMEOUT_MS,
    });
    expect(bridge).not.toBeNull();
    await bridge!.start();
    await new Promise((r) => setTimeout(r, 200));

    const unrelated = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "par-test" } },
      undefined,
    );
    const publishAt = Date.now();
    await publish({
      type: "created",
      item: unrelated,
      originatingConnectionId: "itm_par_origin",
    });
    // Wait long enough for both the slow timeout and every fast
    // delivery to land. The slow timeout fires at ~SLOW_TIMEOUT_MS;
    // the fast deliveries should land much earlier under parallel
    // fanout.
    await new Promise((r) => setTimeout(r, SLOW_TIMEOUT_MS + 300));

    expect(captured.slowResolveAt).not.toBeNull();
    expect(connSlow).toBeTruthy();
    // Every fast subscriber must have delivered.
    expect(captured.fastDeliverAt.size).toBe(FAST_COUNT);
    // And every fast subscriber's delivery must have happened well
    // before the slow timeout would have completed in a sequential
    // model. Half-of-the-timeout is a generous bound to absorb
    // test-container jitter; pre-T-036 sequential fanout could not
    // satisfy this for any subscriber positioned behind the wedged
    // one in the iteration order.
    for (const [connId, ts] of captured.fastDeliverAt) {
      void connId;
      const latency = ts - publishAt;
      expect(latency).toBeLessThan(SLOW_TIMEOUT_MS / 2);
    }

    await bridge!.stop();
  });
});
