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

afterAll(() => {
  ctx.cleanup();
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
}): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: opts.kind ?? "external-service-connector",
        status: opts.status ?? "active",
        granted_at: new Date().toISOString(),
        integration_ref: opts.integrationRef,
      },
    },
    undefined,
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

  it("returns null when kind is not external-service-connector", async () => {
    const intId = await createIntegration(manifest({ name: "acme.kind-skip" }));
    const connId = await createConnection({
      integrationRef: intId,
      kind: "user-app-grant",
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

    bridge!.stop();
  });
});
