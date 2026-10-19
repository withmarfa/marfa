import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateId } from "@withmarfa/shared";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";
import {
  activeFaults,
  clearFaults,
  setFault,
  scriptedAnswer,
  unfoldDeadlineFault,
} from "../control/faults.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import { createWebhookHttpClient } from "../webhooks/outbound-http.js";
import {
  createTestContext,
  collectItemEvents,
  readSse,
  request,
  runBulkActionAsync,
  type TestContext,
} from "../test-utils.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { expandSeries } from "../events/expand-recurrence.js";
import { WebhookPoller, WebhookScheduler } from "../webhooks/delivery.js";

const spies = vi.hoisted(() => ({
  audit: vi.fn(),
  scope: vi.fn(),
  hold: vi.fn(),
  read: vi.fn(),
  headConstruction: vi.fn(),
  rows: vi.fn(),
  edge: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("../control/event-faults.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../control/event-faults.js")>();
  return {
    ...actual,
    createFaultedHeadRead: (
      ...args: Parameters<typeof actual.createFaultedHeadRead>
    ) => {
      spies.headConstruction();
      return actual.createFaultedHeadRead(...args);
    },
    replayRowsUnderFaults: (
      ...args: Parameters<typeof actual.replayRowsUnderFaults>
    ) => {
      spies.rows();
      return actual.replayRowsUnderFaults(...args);
    },
    edgeUnderFaults: (...args: Parameters<typeof actual.edgeUnderFaults>) => {
      spies.edge();
      return actual.edgeUnderFaults(...args);
    },
  };
});
vi.mock("../control/faults.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../control/faults.js")>();
  return {
    ...actual,
    unfoldDeadlineFault: vi.fn(actual.unfoldDeadlineFault),
    scriptedAnswer: (...args: Parameters<typeof actual.scriptedAnswer>) => {
      spies.lookup();
      return actual.scriptedAnswer(...args);
    },
    holdAt: (...args: Parameters<typeof actual.holdAt>) => {
      spies.hold(...args);
      return actual.holdAt(...args);
    },
  };
});
vi.mock("./sqlite/injected-failure.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./sqlite/injected-failure.js")>();
  return {
    ...actual,
    auditUnderFaults: (...args: Parameters<typeof actual.auditUnderFaults>) => {
      spies.audit();
      return actual.auditUnderFaults(...args);
    },
    withStatementFault: (
      ...args: Parameters<typeof actual.withStatementFault>
    ) => {
      spies.scope();
      return actual.withStatementFault(...args);
    },
    failRead: (...args: Parameters<typeof actual.failRead>) => {
      spies.read();
      actual.failRead(...args);
    },
  };
});

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  spies.audit.mockClear();
  spies.scope.mockClear();
  spies.hold.mockClear();
  spies.read.mockClear();
  spies.headConstruction.mockClear();
  spies.rows.mockClear();
  spies.edge.mockClear();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  clearFaults();
  __resetEventLogForTests();
  await ctx.cleanup();
});

const entry = { action: "test.hooks", resource_type: "settings" };
it("does not look up an unfold deadline until a fault is armed", () => {
  const expand = () =>
    expandSeries(
      {
        id: "series",
        starts_at: "2026-01-01T12:00:00Z",
        timezone: "UTC",
        recurrence: ["RRULE:FREQ=DAILY"],
      },
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-02T00:00:00Z"),
    );
  vi.mocked(unfoldDeadlineFault).mockClear();
  expect(expand()).toHaveLength(1);
  expect(unfoldDeadlineFault).not.toHaveBeenCalled();
  setFault("unfold-deadline", "1000");
  expect(expand()).toHaveLength(1);
  expect(unfoldDeadlineFault).toHaveBeenCalledTimes(1);
});
const write = () =>
  runAuditedTransaction(
    ctx.storage,
    () => ctx.storage.settings.set("hooks.off", "v"),
    entry,
  );

it("takes the original path with no fault set: no fault wrapper is built and no scope is entered", async () => {
  await write();
  expect(spies.hold).not.toHaveBeenCalled();
  expect(spies.audit).not.toHaveBeenCalled();
  expect(spies.scope).not.toHaveBeenCalled();
  expect(await ctx.storage.audit.list({ action: "test.hooks" })).toMatchObject({
    data: [expect.anything()],
  });
});

