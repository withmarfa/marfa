/**
 * A bulk job announces to the space its rows belonged to, whoever ran it.
 *
 * A job records the space of the credential that started it, and a platform
 * admin has none. Every publish in this file used to take that job space, so a
 * job an admin ran over somebody else's rows published every event unscoped —
 * and `pubsub` drops an unscoped event for every space-bound subscriber while
 * passing it to the unscoped admin. The account whose rows were written was
 * the one account not told.
 *
 * On a purge that is the worst of the set: a client keeps rendering rows the
 * server no longer has, with nothing that will ever correct it, and opening
 * one reports not found. Found exactly that way, against a live instance, when
 * 2,000 rows purged by an admin stayed in an open Library for ten minutes
 * while a row created in the same space reached the same client in seconds.
 *
 * **A test that runs the job as the space's own owner passes either way** —
 * job space and row space are the same thing then — so both are here and the
 * cross-account one is the point.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Edge, Item } from "@withmarfa/shared";

const published: { type: string; spaceId?: string; id: string }[] = [];

vi.mock("../pubsub.js", () => ({
  publish: (event: { type: string; spaceId?: string; item: Item }) => {
    published.push({
      type: event.type,
      ...(event.spaceId !== undefined && { spaceId: event.spaceId }),
      id: event.item.id,
    });
    return Promise.resolve();
  },
  publishEdge: (event: { type: string; spaceId?: string; edge: Edge }) => {
    published.push({
      type: event.type,
      ...(event.spaceId !== undefined && { spaceId: event.spaceId }),
      id: event.edge.id,
    });
    return Promise.resolve();
  },
}));

const { runChunk } = await import("./runner.js");

const OWNER_SPACE = "spc_owner";

function itemIn(space: string | null, id: string): Item {
  return {
    id,
    type: "core.note",
    state: "trashed",
    tier: "library",
    properties: { title: id },
    space_id: space,
    source: "web",
    version: 1,
    schema_version: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    timestamp: "2026-01-01T00:00:00Z",
  } as unknown as Item;
}

/** Enough storage for the purge path, and nothing else. */
function storageHolding(items: Item[]) {
  return {
    runInTransaction: async (fn: () => Promise<void>) => {
      await fn();
    },
    items: {
      getMany: () => Promise.resolve(new Map(items.map((i) => [i.id, i]))),
      bulkPurge: () => Promise.resolve(items.length),
    },
    edges: {
      deleteBySourceBatch: () => Promise.resolve([]),
      deleteByTargetBatch: () => Promise.resolve([]),
    },
  } as never;
}

beforeEach(() => {
  published.length = 0;
});

describe("a bulk purge announces to the space it emptied", () => {
  it("uses the row's space when the job has none, which is how an admin runs one", async () => {
    const items = [itemIn(OWNER_SPACE, "itm_a"), itemIn(OWNER_SPACE, "itm_b")];

    await runChunk({
      storage: storageHolding(items),
      input: { action: "purge", confirm: "PURGE", filter: {} } as never,
      // A platform-admin credential is not space-bound, so this is what the
      // job carries. It is the whole case.
      spaceId: null,
      ids: items.map((i) => i.id),
    });

    expect(published).toHaveLength(2);
    for (const event of published) {
      expect(event.type).toBe("purged");
      expect(event.spaceId).toBe(OWNER_SPACE);
    }
  });

  it("is unchanged when the space's own owner runs it", async () => {
    const items = [itemIn(OWNER_SPACE, "itm_c")];

    await runChunk({
      storage: storageHolding(items),
      input: { action: "purge", confirm: "PURGE", filter: {} } as never,
      spaceId: OWNER_SPACE,
      ids: ["itm_c"],
    });

    expect(published).toEqual([
      { type: "purged", spaceId: OWNER_SPACE, id: "itm_c" },
    ]);
  });

  it("stays unscoped where the rows themselves carry no space", async () => {
    // The single-space shape, where items are stored with a null space and
    // subscribers are unscoped too. An unscoped event is what they want.
    const items = [itemIn(null, "itm_d")];

    await runChunk({
      storage: storageHolding(items),
      input: { action: "purge", confirm: "PURGE", filter: {} } as never,
      spaceId: null,
      ids: ["itm_d"],
    });

    expect(published).toEqual([{ type: "purged", id: "itm_d" }]);
  });
});
