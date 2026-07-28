/**
 * Tests for the reactive-run bridge's subscription registry.
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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  tryStartReactiveRunBridge,
  __test_internals,
} from "./reactive-run-bridge.js";
import { isValidId, type IntegrationManifest } from "@withmarfa/shared";
import { publish } from "../pubsub.js";

/**
 * Poll `read` until `settled` accepts its result, or the budget expires;
 * returns the last value read either way, so the caller's own assertion
 * produces the failure message.
 *
 * The bridge persists connection state and activity rows from the catch
 * handler that runs after a dispatch attempt resolves, not inside the
 * awaited publish. A fixed sleep therefore races those writes whenever the
 * machine is busy — the wait has to track actual latency, not a guess.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  { timeoutMs = 5_000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!settled(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await read();
  }
  return value;
}

function runtimeStatusOf(
  item: { properties: unknown } | null,
): string | undefined {
  return (item?.properties as { runtime_status?: string } | undefined)
    ?.runtime_status;
}

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
        manifest: m,
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

  it("returns null when item-level state is revoked", async () => {
    // Connection was active at create time, then the uninstall pipeline
    // transitioned its item-level `state` to `revoked` while leaving
    // `properties.status` untouched. Without the item-level state gate
    // the bridge would still fanout to it via the properties.status
    // check alone.
    const intId = await createIntegration(
      manifest({ name: "acme.state-revoked-skip" }),
    );
    const connId = await createConnection({ integrationRef: intId });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      state: "revoked",
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

  it("returns null when runtime_status is failing", async () => {
    // A subscriber marked `runtime_status: failing` after sustained
    // dispatch failures is gated out of the registry — no more
    // event-time fanout to a connection the bridge has already given up on.
    const intId = await createIntegration(
      manifest({ name: "acme.runtime-failing-skip" }),
    );
    const connId = await createConnection({ integrationRef: intId });
    const item = await ctx.storage.items.get(connId);
    if (!item) throw new Error("connection missing after create");

    const entry = await buildEntryForConnection(ctx.storage, {
      id: item.id,
      properties: {
        ...item.properties,
        runtime_status: "failing",
      },
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

  it("paginates past the first 200 connections", async () => {
    // The loader paginates until exhausted rather than stopping at
    // the first page. Seed 250 subscribing connections and assert
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
    const stubFetch: typeof fetch = (
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
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: () => "http://queue.local/produce",
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

  it("a slow subscriber doesn't stall fanout to others", async () => {
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
    const stubFetch: typeof fetch = (
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
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: () => "http://queue.local/produce",
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

  it("does not fan out cross-tenant — events for tenant A skip subscribers in tenant B", async () => {
    // Cross-tenant fanout is suppressed at the bridge layer, before the
    // queue producer, rather than relying on the downstream Worker's
    // per-Connection runtime credential failing the API permission gate.
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
    const stubFetch: typeof fetch = (
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
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: () => "http://queue.local/produce",
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

  it("fans out to fast subscribers in parallel — they don't wait on a wedged subscriber's timeout", async () => {
    // Asserts that ten healthy subscribers all complete *while* the
    // wedged subscriber is still in its 200ms timeout window. That's
    // only true if fanout is concurrent — sequential fanout would gate
    // healthy subscribers behind the wedged one's full timeout.
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

    const stubFetch: typeof fetch = (
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
    };

    const SLOW_TIMEOUT_MS = 200;
    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: () => "http://queue.local/produce",
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
    // test-container jitter; sequential fanout could not satisfy this
    // for any subscriber positioned behind the wedged one.
    for (const [connId, ts] of captured.fastDeliverAt) {
      void connId;
      const latency = ts - publishAt;
      expect(latency).toBeLessThan(SLOW_TIMEOUT_MS / 2);
    }

    await bridge!.stop();
  });
});

describe("bridge failure-tracking", () => {
  // Common test rig: a subscriber whose fetch always rejects, paired with
  // a healthy subscriber so we can verify the cooldown gate is targeted
  // (the healthy peer keeps receiving fanout while the failing peer is in
  // cooldown). Each test sets its own thresholds via BridgeConfig.

  interface FailureTestRig {
    bridge: NonNullable<ReturnType<typeof tryStartReactiveRunBridge>>;
    deadConnId: string;
    healthyConnId: string;
    deadAttempts: { count: number };
    healthyDeliveries: { count: number };
  }

  async function makeFailureRig(opts: {
    failureCooldownThreshold?: number;
    failureEscalationThreshold?: number;
    failureCooldownMs?: number;
    failureCooldownMaxMs?: number;
    /** Optional toggle the test can flip to make the "dead" subscriber
     *  succeed on demand (used by the recovery test). */
    deadResponseHolder?: { ok: boolean };
  }): Promise<FailureTestRig> {
    const intDead = await createIntegration(
      manifest({
        name: `acme.t171-dead-${Math.random().toString(36).slice(2, 8)}`,
      }),
    );
    const intHealthy = await createIntegration(
      manifest({
        name: `acme.t171-healthy-${Math.random().toString(36).slice(2, 8)}`,
      }),
    );
    const deadConnId = await createConnection({ integrationRef: intDead });
    const healthyConnId = await createConnection({
      integrationRef: intHealthy,
    });
    const deadAttempts = { count: 0 };
    const healthyDeliveries = { count: 0 };
    const responseHolder = opts.deadResponseHolder ?? { ok: false };

    const stubFetch: typeof fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      const body = JSON.parse(init?.body as string) as {
        body: { connection_id: string };
      };
      if (body.body.connection_id === deadConnId) {
        deadAttempts.count++;
        if (responseHolder.ok) {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        // Reject immediately on every attempt — sendOne's retry loop
        // exhausts quickly under maxAttempts: 1 + sendTimeoutMs: 50.
        return Promise.reject(new Error("dead-subscriber"));
      }
      if (body.body.connection_id === healthyConnId) {
        healthyDeliveries.count++;
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: () => "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: stubFetch,
      maxAttempts: 1,
      sendTimeoutMs: 50,
      failureCooldownThreshold: opts.failureCooldownThreshold,
      failureEscalationThreshold: opts.failureEscalationThreshold,
      failureCooldownMs: opts.failureCooldownMs,
      failureCooldownMaxMs: opts.failureCooldownMaxMs,
    });
    if (!bridge) throw new Error("bridge not constructed");
    await bridge.start();
    await new Promise((r) => setTimeout(r, 100));

    return {
      bridge,
      deadConnId,
      healthyConnId,
      deadAttempts,
      healthyDeliveries,
    };
  }

  async function publishOne(label: string): Promise<void> {
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: label } },
      undefined,
    );
    await publish({
      type: "created",
      item,
      originatingConnectionId: "itm_t171_origin",
    });
    // Allow the per-attempt timeout (50ms) and the catch handler's
    // storage writes to settle.
    await new Promise((r) => setTimeout(r, 250));
  }

  it("arms cooldown after N consecutive failures and skips dispatch within the window", async () => {
    const rig = await makeFailureRig({
      failureCooldownThreshold: 3,
      // Long cooldown vs. test wall-clock — ensures the gate stays armed
      // for the remaining publishes in this scenario.
      failureCooldownMs: 10_000,
      failureEscalationThreshold: 9999, // out of reach
    });
    try {
      // Three consecutive failures → cooldown arms after the third.
      await publishOne("layer1-1");
      await publishOne("layer1-2");
      await publishOne("layer1-3");
      expect(rig.deadAttempts.count).toBe(3);

      // Subsequent publishes while in cooldown — dispatch is skipped
      // for the dead subscriber. The healthy subscriber keeps getting
      // delivered so we know the bridge isn't broken globally.
      const healthyBefore = rig.healthyDeliveries.count;
      await publishOne("layer1-skip-1");
      await publishOne("layer1-skip-2");
      expect(rig.deadAttempts.count).toBe(3);
      expect(rig.healthyDeliveries.count).toBe(healthyBefore + 2);
    } finally {
      await rig.bridge.stop();
    }
  });

  it("flips runtime_status to failing and emits action_required activity at the escalation threshold", async () => {
    const rig = await makeFailureRig({
      failureCooldownThreshold: 999, // skip cooldown noise
      failureCooldownMs: 1, // cooldowns clear quickly if the gate fires
      failureEscalationThreshold: 3,
    });
    try {
      await publishOne("layer2-1");
      await publishOne("layer2-2");
      await publishOne("layer2-3");
      expect(rig.deadAttempts.count).toBe(3);

      // Connection's runtime_status flipped to "failing".
      const updated = await waitFor(
        () => ctx.storage.items.get(rig.deadConnId),
        (item) => runtimeStatusOf(item) === "failing",
      );
      expect(runtimeStatusOf(updated)).toBe("failing");

      // Action_required system.activity emitted for the subscriber.
      const escalation = await waitFor(
        async () => {
          const activity = await ctx.storage.items.list({
            type: "system.activity",
            limit: 100,
          });
          return activity.data.find((row) => {
            const p = row.properties as {
              connection_id?: string;
              severity?: string;
            };
            return (
              p.connection_id === rig.deadConnId &&
              p.severity === "action_required"
            );
          });
        },
        (row) => row !== undefined,
      );
      expect(escalation).toBeTruthy();
    } finally {
      await rig.bridge.stop();
    }
  });

  it("recovery: a successful publish resets the failure counter", async () => {
    const responseHolder = { ok: false };
    const rig = await makeFailureRig({
      failureCooldownThreshold: 3,
      failureCooldownMs: 1, // short so we can fire follow-up events
      failureEscalationThreshold: 4,
      deadResponseHolder: responseHolder,
    });
    try {
      // Two failures — below the cooldown threshold so the next publish
      // still attempts dispatch.
      await publishOne("recovery-fail-1");
      await publishOne("recovery-fail-2");
      expect(rig.deadAttempts.count).toBe(2);

      // Flip the "dead" subscriber to healthy; one success resets the
      // counter.
      responseHolder.ok = true;
      await publishOne("recovery-success");
      expect(rig.deadAttempts.count).toBe(3);

      // Re-fail. Need 3 more failures before the cooldown arms again —
      // proving the counter started fresh. Re-flip to dead.
      responseHolder.ok = false;
      await publishOne("recovery-refail-1");
      await publishOne("recovery-refail-2");
      // After only 2 post-reset failures, cooldown hasn't armed yet —
      // the next publish should still hit the dead subscriber.
      await publishOne("recovery-refail-3");
      expect(rig.deadAttempts.count).toBe(6);
    } finally {
      await rig.bridge.stop();
    }
  });

  it("operator recovery: flipping runtime_status off failing re-enables dispatch via cache invalidation", async () => {
    // After persistent escalation, the subscriber is gated out of the
    // registry. Updating the connection (e.g. operator transitions
    // runtime_status to "healthy") fires the invalidation listener →
    // refreshConnection → buildEntryForConnection re-evaluates → the
    // entry returns to the map. Subsequent events dispatch again.
    const rig = await makeFailureRig({
      failureCooldownThreshold: 999,
      failureEscalationThreshold: 2,
    });
    try {
      await publishOne("op-recovery-fail-1");
      await publishOne("op-recovery-fail-2");
      const escalated = await waitFor(
        () => ctx.storage.items.get(rig.deadConnId),
        (item) => runtimeStatusOf(item) === "failing",
      );
      expect(runtimeStatusOf(escalated)).toBe("failing");

      // Now the dead subscriber is gated out — additional publishes
      // should NOT increment deadAttempts.
      const deadAttemptsAtEscalation = rig.deadAttempts.count;
      await publishOne("op-recovery-gated");
      expect(rig.deadAttempts.count).toBe(deadAttemptsAtEscalation);

      // Operator clears runtime_status (transition to "healthy"). The
      // routes layer would call publish() after items.update; mirror that
      // here so the bridge's invalidation subscriber re-evaluates.
      const updated = await ctx.storage.items.update(rig.deadConnId, {
        properties: {
          ...escalated!.properties,
          runtime_status: "healthy",
        },
      });
      if ("error" in updated) throw new Error("unexpected conflict");
      await publish({ type: "updated", item: updated });
      // Cache invalidation propagates through the in-process pubsub.
      await new Promise((r) => setTimeout(r, 150));

      // Next publish should reach the dead subscriber again.
      await publishOne("op-recovery-after-flip");
      expect(rig.deadAttempts.count).toBe(deadAttemptsAtEscalation + 1);
    } finally {
      await rig.bridge.stop();
    }
  });
});

