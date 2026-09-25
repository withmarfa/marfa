/**
 * An edge frame that cannot be sent is the whole stream failing, not half
 * of it going quiet.
 *
 * An edge frame is written only after a read that decides whether the
 * subscriber may see it. A failure there, swallowed, would end edge
 * delivery while item delivery carried on over the same connection: the
 * client would keep receiving events and never learn it had stopped
 * hearing about relationships. Half a stream that looks whole is the one
 * shape a durable client cannot detect, which is what makes silence the
 * wrong default even though the failure is a rare one.
 *
 * No throw path in that read was identified in the tree, so the rejection
 * is injected. That is the point rather than a weakness of the test:
 * unreachable today is a property of the current callers, and the handler
 * is what decides what happens when one of them changes.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createTestContext, readSse, request, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.mock("./_edge-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_edge-visibility.js")>();
  return {
    ...actual,
    // Everything else stays real: what is under test is one rejection on
    // the live path, not a reimplementation of the module.
    edgeReadable: () => Promise.reject(new Error("the source read failed")),
  };
});

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("a non-abort failure sending an edge frame", () => {
  it("tells the client and closes, instead of continuing quietly", async () => {
    const source = await note("edge-failure-source");
    const target = await note("edge-failure-target");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    // Past the prologue, so the edge below is sent live rather than held.
    await settle();
    await settle();

    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: target, edge_type: "references" },
    });
    expect(edge.status).toBe(201);

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"edge_delivery_failed"');
  });
});
