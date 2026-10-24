import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { BulkActionWorker } from "../bulk-actions/worker.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { setBulkJobEnqueueListener } from "../bulk-actions/enqueue-signal.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  setBulkJobEnqueueListener(null);
  __resetEventLogForTests();
  await ctx.cleanup();
});

const CONTRACT = "acme.contractwithalongername";

async function register(id: string, fields: Record<string, unknown>) {
  const r = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id, fields },
  });
  expect(r.status, await r.clone().text()).toBe(201);
}

async function types(contract: Record<string, unknown> = {}) {
  await register("acme.deal", { title: { type: "string" } });
  await register(CONTRACT, { title: { type: "string" }, ...contract });
}

async function deal(title: string): Promise<string> {
  const r = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "acme.deal", properties: { title } },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}

async function view(filter: string): Promise<string> {
  const r = await request(ctx.app, "POST", "/views", {
    key: ctx.workingKey,
    body: {
      title: "Deals",
      query: { filter },
    },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { item: { id: string } }).item.id;
}

async function move(body: Record<string, unknown> = {}) {
  return request(ctx.app, "POST", "/types/acme.deal/move", {
    key: ctx.workingKey,
    body: { to: CONTRACT, ...body },
  });
}

async function finished(jobId: string) {
  const worker = new BulkActionWorker({ storage: ctx.storage });
  try {
    while (await worker.runOnce());
  } finally {
    await worker.stop();
  }
  const job = await ctx.storage.bulkActionJobs.getById(jobId);
  expect(job?.status, job?.error ?? "").toBe("completed");
  return JSON.parse(job?.result ?? "{}") as Record<string, unknown>;
}

async function queued(): Promise<string> {
  const r = await move();
  expect(r.status).toBe(202);
  return ((await r.json()) as { id: string }).id;
}

it("reports an item of the old type written while the move runs, and rewrites no setting", async () => {
  await types();
  await deal("before");
  await view('type eq "acme.deal"');
  const jobId = await queued();
  await deal("during");

  expect(await finished(jobId)).toMatchObject({
    succeeded: 1,
    errored: 0,
    remaining: 1,
    remaining_hidden: false,
    settings_rewritten: false,
  });

  // The witness: with nothing left behind, the same move rewrites them.
  expect(await finished(await queued())).toMatchObject({
    succeeded: 1,
    remaining: 0,
    remaining_hidden: false,
    settings_rewritten: true,
  });
});

it("lists the first 100 items a move left, and counts every one", async () => {
  await types({ amount: { type: "number", required: true } });
  for (let i = 0; i < 101; i++) await deal(`unpriced ${String(i)}`);

  const result = await finished(await queued());
  expect(result.errors).toHaveLength(100);
  expect(result).toMatchObject({ errored: 101, remaining: 101 });
});

it("blocks a move and names a filter it can't read or rewrite, and a delete still answers", async () => {
  await types();
  const unreadable = await view('type eq "acme.deal"');
  await (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun(s: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(
    "UPDATE items SET properties = jsonb_set(properties, '$.query.filter', ?) WHERE id = ?",
    ['type eq "acme.deal" AND (', unreadable],
  );
  // Within the limit as written, over it once it names the longer type.
  const padding = "x".repeat(
    2048 - 'type eq "acme.deal" OR properties.title eq ""'.length,
  );
  const long = await view(
    `type eq "acme.deal" OR properties.title eq "${padding}"`,
  );

  const r = await move({ dry_run: true });
  expect(r.status, await r.clone().text()).toBe(409);
  const { error } = (await r.json()) as {
    error: { code: string; details: { settings: Record<string, unknown>[] } };
  };
  expect(error.code).toBe("type_move_blocked");
  expect(
    error.details.settings.map(({ id, field, reason }) => ({
      id,
      field,
      reason,
    })),
  ).toEqual(
    expect.arrayContaining([
      { id: unreadable, field: "query.filter", reason: "filter_term" },
      { id: long, field: "query.filter", reason: "filter_term" },
    ]),
  );

  const deleted = await request(ctx.app, "DELETE", "/types/acme.deal", {
    key: ctx.workingKey,
  });
  expect(deleted.status, await deleted.clone().text()).toBe(409);
  expect(
    ((await deleted.json()) as { error: { code: string } }).error.code,
  ).toBe("type_in_use");
});
