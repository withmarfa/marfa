/**
 * A write is judged against the row as it stands inside the transaction that
 * writes it, on every door.
 *
 * The race each test stages is a retype landing after the door begins and
 * before its write transaction opens: the row a key may write becomes one it
 * may only read. A rule asked before the transaction opened is asked of the
 * row as it was, and the write lands on a row the key is refused. The retype
 * is committed at the moment the door opens its first transaction, which is
 * the latest point a check made outside it could have run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionWorker } from "../bulk-actions/worker.js";

let ctx: TestContext;
/** Write on notes, read on tasks. */
let narrowKey: string;
let narrowSource: string;

beforeAll(async () => {
  ctx = await createTestContext();
  narrowSource = `race-${Math.random().toString(36).slice(2, 10)}`;
  narrowKey = await mintWorkingKey(ctx, {
    source: narrowSource,
    type_permissions: { "core.note": "write", "core.task": "read" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Commit `change` the first time the app opens a transaction after this is
 * called, and report whether it fired.
 */
function raceTheNextTransaction(change: () => Promise<void>): {
  fired: () => boolean;
  restore: () => void;
} {
  const storage = ctx.storage;
  const original = storage.runInTransaction.bind(storage);
  let fired = false;
  storage.runInTransaction = async <T>(
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    if (!fired) {
      fired = true;
      await change();
    }
    return await original(fn);
  };
  return {
    fired: () => fired,
    restore: () => {
      storage.runInTransaction = original;
    },
  };
}

async function seedNote(
  marker: string,
  sourceId?: string,
): Promise<{ id: string; version: number }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: narrowKey,
    body: {
      type: "core.note",
      properties: { body: `before-${marker}` },
      tags: [marker],
      ...(sourceId !== undefined && { source_id: sourceId }),
    },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as {
    item: { id: string; version: number };
  };
  return item;
}

function retype(id: string): () => Promise<void> {
  return async () => {
    const raw = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await raw.__sqliteRun("UPDATE items SET type = ? WHERE id = ?", [
      "core.task",
      id,
    ]);
  };
}

async function bodyOf(id: string): Promise<unknown> {
  const row = await ctx.storage.items.getIncludingTrashed(id);
  return row?.properties.body;
}

describe("a create raced by another on its natural key", () => {
  it("lands as the upsert onto the row the other wrote", async () => {
    const sourceId = "race-natural-key";
    const send = (body: string): Promise<Response> =>
      request(ctx.app, "POST", "/items", {
        key: narrowKey,
        body: {
          type: "core.note",
          properties: { body },
          source_id: sourceId,
        },
      });
    let first: Response | undefined;
    const race = raceTheNextTransaction(async () => {
      first = await send("first");
    });
    let second: Response;
    try {
      second = await send("second");
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(first?.status).toBe(201);
    const created = (await first!.json()) as { item: { id: string } };
    expect(second.status).toBe(200);
    const upserted = (await second.json()) as {
      item: { id: string; version: number };
    };
    expect(upserted.item.id).toBe(created.item.id);
    expect(upserted.item.version).toBe(2);
    expect(await bodyOf(created.item.id)).toBe("second");
  });
});

describe("a write raced against a retype is refused on every door", () => {
  it("PATCH /items/{id}", async () => {
    const { id, version } = await seedNote("patch");
    const race = raceTheNextTransaction(retype(id));
    try {
      const res = await request(ctx.app, "PATCH", `/items/${id}`, {
        key: narrowKey,
        body: { properties: { body: "after" }, version },
      });
      expect(race.fired()).toBe(true);
      expect(res.status).toBe(403);
      expect(res.headers.get("X-Error-Code")).toBe("type_not_permitted");
    } finally {
      race.restore();
    }
    expect(await bodyOf(id)).toBe("before-patch");
  });

  it("POST /items on a natural key", async () => {
    const sourceId = "race-upsert";
    const { id } = await seedNote("upsert", sourceId);
    const race = raceTheNextTransaction(retype(id));
    try {
      const res = await request(ctx.app, "POST", "/items", {
        key: narrowKey,
        body: {
          type: "core.note",
          properties: { body: "after" },
          source_id: sourceId,
        },
      });
      expect(race.fired()).toBe(true);
      expect(res.status).toBe(403);
      expect(res.headers.get("X-Error-Code")).toBe("type_not_permitted");
    } finally {
      race.restore();
    }
    expect(await bodyOf(id)).toBe("before-upsert");
  });

  for (const atomic of [true, false]) {
    it(`POST /items/bulk, atomic: ${String(atomic)}`, async () => {
      const sourceId = `race-bulk-${String(atomic)}`;
      const { id } = await seedNote(`bulk-${String(atomic)}`, sourceId);
      const race = raceTheNextTransaction(retype(id));
      let res: Response;
      try {
        res = await request(ctx.app, "POST", "/items/bulk", {
          key: narrowKey,
          body: {
            atomic,
            items: [
              {
                type: "core.note",
                properties: { body: "after" },
                source_id: sourceId,
              },
            ],
          },
        });
        expect(race.fired()).toBe(true);
      } finally {
        race.restore();
      }
      if (atomic) {
        expect(res.status).toBe(403);
        const { error } = (await res.json()) as {
          error: { details: { code: string } };
        };
        expect(error.details.code).toBe("type_not_permitted");
      } else {
        expect(res.status).toBe(200);
        const { results } = (await res.json()) as {
          results: { outcome: string; error?: { code: string } }[];
        };
        expect(results[0]?.outcome).toBe("errored");
        expect(results[0]?.error?.code).toBe("type_not_permitted");
      }
      expect(await bodyOf(id)).toBe(`before-bulk-${String(atomic)}`);
    });
  }

  it("POST /items/bulk-actions update_properties", async () => {
    const marker = "race-action";
    const { id } = await seedNote(marker);
    const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: narrowKey,
      body: {
        action: "update_properties",
        patch: { body: "after" },
        filter: { tags: [marker] },
      },
    });
    expect(queued.status).toBe(202);
    const job = (await queued.json()) as { id: string };
    const race = raceTheNextTransaction(retype(id));
    try {
      const worker = new BulkActionWorker({
        storage: ctx.storage,
        chunkSize: 100,
        pollIntervalMs: 1,
      });
      while (await worker.runOnce()) {
        /* drain */
      }
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }
    const done = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${job.id}`,
      { key: narrowKey },
    );
    const { result } = (await done.json()) as {
      result: { succeeded: number; errors: { id: string; code: string }[] };
    };
    expect(result.succeeded).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({ id, code: "type_not_permitted" }),
    ]);
    expect(await bodyOf(id)).toBe(`before-${marker}`);
  });
});