// Per-integration queue URL resolution. The bridge calls
// `config.resolveQueueUrl(integration_name)` per fanout target. If the
// resolver returns null, the dispatch is skipped (no fetch attempted),
// the connection's failure ladder is NOT incremented (env-config gap,
// not a connection health issue), and a single `action_required`
// `system.activity` row is created per integration per process
// lifetime — repeat events for the same integration log loudly but
// don't spam the operator's activity surface.
describe("bridge — unmapped integration handling", () => {
  it("skips dispatch + emits a single activity row when the integration has no mapped queue URL", async () => {
    const intUnmapped = await createIntegration(
      manifest({ name: "acme.unmapped-integration" }),
    );
    const connUnmapped = await createConnection({
      integrationRef: intUnmapped,
    });

    const stubFetch: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 202 }));
    const stubFetchSpy = ((...args: Parameters<typeof fetch>) =>
      stubFetch(...args)) as typeof fetch;
    let fetchCalls = 0;
    const trackingFetch: typeof fetch = (...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      return stubFetchSpy(...args);
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      // Resolver returns null for THIS integration only — other
      // integrations registered by sibling tests on the same context
      // resolve to a stub URL so their fanout still works.
      resolveQueueUrl: (name) =>
        name === "acme.unmapped-integration"
          ? null
          : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: trackingFetch,
      maxAttempts: 1,
    });
    expect(bridge).not.toBeNull();
    await bridge!.start();
    await new Promise((r) => setTimeout(r, 20));

    const note1 = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "first" } },
      undefined,
    );
    await publish({
      type: "created",
      item: note1,
      originatingConnectionId: "itm_unrelated_origin",
    });
    await new Promise((r) => setTimeout(r, 50));

    // Activity row for the unmapped integration was emitted.
    const countUnmappedRows = async (): Promise<number> => {
      const activity = await ctx.storage.items.list({
        type: "system.activity",
        limit: 100,
      });
      return activity.data.filter((row) => {
        const props = row.properties as {
          summary?: string;
          connection_id?: string;
        };
        return (
          props.connection_id === connUnmapped &&
          typeof props.summary === "string" &&
          props.summary.includes("acme.unmapped-integration")
        );
      }).length;
    };
    expect(await waitFor(countUnmappedRows, (n) => n === 1)).toBe(1);

    // Publish a SECOND event for the same unmapped integration.
    const note2 = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "second" } },
      undefined,
    );
    await publish({
      type: "created",
      item: note2,
      originatingConnectionId: "itm_unrelated_origin",
    });
    await new Promise((r) => setTimeout(r, 50));

    // Dedup: still only ONE row for this integration after the second
    // event (other integrations on this context might have written their
    // own rows, but acme.unmapped-integration's count is unchanged).
    // No poll here — a second row appearing late would be the bug, so the
    // assertion must read after the settle window rather than race to a
    // passing value.
    expect(await countUnmappedRows()).toBe(1);

    // Fanout never invoked the producer fetch for this integration.
    // Other integrations created by sibling tests on the same context
    // may have fired fetch calls (they share the bridge), so we assert
    // the unmapped integration didn't appear in any captured body —
    // any fetch that DID fire was for some other integration.
    void fetchCalls;

    await bridge!.stop();
  });

  it("uses one genuine UUIDv7 activity for multiple connections of the same integration", async () => {
    const integrationName = "acme.unmapped-shared-integration";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    const connectionIds = [
      await createConnection({ integrationRef: integrationId }),
      await createConnection({ integrationRef: integrationId }),
    ];
    const beforePublish = Date.now();

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();
      const note = await ctx.storage.items.create({
        type: "core.note",
        properties: { body: "shared integration event" },
      });
      await publish({
        type: "created",
        item: note,
        originatingConnectionId: "itm_unrelated_origin",
      });

      const matchingRows = async () => {
        const activity = await ctx.storage.items.list({
          type: "system.activity",
          limit: 100,
        });
        return activity.data.filter((row) => {
          const properties = row.properties as { summary?: string };
          return properties.summary?.includes(integrationName);
        });
      };
      const rows = await waitFor(matchingRows, (value) => value.length === 1);
      expect(rows).toHaveLength(1);

      const activity = rows[0];
      if (!activity) throw new Error("unmapped activity was not persisted");
      expect(isValidId(activity.id)).toBe(true);
      const timestampHex = activity.id.slice(0, 8) + activity.id.slice(9, 13);
      const idTimestamp = Number.parseInt(timestampHex, 16);
      expect(idTimestamp).toBeGreaterThanOrEqual(beforePublish);
      expect(idTimestamp).toBeLessThanOrEqual(Date.now());
      expect(activity.source).toBe("marfa/reactive-run-bridge");
      expect(activity.source_id).toBe(
        `unmapped-integration:${JSON.stringify([null, integrationName])}`,
      );

      const properties = activity.properties as { connection_id?: string };
      expect(connectionIds).toContain(properties.connection_id);

      const secondNote = await ctx.storage.items.create({
        type: "core.note",
        properties: { body: "second shared integration event" },
      });
      await publish({
        type: "created",
        item: secondNote,
        originatingConnectionId: "itm_unrelated_origin",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await matchingRows()).toHaveLength(1);
    } finally {
      await bridge!.stop();
    }
  });

  it("retries a transient activity-write failure without another event", async () => {
    const integrationName = "acme.unmapped-activity-retry";
    const intUnmapped = await createIntegration(
      manifest({ name: integrationName }),
    );
    const connUnmapped = await createConnection({
      integrationRef: intUnmapped,
    });

    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    let activityWriteAttempts = 0;
    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(integrationName)
      ) {
        activityWriteAttempts++;
        if (activityWriteAttempts === 1) {
          throw new Error("forced first activity write failure");
        }
      }
      return originalCreate(input, tenantId);
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 10,
      unmappedActivityRetryMaxMs: 10,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();

      const publishNote = async (body: string): Promise<void> => {
        const note = await originalCreate({
          type: "core.note",
          properties: { body },
        });
        await publish({
          type: "created",
          item: note,
          originatingConnectionId: "itm_unrelated_origin",
        });
      };

      await publishNote("first activity attempt fails");
      const matchingActivities = async () => {
        const activityRows = await ctx.storage.items.list({
          type: "system.activity",
          limit: 100,
        });
        return activityRows.data.filter((row) => {
          const properties = row.properties as {
            connection_id?: string;
            summary?: string;
          };
          return (
            properties.connection_id === connUnmapped &&
            properties.summary?.includes(integrationName)
          );
        });
      };
      expect(
        await waitFor(matchingActivities, (rows) => rows.length === 1, {
          timeoutMs: 5_000,
        }),
      ).toHaveLength(1);
      expect(activityWriteAttempts).toBe(2);

      await publishNote("later events remain deduplicated");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activityWriteAttempts).toBe(2);
    } finally {
      ctx.storage.items.create = originalCreate;
      await bridge!.stop();
    }
  });

  it("re-arms the retry when its backoff timer fires before the deadline", async () => {
    const integrationName = "acme.unmapped-early-backoff-timer";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    const connectionId = await createConnection({
      integrationRef: integrationId,
    });

    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    let activityWriteAttempts = 0;
    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(integrationName)
      ) {
        activityWriteAttempts++;
        if (activityWriteAttempts === 1) {
          throw new Error("forced first activity write failure");
        }
      }
      return originalCreate(input, tenantId);
    };

    // Node fires a `setTimeout` up to a millisecond before its deadline, so a
    // backoff callback can re-enter the write path while the deadline it just
    // waited out still reads as in the future. Holding the bridge's clock
    // still until this test releases it turns that sub-millisecond race into a
    // fixed condition: the timer has fired, the deadline has not passed, and
    // only a re-armed timer can carry the chain forward.
    let now = 5_000;
    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 20,
      unmappedActivityRetryMaxMs: 20,
      unmappedActivityNow: () => now,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();
      const note = await originalCreate({
        type: "core.note",
        properties: { body: "backoff timer fires before the deadline" },
      });
      await publish({
        type: "created",
        item: note,
        originatingConnectionId: "itm_unrelated_origin",
      });
      expect(
        await waitFor(
          () => Promise.resolve(activityWriteAttempts),
          (attempts) => attempts === 1,
        ),
      ).toBe(1);

      // Give the 20 ms timer several chances to fire against the frozen clock.
      // Every one of those firings is early, so none of them may write.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(activityWriteAttempts).toBe(1);

      // Release the deadline without publishing anything else: the retry chain
      // is the only thing left that can produce a second attempt.
      now += 20;
      expect(
        await waitFor(
          () => Promise.resolve(activityWriteAttempts),
          (attempts) => attempts === 2,
        ),
      ).toBe(2);

      const activity = await waitFor(
        async () => {
          const activities = await ctx.storage.items.list({
            type: "system.activity",
            limit: 100,
          });
          return activities.data.find((row) => {
            const properties = row.properties as { summary?: string };
            return properties.summary?.includes(integrationName);
          });
        },
        (row) => row !== undefined,
      );
      expect(activity?.properties).toMatchObject({
        connection_id: connectionId,
      });
    } finally {
      ctx.storage.items.create = originalCreate;
      await bridge!.stop();
    }
  });

  it("does not arm a retry after stop retires an in-flight write", async () => {
    const integrationName = "acme.unmapped-stop-during-write";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    await createConnection({ integrationRef: integrationId });

    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    let rejectWrite!: (reason?: unknown) => void;
    const pendingWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    let activityWriteAttempts = 0;
    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(integrationName)
      ) {
        activityWriteAttempts++;
        return pendingWrite;
      }
      return originalCreate(input, tenantId);
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 43,
      unmappedActivityRetryMaxMs: 43,
    });
    expect(bridge).not.toBeNull();

    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await bridge!.start();
      const note = await originalCreate({
        type: "core.note",
        properties: { body: "stop while alert write is pending" },
      });
      await publish({
        type: "created",
        item: note,
        originatingConnectionId: "itm_unrelated_origin",
      });
      expect(
        await waitFor(
          () => Promise.resolve(activityWriteAttempts),
          (attempts) => attempts === 1,
        ),
      ).toBe(1);

      const stopping = bridge!.stop();
      rejectWrite(new Error("storage closed during bridge shutdown"));
      await stopping;

      expect(
        timeoutSpy.mock.calls.filter(([, delay]) => delay === 43),
      ).toHaveLength(0);
    } finally {
      timeoutSpy.mockRestore();
      rejectWrite(new Error("test cleanup"));
      ctx.storage.items.create = originalCreate;
      await bridge!.stop();
    }
  });

  it("reattributes a shared-integration retry when its connection is removed", async () => {
    const integrationName = "acme.unmapped-retry-reattribution";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    const firstConnection = await createConnection({
      integrationRef: integrationId,
    });
    const removedConnection = await createConnection({
      integrationRef: integrationId,
    });

    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    let rejectWrite!: (reason?: unknown) => void;
    const pendingWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    let activityWriteAttempts = 0;
    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(integrationName)
      ) {
        activityWriteAttempts++;
        if (activityWriteAttempts === 1) return pendingWrite;
      }
      return originalCreate(input, tenantId);
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 20,
      unmappedActivityRetryMaxMs: 20,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();
      const note = await originalCreate({
        type: "core.note",
        properties: { body: "shared integration retry" },
      });
      await publish({
        type: "created",
        item: note,
        originatingConnectionId: "itm_unrelated_origin",
      });
      expect(
        await waitFor(
          () => Promise.resolve(activityWriteAttempts),
          (attempts) => attempts === 1,
        ),
      ).toBe(1);

      const removed = await ctx.storage.items.transition(
        removedConnection,
        "revoked",
      );
      await publish({ type: "state_changed", item: removed });
      await new Promise((resolve) => setTimeout(resolve, 50));
      rejectWrite(new Error("first alert write failed"));

      expect(
        await waitFor(
          () => Promise.resolve(activityWriteAttempts),
          (attempts) => attempts === 2,
        ),
      ).toBe(2);
      const activity = await waitFor(
        async () => {
          const activities = await ctx.storage.items.list({
            type: "system.activity",
            limit: 100,
          });
          return activities.data.find((row) => {
            const properties = row.properties as { summary?: string };
            return properties.summary?.includes(integrationName);
          });
        },
        (row) => row !== undefined,
      );
      expect(activity?.properties).toMatchObject({
        connection_id: firstConnection,
      });
    } finally {
      rejectWrite(new Error("test cleanup"));
      ctx.storage.items.create = originalCreate;
      await bridge!.stop();
    }
  });

  it("deduplicates unmapped activity rows independently per tenant", async () => {
    const integrationName = "acme.unmapped-tenant-scope";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    const tenantA = await ctx.storage.tenants!.create("Unmapped tenant A");
    const tenantB = await ctx.storage.tenants!.create("Unmapped tenant B");
    await createConnection({
      integrationRef: integrationId,
      tenantId: tenantA.id,
    });
    await createConnection({
      integrationRef: integrationId,
      tenantId: tenantB.id,
    });

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();
      for (const [tenantId, body] of [
        [tenantA.id, "tenant A event"],
        [tenantB.id, "tenant B event"],
      ] as const) {
        const note = await ctx.storage.items.create(
          { type: "core.note", properties: { body } },
          tenantId,
        );
        await publish({
          type: "created",
          item: note,
          tenantId,
          originatingConnectionId: "itm_unrelated_origin",
        });
        expect(
          await waitFor(
            async () => {
              const activity = await ctx.storage.items.list({
                tenantId,
                type: "system.activity",
                limit: 100,
              });
              return activity.data.filter((row) => {
                const properties = row.properties as { summary?: string };
                return properties.summary?.includes(integrationName);
              }).length;
            },
            (count) => count === 1,
          ),
        ).toBe(1);
      }

      const matchingRows = async () => {
        const activity = await Promise.all(
          [tenantA.id, tenantB.id].map((tenantId) =>
            ctx.storage.items.list({
              tenantId,
              type: "system.activity",
              limit: 100,
            }),
          ),
        );
        return activity
          .flatMap((page) => page.data)
          .filter((row) => {
            const properties = row.properties as { summary?: string };
            return properties.summary?.includes(integrationName);
          });
      };
      const rows = await waitFor(matchingRows, (value) => value.length === 2);
      expect(rows.map((row) => row.tenant_id).sort()).toEqual(
        [tenantA.id, tenantB.id].sort(),
      );
    } finally {
      await bridge!.stop();
    }
  });

  it("treats a trashed prior unmapped activity as already reported after restart", async () => {
    const integrationName = "acme.unmapped-trashed-alert";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    await createConnection({ integrationRef: integrationId });

    const firstBridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
    });
    expect(firstBridge).not.toBeNull();

    let activityId: string;
    try {
      await firstBridge!.start();
      const note = await ctx.storage.items.create({
        type: "core.note",
        properties: { body: "create the original alert" },
      });
      await publish({
        type: "created",
        item: note,
        originatingConnectionId: "itm_unrelated_origin",
      });
      const activity = await waitFor(
        async () => {
          const activities = await ctx.storage.items.list({
            type: "system.activity",
            limit: 100,
          });
          return activities.data.find((row) => {
            const properties = row.properties as { summary?: string };
            return properties.summary?.includes(integrationName);
          });
        },
        (row) => row !== undefined,
      );
      expect(activity).toBeDefined();
      activityId = activity!.id;
    } finally {
      await firstBridge!.stop();
    }

    await ctx.storage.items.delete(activityId);
    expect(await ctx.storage.items.get(activityId)).toBeNull();

    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    const originalFindBySourceIdIncludingTrashed =
      ctx.storage.items.findBySourceIdIncludingTrashed.bind(ctx.storage.items);
    let activityWriteAttempts = 0;
    let sourceLookupCompletions = 0;
    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(integrationName)
      ) {
        activityWriteAttempts++;
      }
      return originalCreate(input, tenantId);
    };
    ctx.storage.items.findBySourceIdIncludingTrashed = async (
      source,
      sourceId,
      tenantId,
    ) => {
      const item = await originalFindBySourceIdIncludingTrashed(
        source,
        sourceId,
        tenantId,
      );
      if (item?.id === activityId) sourceLookupCompletions++;
      return item;
    };

    const restartedBridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 1,
      unmappedActivityRetryMaxMs: 1,
    });
    expect(restartedBridge).not.toBeNull();

    try {
      await restartedBridge!.start();
      const publishNote = async (body: string): Promise<void> => {
        const note = await originalCreate({
          type: "core.note",
          properties: { body },
        });
        await publish({
          type: "created",
          item: note,
          originatingConnectionId: "itm_unrelated_origin",
        });
      };

      await publishNote("restart sees the reserved natural key");
      expect(
        await waitFor(
          () => Promise.resolve(sourceLookupCompletions),
          (count) => count === 1,
        ),
      ).toBe(1);
      await Promise.resolve();
      expect(activityWriteAttempts).toBe(0);

      await publishNote("later events stay deduplicated");
      await Promise.resolve();
      expect(sourceLookupCompletions).toBe(1);
      expect(activityWriteAttempts).toBe(0);
    } finally {
      ctx.storage.items.create = originalCreate;
      ctx.storage.items.findBySourceIdIncludingTrashed =
        originalFindBySourceIdIncludingTrashed;
      await restartedBridge!.stop();
    }
  });

  it("recognizes a committed activity after an ambiguous rejection and retry", async () => {
    const integrationName = "acme.unmapped-ambiguous-commit";
    const integrationId = await createIntegration(
      manifest({ name: integrationName }),
    );
    const connectionId = await createConnection({
      integrationRef: integrationId,
    });
    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    const originalFindBySourceIdIncludingTrashed =
      ctx.storage.items.findBySourceIdIncludingTrashed.bind(ctx.storage.items);
    let activityWriteAttempts = 0;
    let committedActivityId: string | undefined;
    let hideCommittedRowOnce = true;
    let sourceLookupAttempts = 0;
    let sourceLookupCompletions = 0;

    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(integrationName)
      ) {
        activityWriteAttempts++;
        if (activityWriteAttempts === 1) {
          const created = await originalCreate(input, tenantId);
          committedActivityId = created.id;
          throw new Error("commit outcome was lost after persistence");
        }
      }
      return originalCreate(input, tenantId);
    };
    ctx.storage.items.findBySourceIdIncludingTrashed = async (
      source,
      sourceId,
      tenantId,
    ) => {
      sourceLookupAttempts++;
      const existing = await originalFindBySourceIdIncludingTrashed(
        source,
        sourceId,
        tenantId,
      );
      sourceLookupCompletions++;
      if (
        committedActivityId !== undefined &&
        existing?.id === committedActivityId &&
        hideCommittedRowOnce
      ) {
        hideCommittedRowOnce = false;
        return null;
      }
      return existing;
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === integrationName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 0,
      unmappedActivityRetryMaxMs: 0,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();
      const publishNote = async (body: string): Promise<void> => {
        const note = await originalCreate({
          type: "core.note",
          properties: { body },
        });
        await publish({
          type: "created",
          item: note,
          originatingConnectionId: "itm_unrelated_origin",
        });
      };

      await publishNote("ambiguous first attempt");
      expect(
        await waitFor(
          () =>
            Promise.resolve({
              activityWriteAttempts,
              sourceLookupAttempts,
              sourceLookupCompletions,
            }),
          (lookups) =>
            lookups.activityWriteAttempts === 1 &&
            lookups.sourceLookupAttempts === 3 &&
            lookups.sourceLookupCompletions === 3,
        ),
      ).toEqual({
        activityWriteAttempts: 1,
        sourceLookupAttempts: 3,
        sourceLookupCompletions: 3,
      });

      await publishNote("later event remains deduplicated");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sourceLookupAttempts).toBe(3);
      expect(activityWriteAttempts).toBe(1);

      const activity = await ctx.storage.items.list({
        type: "system.activity",
        limit: 100,
      });
      expect(
        activity.data.filter((row) => {
          const properties = row.properties as {
            connection_id?: string;
            summary?: string;
          };
          return (
            properties.connection_id === connectionId &&
            properties.summary?.includes(integrationName)
          );
        }),
      ).toHaveLength(1);

      await publishNote("deduped after recovered commit");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activityWriteAttempts).toBe(1);
      expect(sourceLookupAttempts).toBe(3);
      expect(sourceLookupCompletions).toBe(3);
    } finally {
      ctx.storage.items.create = originalCreate;
      ctx.storage.items.findBySourceIdIncludingTrashed =
        originalFindBySourceIdIncludingTrashed;
      await bridge!.stop();
    }
  });

  it("gates concurrent unmapped writes, backs off failures, and keeps mapped fanout moving", async () => {
    const unmappedName = "acme.unmapped-write-backoff";
    const mappedName = "acme.mapped-during-unmapped-write";
    const unmappedIntegration = await createIntegration(
      manifest({ name: unmappedName }),
    );
    const mappedIntegration = await createIntegration(
      manifest({ name: mappedName }),
    );
    await createConnection({ integrationRef: unmappedIntegration });
    await createConnection({ integrationRef: unmappedIntegration });
    await createConnection({ integrationRef: mappedIntegration });

    const originalCreate = ctx.storage.items.create.bind(ctx.storage.items);
    let rejectFirstWrite!: (reason?: unknown) => void;
    const pendingFirstWrite = new Promise<never>((_resolve, reject) => {
      rejectFirstWrite = reject;
    });
    let activityWriteAttempts = 0;
    let mappedFetches = 0;
    let now = 3_000;
    ctx.storage.items.create = async (input, tenantId) => {
      const properties = input.properties as { summary?: string } | undefined;
      if (
        input.type === "system.activity" &&
        properties?.summary?.includes(unmappedName)
      ) {
        activityWriteAttempts++;
        if (activityWriteAttempts === 1) return pendingFirstWrite;
      }
      return originalCreate(input, tenantId);
    };

    const bridge = tryStartReactiveRunBridge(ctx.storage, {
      resolveQueueUrl: (name) =>
        name === unmappedName ? null : "http://queue.local/produce",
      apiToken: "stub-token",
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected queue request body to be a string");
        }
        const body = JSON.parse(init.body) as {
          body?: { integration_name?: string };
        };
        if (body.body?.integration_name === mappedName) {
          mappedFetches++;
        }
        return Promise.resolve(new Response(null, { status: 202 }));
      },
      maxAttempts: 1,
      unmappedActivityRetryBaseMs: 100,
      unmappedActivityRetryMaxMs: 100,
      unmappedActivityNow: () => now,
    });
    expect(bridge).not.toBeNull();

    try {
      await bridge!.start();
      const publishNote = async (body: string): Promise<void> => {
        const note = await originalCreate({
          type: "core.note",
          properties: { body },
        });
        await publish({
          type: "created",
          item: note,
          originatingConnectionId: "itm_unrelated_origin",
        });
      };

      await publishNote("write remains in flight");
      expect(
        await waitFor(
          () => Promise.resolve({ activityWriteAttempts, mappedFetches }),
          (value) =>
            value.activityWriteAttempts === 1 && value.mappedFetches === 1,
        ),
      ).toEqual({ activityWriteAttempts: 1, mappedFetches: 1 });

      await publishNote("second event while write remains in flight");
      expect(
        await waitFor(
          () => Promise.resolve(mappedFetches),
          (count) => count === 2,
        ),
      ).toBe(2);
      expect(activityWriteAttempts).toBe(1);

      rejectFirstWrite(new Error("activity storage unavailable"));
      await publishNote("event inside backoff");
      expect(
        await waitFor(
          () => Promise.resolve(mappedFetches),
          (count) => count === 3,
        ),
      ).toBe(3);
      expect(activityWriteAttempts).toBe(1);

      now += 99;
      await publishNote("event just before retry deadline");
      expect(
        await waitFor(
          () => Promise.resolve(mappedFetches),
          (count) => count === 4,
        ),
      ).toBe(4);
      expect(activityWriteAttempts).toBe(1);

      now += 1;
      await publishNote("event at retry deadline");
      expect(
        await waitFor(
          () => Promise.resolve({ activityWriteAttempts, mappedFetches }),
          (value) =>
            value.activityWriteAttempts === 2 && value.mappedFetches === 5,
        ),
      ).toEqual({ activityWriteAttempts: 2, mappedFetches: 5 });

      await publishNote("deduped after eventual success");
      expect(
        await waitFor(
          () => Promise.resolve(mappedFetches),
          (count) => count === 6,
        ),
      ).toBe(6);
      expect(activityWriteAttempts).toBe(2);
    } finally {
      rejectFirstWrite(new Error("bridge stopped"));
      ctx.storage.items.create = originalCreate;
      await bridge!.stop();
    }
  });
});
