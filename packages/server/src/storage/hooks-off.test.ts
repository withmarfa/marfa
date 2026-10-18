import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFaults, setFault } from "../control/faults.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import {
  createTestContext,
  readSse,
  request,
  runBulkActionAsync,
  type TestContext,
} from "../test-utils.js";
import { runAuditedTransaction } from "./audited-transaction.js";

const spies = vi.hoisted(() => ({
  audit: vi.fn(),
  scope: vi.fn(),
  hold: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../control/faults.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../control/faults.js")>();
  return {
    ...actual,
    holdAt: (...args: Parameters<typeof actual.holdAt>) => {
      spies.hold();
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
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  clearFaults();
  __resetEventLogForTests();
  await ctx.cleanup();
});

const entry = { action: "test.hooks", resource_type: "settings" };
const write = () =>
  runAuditedTransaction(
    ctx.storage,
    () => ctx.storage.settings.set("hooks.off", "v"),
    entry,
  );

it("takes the original path with no fault set: no fault wrapper is built and no scope is entered", async () => {
  await write();
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
