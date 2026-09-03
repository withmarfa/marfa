/**
 * A metadata write moves the item's modification time.
 *
 * Tags and extensions live in a sidecar table, so every write door here
 * used to leave `items.updated_at` exactly where it was. A client
 * resuming an incremental catch-up filters on that column, so a tag
 * change was invisible to it and the short list it got back looked
 * complete — the failure that reads as data loss and reports as nothing
 * at all.
 *
 * Every assertion reads the stored column back rather than an API
 * response. The item is forced to a fixed past timestamp first, so the
 * assertion is "the write moved it" rather than a comparison against a
 * clock the test would otherwise have to out-wait.
 *
 * Runs against whichever dialect the suite is running, so Postgres and
 * SQLite are held to one contract rather than one of them being covered.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { RUNTIME_NAMESPACE } from "../metadata-namespaces.js";

let ctx: TestContext;

const isPg = (): boolean => (process.env.DB_DIALECT ?? "sqlite") === "pg";

/** Old enough that no clock skew or test ordering could produce it. */
const PAST = "2000-01-01T00:00:00.000Z";

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Forces an item's `updated_at` via the dialect-specific escape hatch.
 * Every write path stamps `now`, so a contrived past value is the only
 * way to make "did this move" a question with a stable answer.
 */
async function forceUpdatedAt(itemId: string, iso: string): Promise<void> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(`UPDATE items SET updated_at = $1 WHERE id = $2`, [
      iso,
      itemId,
    ]);
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
      iso,
      itemId,
    ]);
  }
}

async function readUpdatedAt(itemId: string): Promise<string | undefined> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    const rows = (await s.__pgClient(
      `SELECT updated_at FROM items WHERE id = $1`,
      [itemId],
    )) as { updated_at: string }[];
    return rows[0]?.updated_at;
  }
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  // ids are well-formed hex + hyphens; safe to interpolate in this
  // test-only context (the escape hatch doesn't bind params).
  const rows = (await s.__sqliteAll(
    `SELECT updated_at FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  )) as { updated_at: string }[];
  return rows[0]?.updated_at;
}

/** A fresh item, already tagged and carrying one extension, pinned to
 *  the past so any movement is the write under test. */
async function pinnedItem(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "core.note",
      properties: { body: "metadata touches item" },
      tags: ["seed"],
    },
    undefined,
  );
  await ctx.storage.metadata.setExtension(item.id, "testapp.state", { n: 0 });
  await forceUpdatedAt(item.id, PAST);
  return item.id;
}

const writes: {
  name: string;
  run: (itemId: string) => Promise<unknown>;
}[] = [
  { name: "set", run: (id) => ctx.storage.metadata.set(id, ["alpha"]) },
  { name: "merge", run: (id) => ctx.storage.metadata.merge(id, ["bravo"]) },
  {
    name: "addTags",
    run: (id) => ctx.storage.metadata.addTags(id, ["charlie"]),
  },
  {
    name: "removeTag",
    run: (id) => ctx.storage.metadata.removeTag(id, "seed"),
  },
  {
    name: "setExtension",
    run: (id) =>
      ctx.storage.metadata.setExtension(id, "testapp.state", { n: 1 }),
  },
  {
    name: "mutateExtension",
    run: (id) =>
      ctx.storage.metadata.mutateExtension(id, "testapp.state", (cur) => ({
        ...cur,
        n: 2,
      })),
  },
  {
    name: "deleteExtension",
    run: (id) => ctx.storage.metadata.deleteExtension(id, "testapp.state"),
  },
];

describe("a metadata write moves items.updated_at", () => {
  for (const { name, run } of writes) {
    it(`${name} moves it`, async () => {
      const itemId = await pinnedItem();
      await run(itemId);
      expect(await readUpdatedAt(itemId)).not.toBe(PAST);
    });
  }
});

describe("a write no client can learn about leaves it alone", () => {
  /**
   * The reserved `connection.` root is per-Connection runtime state and
   * is deliberately silent on the event stream. Moving the item's
   * modification time for it would make the same write silent to a
   * subscriber and loud to a client catching up, which is a worse
   * disagreement than either half on its own.
   */
  it("a reserved-namespace extension write does not move it", async () => {
    const itemId = await pinnedItem();
    await ctx.storage.metadata.setExtension(itemId, RUNTIME_NAMESPACE, {
      cursor: "abc",
    });
    expect(await readUpdatedAt(itemId)).toBe(PAST);
  });

  /**
   * Both arms of one method, so the property under test is the
   * namespace predicate rather than which door was used. Without this
   * pair the suite passes whether the predicate is consulted or ignored.
   */
  it("setExtension disagrees with itself across the predicate", async () => {
    const announcing = await pinnedItem();
    const silent = await pinnedItem();

    await ctx.storage.metadata.setExtension(announcing, "testapp.state", {
      n: 1,
    });
    await ctx.storage.metadata.setExtension(silent, RUNTIME_NAMESPACE, {
      n: 1,
    });

    expect(await readUpdatedAt(announcing)).not.toBe(PAST);
    expect(await readUpdatedAt(silent)).toBe(PAST);
  });

  it("a reserved-namespace mutate and delete leave it alone too", async () => {
    const itemId = await pinnedItem();
    await ctx.storage.metadata.setExtension(itemId, RUNTIME_NAMESPACE, {
      n: 0,
    });
    await forceUpdatedAt(itemId, PAST);

    await ctx.storage.metadata.mutateExtension(
      itemId,
      RUNTIME_NAMESPACE,
      (cur) => ({ ...cur, n: 1 }),
    );
    expect(await readUpdatedAt(itemId)).toBe(PAST);

    await ctx.storage.metadata.deleteExtension(itemId, RUNTIME_NAMESPACE);
    expect(await readUpdatedAt(itemId)).toBe(PAST);
  });
});