it("takes the fault path once a fault is set, which is the witness for the absence above", async () => {
  setFault("fail:commit-ack", null);
  await write();
  expect(spies.audit).toHaveBeenCalledTimes(1);
});

const ACTIONS: [string, Record<string, unknown>][] = [
  ["update_tags", { add: ["hooks-off-added"] }],
  ["update_tier", { tier: "feed" }],
  ["update_properties", { patch: { body: "patched" } }],
  ["update_occurred_at", { occurred_at: "2024-01-01T00:00:00.000Z" }],
  ["transition", { state: "archived" }],
  ["purge", { confirm: "PURGE" }],
];

async function jobFor(action: string, extra: Record<string, unknown>) {
  const made = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "row" }, tags: [action] },
  });
  expect(made.status).toBe(201);
  const ran = await runBulkActionAsync(
    ctx,
    { action, filter: { tags: [action] }, ...extra },
    ctx.workingKey,
  );
  expect(ran.initialStatus).toBe(202);
  return ran.job!;
}

it.each(ACTIONS)(
  "writes the rows of %s by the original code with no fault set, and through the fault scope once one is",
  async (action, extra) => {
    const job = await jobFor(action, extra);
    expect(job.status).toBe("completed");
    expect(spies.scope).not.toHaveBeenCalled();

    // The witness: with a fault set the same rows are written inside a scope.
    setFault("fail:job-row", null);
    await jobFor(action, extra);
    expect(spies.scope).toHaveBeenCalled();
  },
);

/** Opens a stream and reads what it sends until `until` shows or the window passes. */
async function streamRead(
  path: string,
  headers: Record<string, string>,
  until?: string,
): Promise<string> {
  const res = await request(ctx.app, "GET", path, {
    key: ctx.workingKey,
    headers,
  });
  expect(res.status).toBe(200);
  return (
    await readSse(
      res,
      until === undefined
        ? { timeoutMs: 500 }
        : { until: (text) => text.includes(until) },
    )
  ).text;
}

const stream = "/events";
const copy = "/events?edges=all&copy=1";

const reached = () => ({
  hold: spies.hold.mock.calls.length,
  read: spies.read.mock.calls.length,
});

/** The cursor and read view a copy stream announces once it is live. */
async function copyProof(): Promise<Record<string, string>> {
  const text = await streamRead(copy, {}, "event: stream_live");
  const live = /event: stream_live\ndata: (.*)\n/.exec(text)?.[1];
  const proof = JSON.parse(live!) as { cursor: string; read_view: string };
  return {
    "Last-Event-ID": proof.cursor,
    "X-Marfa-Read-View": proof.read_view,
  };
}

async function note(body: string) {
  const made = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(made.status).toBe(201);
}

it("opens, replays and goes live as an event stream by the original code with no fault set: no hold is entered and no read is failed", async () => {
  await note("to replay");
  const text = await streamRead(
    stream,
    { "Last-Event-ID": "0" },
    "event: stream_live",
  );
  expect(text).toContain("to replay");
  await note("sent live");
  expect(reached()).toEqual({ hold: 0, read: 0 });
  expect(spies.headConstruction).not.toHaveBeenCalled();
  expect(spies.rows).not.toHaveBeenCalled();
});

it("opens, replays and goes live as a copy stream by the original code with no fault set: no hold is entered and no read is failed", async () => {
  const resume = await copyProof();
  await note("to replay on a copy");
  const text = await streamRead(copy, resume, "event: stream_live");
  expect(text).toContain("to replay on a copy");
  expect(reached()).toEqual({ hold: 0, read: 0 });
});

it.each([
  "hold:stream-open",
  "hold:stream-head",
  "hold:stream-replay",
  "hold:stream-drain",
  "fail:stream-head",
  "fail:stream-replay",
  "fail:stream-credential",
])(
  "reaches %s on an event stream once it is set, which is the witness for the absence above",
  async (name) => {
    await note("reached");
    setFault(name, null);
    const opened = request(ctx.app, "GET", stream, {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": "0" },
    });
    await vi.waitFor(() => {
      expect(
        name.startsWith("hold:") ? reached().hold : reached().read,
      ).toBeGreaterThan(0);
    });
    clearFaults();
    await readSse(await opened, { timeoutMs: 500 });
  },
);

