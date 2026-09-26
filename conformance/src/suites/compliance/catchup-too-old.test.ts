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
 * Read an SSE response until `done` holds of what has arrived, or the
 * stream closes. Bounded, because a stream that replays and then goes live
 * never closes on its own, and a read waiting for a close would spend the
 * whole test budget saying nothing about why.
 */
async function readUntil(
  response: Response,
  done: (text: string) => boolean,
  budgetMs = 30_000,
): Promise<{ text: string; closed: boolean }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const outOfTime = Symbol("out of time");
  let text = "";
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (done(text)) return { text, closed: false };
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<typeof outOfTime>((resolve) =>
        setTimeout(() => resolve(outOfTime), Math.max(remaining, 0)),
      ),
    ]);
    if (next === outOfTime) {
      throw new Error(
        `the stream delivered nothing that satisfied the read within ${String(budgetMs)}ms; it had sent:\n${text.slice(-2000)}`,
      );
    }
    if (next.done) return { text, closed: true };
    text += decoder.decode(next.value, { stream: true });
  }
}

describe("the cursor a catch-up resumes from", () => {
  it("replays from a cursor of zero when the log begins at one", async () => {
    // `Last-Event-ID: 0` is what a device holds after hydrating an instance
    // whose log was empty: the head cursor it took was `0`. The first write
    // after that is event `1`, and a device resuming from `0` has missed
    // nothing, so the answer is the replay and not the refusal. A server
    // comparing the cursor itself against its oldest id refuses exactly
    // this, which is why the boundary is the case worth pinning.
    //
    // The premise is that this run's server still holds event `1`. It does:
    // the server is booted for the run and retains events for hours, and a
    // run lasts minutes. The stale case itself cannot be arranged over the
    // wire: a request can run the retention sweep but cannot make an event
    // older than the shortest retention, an hour; `events.md` 3 says where
    // it is asserted.
    const seed = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "catchup-seed" } }),
    );
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const seededId = seed.data.item.id;

    // Subscriptions always go through openEventStream so the suite has one
    // way of opening a stream, and so no future edit that adds a write
    // alongside an open stream deadlocks. See the helper for why.
    const stream = await openEventStream(apiUrl, apiKey, { lastEventId: "0" });
    expect(stream.response.status).toBe(200);

    // The replay covers the whole log from `1`, so the read stops at the
    // seeded item's own event, or at the refusal that would end the stream
    // before it. Closed whatever the read did, so a read that ran out of
    // time does not leave the subscription open into the next file.
    //
    // **The predicate parses rather than searching the text.** A chunk
    // boundary can fall inside the frame that carries the id, and
    // `t.includes(seededId)` is then true of a frame `parseSse` drops as
    // incomplete — so the read stopped one chunk early and the assertion
    // below looked for an event that had not arrived whole. It is a race
    // against the log's length, which is why it surfaced on a busy host
    // and not on a quiet one. Asking the predicate the same question the
    // assertion asks removes the gap between them.
    let text: string;
    try {
      ({ text } = await readUntil(
        stream.response,
        (t) =>
          parseSse(t).some(
            (e) =>
              e.event === "item.created" &&
              (e.data as { item?: { id?: string } }).item?.id === seededId,
          ) || t.includes("event: catchup_too_old"),
      ));
    } finally {
      await stream.close();
    }

    const events = parseSse(text);
    expect(events.find((e) => e.event === "catchup_too_old")).toBeUndefined();
    // The replay began at the log's first event. This is what makes the
    // cursor the boundary rather than merely a cursor within retention: a
    // resume from `0` that started anywhere later would pass the two
    // assertions around it while asserting nothing about `0`, and it also
    // probes the premise above instead of reading it, because a log that
    // had lost event `1` could not replay it.
    expect(
      events.some((e) => e.id === "1"),
      "the replay from cursor 0 did not deliver event 1, so either the log no longer begins at 1 or the resume started later than the cursor",
    ).toBe(true);
    const replayed = events.find(
      (e) =>
        e.event === "item.created" &&
        (e.data as { item?: { id?: string } }).item?.id === seededId,
    );
    expect(replayed).toBeDefined();
  });
});
