/**
 * Frames that wait behind an edge frame's send go out in id order, on the
 * live pump and out of the prologue's hold alike, and a send that fails
 * while the hold is released ends the stream naming the last id sent.
 *
 * An edge frame is sent only after a read of its source, and neither path
 * takes another frame until that send has settled. Everything published
 * in the meantime waits: in the subscription's queue on the live pump, in
 * the hold during the prologue. These are the two places a queue holds
 * more than a frame at a time, so they are the two places the order it
 * hands them on in can be seen. The purge test lets every read finish at
 * once; here the first read is held open by the test until the later
 * writes have been published, or the prologue is held by a gated log
 * while the writes go in, and only then let go.
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
  request,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

/**
 * How the next edge frame's source read behaves. `pass` is the real read;
 * `hold` waits on the gate before the real read; `reject` fails it. Only
 * the first read after a mode is set is affected, so a test can shape one
 * send and leave the rest real.
 */
const nextRead = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const state = {
    mode: "pass" as "pass" | "hold" | "reject",
    taken: false,
    opened: Promise.resolve(),
    release: (): void => undefined,
    arm(mode: "hold" | "reject") {
      state.mode = mode;
      state.taken = false;
      state.opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.release = () => {
        release();
      };
    },
    reset() {
      state.mode = "pass";
      state.taken = false;
      release();
    },
  };
  return state;
});

vi.mock("./_edge-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_edge-visibility.js")>();
  return {
    ...actual,
    // One read shaped by the test, every other one real, so what is under
    // test is the order the route keeps around a send that is slow or
    // fails, not the read itself.
    edgeReadable: async (
      ...args: Parameters<typeof actual.edgeReadable>
    ): Promise<boolean> => {
      if (nextRead.mode !== "pass" && !nextRead.taken) {
        nextRead.taken = true;
        if (nextRead.mode === "reject") {
          throw new Error("the source read failed");
        }
        await nextRead.opened;
      }
      return actual.edgeReadable(...args);
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

describe("the live pump with an edge send outstanding", () => {
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
    let writes: Promise<void> | undefined;
    const write = async (): Promise<void> => {
      // The first edge's send is held. Everything after it is published
      // while the pump waits, so it queues: two items, an edge, an item,
      // another edge, and a sentinel item to read up to.
      await edge(a, b);
      await settle();
      expect(nextRead.taken, "the first edge's read was not held").toBe(true);
      await note("live-hold-1");
      await note("live-hold-2");
      await edge(b, c);
      await note("live-hold-3");
      await edge(c, a);
      sentinel = await note("live-hold-sentinel");
      nextRead.release();
    };
    const { text } = await readSse(res, {
      onChunk: (seen) => {
        if (writes === undefined && seen.includes(probe)) writes = write();
      },
      until: (seen) => sentinel !== "" && seen.includes(sentinel),
    });
    await writes;

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

    const { storage, open } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(storage, {
      edge_permissions: { "*": "read" },
    }).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    // Lets the prologue reach the gate, so everything written below is
    // held rather than delivered live. A write that got in first would
    // be replayed rather than held, and the order assertions below would
    // then be about the replay, which is why the announcement's position
    // is checked against the first edge frame and not the first frame.
    await settle();

    await edge(a, b);
    await note("prologue-hold-item");
    await edge(b, c);
    const sentinel = await note("prologue-hold-sentinel");
    await settle();
    open();

    const { text } = await readSse(res, {
      until: (seen) => seen.includes(sentinel),
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
  });

  it("ends the stream naming the last id sent when an edge send fails during the release", async () => {
    const a = await note("release-fail-a");
    const b = await note("release-fail-b");
    const cursor = await ctx.storage.eventLog.getMaxId();

    const { storage, open } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(storage, {
      edge_permissions: { "*": "read" },
    }).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    await settle();

    // The item is sent from the hold first, so the cursor the failure
    // names has a position to be: the last frame the client received.
    const item = await note("release-fail-item");
    const itemId = await ctx.storage.eventLog.getMaxId();
    nextRead.arm("reject");
    await edge(a, b);
    await settle();
    open();

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain(item);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"edge_delivery_failed"');
    expect(text).toContain(`"cursor":"${String(itemId)}"`);
  });
});