it.each([
  "hold:stream-open",
  "hold:stream-replay",
  "hold:stream-drain",
  "fail:stream-head",
  "fail:stream-replay",
  "fail:stream-credential",
])(
  "reaches %s on a copy stream once it is set, which is the witness for the absence above",
  async (name) => {
    const resume = await copyProof();
    await note("reached on a copy");
    setFault(name, null);
    const opened = request(ctx.app, "GET", copy, {
      key: ctx.workingKey,
      headers: resume,
    });
    await vi.waitFor(() => {
      expect(
        name.startsWith("hold:") ? reached().hold : reached().read,
      ).toBeGreaterThan(0);
    });
    clearFaults();
    await readSse(await opened, { timeoutMs: 500 });
  },
);

it("constructs a head-read wrapper only when a fault is armed", async () => {
  setFault("fail:stream-head", "2");
  await streamRead(stream, {}, "event: stream_live");
  expect(spies.headConstruction).toHaveBeenCalledTimes(1);
});

it("makes only the nth replay row unreadable and leaves the stored row intact", async () => {
  await note("first readable");
  await note("second unreadable");
  await note("third readable");
  setFault("fail:stream-replay-row", "2");
  const text = await streamRead(
    stream,
    { "Last-Event-ID": "0" },
    "event: stream_live",
  );
  expect(spies.rows).toHaveBeenCalled();
  expect(text).toContain("first readable");
  expect(text).not.toContain("second unreadable");
  expect(text).toContain("third readable");
  expect(activeFaults()).toContainEqual(
    expect.objectContaining({ name: "fail:stream-replay-row", fired: 1 }),
  );
  clearFaults();
  expect(
    await streamRead(stream, { "Last-Event-ID": "0" }, "event: stream_live"),
  ).toContain("second unreadable");
});

it("publishes edges without entering a fault wrapper unless a fault is armed", async () => {
  const make = async () => {
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "endpoint" } },
    });
    expect(made.status).toBe(201);
    return ((await made.json()) as { item: { id: string } }).item.id;
  };
  const source = await make();
  const create = async () =>
    request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: await make(), edge_type: "about" },
    });
  expect((await create()).status).toBe(201);
  expect(spies.edge).not.toHaveBeenCalled();
  setFault("fail:edge-source-type", "2");
  expect((await create()).status).toBe(201);
  expect(activeFaults()[0]!.fired).toBe(0);
  expect((await create()).status).toBe(201);
  expect(activeFaults()[0]!.fired).toBe(1);
  expect((await create()).status).toBe(201);
  expect(spies.edge).toHaveBeenCalledTimes(3);
  const rows = (await ctx.storage.eventLog.getAfter(0n, 100)).filter(
    (row) => row.edge_id !== null,
  );
  expect(
    rows.map(
      (row) =>
        (JSON.parse(row.payload) as { source_type?: string }).source_type,
    ),
  ).toEqual(["core.note", "core.note", undefined, "core.note"]);
});

it("announces a write by the original code with no fault set, and through the hold once one is", async () => {
  const create = () =>
    request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "announced" } },
    });
  expect((await create()).status).toBe(201);
  expect(spies.hold).not.toHaveBeenCalled();
  setFault("hold:announce", null);
  expect((await create()).status).toBe(201);
  await vi.waitFor(() => {
    expect(spies.hold).toHaveBeenCalledTimes(1);
  });
});

it("reads a conditional read by the original code with no fault set, and through the hold once one is", async () => {
  const opened = await streamRead(copy, {}, "event: stream_live");
  const view = /"read_view":"([0-9a-f]{64})"/.exec(opened)?.[1];
  expect(view).toBeDefined();
  const read = () =>
    request(ctx.app, "GET", "/items?include=metadata&limit=1", {
      key: ctx.workingKey,
      headers: { "X-Marfa-Read-View": view! },
    });
  expect((await read()).status).toBe(200);
  expect(spies.hold).not.toHaveBeenCalled();
  setFault("hold:read-snapshot", null);
  const held = read();
  await vi.waitFor(() => {
    expect(spies.hold).toHaveBeenCalledTimes(1);
  });
  clearFaults();
  expect((await held).status).toBe(200);
});

