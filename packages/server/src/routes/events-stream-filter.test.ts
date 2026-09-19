/**
 * What `GET /events` delivers, decided once and asserted on both paths.
 *
 * Three properties, and they are one file because they are one decision.
 * A subscriber's `?type=` may name several types; a named type covers its
 * subtree; and an edge event reaches a filtered subscriber unless it says
 * `edges=none`. Whether a frame goes out is a property of the stream, not
 * of the code path the frame happens to arrive on.
 *
 * **The two paths are two different pieces of code**, and this repository
 * has already shipped a defect where they disagreed: the live stream
 * resolved `?type=` as a subtree while the `Last-Event-ID` replay compared
 * the stored string, so a subscriber narrowing to a parent type received a
 * subtype while connected and lost it on every reconnect. Nothing told the
 * client: replay reports no error and closes no stream, so the events
 * simply are not there.
 *
 * So the case table below is written once and run through both paths. A
 * rule reintroduced inline on either side changes that side's verdict on a
 * case the other side still answers correctly, and the assertion names the
 * case rather than reporting a bare gap.
 *
 * `events-type-filter.test.ts` is the sibling that pins the same agreement
 * for a filter naming one type. It is not superseded by this file: a list
 * takes a different branch, so proving the list agrees says nothing about
 * the single value every existing client sends.
 *
 * **Every read stops on a marker this file chooses before the first
 * write**, carried by the last write of the scenario and always one the
 * filter admits. That ordering is load-bearing rather than tidy: a
 * terminator only known once the writes have finished can be overtaken by
 * the frame announcing it, leaving the read waiting on a condition that
 * was already true. Nothing here waits out a clock either — a frame that
 * should have arrived and did not fails the assertion that names it,
 * rather than expiring a budget that names nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this the replay path has nothing to replay: `publish` only
  // appends when an event-log store is installed, and the test context
  // does not install one.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

/** The newest id in the event log, or 0 when it is empty. Read rather than
 *  guessed: a fixed cursor trips the retention check on a trimmed log, and
 *  the stream then closes with `catchup_too_old` having replayed nothing. */
async function latestEventId(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 1000);
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0n);
}

async function createItem(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type, properties },
  });
  if (res.status !== 201) {
    throw new Error(`create ${type} failed: ${String(res.status)}`);
  }
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** Two notes and an edge between them; returns the edge's own id. */
async function createEdge(): Promise<string> {
  const source = await createItem("core.note", { body: "edge source" });
  const target = await createItem("core.note", { body: "edge target" });
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { source_id: source, target_id: target, edge_type: "about" },
  });
  if (res.status !== 201) {
    throw new Error(`create edge failed: ${String(res.status)}`);
  }
  return ((await res.json()) as { edge: { id: string } }).edge.id;
}

/**
 * One thing written, and whether the subscriber under test must see it.
 *
 * `needle` is what identifies it in the raw stream text — a marker in an
 * item's properties, or an edge's id. `why` is what the assertion says
 * when it fails, so a red names the rule rather than the string.
 */
interface Expectation {
  needle: string;
  delivered: boolean;
  why: string;
}

interface Scenario {
  /**
   * Everything the scenario writes, in the order it writes it. The last
   * write must carry `terminator` and must be one the filter admits: the
   * read stops on it, and everything the scenario expects to be withheld
   * is written before it so its absence has already been decided by then.
   */
  write: (tag: string, terminator: string) => Promise<Expectation[]>;
}

function assertTerminator(
  expectations: Expectation[],
  terminator: string,
): void {
  const last = expectations.at(-1);
  if (!last?.delivered || last.needle !== terminator) {
    throw new Error(
      "a scenario's last expectation must be the terminator, delivered",
    );
  }
}

function assertDelivery(text: string, expectations: Expectation[]): void {
  for (const e of expectations) {
    if (e.delivered) expect(text, e.why).toContain(e.needle);
    else expect(text, e.why).not.toContain(e.needle);
  }
}

function uniqueTag(): string {
  return `zz${Math.random().toString(36).slice(2, 8)}zz`;
}

/** Run the scenario against the live stream: subscribe, then write. */
async function deliveredLive(query: string, scenario: Scenario): Promise<void> {
  const tag = uniqueTag();
  const terminator = `${tag}end`;

  const stream = await request(ctx.app, "GET", `/events${query}`, {
    key: ctx.workingKey,
  });
  expect(stream.status).toBe(200);

  const reading = readSse(stream, { until: (t) => t.includes(terminator) });
  // The read is already running; this lets the subscription attach, so
  // nothing published below lands before there is a listener for it.
  await settle();

  const expectations = await scenario.write(tag, terminator);
  assertTerminator(expectations, terminator);

  const { text } = await reading;
  assertDelivery(text, expectations);
}

/** Run the scenario against the `Last-Event-ID` replay: write, then subscribe
 *  from a cursor that predates every write. */
