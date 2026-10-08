/**
 * Frames that wait behind a credential read go out in id order, on the
 * live pump and out of the prologue's hold alike, and a read that fails
 * while the hold is released ends the stream.
 *
 * A batch of frames is delivered only after the stream reads its
 * credential again, and neither path takes another frame until that read
 * has settled. Everything published in the meantime waits: in the
 * subscription's queue on the live pump, in the hold during the prologue.
 * These are the two places a queue holds more than a frame at a time, so
 * they are the two places the order it hands them on in can be seen. Here
 * a read is held open by the test until the later writes have been
 * published, or the prologue is held by a gated log while the writes go
 * in, and only then let go.
 */
import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import {
  createTestContext,
  eventsAppWithKey,
  gatedEventLog,
  readSse,
  readSseWriting,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  __resetEventLogForTests,
  emitWake,
  initEventLog,
  type ItemEventWithId,
} from "../pubsub.js";

/**
 * How the stream's next credential read behaves. `pass` is the real read;
 * `hold` waits on the gate before the real read, and `held` settles the
 * moment it is waiting, which is the observation that the send is
 * outstanding; `reject` fails it. Only the first read after a mode is set
 * is affected, so a test can shape one send and leave the rest real.
 */
const nextRead = vi.hoisted(() => {
  let release: () => void = () => undefined;
  let taken: () => void = () => undefined;
  const state = {
    mode: "pass" as "pass" | "hold" | "reject",
    used: false,
    opened: Promise.resolve(),
    held: Promise.resolve(),
    release: (): void => undefined,
    arm(mode: "hold" | "reject") {
      state.mode = mode;
      state.used = false;
      state.opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.held = new Promise<void>((resolve) => {
        taken = resolve;
      });
      state.release = () => {
        release();
      };
    },
    take() {
      taken();
    },
    reset() {
      state.mode = "pass";
      state.used = false;
      release();
    },
  };
  return state;
});

vi.mock("../auth/live-credential.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auth/live-credential.js")>();
  return {
    ...actual,
    // One read shaped by the test, every other one real, so what is under
    // test is the order the route keeps around a read that is slow or
    // fails, not the read itself.
    resolveLiveCredential: async (
      ...args: Parameters<typeof actual.resolveLiveCredential>
    ): ReturnType<typeof actual.resolveLiveCredential> => {
      if (nextRead.mode !== "pass" && !nextRead.used) {
        nextRead.used = true;
        if (nextRead.mode === "reject") {
          throw new Error("the credential read failed");
        }
        nextRead.take();
        await nextRead.opened;
      }
      return actual.resolveLiveCredential(...args);
    },
  };
});

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Frames carry an `id:` only when the log records them.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

afterEach(() => {
  nextRead.reset();
});

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function edge(source: string, target: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { source_id: source, target_id: target, edge_type: "references" },
  });
  expect(res.status).toBe(201);
}

/** The `id:` of every frame in the text, in the order they were written. */
function frameIds(text: string): bigint[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => BigInt(match[1]!));
}

function expectAscending(ids: bigint[]): void {
  for (let i = 1; i < ids.length; i += 1) {
    expect(
      ids[i]! > ids[i - 1]!,
      `frames arrived out of id order: ${ids.join(", ")}`,
    ).toBe(true);
  }
}

const count = (text: string, needle: string): number =>
  text.split(needle).length - 1;