it("holds an archive restore's announcements and later writes until the hold is cleared", async () => {
  const id = generateId();
  const pack = tar.pack();
  const gzip = pack.pipe(createGzip());
  const chunks: Buffer[] = [];
  const drained = (async () => {
    for await (const chunk of gzip) chunks.push(chunk as Buffer);
  })();
  pack.entry(
    { name: "manifest.json" },
    JSON.stringify({ version: 0, format: "marfa-archive-v0", blobs: {} }),
  );
  pack.entry(
    { name: "items.ndjson" },
    JSON.stringify({
      item: {
        id,
        type: "core.note",
        properties: { body: "restored" },
        source: "test",
        source_id: id,
      },
      metadata: { tags: [], extensions: {} },
    }) + "\n",
  );
  pack.finalize();
  await drained;
  const abort = new AbortController();
  const observed = collectItemEvents(abort.signal);
  try {
    setFault("hold:announce", null);
    const restored = await ctx.app.request("/restore", {
      method: "POST",
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: Buffer.concat(chunks),
    });
    expect(restored.status, await restored.text()).toBe(200);
    await vi.waitFor(() => {
      expect(activeFaults()).toContainEqual(
        expect.objectContaining({ name: "hold:announce", waiting: 1 }),
      );
    });
    await note("after restore");
    expect(observed.events).toEqual([]);
    clearFaults();
    await vi.waitFor(() => {
      expect(observed.events).toHaveLength(2);
    });
    expect(observed.events[0]!.item.id).toBe(id);
    expect(observed.events[1]!.item.properties.body).toBe("after restore");
    expect(observed.events[0]!.eventId!).toBeLessThan(
      observed.events[1]!.eventId!,
    );
  } finally {
    clearFaults();
    abort.abort();
    await observed.done;
  }
});
it("passes the webhook scheduler's hold point by without a call with no fault set, and reaches it once one is", async () => {
  const sub = await request(ctx.app, "POST", "/webhooks", {
    key: ctx.workingKey,
    body: { url: "http://receiver.invalid/hook", events: ["item.created"] },
  });
  expect(sub.status).toBe(201);
  const scheduler = new WebhookScheduler({
    storage: ctx.storage,
    wakePoller: () => Promise.resolve(),
  });
  const note = async () => {
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "scheduled" } },
    });
    expect(made.status).toBe(201);
  };
  await note();
  expect((await scheduler.runOnce()).scheduled).toBe(1);
  expect(spies.hold).not.toHaveBeenCalled();

  // The witness: with any fault set, the same run reaches the point.
  setFault("fail:job-row", null);
  await note();
  expect((await scheduler.runOnce()).scheduled).toBe(1);
  expect(spies.hold).toHaveBeenCalledTimes(1);
});

it("answers no lookup from a script with no fault set, and one once a resolve fault is", () => {
  expect(scriptedAnswer("rebind.test")).toBeUndefined();
  setFault("resolve:rebind.test", "1.1.1.1");
  expect(scriptedAnswer("rebind.test")).toEqual({
    checked: ["1.1.1.1"],
    connected: ["1.1.1.1"],
  });
});

it("does not enter the scripted resolver with hooks off, and does with a fault armed", async () => {
  const receiver = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = receiver.address();
    if (address === null || typeof address === "string")
      throw new Error("no receiver port");
    const post = () =>
      createWebhookHttpClient({ allowPrivateAddresses: true }).post({
        url: `http://localhost:${String(address.port)}/hook`,
        headers: {},
        body: "{}",
        timeoutMs: 5000,
      });
    spies.lookup.mockClear();
    expect(await post()).toMatchObject({ status: 200 });
    expect(spies.lookup).not.toHaveBeenCalled();
    setFault("resolve:localhost", "127.0.0.1");
    expect(await post()).toMatchObject({ status: 200 });
    expect(spies.lookup).toHaveBeenCalledTimes(1);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

const HOLDS = [
  "bulk-job:selected",
  "bulk-job:claimed",
  "bulk-job:in-chunk",
  "bulk-job:between-chunks",
];

it("adds no webhook response hold until a fault is armed", async () => {
  const subscription = await request(ctx.app, "POST", "/webhooks", {
    key: ctx.workingKey,
    body: { url: "https://example.com/hook", events: ["item.created"] },
  });
  expect(subscription.status).toBe(201);
  const scheduler = new WebhookScheduler({
    storage: ctx.storage,
    wakePoller: () => Promise.resolve(),
  });
  const post = vi.fn(() =>
    Promise.resolve({
      kind: "answered" as const,
      status: 200,
      retryAfter: null,
    }),
  );
  const poller = new WebhookPoller({ storage: ctx.storage, http: { post } });
  const deliver = async () => {
    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: {
            type: "core.note",
            properties: { body: "webhook hold witness" },
          },
        })
      ).status,
    ).toBe(201);
    await scheduler.runOnce();
    await poller.runOnce();
  };
  await deliver();
  expect(post).toHaveBeenCalledTimes(1);
  expect(spies.hold).not.toHaveBeenCalled();
  setFault("hold:webhook:response", null);
  const held = deliver();
  try {
    await vi.waitFor(() => {
      expect(spies.hold).toHaveBeenCalledWith("webhook:response");
    });
    expect(post).toHaveBeenCalledTimes(2);
  } finally {
    clearFaults();
    await held;
  }
});

