import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const EDGE_COUNT = 10050;
const stamp = "2026-01-01T00:00:00.000Z";

function id(prefix: string, n: number): string {
  return `${prefix}-0000-7000-a000-${String(n).padStart(12, "0")}`;
}

async function seedGraph(
  prefix: string,
  edgeType: "parent-of" | "supersedes",
  breadth: boolean,
): Promise<void> {
  const storage = ctx.storage as typeof ctx.storage & {
    __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
  };
  await storage.__sqliteRun(
    `WITH RECURSIVE nodes(n) AS (
     SELECT 0 UNION ALL SELECT n + 1 FROM nodes WHERE n < ${String(EDGE_COUNT + 2)}
     )
     INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
     SELECT printf('${prefix}-0000-7000-a000-%012d', n), 'core.note', 'active', 'library',
            jsonb('{}'), ?, ?, ?, 1 FROM nodes`,
    [stamp, stamp, stamp],
  );
  await storage.__sqliteRun(
    `WITH RECURSIVE links(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM links WHERE n < ${String(EDGE_COUNT)}
     )
     INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at, version)
     SELECT printf('${prefix}-0000-7000-b000-%012d', n),
            printf('${prefix}-0000-7000-a000-%012d', ${breadth ? "0" : "n - 1"}),
            printf('${prefix}-0000-7000-a000-%012d', n),
            ?, '{}', ?, ?, 1 FROM links`,
    [edgeType, stamp, stamp],
  );
}

async function postEdge(
  sourceId: string,
  targetId: string,
  edgeType: string,
): Promise<Response> {
  return request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: {
      source_id: sourceId,
      target_id: targetId,
      edge_type: edgeType,
    },
  });
}

describe("large edge cycles", () => {
  it("rejects a parent-of cycle past 10,000 siblings while accepting an acyclic edge", async () => {
    const prefix = "11111111";
    await seedGraph(prefix, "parent-of", true);
    const witness = await postEdge(
      id(prefix, 0),
      id(prefix, EDGE_COUNT + 1),
      "parent-of",
    );
    expect(witness.status).toBe(201);

    const cycle = await postEdge(
      id(prefix, EDGE_COUNT),
      id(prefix, 0),
      "parent-of",
    );
    expect(cycle.status).toBe(400);
    expect(
      ((await cycle.json()) as { error: { code: string } }).error.code,
    ).toBe("edge_cycle");
    expect(
      await ctx.storage.edges.listOutboundOfType(
        id(prefix, EDGE_COUNT),
        "parent-of",
      ),
    ).toHaveLength(0);
  }, 30_000);

  it("rejects a supersedes cycle deeper than 10,000 edges while accepting an acyclic edge", async () => {
    const prefix = "22222222";
    await seedGraph(prefix, "supersedes", false);
    const witness = await postEdge(
      id(prefix, EDGE_COUNT + 1),
      id(prefix, EDGE_COUNT + 2),
      "supersedes",
    );
    expect(witness.status).toBe(201);

    const cycle = await postEdge(
      id(prefix, EDGE_COUNT),
      id(prefix, 0),
      "supersedes",
    );
    expect(cycle.status).toBe(400);
    expect(
      ((await cycle.json()) as { error: { code: string } }).error.code,
    ).toBe("edge_cycle");
    expect(
      await ctx.storage.edges.listOutboundOfType(
        id(prefix, EDGE_COUNT),
        "supersedes",
      ),
    ).toHaveLength(0);
  }, 30_000);

  it.each(["parent-of", "supersedes"] as const)(
    "rejects an atomic %s cycle formed by earlier proposals and writes neither edge",
    async (edgeType) => {
      const prefix = edgeType === "parent-of" ? "33333333" : "44444444";
      const storage = ctx.storage as typeof ctx.storage & {
        __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
      };
      await storage.__sqliteRun(
        `WITH RECURSIVE nodes(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM nodes WHERE n < 1)
         INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
         SELECT printf('${prefix}-0000-7000-a000-%012d', n), 'core.note', 'active', 'library',
                jsonb('{}'), ?, ?, ?, 1 FROM nodes`,
        [stamp, stamp, stamp],
      );
      const response = await request(ctx.app, "POST", "/edges/bulk", {
        key: ctx.workingKey,
        body: {
          atomic: true,
          edges: [
            {
              source_id: id(prefix, 0),
              target_id: id(prefix, 1),
              edge_type: edgeType,
            },
            {
              source_id: id(prefix, 1),
              target_id: id(prefix, 0),
              edge_type: edgeType,
            },
          ],
        },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: { index?: number } };
      };
      expect(body.error.code).toBe("bulk_atomic_rollback");
      expect(body.error.details?.index).toBe(1);
      const stored = await ctx.storage.edges.listOutboundOfType(
        id(prefix, 0),
        edgeType,
      );
      expect(stored).toHaveLength(0);
    },
  );

  it("terminates on a preexisting cycle that cannot reach the proposed source", async () => {
    const prefix = "55555555";
    const storage = ctx.storage as typeof ctx.storage & {
      __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
    };
    await storage.__sqliteRun(
      `WITH RECURSIVE nodes(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM nodes WHERE n < 3)
       INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
       SELECT printf('${prefix}-0000-7000-a000-%012d', n), 'core.note', 'active', 'library',
              jsonb('{}'), ?, ?, ?, 1 FROM nodes`,
      [stamp, stamp, stamp],
    );
    await storage.__sqliteRun(
      `WITH links(n, source_id, target_id) AS (
         VALUES (0, ?, ?), (1, ?, ?), (2, ?, ?)
       )
       INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at, version)
       SELECT printf('${prefix}-0000-7000-b000-%012d', n), source_id, target_id,
              'parent-of', '{}', ?, ?, 1
       FROM links`,
      [
        id(prefix, 0),
        id(prefix, 1),
        id(prefix, 1),
        id(prefix, 2),
        id(prefix, 2),
        id(prefix, 1),
        stamp,
        stamp,
      ],
    );
    const response = await postEdge(id(prefix, 3), id(prefix, 0), "parent-of");
    expect(response.status).toBe(201);
  });
});
