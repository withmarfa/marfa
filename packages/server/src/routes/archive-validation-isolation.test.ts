import { afterEach, expect, it, vi } from "vitest";
import {
  createTestContext,
  request,
  collectItemEvents,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { readdirSync } from "node:fs";
import { DiskReserve, setAvailableBytesProbe } from "../storage/disk-space.js";

let ctx: TestContext;
afterEach(async () => {
  vi.restoreAllMocks();
  setAvailableBytesProbe(undefined);
  __resetEventLogForTests();
  await ctx.cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("delivers a live write's event while archive validation is paused", async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  expect(
    (
      await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: Array.from({ length: 120 }, (_, i) => ({
            type: "core.note",
            properties: { body: `note ${String(i)}` },
          })),
        },
      })
    ).status,
  ).toBe(200);
  const reached = deferred();
  const release = deferred();
  vi.spyOn(DiskReserve.prototype, "look").mockImplementationOnce(async () => {
    reached.resolve();
    await release.promise;
  });
  const abort = new AbortController();
  const observed = collectItemEvents(abort.signal);
  const pending = request(ctx.app, "GET", "/export?format=archive", {
    key: ctx.workingKey,
  });
  try {
    await reached.promise;
    const live = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "live during validation" },
      },
    });
    expect(live.status).toBe(201);
    await vi.waitFor(
      () => {
        expect(
          observed.events.some(
            (event) => event.item.properties.body === "live during validation",
          ),
        ).toBe(true);
      },
      { timeout: 1000 },
    );
  } finally {
    release.resolve();
    const exported = await pending;
    await exported.arrayBuffer();
    abort.abort();
    await observed.done;
  }
});

it("refuses with 507 when the volume falls below the reserve during validation, and removes every temporary file", async () => {
  ctx = await createTestContext({ diskReserveBytes: 1024 * 1024 });
  initEventLog(ctx.storage.eventLog);
  expect(
    (
      await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: Array.from({ length: 120 }, (_, i) => ({
            type: "core.note",
            properties: { body: `note ${String(i)}` },
          })),
        },
      })
    ).status,
  ).toBe(200);
  const run = () =>
    request(ctx.app, "GET", "/export?format=archive", { key: ctx.workingKey });
  const witness = await run();
  expect(witness.status).toBe(200);
  await witness.arrayBuffer();
  await vi.waitFor(() => {
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
  });
  const look = vi
    .spyOn(DiskReserve.prototype, "look")
    .mockImplementationOnce(function (this: DiskReserve) {
      setAvailableBytesProbe(() => Promise.resolve(1024 * 1024 - 4096));
      look.mockRestore();
      return this.look();
    });
  const refused = await run();
  expect(refused.status, await refused.clone().text()).toBe(507);
  expect(await refused.json()).toMatchObject({
    error: { code: "insufficient_storage" },
  });
  expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
});

it("ends a paused validation on disconnect and removes the spool", async () => {
  ctx = await createTestContext();
  expect(
    (
      await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: Array.from({ length: 120 }, (_, i) => ({
            type: "core.note",
            properties: { body: `note ${String(i)}` },
          })),
        },
      })
    ).status,
  ).toBe(200);
  const reached = deferred();
  const release = deferred();
  vi.spyOn(DiskReserve.prototype, "look").mockImplementationOnce(async () => {
    reached.resolve();
    await release.promise;
  });
  const abort = new AbortController();
  const pending = ctx.app.request("/export?format=archive", {
    headers: { Authorization: `Bearer ${ctx.workingKey}` },
    signal: abort.signal,
  });
  try {
    await reached.promise;
    expect(readdirSync(ctx.blobs.disk.spoolDir).length).toBeGreaterThan(0);
    abort.abort();
    await pending;
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
  } finally {
    release.resolve();
    await pending;
  }
});