/** A job over more rows than one chunk of 100 takes, so it has a place between chunks. */
async function jobOverTwoChunks(tag: string) {
  const made = await request(ctx.app, "POST", "/items/bulk", {
    key: ctx.workingKey,
    body: {
      atomic: false,
      items: Array.from({ length: 150 }, (_, index) => ({
        type: "core.note",
        properties: { body: `${tag} ${String(index)}` },
        tags: [tag],
      })),
    },
  });
  expect(made.status).toBe(200);
  return runBulkActionAsync(
    ctx,
    { action: "update_tags", add: ["held"], filter: { tags: [tag] } },
    ctx.workingKey,
  );
}

it("waits at no job hold point when no fault is set", async () => {
  const ran = await jobOverTwoChunks("holds-off");
  expect(ran.job?.status).toBe("completed");
  expect(spies.hold).not.toHaveBeenCalled();
});

it.each(HOLDS)(
  "reaches %s once a fault holds it, which is the witness for the absence above",
  async (point) => {
    setFault(`hold:${point}`, null);
    const ran = jobOverTwoChunks(`holds-on-${point}`);
    await vi.waitFor(() => {
      expect(spies.hold).toHaveBeenCalledWith(point);
    });
    clearFaults();
    expect((await ran).job?.status).toBe("completed");
  },
);

it("hydrates an ordinary read without entering a hold unless a fault is armed", async () => {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "read boundary" } },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as { item: { id: string } };
  spies.hold.mockClear();
  const read = () =>
    request(ctx.app, "GET", `/items/${item.id}`, { key: ctx.workingKey });
  expect((await read()).status).toBe(200);
  expect(spies.hold).not.toHaveBeenCalled();
  setFault("hold:read-hydration", null);
  const held = read();
  try {
    await vi.waitFor(() => {
      expect(
        activeFaults().find((f) => f.name === "hold:read-hydration")?.waiting,
      ).toBe(1);
    });
    expect(spies.hold).toHaveBeenCalledTimes(1);
  } finally {
    clearFaults();
  }
  expect((await held).status).toBe(200);
});

it("enters the write hold only when it is armed, before work starts", async () => {
  await write();
  expect(spies.hold).not.toHaveBeenCalled();
  setFault("hold:write", "test.hooks@1");
  const work = vi.fn(() => ctx.storage.settings.set("hooks.off", "held"));
  const pending = runAuditedTransaction(ctx.storage, work, entry);
  await vi.waitFor(() => {
    expect(activeFaults()[0]?.waiting).toBe(1);
  });
  expect(work).not.toHaveBeenCalled();
  clearFaults();
  await pending;
  expect(work).toHaveBeenCalledTimes(1);
  expect(spies.hold).toHaveBeenCalledTimes(1);
});

it("enters the export page hold only when it is armed", async () => {
  await note("exported");
  const read = () =>
    request(ctx.app, "GET", "/export?format=archive", { key: ctx.workingKey });
  const ordinary = await read();
  expect(ordinary.status).toBe(200);
  await ordinary.arrayBuffer();
  expect(spies.hold).not.toHaveBeenCalled();
  setFault("hold:export-page", "1");
  const pending = read();
  await vi.waitFor(() => {
    expect(activeFaults()[0]?.waiting).toBe(1);
  });
  clearFaults();
  const exported = await pending;
  expect(exported.status).toBe(200);
  await exported.arrayBuffer();
  expect(
    spies.hold.mock.calls.filter(([point]) => point === "export-page"),
  ).toHaveLength(1);
});
