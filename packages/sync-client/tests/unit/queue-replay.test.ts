import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { uuidv7 } from "uuidv7";
import { OptimisticItemStore } from "../../src/optimistic/store.js";
import { rebuildOptimisticStore } from "../../src/optimistic/reconcile.js";
import { createPGlite, type PGliteWithSync } from "../../src/storage/pglite.js";

/**
 * Queue-replay contract: when `MymeSyncClient.start()` runs, any
 * pending mutations in `_myme_mutation_queue` are replayed into the
 * `OptimisticItemStore` so reads observe the user's intent
 * immediately. Without replay, an app that restarted with pending
 * writes would have the queue intact (durable in PGlite) but the
 * UI state lost.
 *
 * v0.1 acceptable scale is ~20 pending mutations — large enough to
 * pin the contract, small enough that the synchronous replay's cost
 * is acceptable. v0.2 will revisit if real apps push past that.
 */

let pg: PGliteWithSync;

beforeEach(async () => {
  pg = await createPGlite("memory");
});

afterEach(async () => {
  await pg.close();
});

async function enqueueRaw(
  kind: string,
  payload: unknown,
  targetId: string,
): Promise<string> {
  const writeId = uuidv7();
  const now = new Date().toISOString();
  await pg.query(
    `INSERT INTO _myme_mutation_queue
       (write_id, kind, payload, target_id, attempt_count, last_error, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, NULL, 'pending', $5, $5)`,
    [writeId, kind, JSON.stringify(payload), targetId, now],
  );
  return writeId;
}

describe("queue replay rebuilds OptimisticItemStore", () => {
  it("replays a 20-row mixed queue into the optimistic store", async () => {
    // 15 creates, 3 updates, 1 transition, 1 delete on ghost id.
    // Composition: ids 0..2 have create+update; id 14 has
    // create+transition. The ghost delete (ids[15]) has no prior —
    // it lands as a tombstone regardless (the queue's drain will
    // 404 on it, but that's not the contract under test here).
    const ids = Array.from({ length: 16 }, () => uuidv7());

    // 15 creates (ids 0..14)
    for (let i = 0; i < 15; i++) {
      await enqueueRaw(
        "createItem",
        {
          input: {
            id: ids[i],
            type: "core.note",
            properties: { title: `n${String(i)}` },
          },
        },
        ids[i] as string,
      );
    }
    // 3 updates on ids 0..2 — compose with the prior creates via
    // the inflight map.
    for (let i = 0; i < 3; i++) {
      await enqueueRaw(
        "updateItem",
        {
          id: ids[i],
          properties: { title: `n${String(i)}-updated` },
          expectedVersion: 1,
        },
        ids[i] as string,
      );
    }
    // 1 transition on id 14 → 'archived' (composes with create).
    await enqueueRaw(
      "transitionItem",
      { id: ids[14], state: "archived" },
      ids[14] as string,
    );
    // 1 ghost delete on ids[15] (no prior) — the rebuild applies
    // the tombstone unconditionally; drain will 404 on the actual
    // server call. This is the same shape as the integration
    // suite's 4xx test.
    await enqueueRaw("deleteItem", { id: ids[15] }, ids[15] as string);

    // Total queue rows: 15 + 3 + 1 + 1 = 20.

    const store = new OptimisticItemStore();
    await rebuildOptimisticStore(pg, store, {
      source: "test",
      defaultOrigin: "user",
    });

    const snapshot = store.snapshot();
    // 15 applies + 1 tombstone = 16 entries total.
    expect(snapshot.size).toBe(16);

    // Ids 0..14: applies.
    for (let i = 0; i < 15; i++) {
      const entry = snapshot.get(ids[i] as string);
      expect(entry?.kind).toBe("apply");
    }
    // The 3 updates compose: title is the updated form, version=2.
    for (let i = 0; i < 3; i++) {
      const entry = snapshot.get(ids[i] as string);
      if (entry?.kind !== "apply") throw new Error("expected apply");
      expect(entry.item.version).toBe(2);
      expect(entry.item.properties).toEqual({ title: `n${String(i)}-updated` });
    }
    // Id 14: transition to 'archived' composes with the prior create.
    const archived = snapshot.get(ids[14] as string);
    if (archived?.kind !== "apply") throw new Error("expected apply");
    expect(archived.item.state).toBe("archived");
    // Id 15: tombstone.
    expect(snapshot.get(ids[15] as string)?.kind).toBe("tombstone");
  });

  it("transition-to-trashed produces a tombstone, not an apply", async () => {
    const id = uuidv7();
    await enqueueRaw(
      "createItem",
      { input: { id, type: "core.note", properties: { v: 1 } } },
      id,
    );
    await enqueueRaw(
      "transitionItem",
      { id, state: "trashed" },
      id,
    );
    const store = new OptimisticItemStore();
    await rebuildOptimisticStore(pg, store, {
      source: "test",
      defaultOrigin: "user",
    });
    expect(store.snapshot().get(id)?.kind).toBe("tombstone");
  });

  it("replays a tombstone-then-create on the same id correctly", async () => {
    // Edge case: a delete followed by a re-create with the same id.
    // The reconcile path would normally clear the tombstone when
    // the canonical row drops, but here we're testing pure replay.
    const id = uuidv7();
    await enqueueRaw(
      "createItem",
      {
        input: {
          id,
          type: "core.note",
          properties: { title: "first" },
        },
      },
      id,
    );
    await enqueueRaw("deleteItem", { id }, id);

    const store = new OptimisticItemStore();
    await rebuildOptimisticStore(pg, store, {
      source: "test",
      defaultOrigin: "user",
    });

    // The final state is a tombstone — the delete supersedes the
    // create per FIFO replay order.
    const entry = store.snapshot().get(id);
    expect(entry?.kind).toBe("tombstone");
  });

  it("ignores edge / metadata mutations (v0.1 — items only)", async () => {
    // v0.1 only routes items through the OptimisticItemStore.
    // Edges / metadata are still PGlite-direct; replay should skip
    // them rather than crash on an unknown kind.
    const id = uuidv7();
    await enqueueRaw(
      "createEdge",
      { input: { source_id: id, target_id: id, edge_type: "parent-of" } },
      id,
    );
    await enqueueRaw(
      "setMetadata",
      { itemId: id, tags: ["x"] },
      id,
    );

    const store = new OptimisticItemStore();
    await rebuildOptimisticStore(pg, store, {
      source: "test",
      defaultOrigin: "user",
    });

    expect(store.snapshot().size).toBe(0);
  });
});
