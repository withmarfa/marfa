/**
 * An edge write is judged against the graph and the rows as they stand inside
 * the transaction that writes it, on every edge door.
 *
 * Each race commits a competing change at the moment the door opens its first
 * transaction, the latest point a check made outside that transaction could
 * have run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  raceTheNextTransaction,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";

let ctx: TestContext;
/** Write on notes, read on tasks, write on every edge type. */
let narrowKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  narrowKey = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "write", "core.task": "read" },
  });
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

const raw = () =>
  ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    __sqliteAll: (sql: string) => Promise<Record<string, unknown>[]>;
  };

async function note(body: string, key = ctx.workingKey): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

interface WireEdge {
  id: string;
  source_id: string;
  target_id: string;
  version: number;
}

function createEdge(
  source_id: string,
  target_id: string,
  edge_type: string,
  key = ctx.workingKey,
): Promise<Response> {
  return request(ctx.app, "POST", "/edges", {
    key,
    body: { source_id, target_id, edge_type },
  });
}

async function edge(
  source_id: string,
  target_id: string,
  edge_type: string,
  key = ctx.workingKey,
): Promise<WireEdge> {
  const res = await createEdge(source_id, target_id, edge_type, key);
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: WireEdge }).edge;
}

function retype(id: string): () => Promise<void> {
  return async () => {
    await raw().__sqliteRun("UPDATE items SET type = ? WHERE id = ?", [
      "core.task",
      id,
    ]);
  };
}

async function edgeEvents(
  edgeId: string,
): Promise<{ type: string; edge: WireEdge }[]> {
  const rows = await raw().__sqliteAll(
    `SELECT payload FROM event_log WHERE edge_id = '${edgeId}' ORDER BY id`,
  );
  return rows.map(
    (row) =>
      JSON.parse(row.payload as string) as { type: string; edge: WireEdge },
  );
}

async function audits(action: string, edgeId: string): Promise<number> {
  const rows = await raw().__sqliteAll(
    `SELECT id FROM audit_log WHERE action = '${action}' AND resource_id = '${edgeId}'`,
  );
  return rows.length;
}

async function parentsOf(child: string): Promise<string[]> {
  const rows = await raw().__sqliteAll(
    `SELECT source_id FROM edges WHERE target_id = '${child}' AND edge_type = 'parent-of'`,
  );
  return rows.map((row) => row.source_id as string);
}