async function deliveredOnReplay(
  query: string,
  scenario: Scenario,
): Promise<void> {
  const tag = uniqueTag();
  const terminator = `${tag}end`;

  // A row the cursor can point at. `Last-Event-ID: 0` against an empty log
  // is older than anything retained, so the stream would answer a terminal
  // `catchup_too_old` and replay nothing at all.
  await createItem("core.note", { body: "replay seed" });
  const cursor = await latestEventId();

  const expectations = await scenario.write(tag, terminator);
  assertTerminator(expectations, terminator);

  const res = await request(ctx.app, "GET", `/events${query}`, {
    key: ctx.workingKey,
    headers: { "Last-Event-ID": String(cursor) },
  });
  expect(res.status).toBe(200);

  const { text } = await readSse(res, { until: (t) => t.includes(terminator) });
  assertDelivery(text, expectations);
}

const PATHS = [
  { name: "live", run: deliveredLive },
  { name: "replay", run: deliveredOnReplay },
] as const;

/**
 * `?type=` naming two types, with a subtype of one of them and an edge
 * written between them. One table; both paths must answer it identically.
 */
describe.each(PATHS)("GET /events?type=a,b ($name)", ({ run }) => {
  it("delivers both named types, a subtype of either, and edges", async () => {
    await run("?type=core.note,core.media", {
      write: async (tag, terminator) => {
        // Written first, so its frame is already decided by the time the
        // read stops on the terminator.
        const outside = await createItem("core.task", {
          title: `${tag}task`,
        });
        const firstNamed = await createItem("core.note", {
          body: `${tag}note`,
        });
        const edgeId = await createEdge();
        const subtype = await createItem("core.media.song", {
          title: `${tag}song`,
        });
        await createItem("core.media", { title: terminator });
        return [
          {
            needle: outside,
            delivered: false,
            why: "a type the filter does not name must stay out of the stream",
          },
          {
            needle: firstNamed,
            delivered: true,
            why: "the first type in the list must be delivered",
          },
          {
            needle: edgeId,
            delivered: true,
            why: "an edge event must reach a subscriber that set a type filter",
          },
          {
            needle: subtype,
            delivered: true,
            why: "a subtype of a named type must be delivered, as it is with one type",
          },
          {
            needle: terminator,
            delivered: true,
            why: "the second type in the list must be delivered",
          },
        ];
      },
    });
  });
});

describe.each(PATHS)("GET /events?edges=none ($name)", ({ run }) => {
  it("suppresses edge events under a type filter and keeps item events", async () => {
    await run("?type=core.note&edges=none", {
      write: async (_tag, terminator) => {
        const edgeId = await createEdge();
        await createItem("core.note", { body: terminator });
        return [
          {
            needle: edgeId,
            delivered: false,
            why: "edges=none must suppress the edge event",
          },
          {
            needle: terminator,
            delivered: true,
            why: "edges=none must not touch item delivery",
          },
        ];
      },
    });
  });

  it("suppresses edge events with no type filter at all", async () => {
    // The sibling above cannot see this one: an implementation reading the
    // opt-out as "no edges while a type filter is set" answers it
    // correctly and silently keeps sending edges to everyone else.
    await run("?edges=none", {
      write: async (_tag, terminator) => {
        const edgeId = await createEdge();
        await createItem("core.note", { body: terminator });
        return [
          {
            needle: edgeId,
            delivered: false,
            why: "the edge opt-out is not conditional on a type filter",
          },
          {
            needle: terminator,
            delivered: true,
            why: "edges=none must not touch item delivery",
          },
        ];
      },
    });
  });
});

describe("GET /events refuses a filter it cannot honor", () => {
  async function open(query: string): Promise<number> {
    const res = await request(ctx.app, "GET", `/events${query}`, {
      key: ctx.workingKey,
    });
    await res.body?.cancel();
    return res.status;
  }

  it("refuses more types than the cap", async () => {
    const types = Array.from({ length: 11 }, (_, i) => `core.t${String(i)}`);
    expect(await open(`?type=${types.join(",")}`)).toBe(400);
  });

  it("accepts exactly the cap", async () => {
    // The boundary belongs beside the refusal: a cap written one out is a
    // refusal of a request the documentation says is legal, and only the
    // pair pins which side of the boundary is which.
    const types = Array.from({ length: 10 }, (_, i) => `core.t${String(i)}`);
    expect(await open(`?type=${types.join(",")}`)).toBe(200);
  });

  it("refuses an edges value it does not understand, and accepts the one it does", async () => {
    // Silently ignoring the unknown value would open a stream that carries
    // everything while the caller believes it filtered, which is the shape
    // of failure this parameter exists to remove. The affirmative spelling
    // is asserted beside it because a client cannot write the default
    // explicitly unless it is accepted, and "refuse what is not `none`"
    // passes the refusal on its own.
    expect(await open("?edges=some")).toBe(400);
    expect(await open("?edges=all")).toBe(200);
  });
});
