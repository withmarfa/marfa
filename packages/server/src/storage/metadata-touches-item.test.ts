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

/**
 * `setExtensions` is `setExtension` applied to a set, and the only caller
 * it has writes to a freshly created item — so the existing extensions map
 * is always empty there and the merge half of the contract is exercised by
 * nothing. A rewrite from merge to replace would contradict the door's own
 * documentation and pass every other test in the repository.
 *
 * The announce predicate is asked once for the whole set rather than once
 * per namespace, which is a second rule the per-namespace door does not
 * have. Both arms are held below, and the mixed set is the one that
 * separates "any member announces" from "every member announces".
 */
describe("setExtensions writes a whole set at once", () => {
  const OTHER = "otherapp.data";

  it("merges into the existing map rather than replacing it", async () => {
    // `pinnedItem` leaves `testapp.state` already set, which is the
    // fixture the archive restore never produces.
    const itemId = await pinnedItem();

    const { extensions } = await ctx.storage.metadata.setExtensions(itemId, {
      [OTHER]: { b: 1 },
    });

    // Answered and stored have to agree, and both have to carry the
    // namespace the write never mentioned.
    expect(extensions).toEqual({
      "testapp.state": { n: 0 },
      [OTHER]: { b: 1 },
    });
    expect(await ctx.storage.metadata.getExtensions(itemId)).toEqual({
      "testapp.state": { n: 0 },
      [OTHER]: { b: 1 },
    });
  });

  it("replaces a namespace it does name, whole", async () => {
    const itemId = await pinnedItem();
    await ctx.storage.metadata.setExtensions(itemId, {
      "testapp.state": { replaced: true },
    });
    // `setExtension`'s rule, not `mutateExtension`'s: the previous `n` is
    // gone rather than merged with.
    expect(await ctx.storage.metadata.getExtensions(itemId)).toEqual({
      "testapp.state": { replaced: true },
    });
  });

  it("moves the modification time, and answers the value it wrote", async () => {
    const itemId = await pinnedItem();
    const { updated_at } = await ctx.storage.metadata.setExtensions(itemId, {
      "testapp.one": { a: 1 },
      "testapp.two": { b: 2 },
    });
    const stored = await readUpdatedAt(itemId);
    expect(stored).not.toBe(PAST);
    // The answer is what the caller announces the item with, so it has to
    // be the row's value rather than merely a plausible timestamp.
    expect(updated_at).toBe(stored);
  });

  it("an empty set writes nothing at all", async () => {
    const itemId = await pinnedItem();
    const { extensions, updated_at } = await ctx.storage.metadata.setExtensions(
      itemId,
      {},
    );
    expect(await readUpdatedAt(itemId)).toBe(PAST);
    expect(updated_at).toBeNull();
    expect(extensions).toEqual({ "testapp.state": { n: 0 } });
  });
});
