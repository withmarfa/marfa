/**
 * Space isolation on the live SSE path. Since live delivery stopped
 * holding a database connection, the application fence — the
 * subscription's space filter plus the caller's type projection — is the
 * ONLY thing between a viewer and another space's events, so it gets its
 * own suite: a scoped viewer must never receive a sibling space's item
 * or edge event, nor a space-less one, while a platform viewer (no
 * space) deliberately sees everything. Mirrors export.space-scoping.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ApiKey } from "@withmarfa/shared";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { emitWake, type ItemEventWithId } from "../pubsub.js";
import { eventRoutes } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function keyFor(spaceId: string | undefined): ApiKey {
  return {
    id: `key_${spaceId ?? "platform"}`,
    name: "events scoping",
    key_hash: "unused",
    space_id: spaceId,
    is_operator: spaceId === undefined,
    type_permissions: { "*": "read" },
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
  } as unknown as ApiKey;
}

function makeApp(spaceId: string | undefined): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", keyFor(spaceId));
    await next();
  });
  app.route("/events", eventRoutes(ctx.storage, {}));
  return app;
}

function itemEvent(id: string, spaceId: string | undefined): void {
  emitWake({
    type: "created",
    item: {
      id,
      type: "core.note",
      properties: {},
    } as unknown as ItemEventWithId["item"],
    ...(spaceId !== undefined && { spaceId }),
  });
}

function edgeEvent(id: string, spaceId: string | undefined): void {
  emitWake({
    type: "edge_created",
    edge: {
      id,
      edge_type: "references",
      source_id: "src",
      target_id: "tgt",
    } as unknown as import("../pubsub.js").EdgeEventWithId["edge"],
    ...(spaceId !== undefined && { spaceId }),
  });
}

/** Open a stream, fire the events, read until the marker or deadline. */
async function collect(app: Hono<AppEnv>, fire: () => void): Promise<string> {
  const res = await app.request("/events");
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  try {
    // First chunk is the ": connected" flush; events fire after the
    // subscription is live.
    const first = await reader.read();
    if (first.value) received += decoder.decode(first.value);
    fire();
    // The marker event is emitted last by every caller, so reading up
    // to it proves everything fired before it was or was not delivered.
    while (!received.includes("scope-marker")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
          setTimeout(() => {
            r({ done: false });
          }, 250),
        ),
      ]);
      if (chunk.value) received += decoder.decode(chunk.value);
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel();
  }
  return received;
}

describe("GET /events — live-path space isolation", () => {
  it("a scoped viewer receives its own space's events and nothing else", async () => {
    const app = makeApp("space-a");
    const received = await collect(app, () => {
      itemEvent("evt-own-space", "space-a");
      itemEvent("evt-other-space", "space-b");
      itemEvent("evt-no-space", undefined);
      edgeEvent("edge-other-space", "space-b");
      edgeEvent("edge-no-space", undefined);
      // Own-space marker last: its arrival proves delivery ordering has
      // flushed everything above.
      itemEvent("scope-marker", "space-a");
    });
    expect(received).toContain("evt-own-space");
    expect(received).toContain("scope-marker");
    expect(received).not.toContain("evt-other-space");
    expect(received).not.toContain("evt-no-space");
    expect(received).not.toContain("edge-other-space");
    expect(received).not.toContain("edge-no-space");
  }, 30_000);

  it("a scoped viewer receives its own space's edge events", async () => {
    const app = makeApp("space-a");
    const received = await collect(app, () => {
      edgeEvent("edge-own-space", "space-a");
      itemEvent("scope-marker", "space-a");
    });
    expect(received).toContain("edge-own-space");
  }, 30_000);

  it("a platform viewer with no space sees every space's events", async () => {
    const app = makeApp(undefined);
    const received = await collect(app, () => {
      itemEvent("evt-a", "space-a");
      itemEvent("evt-b", "space-b");
      itemEvent("evt-none", undefined);
      edgeEvent("edge-b", "space-b");
      itemEvent("scope-marker", undefined);
    });
    expect(received).toContain("evt-a");
    expect(received).toContain("evt-b");
    expect(received).toContain("evt-none");
    expect(received).toContain("edge-b");
  }, 30_000);
});