describe("the live pump with a credential read outstanding", () => {
  it("delivers the frames that queued behind it in id order", async () => {
    const a = await note("live-hold-a");
    const b = await note("live-hold-b");
    const c = await note("live-hold-c");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);

    // The writes are issued from inside the read, once the probe's frame
    // has arrived: a frame delivered means the prologue has released its
    // hold, since the release flips the flag with no await after the
    // last frame it sends, so everything published after it takes the
    // live path. Observed rather than waited for.
    const probe = await note("live-hold-probe");
    nextRead.arm("hold");
    let sentinel = "";
    const { text } = await readSseWriting(
      res,
      probe,
      async () => {
        // The read before the first edge's batch is held. Everything after
        // it is published while the pump waits, so it queues: two items,
        // an edge, an item, another edge, and a sentinel item to read up
        // to.
        await edge(a, b);
        await nextRead.held;
        await note("live-hold-1");
        await note("live-hold-2");
        await edge(b, c);
        await note("live-hold-3");
        await edge(c, a);
        sentinel = await note("live-hold-sentinel");
        nextRead.release();
      },
      (seen) => sentinel !== "" && seen.includes(sentinel),
    );

    // From the probe's frame on: what was published after the hold was
    // seen to be released.
    const live = text.slice(text.lastIndexOf("\nid: ", text.indexOf(probe)));
    expect(count(live, '"edge.created"')).toBe(3);
    expect(count(live, '"item.created"')).toBe(5);
    const ids = frameIds(live);
    expect(ids).toHaveLength(8);
    expectAscending(ids);
  });
});

