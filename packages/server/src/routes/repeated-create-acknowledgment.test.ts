/**
 * A create the server has already performed, arriving again.
 *
 * A synced client mints an id before the server has seen the row, so it
 * is the only party that can name a write it is unsure landed. When the
 * response to its create is lost it retries with the same id, and the
 * server answered 409. The client reads a conflict as transient — which
 * it is, for an update — so it retried forever, and the queue's ordering
 * meant every later edit to that item waited behind it.
 *
 * **Why this lives at the server rather than in each client.** A second
 * arrival of an id the server already holds is that client's own write.
 * Every sync engine would otherwise have to implement the same lookup —
 * catch the conflict, fetch the row, decide whether it is mine — and
 * each would get the edge cases differently. The contract answers
 * success and returns the row instead.
 *
 * The negative half is the load-bearing one and is asserted separately:
 * an acknowledgment must write nothing and emit nothing, or it is an
 * idempotent-looking write that still bumps a version and wakes every
 * other device.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId, MarfaError, ErrorCode } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  collectItemEvents,
  collectEdgeEvents,
  settle,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ItemBody {
  item: {
    id: string;
    type: string;
    version: number;
    updated_at: string;
    state: string;
    properties: Record<string, unknown>;
  };
  metadata: { tags: string[] };
  acknowledged?: boolean;
}
interface EdgeBody {
  edge: {
    id: string;
    source_id: string;
    target_id: string;
    edge_type: string;
    properties: Record<string, unknown>;
  };
  acknowledged?: boolean;
}
interface ErrorBody {
  error: { code: string; details?: { existing_id?: string } };
}

/** A note created under an id the caller chose. */
async function createNote(
  id: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", id, properties: { body: "first" }, ...body },
  });
}

describe("a repeated item create", () => {
  it("writes nothing and emits nothing", async () => {
    const id = generateId();
    const first = await createNote(id, { tags: ["kept"] });
    expect(first.status).toBe(201);
    const before = (await first.json()) as ItemBody;

    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    // A repeat carrying different properties. Nothing about it may land:
    // an acknowledgment that quietly merged would be an update wearing
    // a create's name.
    const repeat = await createNote(id, {
      properties: { body: "second" },
      tags: ["added"],
    });
    expect(repeat.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const after = (await repeat.json()) as ItemBody;
    expect(after.acknowledged).toBe(true);
    expect(after.item.id).toBe(id);
    expect(after.item.version).toBe(before.item.version);
    expect(after.item.updated_at).toBe(before.item.updated_at);
    expect(after.metadata.tags).toEqual(["kept"]);

    // And no second device is woken. A subscriber attached before the
    // repeat sees nothing for this item at all — not a create, not an
    // update.
    expect(events.filter((e) => e.item.id === id)).toHaveLength(0);

    // Read back independently of the response, so the assertion is about
    // the row rather than about what the route chose to echo.
    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    expect(((await read.json()) as ItemBody).item.properties).toEqual({
      body: "first",
    });
  });

  it("is refused when the repeat declares a different type", async () => {
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);

    const repeat = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.task", id, properties: { title: "different" } },
    });
    expect(repeat.status).toBe(409);
    // A reused id, not a declaration that disagrees: the caller minted the
    // id and it is taken by a row it is not describing, which is the same
    // mistake the edge door answers for an id naming a different triple.
    expect(((await repeat.json()) as ErrorBody).error.code).toBe("id_reused");
  });
});

describe("a repeated edge create", () => {
  async function seedItem(label: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: label } },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  it("writes nothing and emits nothing", async () => {
    const source = await seedItem("edge-quiet-source");
    const target = await seedItem("edge-quiet-target");
    const id = generateId();
    const body = {
      id,
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { note: "first" },
    };
    expect(
      (await request(ctx.app, "POST", "/edges", { key: ctx.workingKey, body }))
        .status,
    ).toBe(201);

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const repeat = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { ...body, properties: { note: "second" } },
    });
    expect(repeat.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const parsed = (await repeat.json()) as EdgeBody;
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.edge.id).toBe(id);
    // The stored properties are the first write's.
    expect(parsed.edge.properties).toEqual({ note: "first" });
    expect(events.filter((e) => e.edge.id === id)).toHaveLength(0);
  });
});

describe("the gates an acknowledgment still runs", () => {
  it("acknowledges a trashed row, in the state it holds", async () => {
    // The retry is not asking to revive it. Hiding the row instead would
    // send the create down the insert path and refuse it forever, which
    // is the natural-key branch's original bug in the id path.
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${id}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);

    const repeat = await createNote(id);
    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as ItemBody;
    expect(body.acknowledged).toBe(true);
    // The deletion stands and is visible, rather than being papered over
    // with an active-looking row.
    expect(body.item.state).toBe("trashed");
  });

  it("writes no audit row", async () => {
    // An acknowledgment writes nothing, and audit rows record writes.
    // Matching the trashed natural-key branch it sits beside.
    //
    // Scoped to this item's own id rather than counting the whole table.
    // Audit writes are fire-and-forget, so a global count races every
    // other test's pending inserts — which is exactly how this first failed.
    const id = generateId();
    expect((await createNote(id)).status).toBe(201);
    // Wait for the create's own row, so the comparison below is against a
    // settled state rather than a half-written one. It also proves the
    // read works at all: an assertion that nothing was added is vacuous
    // if the query can never see anything.
    const before = await waitForAudit(
      () => ctx.storage.audit.list({ resource_id: id, limit: 50 }),
      (rows) => rows.data.length === 1,
    );
    expect(before.data[0]?.action).toBe("item.create");

    const repeat = await createNote(id);
    expect(repeat.status).toBe(200);
    await settle();
    const after = await ctx.storage.audit.list({ resource_id: id, limit: 50 });
    expect(after.data).toHaveLength(1);
  });
});

