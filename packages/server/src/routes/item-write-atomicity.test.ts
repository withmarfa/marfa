/**
 * A door that makes more than one write finishes all of them or none.
 *
 * Three doors on the item write path each made several writes with nothing
 * holding them together, so a failure part-way left the row in a state no
 * caller asked for and no caller was told about. The refusal or the error
 * reaches the client either way, which is what makes these invisible: the
 * caller is told the request failed and rolls back its own copy, while the
 * server keeps half of it.
 *
 * The breakage is applied to the LAST write in each door, because that is
 * the only position from which the earlier writes have really happened. A
 * failure at the first write proves nothing — there is nothing yet to undo.
 *
 * Every assertion reads storage back rather than trusting the response.
 * Runs against whichever dialect the suite is running, so both are held to
 * one contract rather than one of them being covered.
 *
 * Separate from `rollback-event-doors.test.ts`, which holds the neighboring
 * property — that a write which is undone tells the stream nothing. That
 * file's door table records the transaction each door opens, so a door that
 * gains one here reddens there too, by design.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

class ForcedFailure extends Error {
  constructor(what: string) {
    super(`forced failure at ${what}`);
    this.name = "ForcedFailure";
  }
}

/**
 * Make one named storage write throw, and report whether it engaged.
 *
 * A guard whose probe never fired has proved nothing, so every use asserts
 * on the count. The replacement is installed on the store object the route
 * resolves per call, which is what makes it reach the handler.
 */
function breakWrite<O extends object>(
  owner: O,
  method: keyof O,
): { fired: () => number; restore: () => void } {
  const original = owner[method];
  let fired = 0;
  owner[method] = ((...args: unknown[]): never => {
    void args;
    fired += 1;
    throw new ForcedFailure(String(method));
  }) as O[typeof method];
  return {
    fired: () => fired,
    restore: () => {
      owner[method] = original;
    },
  };
}

