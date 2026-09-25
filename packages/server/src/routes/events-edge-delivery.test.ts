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
import { createTestContext, readSseWriting, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

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
  // Frames carry an `id:` only when the log records them, and the cursor
  // the failure names is one of those ids.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
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

    // The edge is written from inside the read, once the probe's frame
    // has arrived: a frame delivered means the prologue has released its
    // hold, so the edge takes the live path rather than the release path
    // that reports the same reason. The probe's frame is also the last
    // one sent before the failure, so it is the cursor the failure names.
    const probe = await note("edge-failure-probe");
    const probeId = await ctx.storage.eventLog.getMaxId();
    const write = async (): Promise<void> => {
      const edge = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: source,
          target_id: target,
          edge_type: "references",
        },
      });
      expect(edge.status).toBe(201);
    };
    const { text, closed } = await readSseWriting(res, probe, write, {
      untilClosed: true,
    });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"edge_delivery_failed"');
    // Where to reconnect from: the last frame delivered, not the edge
    // that never was.
    expect(text).toContain(`"cursor":"${String(probeId)}"`);
  });
});