describe("a repeated edge create under concurrency", () => {
  it("is acknowledged when the row appears after the pre-check", async () => {
    // The pre-check cannot see a row that does not exist yet, so two sends
    // of one id can both miss it and the loser of the insert reaches the
    // trap. That is what the catch behind the pre-check is for.
    //
    // Driven by blinding the pre-check once rather than by firing two real
    // requests: the test database is a single in-memory SQLite, where two
    // concurrent write transactions produce `SQLITE_BUSY` rather than the
    // collision under test. A race the harness cannot hold still is not
    // evidence about this code — the deterministic version is.
    const source = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "race-source" } },
    });
    const target = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "race-target" } },
    });
    const sourceId = ((await source.json()) as { item: { id: string } }).item
      .id;
    const targetId = ((await target.json()) as { item: { id: string } }).item
      .id;
    const id = generateId();
    const body = {
      id,
      source_id: sourceId,
      target_id: targetId,
      edge_type: "about",
    };

    expect(
      (await request(ctx.app, "POST", "/edges", { key: ctx.workingKey, body }))
        .status,
    ).toBe(201);

    // Two guards sit between the pre-check and the insert, and a real race
    // can slip past either. Blind both for one request so the insert is
    // reached against a row that is already there — which is exactly the
    // state a lost race leaves.
    //
    // `existsExactBatch` is the second one: it is what refuses an exact
    // duplicate triple with 400 before any insert, and with only the
    // pre-check blinded that 400 is what comes back rather than the
    // collision. Worth naming because it means the window this catch
    // covers is narrower than "the pre-check missed".
    const store = ctx.storage.edges;
    const realGet = store.get.bind(store);
    const realExists = store.existsExactBatch.bind(store);
    let blindedGet = false;
    let blindedExists = false;
    store.get = async (edgeId: string) => {
      if (!blindedGet) {
        blindedGet = true;
        return null;
      }
      return realGet(edgeId);
    };
    store.existsExactBatch = async (proposals) => {
      if (!blindedExists) {
        blindedExists = true;
        return new Set<string>();
      }
      return realExists(proposals);
    };
    let res: Response;
    try {
      res = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body,
      });
    } finally {
      store.get = realGet;
      store.existsExactBatch = realExists;
    }

    // Both blinds were used. Without this the test passes when the stubs
    // are never reached, which is the state a refactor that moves the
    // pre-check would leave — green, and measuring nothing.
    expect(blindedGet).toBe(true);
    expect(blindedExists).toBe(true);

    expect(res.status).toBe(200);
    const parsed = (await res.json()) as EdgeBody;
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.edge.id).toBe(id);

    const listed = await request(ctx.app, "GET", `/items/${sourceId}/edges`, {
      key: ctx.workingKey,
    });
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("a repeat sent while the first is in flight", () => {
  it("acknowledges the row the first send wrote just before this one's transaction", async () => {
    // The repeat is decided inside the transaction that would write, so the
    // first send landing at the last moment before it is a repeat like any
    // other rather than a collision.
    const id = generateId();
    const storage = ctx.storage;
    const original = storage.runInTransaction.bind(storage);
    let raced = false;
    storage.runInTransaction = async <T>(
      fn: () => T | Promise<T>,
    ): Promise<T> => {
      if (!raced) {
        raced = true;
        expect((await createNote(id)).status).toBe(201);
      }
      return await original(fn);
    };
    let res: Response;
    try {
      res = await createNote(id, { properties: { body: "the racer" } });
    } finally {
      storage.runInTransaction = original;
    }

    expect(raced).toBe(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemBody;
    expect(body.acknowledged).toBe(true);
    expect(body.item.id).toBe(id);
    expect(body.item.properties).toEqual({ body: "first" });
  });

  it("does not acknowledge a conflict raised about a different id", async () => {
    // The catch is pinned to `existing_id` matching the id this request
    // sent. Without that equality any CONFLICT surfacing from inside the
    // transaction would be answered with whatever row the lookup happened
    // to find — a 200 for a write that did not happen.
    const id = generateId();
    const store = ctx.storage.items;
    const realCreate = store.create.bind(store);
    store.create = () =>
      Promise.reject(
        new MarfaError(
          ErrorCode.CONFLICT,
          "Item with id=someone-else already exists",
          { existing_id: generateId() },
        ),
      );
    let res: Response;
    try {
      res = await createNote(id);
    } finally {
      store.create = realCreate;
    }
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("conflict");
  });
});