async function readUpdatedAt(itemId: string): Promise<string | undefined> {
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = (await s.__sqliteAll(
    `SELECT updated_at FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  )) as { updated_at: string }[];
  return rows[0]?.updated_at;
}

let seq = 0;
const uniq = (p: string): string =>
  `${p}-${String(++seq)}-${String(Date.now())}`;

/** Seeded straight into the context's space, because every door below is
 *  reached with a space-bound credential and a row with no space of its own
 *  is outside what that credential can see. */
async function makeNote(body: string): Promise<string> {
  const item = await ctx.storage.items.create({
    type: "core.note",
    properties: { body },
  });
  return item.id;
}

/**
 * Plant the mirror a promotion is defined against, carrying a body no other
 * row shares. Promotion copies the properties, so counting rows with that
 * body counts the mirror plus every copy of it that survived.
 */
async function plantMirror(body: string): Promise<string> {
  const mirror = await ctx.storage.items.create({
    type: "core.note",
    properties: { body },
    source: "integration:promote-atomicity",
    source_id: uniq("mirror"),
  });
  return mirror.id;
}

async function countNotesWithBody(body: string): Promise<number> {
  const page = await ctx.storage.items.list({ type: "core.note", limit: 500 });
  return page.data.filter((i) => i.properties.body === body).length;
}

async function makeEdge(source: string, target: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.spaceKey,
    body: { source_id: source, target_id: target, edge_type: "references" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: { id: string } }).edge.id;
}

// ---------------------------------------------------------------------------
// promote: the item and the edge joining it back to its mirror
// ---------------------------------------------------------------------------

describe("POST /items/{id}/promote", () => {
  it("leaves no promoted item behind when the edge cannot be written", async () => {
    const body = uniq("promote-broken-body");
    const mirror = await plantMirror(body);
    expect(await countNotesWithBody(body)).toBe(1);

    const broken = breakWrite(ctx.storage.edges, "createRaw");
    let status: number;
    try {
      const res = await request(ctx.app, "POST", `/items/${mirror}/promote`, {
        key: ctx.spaceKey,
      });
      status = res.status;
    } finally {
      broken.restore();
    }

    expect(broken.fired()).toBe(1);
    expect(status).toBe(500);

    // The promoted copy's whole purpose is the join back to the mirror.
    // Without the edge it is an untraceable duplicate that no query relates
    // to its origin, so the copy must not survive the edge's failure.
    expect(await countNotesWithBody(body)).toBe(1);
  });

  it("writes both the copy and its edge when nothing fails", async () => {
    const body = uniq("promote-ok-body");
    const mirror = await plantMirror(body);

    const res = await request(ctx.app, "POST", `/items/${mirror}/promote`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(201);
    const promoted = (await res.json()) as { item: { id: string } };

    expect(await ctx.storage.items.get(promoted.item.id)).not.toBeNull();
    const joined = await ctx.storage.edges.listToTarget(mirror);
    expect(joined.data.map((e) => e.source_id)).toContain(promoted.item.id);
  });
});

// ---------------------------------------------------------------------------
// purge: the outbound edges, the inbound edges, and the row
// ---------------------------------------------------------------------------

describe("DELETE /items/{id}/purge", () => {
  it("keeps the edges when the item cannot be removed", async () => {
    const target = await makeNote("to purge");
    const other = await makeNote("pointing at it");
    const inbound = await makeEdge(other, target);
    const outbound = await makeEdge(target, other);
    await request(ctx.app, "DELETE", `/items/${target}`, {
      key: ctx.spaceKey,
    });

    const broken = breakWrite(ctx.storage.items, "purge");
    let status: number;
    try {
      const res = await request(ctx.app, "DELETE", `/items/${target}/purge`, {
        key: ctx.spaceKey,
      });
      status = res.status;
    } finally {
      broken.restore();
    }

    expect(broken.fired()).toBe(1);
    expect(status).toBe(500);

    // Edges are the only record that two items were related. Losing them
    // while the item survives is not recoverable from anything the caller
    // holds, and the caller was told the purge failed.
    expect(await ctx.storage.edges.get(inbound)).not.toBeNull();
    expect(await ctx.storage.edges.get(outbound)).not.toBeNull();
    expect(await ctx.storage.items.getIncludingTrashed(target)).not.toBeNull();
  });

  it("removes the row and both directions of its edges when nothing fails", async () => {
    const target = await makeNote("to purge");
    const other = await makeNote("pointing at it");
    const inbound = await makeEdge(other, target);
    const outbound = await makeEdge(target, other);
    await request(ctx.app, "DELETE", `/items/${target}`, {
      key: ctx.spaceKey,
    });

    const res = await request(ctx.app, "DELETE", `/items/${target}/purge`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    expect(await ctx.storage.edges.get(inbound)).toBeNull();
    expect(await ctx.storage.edges.get(outbound)).toBeNull();
    expect(await ctx.storage.items.getIncludingTrashed(target)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH metadata: the bound is a refusal, so it may not have written first
// ---------------------------------------------------------------------------

describe("PATCH /items/{id}/metadata", () => {
  it("refuses the over-bound patch without storing its tags", async () => {
    const item = await makeNote("bounded");
    const hundred = Array.from({ length: 100 }, (_, i) => `t${String(i)}`);
    const seeded = await request(ctx.app, "PATCH", `/items/${item}/metadata`, {
      key: ctx.spaceKey,
      body: { tags: hundred },
    });
    expect(seeded.status).toBe(200);
    const before = await readUpdatedAt(item);

    const res = await request(ctx.app, "PATCH", `/items/${item}/metadata`, {
      key: ctx.spaceKey,
      body: { tags: ["one-too-many"] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");

    // A refusal that has already changed state is the shape a client cannot
    // recover from: it rolls nothing back locally because it was told the
    // write failed.
    const stored = await ctx.storage.metadata.get(item);
    expect(stored.tags).toHaveLength(100);
    expect(stored.tags).not.toContain("one-too-many");
    // And the leaked write moved the modification time, so the rejected
    // request also showed up in a resuming client's catch-up.
    expect(await readUpdatedAt(item)).toBe(before);
  });

  it("still applies a patch that stays inside the bound", async () => {
    const item = await makeNote("bounded");
    const res = await request(ctx.app, "PATCH", `/items/${item}/metadata`, {
      key: ctx.spaceKey,
      body: { tags: ["alpha", "beta"] },
    });
    expect(res.status).toBe(200);
    const stored = await ctx.storage.metadata.get(item);
    expect(stored.tags.sort()).toEqual(["alpha", "beta"]);
  });
});
