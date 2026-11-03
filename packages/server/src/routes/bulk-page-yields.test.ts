import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBusyBudgetMs } from "../storage/sqlite/connection.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Over a real socket: the starvation this guards against is of I/O, which an
// in-process `app.request` never waits on.

let ctx: TestContext;
let baseUrl: string;
let closeHttp: () => Promise<void>;

beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  await new Promise<void>((resolve) => {
    const server = serve(
      { fetch: ctx.app.fetch, hostname: "127.0.0.1", port: 0 },
      (address) => {
        baseUrl = `http://127.0.0.1:${String(address.port)}`;
        resolve();
      },
    );
    closeHttp = () =>
      new Promise<void>((done, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else done();
        });
      });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  setBusyBudgetMs(5_000);
  __resetEventLogForTests();
  await closeHttp();
  await ctx.cleanup();
});

function send(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal,
  });
}

async function seedNotes(count: number, source: string): Promise<string[]> {
  const ids: string[] = [];
  await ctx.storage.runInTransaction(async () => {
    for (let i = 0; i < count; i++) {
      const item = await itemWrites(ctx.storage).create({
        writer: null,
        type: "core.note",
        properties: { body: `seed ${String(i)}` },
        source,
        source_id: String(i),
      });
      ids.push(item.id);
    }
  });
  return ids;
}

/** Counts the entries a page has looked up, and resolves once it has begun. */
function countLookups(
  after: (calls: number) => Promise<void> = async () => {},
) {
  let calls = 0;
  let begun!: () => void;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const find = ctx.storage.items.findBySourceId.bind(ctx.storage.items);
  vi.spyOn(ctx.storage.items, "findBySourceId").mockImplementation(
    async (...args) => {
      calls++;
      begun();
      const found = await find(...args);
      await after(calls);
      return found;
    },
  );
  return { started, calls: () => calls };
}

function notesPage(count: number, atomic: boolean, firstBody?: string) {
  return {
    mode: "upsert",
    atomic,
    items: Array.from({ length: count }, (_, i) => ({
      type: "core.note",
      source_id: String(i),
      properties: {
        body: i === 0 && firstBody ? firstBody : `page ${String(i)}`,
      },
    })),
  };
}

