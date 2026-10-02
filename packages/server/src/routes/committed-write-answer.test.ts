/**
 * A write and its event commit together, and a write that committed is never
 * answered with a failure.
 *
 * A `5xx` tells the caller nothing was written, so it sends the write again,
 * and a write that had in fact committed is written twice. An idempotency key
 * does not catch it: a door that takes one releases it on a `5xx`, and the
 * bulk doors take none. So every write's event row and every read its answer
 * needs happen inside its transaction, a failure anywhere before the answer
 * undoes the write, and the retry is the only write there is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

/** Make the next call of a store method throw, and report whether it did. */
function failOnce(owner: object, method: string): () => boolean {
  const target = owner as Record<string, unknown>;
  const original = target[method] as (...args: unknown[]) => unknown;
  let fired = false;
  target[method] = (...args: unknown[]): unknown => {
    if (fired) return original.apply(owner, args);
    fired = true;
    target[method] = original;
    throw new Error(`forced failure at ${method}`);
  };
  return () => fired;
}

async function head(): Promise<bigint> {
  return (await ctx.storage.eventLog.getMaxId()) ?? 0n;
}

describe("a write and the answer to it", () => {
  it("undoes a write whose answer fails after its event was written, and the retry writes it once", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "before" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as {
      item: { id: string; version: number };
    };
    const send = () =>
      request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.workingKey,
        headers: { "Idempotency-Key": `answer-${item.id}` },
        body: { properties: { body: "after" }, version: item.version },
      });

    // The edges the answer carries are the last thing read before it, after
    // the row and its event are written.
    const before = await head();
    const fired = failOnce(ctx.storage.edges, "listFromSourcesBatched");
    const failed = await send();
    expect(fired()).toBe(true);
    expect(failed.status).toBe(500);
    expect((await ctx.storage.items.get(item.id))?.version).toBe(item.version);
    expect(await head()).toBe(before);

    const retried = await send();
    expect(retried.status).toBe(200);
    const after = (await ctx.storage.items.get(item.id))!;
    expect(after.version).toBe(item.version + 1);
    expect(after.properties.body).toBe("after");
    const logged = await ctx.storage.eventLog.getAfter(before, 10);
    expect(
      logged.filter((e) => e.item_id === item.id && e.event_type === "updated"),
    ).toHaveLength(1);
  });

  it("writes no row whose event could not be written, so a retried create makes one", async () => {
    const key = `answer-create-${String(Date.now())}`;
    const send = () =>
      request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        headers: { "Idempotency-Key": key },
        body: {
          type: "core.note",
          source_id: key,
          properties: { body: "once" },
        },
      });
    const fired = failOnce(ctx.storage.eventLog, "append");
    const failed = await send();
    expect(fired()).toBe(true);
    expect(failed.status).toBe(500);

    const retried = await send();
    expect(retried.status).toBe(201);
    const listed = await ctx.storage.items.list({ limit: 500 });
    expect(listed.data.filter((row) => row.source_id === key)).toHaveLength(1);
  });
});

describe("a best-effort page whose later entry fails after earlier ones committed", () => {
  /** Let the first `n` appends through and refuse the next one. */
  function refuseAppendAfter(n: number): () => number {
    const log = ctx.storage.eventLog;
    const append = log.append.bind(log);
    let seen = 0;
    let refused = 0;
    log.append = (entry) => {
      seen += 1;
      if (seen === n + 1) {
        refused += 1;
        log.append = append;
        return Promise.reject(new Error("forced failure at the event append"));
      }
      return append(entry);
    };
    return () => refused;
  }

  it("reports the failed entry and answers the page, on POST /items/bulk", async () => {
    const tag = `page-${String(Date.now())}`;
    const refused = refuseAppendAfter(1);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      headers: { "Idempotency-Key": tag },
      body: {
        atomic: false,
        items: [
          { type: "core.note", properties: { body: "kept" }, tags: [tag] },
          { type: "core.note", properties: { body: "lost" }, tags: [tag] },
        ],
      },
    });
    expect(refused()).toBe(1);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(results.map((r) => r.outcome)).toEqual(["created", "errored"]);
    expect(results[1]?.error?.code).toBe("internal_error");
    const listed = await ctx.storage.items.list({ tags: [tag], limit: 10 });
    expect(listed.data.map((row) => row.properties.body)).toEqual(["kept"]);
  });

  it("reports the failed entry and answers the page, on POST /edges/bulk", async () => {
    const made = async (): Promise<string> => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "end" } },
      });
      return ((await res.json()) as { item: { id: string } }).item.id;
    };
    const [a, b, c2] = [await made(), await made(), await made()];
    const refused = refuseAppendAfter(1);
    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        edges: [
          { source_id: a, target_id: b, edge_type: "references" },
          { source_id: a, target_id: c2, edge_type: "references" },
        ],
      },
    });
    expect(refused()).toBe(1);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(results.map((r) => r.outcome)).toEqual(["created", "errored"]);
    expect(results[1]?.error?.code).toBe("internal_error");
  });
});