describe("two deletes of one edge", () => {
  it("answer once 200 and once 404, with one audit record and one event", async () => {
    const made = await edge(await note("a"), await note("b"), "references");
    let first: Response | undefined;
    const race = raceTheNextTransaction(ctx.storage, async () => {
      first = await request(ctx.app, "DELETE", `/edges/${made.id}`, {
        key: ctx.workingKey,
      });
    });
    let second: Response;
    try {
      second = await request(ctx.app, "DELETE", `/edges/${made.id}`, {
        key: ctx.workingKey,
      });
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(first?.status).toBe(200);
    expect(second.status).toBe(404);
    expect(
      ((await second.json()) as { error: { code: string } }).error.code,
    ).toBe("edge_not_found");
    const deleted = (await edgeEvents(made.id)).filter(
      (event) => event.type === "edge.deleted",
    );
    expect(deleted).toHaveLength(1);
    expect(await audits("edge.delete", made.id)).toBe(1);
  });
});

describe("a delete raced by a move", () => {
  it("announces the edge with the ends it had when it was removed", async () => {
    const child = await note("child");
    const before = await note("old parent");
    const after = await note("new parent");
    const made = await edge(before, child, "parent-of");
    let moved: Response | undefined;
    const race = raceTheNextTransaction(ctx.storage, async () => {
      moved = await request(ctx.app, "PATCH", `/edges/${made.id}`, {
        key: ctx.workingKey,
        body: { source_id: after, version: made.version },
      });
    });
    let res: Response;
    try {
      res = await request(ctx.app, "DELETE", `/edges/${made.id}`, {
        key: ctx.workingKey,
      });
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(moved?.status).toBe(200);
    expect(res.status).toBe(200);
    const deleted = (await edgeEvents(made.id)).filter(
      (event) => event.type === "edge.deleted",
    );
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.edge.source_id).toBe(after);
    expect(deleted[0]?.edge.version).toBe(made.version + 1);
  });
});

describe("an edge write raced by a retype of its source", () => {
  it("POST /edges is refused for the type the source now has", async () => {
    const source = await note("source", narrowKey);
    const target = await note("target", narrowKey);
    const race = raceTheNextTransaction(ctx.storage, retype(source));
    let res: Response;
    try {
      res = await createEdge(source, target, "references", narrowKey);
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "type_not_permitted",
    );
    const rows = await raw().__sqliteAll(
      `SELECT id FROM edges WHERE source_id = '${source}'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("PATCH /edges/{id} changing only properties is refused for it", async () => {
    const source = await note("source", narrowKey);
    const made = await edge(
      source,
      await note("target", narrowKey),
      "references",
      narrowKey,
    );
    const race = raceTheNextTransaction(ctx.storage, retype(source));
    let res: Response;
    try {
      res = await request(ctx.app, "PATCH", `/edges/${made.id}`, {
        key: narrowKey,
        body: { properties: { note: "changed" }, version: made.version },
      });
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(res.status).toBe(403);
    const stored = await ctx.storage.edges.get(made.id);
    expect(stored?.version).toBe(made.version);
    expect(stored?.properties).toEqual({});
  });

  it("DELETE /edges/{id} is refused for it", async () => {
    const source = await note("source", narrowKey);
    const made = await edge(
      source,
      await note("target", narrowKey),
      "references",
      narrowKey,
    );
    const race = raceTheNextTransaction(ctx.storage, retype(source));
    let res: Response;
    try {
      res = await request(ctx.app, "DELETE", `/edges/${made.id}`, {
        key: narrowKey,
      });
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(res.status).toBe(403);
    expect(await ctx.storage.edges.get(made.id)).not.toBeNull();
    expect(await audits("edge.delete", made.id)).toBe(0);
  });
});

describe("a bulk entry raced by a create of its triple", () => {
  for (const [atomic, mode, outcome] of [
    [false, "upsert", "updated"],
    [false, "create_only", "skipped"],
    [true, "upsert", "updated"],
  ] as const) {
    it(`is judged against the edge the create wrote (atomic ${String(atomic)}, ${mode})`, async () => {
      const source = await note("source");
      const target = await note("target");
      let raced: Response | undefined;
      const race = raceTheNextTransaction(ctx.storage, async () => {
        raced = await createEdge(source, target, "references");
      });
      let res: Response;
      try {
        res = await request(ctx.app, "POST", "/edges/bulk", {
          key: ctx.workingKey,
          body: {
            atomic,
            mode,
            edges: [
              {
                source_id: source,
                target_id: target,
                edge_type: "references",
                properties: { weight: 1 },
              },
            ],
          },
        });
      } finally {
        race.restore();
      }
      expect(race.fired()).toBe(true);
      expect(raced?.status).toBe(201);
      const { edge: created } = (await raced!.json()) as { edge: WireEdge };
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { outcome: string; id?: string }[];
      };
      expect(body.results).toEqual([
        expect.objectContaining({ outcome, id: created.id }),
      ]);
      const rows = await raw().__sqliteAll(
        `SELECT id FROM edges WHERE source_id = '${source}'`,
      );
      expect(rows).toHaveLength(1);
    });
  }
});

describe("concurrent creates giving one child different parents", () => {
  it("land one parent through the single door", async () => {
    const child = await note("child");
    const parents = await Promise.all(
      Array.from({ length: 12 }, (_, i) => note(`parent ${String(i)}`)),
    );
    const answers = await Promise.all(
      parents.map((parent) => createEdge(parent, child, "parent-of")),
    );
    const statuses = answers.map((res) => res.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(11).fill(400)]);
    expect(await parentsOf(child)).toHaveLength(1);
  });

  it("land one parent through the bulk door, one entry per request", async () => {
    const child = await note("child");
    const parents = await Promise.all(
      Array.from({ length: 12 }, (_, i) => note(`parent ${String(i)}`)),
    );
    const answers = await Promise.all(
      parents.map((parent) =>
        request(ctx.app, "POST", "/edges/bulk", {
          key: ctx.workingKey,
          body: {
            atomic: false,
            edges: [
              { source_id: parent, target_id: child, edge_type: "parent-of" },
            ],
          },
        }),
      ),
    );
    const outcomes = await Promise.all(
      answers.map(async (res) => {
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          results: { outcome: string }[];
        };
        return body.results[0]?.outcome;
      }),
    );
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "errored")).toHaveLength(
      11,
    );
    expect(await parentsOf(child)).toHaveLength(1);
  });
});
