/**
 * Tearing a connection's credential down announces the edges it takes.
 *
 * An uninstall removes real relationships, and the items on the other end
 * of them are ordinary rows a client is holding. The teardown deleted
 * both directions and published nothing, so a device went on showing a
 * connection's edges after the connection was gone — and nothing later
 * repaired it, because the rows are absent rather than changed.
 *
 * Driven against `purgeCredential` directly rather than through the
 * uninstall route: the function is the door, the route is one caller of
 * it, and the pipeline around it needs an OAuth fixture that would test
 * the fixture more than the behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, nextEdgeEvent } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { purgeCredential } from "./upstream-credential.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("purgeCredential", () => {
  it("announces every edge it removes, in both directions", async () => {
    const credential = await ctx.storage.items.create(
      {
        type: "system.credential",
        properties: { label: "upstream", kind: "oauth_token" },
      },
      undefined,
    );
    const neighbour = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "a neighbour" } },
      undefined,
    );

    // One edge each way. The inbound one is the case that cannot be
    // inferred from the credential's own removal: it lives on `neighbour`,
    // which is not being purged and hears nothing else at all.
    const outbound = await ctx.storage.edges.createRaw(
      {
        source_id: credential.id,
        target_id: neighbour.id,
        edge_type: "references",
      },
      undefined,
    );
    const inbound = await ctx.storage.edges.createRaw(
      {
        source_id: neighbour.id,
        target_id: credential.id,
        edge_type: "references",
      },
      undefined,
    );

    // Both awaited rather than slept for: each assertion is that a
    // specific event arrives, which is exactly what `nextEdgeEvent` is
    // for, and vitest's budget owns the wait.
    const outboundHeard = nextEdgeEvent(
      (e) => e.type === "edge_deleted" && e.edge.id === outbound.id,
    );
    const inboundHeard = nextEdgeEvent(
      (e) => e.type === "edge_deleted" && e.edge.id === inbound.id,
    );

    await purgeCredential(ctx.storage, credential, undefined);

    expect((await outboundHeard).edge.source_id).toBe(credential.id);
    expect((await inboundHeard).edge.target_id).toBe(credential.id);
  });
});