async function sourceOfWorkingKey(): Promise<string> {
  const created = await send("POST", "/items", {
    type: "core.note",
    properties: { body: "probe" },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as { item: { source: string } };
  return item.source;
}

describe("a bulk page leaves the server answering other requests", () => {
  // `/health` commits a probe write, which queues behind an atomic page's
  // transaction like any other write, so only a read stands for every other
  // request there.
  it.each([true, false])(
    "answers a read of an item the page updates, and /health between best-effort entries, while an items page is written (atomic=%s)",
    async (atomic) => {
      const pageSize = 400;
      const [first] = await seedNotes(1, await sourceOfWorkingKey());
      const lookups = countLookups();
      let pageDone = false;
      const page = send(
        "POST",
        "/items/bulk",
        notesPage(pageSize, atomic, "rewritten"),
      ).then((response) => {
        pageDone = true;
        return response;
      });
      await lookups.started;

      const read = await send("GET", `/items/${first!}`);
      const readAt = lookups.calls();
      const readBeforePage = !pageDone;
      const health = atomic ? undefined : await send("GET", "/health");
      const healthBeforePage = !pageDone;
      const readItem = (await read.json()) as {
        item: { properties: { body: string } };
      };

      const response = await page;
      expect(response.status).toBe(200);
      const result = (await response.json()) as { counts: { errored: number } };
      expect(result.counts.errored).toBe(0);
      expect(read.status).toBe(200);
      // Witness: the page did look up every entry, so the answers above came
      // while it was part way through, not after.
      expect(lookups.calls()).toBeGreaterThanOrEqual(pageSize);
      expect(readBeforePage).toBe(true);
      expect(readAt).toBeLessThan(pageSize);
      if (health) {
        expect(health.status).toBe(200);
        expect(healthBeforePage).toBe(true);
      }
      // An atomic page is one transaction: a read during it sees none of it.
      if (atomic) expect(readItem.item.properties.body).toBe("seed 0");
      const after = (await (await send("GET", `/items/${first!}`)).json()) as {
        item: { properties: { body: string } };
      };
      expect(after.item.properties.body).toBe("rewritten");
    },
  );

  it.each([true, false])(
    "answers a read while an edges page is written (atomic=%s)",
    async (atomic) => {
      const pageSize = 400;
      const source = await sourceOfWorkingKey();
      const [hub, ...targets] = await seedNotes(pageSize + 1, source);
      let calls = 0;
      let begun!: () => void;
      const started = new Promise<void>((resolve) => {
        begun = resolve;
      });
      const createRaw = ctx.storage.edges.createRaw.bind(ctx.storage.edges);
      vi.spyOn(ctx.storage.edges, "createRaw").mockImplementation(
        async (...args) => {
          calls++;
          begun();
          return createRaw(...args);
        },
      );
      let pageDone = false;
      const page = send("POST", "/edges/bulk", {
        atomic,
        edges: targets.map((target) => ({
          source_id: hub!,
          target_id: target,
          edge_type: "about",
        })),
      }).then((response) => {
        pageDone = true;
        return response;
      });
      await started;
      const read = await send("GET", `/items/${hub!}`);
      const readBeforePage = !pageDone;
      const readAt = calls;

      const response = await page;
      expect(response.status).toBe(200);
      const result = (await response.json()) as { counts: { created: number } };
      expect(result.counts.created).toBe(pageSize);
      expect(read.status).toBe(200);
      expect(calls).toBe(pageSize);
      expect(readBeforePage).toBe(true);
      expect(readAt).toBeLessThan(pageSize);
    },
  );

  it("keeps a best-effort page going past an entry that fails part way", async () => {
    await sourceOfWorkingKey();
    const body = notesPage(200, false);
    body.items[100] = { ...body.items[100]!, type: "Not A Type" };
    const response = await send("POST", "/items/bulk", body);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      counts: { created: number; errored: number };
      results: { index: number; outcome: string }[];
    };
    expect(result.counts).toMatchObject({ created: 199, errored: 1 });
    expect(result.results[100]).toMatchObject({
      index: 100,
      outcome: "errored",
    });
  });

  it("writes an atomic page whole when its client goes away part way", async () => {
    const pageSize = 300;
    const source = await sourceOfWorkingKey();
    const abort = new AbortController();
    let lastEntry!: () => void;
    const reachedEnd = new Promise<void>((resolve) => {
      lastEntry = resolve;
    });
    const lookups = countLookups(async (calls) => {
      if (calls === 20) abort.abort();
      if (calls === pageSize) lastEntry();
    });
    const page = send(
      "POST",
      "/items/bulk",
      notesPage(pageSize, true),
      abort.signal,
    );
    await expect(page).rejects.toThrow();
    expect(lookups.calls()).toBeLessThan(pageSize);
    await reachedEnd;
    // The commit follows the last entry; a read is admitted once it has
    // published, so the count below is the page's outcome.
    let stored = 0;
    for (let attempt = 0; attempt < 200 && stored < pageSize; attempt++) {
      stored = (
        await ctx.storage.items.list({
          source,
          types: ["core.note"],
          limit: 1000,
        })
      ).data.filter((item) => /^\d+$/.test(item.source_id ?? "")).length;
      if (stored < pageSize) await new Promise((r) => setTimeout(r, 10));
    }
    expect(stored).toBe(pageSize);
  });
});

describe("a write that arrives during an atomic page", () => {
  async function singleWriteDuring(delayMs: (calls: number) => number) {
    await sourceOfWorkingKey();
    const lookups = countLookups(
      (calls) => new Promise((resolve) => setTimeout(resolve, delayMs(calls))),
    );
    setBusyBudgetMs(100);
    const page = send("POST", "/items/bulk", notesPage(40, true));
    await lookups.started;
    const single = await send("POST", "/items", {
      type: "core.note",
      properties: { body: "single" },
    });
    const singleAt = lookups.calls();
    const response = await page;
    return { single, singleAt, response };
  }

  it("waits for a page that keeps writing longer than the busy budget", async () => {
    // Forty entries of ten milliseconds each hold the writer four times the
    // budget, every entry well inside it.
    const { single, singleAt, response } = await singleWriteDuring(() => 10);
    expect(response.status).toBe(200);
    expect(single.status).toBe(201);
    expect(singleAt).toBe(40);
    const { item } = (await single.json()) as { item: { id: string } };
    const events = await ctx.storage.eventLog.getAfter(0n, 10_000);
    const singleEvent = events.findIndex((event) => event.item_id === item.id);
    const pageEvents = events.filter(
      (event) => event.item_id !== null && event.item_id !== item.id,
    );
    // Announced in the order admitted: every page entry before the single write.
    expect(pageEvents.length).toBeGreaterThanOrEqual(40);
    expect(singleEvent).toBeGreaterThan(
      events.indexOf(pageEvents[pageEvents.length - 1]!),
    );
  });

  it("is refused behind a page that stops making progress for the budget", async () => {
    // Witness for the test above: the same page, with one entry stalled past
    // the budget, refuses the waiting write as before.
    const { single, response } = await singleWriteDuring((calls) =>
      calls === 2 ? 400 : 1,
    );
    expect(response.status).toBe(200);
    expect(single.status).toBe(503);
    const refusal = (await single.json()) as {
      error: { code: string; details: { budget_ms: number } };
    };
    expect(refusal.error.code).toBe("write_contention");
    expect(refusal.error.details.budget_ms).toBe(100);
  });
});
