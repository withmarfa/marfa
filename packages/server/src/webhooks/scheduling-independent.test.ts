import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { registerHousekeepingJobs } from "../housekeeping/registrations.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({ webhookAllowPrivateAddresses: true });
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.useRealTimers();
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
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("scheduler still waits for the held receiver"));
        }, 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("queues beyond a held attempt batch and preserves a wake during the active poll", async () => {
  const reached = deferred();
  let held: ServerResponse | undefined;
  let active = 0;
  let maximum = 0;
  let fast = 0;
  const receiver = createServer((req, response) => {
    req.resume();
    active++;
    maximum = Math.max(maximum, active);
    response.on("finish", () => {
      active--;
    });
    if (req.url === "/slow") {
      held = response;
      reached.resolve();
    } else {
      fast++;
      response.writeHead(204);
      response.end();
    }
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("receiver did not bind");
  const hooks: string[] = [];
  let scheduling: ReturnType<typeof ctx.housekeeping.runNow> | undefined;
  let polling: ReturnType<typeof ctx.housekeeping.runNow> | undefined;
  try {
    for (let n = 0; n < 151; n++) {
      const response = await request(ctx.app, "POST", "/webhooks", {
        key: ctx.workingKey,
        body: {
          url: `http://127.0.0.1:${String(address.port)}/${n === 0 ? "slow" : "fast"}`,
          events: ["item.created"],
        },
      });
      expect(response.status).toBe(201);
      hooks.push(((await response.json()) as { id: string }).id);
    }
    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: {
            type: "core.note",
            properties: { body: "receiver independence" },
          },
        })
      ).status,
    ).toBe(201);
    registerHousekeepingJobs(
      ctx.housekeeping,
      ctx.storage,
      ctx.blobs,
      ctx.config,
    );
    await ctx.housekeeping.start();
    scheduling = ctx.housekeeping.runNow("webhook-schedule");
    const first = await Promise.race([
      scheduling,
      reached.promise.then(() => ({ kind: "receiver_waiting" as const })),
    ]);
    expect(first.kind).toBe("ran");
    if (first.kind !== "ran") throw new Error("scheduler did not run");
    expect(first.run.result).toMatchObject({ scheduled: 50 });
    polling = ctx.housekeeping.runNow("webhook-poll");
    await deadline(reached.promise);
    const second = await deadline(ctx.housekeeping.runNow("webhook-schedule"));
    expect(second.kind).toBe("ran");
    if (second.kind !== "ran") throw new Error("scheduler did not continue");
    expect(second.run.result).toMatchObject({ scheduled: 50 });
    for (const scheduled of [50, 1]) {
      const next = await deadline(ctx.housekeeping.runNow("webhook-schedule"));
      expect(next.kind).toBe("ran");
      if (next.kind !== "ran")
        throw new Error("scheduler did not finish backlog");
      expect(next.run.result).toMatchObject({ scheduled });
    }
    expect(
      (
        await ctx.storage.outboundWebhookDeliveries.list(hooks[150]!, {
          limit: 10,
        })
      ).data,
    ).toHaveLength(1);
    expect(await ctx.housekeeping.runNow("webhook-poll")).toEqual({
      kind: "running",
    });
    expect(maximum).toBeLessThanOrEqual(50);
    held!.writeHead(204);
    held!.end();
    const firstPoll = await polling;
    expect(firstPoll.kind).toBe("ran");
    const row = await ctx.storage.housekeeping.get("webhook-poll");
    expect(Date.parse(row!.next_run_at)).toBeLessThanOrEqual(Date.now() + 1);
    for (let batch = 0; batch < 3; batch++) {
      await ctx.housekeeping.poll();
      await ctx.housekeeping.settle();
    }
    expect(fast).toBe(150);
    for (const hook of hooks) {
      const page = await ctx.storage.outboundWebhookDeliveries.list(hook, {
        limit: 10,
      });
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({ status: "success", attempt: 1 });
    }
    console.log(
      "NATIVE_INDEPENDENT_SCHEDULING",
      JSON.stringify({
        first: first.run.result,
        second: second.run.result,
        fast,
        maximum,
      }),
    );
  } finally {
    if (held && !held.writableEnded) {
      held.writeHead(204);
      held.end();
    }
    await Promise.allSettled([scheduling, polling]);
    await ctx.housekeeping.stop();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) =>
      receiver.close(() => {
        resolve();
      }),
    );
  }
});