describe("the prologue's hold", () => {
  it("releases edge and item frames in id order, after the announcement", async () => {
    const a = await note("prologue-hold-a");
    const b = await note("prologue-hold-b");
    const c = await note("prologue-hold-c");
    const cursor = await ctx.storage.eventLog.getMaxId();

    const { storage, open, reached } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(ctx, storage, {
      edge_permissions: { "*": "read" },
    }).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    // The prologue has asked for its replay and is waiting on the gate,
    // so the subscription is attached and every write below is held.
    await reached;

    await edge(a, b);
    await note("prologue-hold-item");
    await edge(b, c);
    const sentinel = await note("prologue-hold-sentinel");
    open();

    const { text } = await readSse(res, {
      until: (seen) =>
        seen.includes(sentinel) && seen.includes("event: stream_live"),
    });
    expect(count(text, '"edge.created"')).toBe(2);
    expect(count(text, '"item.created"')).toBe(2);
    const announcedAt = text.indexOf("event: stream_cursor");
    expect(announcedAt).toBeGreaterThanOrEqual(0);
    expect(announcedAt).toBeLessThan(text.indexOf("event: edge.created"));
    const ids = frameIds(text);
    expect(ids).toHaveLength(4);
    expect(ids[0]! > cursor!).toBe(true);
    expectAscending(ids);
    // The marker follows the drained frames and names the last of them,
    // past the announced head: a reader resuming from the head alone
    // would be sent them again.
    const live = text.indexOf("event: stream_live");
    expect(live).toBeGreaterThan(text.lastIndexOf("event: item.created"));
    expect(text.slice(live)).toContain(`"cursor":"${String(ids[3]!)}"`);
  });

  it("names a cursor that covers every frame before the marker and none after, however the gate and a publish align", async () => {
    // A frame published as the gate opens is either held and drained
    // before the marker or sent live after it, and which depends on how
    // many awaits the replay's last step takes against the pump's own.
    // Swept over a few tick offsets between the publish and the gate so
    // that both alignments are seen, and the sweep says so: a run in
    // which every tick landed on one side would prove the cursor right
    // for that side alone.
    const alignments = new Set<"held" | "live">();
    for (let ticks = 0; ticks < 4; ticks += 1) {
      // Seeded, so the cursor names a real position and the replay runs.
      await note(`gate-open-seed-${String(ticks)}`);
      const from = await ctx.storage.eventLog.getMaxId();
      const { storage, open, reached } = gatedEventLog(ctx.storage);
      const res = await eventsAppWithKey(ctx, storage).request("/events", {
        headers: { "Last-Event-ID": String(from) },
      });
      expect(res.status).toBe(200);
      await reached;

      const marker = `ZZgateopen${String(ticks)}ZZ`;
      emitWake({
        type: "created",
        eventId: 10_000_000n + BigInt(ticks),
        item: {
          id: marker,
          type: "core.note",
          properties: {},
        } as unknown as ItemEventWithId["item"],
      });
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      open();

      const { text } = await readSse(res, {
        until: (seen) =>
          seen.includes("event: stream_live") && seen.includes(marker),
      });
      // Whichever side the frame landed, the marker's cursor covers
      // everything before it and nothing after, so a reader adopting it
      // is neither sent a frame again nor skips one.
      const at = text.indexOf("event: stream_live");
      expect(at).toBeGreaterThanOrEqual(0);
      alignments.add(text.indexOf(marker) < at ? "held" : "live");
      const cursor = BigInt(
        /"cursor":"(\d+)"/.exec(text.slice(at))?.[1] ?? "-1",
      );
      for (const id of frameIds(text.slice(0, at))) {
        expect(
          id <= cursor,
          `at ${String(ticks)} ticks, a frame before the marker carries ${String(id)}, past its cursor ${String(cursor)}`,
        ).toBe(true);
      }
      for (const id of frameIds(text.slice(at))) {
        expect(
          id > cursor,
          `at ${String(ticks)} ticks, a frame after the marker carries ${String(id)}, inside its cursor ${String(cursor)}`,
        ).toBe(true);
      }
    }
    expect(
      [...alignments].sort(),
      "the sweep has to see the frame on both sides of the marker",
    ).toEqual(["held", "live"]);
  });

  it("names a drained edge frame past the head when it is the last frame before the marker", async () => {
    // The marker's cursor is the furthest id written, and an edge frame
    // drained from the hold is written by its own path, so that path has
    // to record it too: a cursor stopping at the head would have a
    // resuming reader sent the edge again.
    const a = await note("drained-edge-a");
    const b = await note("drained-edge-b");
    const cursor = await ctx.storage.eventLog.getMaxId();

    const { storage, open, reached } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(ctx, storage, {
      edge_permissions: { "*": "read" },
    }).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    await reached;

    await edge(a, b);
    const edgeId = await ctx.storage.eventLog.getMaxId();
    expect(edgeId! > cursor!).toBe(true);
    open();

    const { text } = await readSse(res, {
      until: (seen) => seen.includes("event: stream_live"),
    });
    expect(count(text, '"edge.created"')).toBe(1);
    expect(frameIds(text)).toEqual([edgeId!]);
    const live = text.indexOf("event: stream_live");
    expect(live).toBeGreaterThan(text.indexOf("event: edge.created"));
    expect(text.slice(live)).toContain(`"cursor":"${String(edgeId!)}"`);
  });

  it("keeps holding while the release waits on a credential read", async () => {
    // The release drains the hold with the flag still up, so a frame
    // published while it waits on the credential read joins the back of
    // the buffer rather than being sent past the edge. A release that
    // dropped the flag first would send that frame at once, and it would
    // reach the client ahead of an edge published before it.
    const a = await note("release-wait-a");
    const b = await note("release-wait-b");
    const cursor = await ctx.storage.eventLog.getMaxId();

    const { storage, open, reached } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(ctx, storage, {
      edge_permissions: { "*": "read" },
    }).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    await reached;

    nextRead.arm("hold");
    await edge(a, b);
    open();
    // The release is now waiting on the held credential read.
    await nextRead.held;
    const during = await note("release-wait-during");
    nextRead.release();

    const { text } = await readSse(res, {
      until: (seen) => seen.includes(during),
    });
    expect(count(text, '"edge.created"')).toBe(1);
    expect(text.indexOf("event: edge.created")).toBeLessThan(
      text.indexOf(during),
    );
    const ids = frameIds(text);
    expect(ids).toHaveLength(2);
    expectAscending(ids);
  });

  it("ends the stream when the credential cannot be read during the release", async () => {
    const a = await note("release-fail-a");
    const b = await note("release-fail-b");
    const cursor = await ctx.storage.eventLog.getMaxId();

    const { storage, open, reached } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(ctx, storage, {
      edge_permissions: { "*": "read" },
    }).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    await reached;

    // Both held frames wait on one read, so a read that fails sends
    // neither, and the cursor names no position this stream reached.
    const item = await note("release-fail-item");
    nextRead.arm("reject");
    await edge(a, b);
    open();

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).not.toContain(item);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"live_delivery_failed"');
    expect(text).toContain('"cursor":null');
    // A drain that failed never finished the prologue, so the stream is
    // not said to be live; the tests above are the witness that a drain
    // which finishes is followed by the marker.
    expect(text).not.toContain("event: stream_live");
  });
});
