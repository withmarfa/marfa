/**
 * A write computed from an unlocked read can erase a concurrent commit.
 *
 * `update()` reads the row, merges the incoming properties over what it
 * read, and writes the merge back. Under READ COMMITTED a concurrent
 * update can commit between that read and that write, and the merge then
 * reverts every property the concurrent commit changed — the shape in
 * which a background sweeper write erased a user's edit made milliseconds
 * earlier. SQLite is immune (its transaction takes an immediate lock);
 * Postgres needs the row locked at the read.
 *
 * The interleave is driven deterministically: a wrapped version store
 * pauses the first update inside its transaction, after the row read, so
 * the test can land a concurrent title edit exactly inside the window.
 * The pause hangs off the snapshot write, which every property update
 * performs between reading the row and writing the merge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { PgItemStore } from "./item-store.js";
import type { PgVersionStore } from "./version-store.js";
import type { PgSearchStore } from "./search-store.js";
import type { PgDb } from "./connection.js";

const isPg = process.env.DB_DIALECT === "pg";

describe.skipIf(!isPg)("pg update read-modify-write race", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("cannot revert a concurrent edit committed mid-transaction", async () => {
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "original body", title: "original title" },
      },
    });
    expect(create.status).toBe(201);
    const { item } = (await create.json()) as { item: { id: string } };

    const storage = ctx.storage as typeof ctx.storage & {
      pgDb: PgDb;
    };

    // A second item store over the same database, with a version store
    // that pauses once inside update()'s transaction — after the row read,
    // before the write.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let pauseArmed = true;
    let paused: (() => void) | null = null;
    const pausedReached = new Promise<void>((resolve) => {
      paused = resolve;
    });

    const baseVersionStore = (
      storage.items as unknown as { versionStore: PgVersionStore }
    ).versionStore;
    const gatedVersionStore = new Proxy(baseVersionStore, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === "create" && typeof value === "function") {
          return async (...args: unknown[]) => {
            if (pauseArmed) {
              pauseArmed = false;
              paused?.();
              await gate;
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const searchStore = (
      storage.items as unknown as { searchStore: PgSearchStore }
    ).searchStore;
    const gatedItemStore = new PgItemStore(
      storage.pgDb,
      gatedVersionStore,
      searchStore,
    );

    // The sweeper-shaped write: merges one property, pauses mid-transaction.
    const sweeperWrite = gatedItemStore.update(item.id, {
      properties: { extracted_text: "swept text" },
    });

    // Land a user edit exactly inside the paused window.
    await pausedReached;
    const userEdit = request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "edited while sweeping" } },
    });
    // The edit must be given time to reach the database. With the row
    // locked it blocks there until the sweeper commits; without the lock
    // it commits inside the window and the sweeper's merge erases it.
    // A fixed wait is deliberate: the blocked edit is invisible from
    // outside, so there is no condition to poll, and the wait's failure
    // direction under load is a vacuous pass on broken code, never a
    // false failure on correct code.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseGate();

    const [sweeperResult, userResult] = await Promise.all([
      sweeperWrite,
      userEdit,
    ]);
    expect("id" in sweeperResult).toBe(true);
    expect(userResult.status).toBe(200);

    const after = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    const data = (await after.json()) as {
      item: { properties: Record<string, unknown> };
    };
    // Both writes survive: the edit was not reverted by the merge computed
    // from the pre-edit read, and the swept text landed.
    expect(data.item.properties.title).toBe("edited while sweeping");
    expect(data.item.properties.extracted_text).toBe("swept text");
  });
});
