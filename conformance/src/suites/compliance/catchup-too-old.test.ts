import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { openEventStream, parseSse } from "../../utils/sse.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "catchup-too-old",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Drain an SSE response to completion. The server is expected to close the
 * stream after emitting the terminal event, so this resolves on that close;
 * a server that never closes it is caught by the suite's own test timeout
 * rather than by a bound in this helper.
 */
async function drainSse(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const collected: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) collected.push(decoder.decode(value, { stream: true }));
  }
  return collected.join("");
}

describe("catchup_too_old terminal event", () => {
  it("emits catchup_too_old when Last-Event-ID predates min retained id", async () => {
    // Ensure the event log has at least one entry. `Last-Event-ID: 0`
    // is strictly less than any server-assigned id (which are monotonically
    // positive, >= 1), so once any event exists the afterId < minRetained
    // predicate fires deterministically.
    const seed = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "catchup-seed" } }),
    );
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    // Subscriptions always go through openEventStream so the suite has one
    // way of opening a stream, and so no future edit that adds a write
    // alongside an open stream deadlocks. See the helper for why.
    const stream = await openEventStream(apiUrl, apiKey, { lastEventId: "0" });
    expect(stream.response.status).toBe(200);

    const raw = await drainSse(stream.response);
    await stream.close();

    const events = parseSse(raw);
    const terminal = events.find((e) => e.event === "catchup_too_old");
    expect(terminal).toBeDefined();

    // The server emits ids as strings on the wire (event ids are bigints
    // server-side; JSON has no native bigint, so they serialize as strings).
    // Conformance asserts the wire shape, not the in-memory type.
    const payload = terminal!.data as {
      type: string;
      min_retained_id: string;
      requested: string;
    };
    expect(payload.type).toBe("catchup_too_old");
    expect(typeof payload.min_retained_id).toBe("string");
    expect(Number(payload.min_retained_id)).toBeGreaterThanOrEqual(1);
    expect(payload.requested).toBe("0");

    // The server is specified to close the stream immediately after emitting
    // the terminal event — no trailing events should follow in the same stream.
    const terminalIdx = events.indexOf(terminal!);
    expect(events.slice(terminalIdx + 1)).toHaveLength(0);
  });
});