it("shutdown waits for a held tracked attempt and starts no further poll", async () => {
  const reached = deferred();
  let held: ServerResponse | undefined;
  let hits = 0;
  const receiver = createServer((req, response) => {
    req.resume();
    hits++;
    held = response;
    reached.resolve();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("receiver did not bind");
  let polling: ReturnType<typeof ctx.housekeeping.runNow> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    const response = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: {
        url: `http://127.0.0.1:${String(address.port)}/slow`,
        events: ["item.created"],
      },
    });
    expect(response.status).toBe(201);
    const hook = ((await response.json()) as { id: string }).id;
    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "core.note", properties: { body: "tracked shutdown" } },
        })
      ).status,
    ).toBe(201);
    registerHousekeepingJobs(
      ctx.housekeeping,
      ctx.storage,
      ctx.blobs,
      ctx.config,
    );
    await ctx.housekeeping.start();
    expect((await ctx.housekeeping.runNow("webhook-schedule")).kind).toBe(
      "ran",
    );
    polling = ctx.housekeeping.runNow("webhook-poll");
    await deadline(reached.promise);
    let stopped = false;
    stopping = ctx.housekeeping.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    await ctx.housekeeping.poll();
    expect(hits).toBe(1);
    held!.writeHead(204);
    held!.end();
    await stopping;
    expect(stopped).toBe(true);
    expect((await polling).kind).toBe("ran");
    expect(
      (await ctx.storage.outboundWebhookDeliveries.list(hook, { limit: 10 }))
        .data[0],
    ).toMatchObject({ status: "success", attempt: 1 });
    expect(
      (await ctx.storage.housekeeping.get("webhook-poll"))?.running_since,
    ).toBeNull();
  } finally {
    if (held && !held.writableEnded) {
      held.writeHead(204);
      held.end();
    }
    await Promise.allSettled([polling, stopping]);
    await ctx.housekeeping.stop();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) =>
      receiver.close(() => {
        resolve();
      }),
    );
  }
});

it("a saturated refused batch wakes once without retrying before row eligibility", async () => {
  let hits = 0;
  const receiver = createServer((req, response) => {
    req.resume();
    hits++;
    response.writeHead(503);
    response.end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("receiver did not bind");
  try {
    for (let n = 0; n < 50; n++) {
      const response = await request(ctx.app, "POST", "/webhooks", {
        key: ctx.workingKey,
        body: {
          url: `http://127.0.0.1:${String(address.port)}/refused`,
          events: ["item.created"],
        },
      });
      expect(response.status).toBe(201);
    }
    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: {
            type: "core.note",
            properties: { body: "retry eligibility" },
          },
        })
      ).status,
    ).toBe(201);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    registerHousekeepingJobs(
      ctx.housekeeping,
      ctx.storage,
      ctx.blobs,
      ctx.config,
    );
    await ctx.housekeeping.start();
    await ctx.housekeeping.runNow("webhook-schedule");
    const first = await ctx.housekeeping.runNow("webhook-poll");
    expect(first.kind).toBe("ran");
    if (first.kind !== "ran") throw new Error("poll did not run");
    expect(first.run.result).toMatchObject({ attempted: 50 });
    expect(hits).toBe(50);
    vi.setSystemTime(now + 1);
    await ctx.housekeeping.poll();
    await ctx.housekeeping.settle();
    expect(hits).toBe(50);
    expect(await ctx.storage.housekeeping.get("webhook-poll")).toMatchObject({
      last_result: { attempted: 0 },
      next_run_at: new Date(now + 30001).toISOString(),
    });
    await ctx.housekeeping.poll();
    await ctx.housekeeping.settle();
    expect(hits).toBe(50);
  } finally {
    await ctx.housekeeping.stop();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) =>
      receiver.close(() => {
        resolve();
      }),
    );
  }
});
