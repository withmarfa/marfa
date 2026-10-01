import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestContext, request, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});

const RUN = Math.random().toString(36).slice(2, 8);

/**
 * Holds a delete door just after it asked whether anything uses the type,
 * so a write can be sent while the door stands between that answer and the
 * delete. `reached` settles when the door has its answer; `release` lets it
 * go on.
 */
function holdAfter(target: { list: (...args: never[]) => Promise<unknown> }): {
  reached: Promise<void>;
  release: () => void;
} {
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = target.list.bind(target);
  const spy = vi
    .spyOn(target, "list")
    .mockImplementation(async (...args: never[]) => {
      const answer = await original(...args);
      spy.mockRestore();
      arrive();
      await gate;
      return answer;
    });
  return { reached, release };
}

async function rowsNaming(sql: string, id: string): Promise<number> {
  const rows = (await (
    ctx.storage as unknown as {
      __sqliteAll: (query: string) => Promise<unknown[]>;
    }
  ).__sqliteAll(sql.replace("?", `'${id}'`))) as { n: number }[];
  return rows[0]?.n ?? 0;
}

describe("DELETE /types/{id} — the check and the delete are one transaction", () => {
  it("leaves no item of the type when one is written while the door stands between them", async () => {
    const type = `acme.atomic_del_${RUN}`;
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: type,
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
    });
    expect(registered.status).toBe(201);

    const hold = holdAfter(ctx.storage.items);
    const deleting = request(ctx.app, "DELETE", `/types/${type}`, {
      key: ctx.workingKey,
    });
    await hold.reached;

    const writing = request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties: { name: "written while held" } },
    });
    await settle(100);
    hold.release();

    const [deleted, written] = await Promise.all([deleting, writing]);
    expect(deleted.status).toBe(200);
    expect(written.status).toBe(400);
    const body = (await written.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_type");
    expect(
      await rowsNaming("SELECT count(*) AS n FROM items WHERE type = ?", type),
    ).toBe(0);
  });

  // A best-effort page opens no transaction of its own around the entry, so
  // only the store's own check stands between the entry and the delete.
  it("leaves no item of the type when a best-effort bulk entry is written while the door stands between them", async () => {
    const type = `acme.atomic_bulk_${RUN}`;
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: type,
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
    });
    expect(registered.status).toBe(201);

    const hold = holdAfter(ctx.storage.items);
    const deleting = request(ctx.app, "DELETE", `/types/${type}`, {
      key: ctx.workingKey,
    });
    await hold.reached;

    const writing = request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        items: [{ type, properties: { name: "written while held" } }],
      },
    });
    await settle(100);
    hold.release();

    const [deleted, written] = await Promise.all([deleting, writing]);
    expect(deleted.status).toBe(200);
    expect(written.status).toBe(200);
    const body = (await written.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.results[0]?.outcome).toBe("errored");
    expect(body.results[0]?.error?.code).toBe("unknown_type");
    expect(
      await rowsNaming("SELECT count(*) AS n FROM items WHERE type = ?", type),
    ).toBe(0);
  });

  it("answers the second of two deletes in flight 404", async () => {
    const type = `acme.atomic_twice_${RUN}`;
    await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: type,
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
    });
    const statuses = (
      await Promise.all(
        [0, 1].map(() =>
          request(ctx.app, "DELETE", `/types/${type}`, {
            key: ctx.workingKey,
          }),
        ),
      )
    )
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([200, 404]);
  });

  it("refuses the delete when the write lands first", async () => {
    const type = `acme.atomic_first_${RUN}`;
    await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: type,
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
    });
    const written = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties: { name: "first" } },
    });
    expect(written.status).toBe(201);

    const deleted = await request(ctx.app, "DELETE", `/types/${type}`, {
      key: ctx.workingKey,
    });
    expect(deleted.status).toBe(409);
    const body = (await deleted.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_in_use");
    const read = await request(ctx.app, "GET", `/types/${type}`, {
      key: ctx.workingKey,
    });
    expect(read.status).toBe(200);
  });
});

describe("DELETE /edge-types/{id} — the check and the delete are one transaction", () => {
  async function note(title: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { title, body: title } },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  async function twoNotes(): Promise<[string, string]> {
    return [await note("source"), await note("target")];
  }

  it("leaves no edge of the type when one is written while the door stands between them", async () => {
    const edgeType = `acme.atomic-del-${RUN}`;
    const registered = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: { id: edgeType, cardinality: "many-to-many" },
    });
    expect(registered.status).toBe(201);
    const [source, target] = await twoNotes();

    const hold = holdAfter(ctx.storage.edges);
    const deleting = request(ctx.app, "DELETE", `/edge-types/${edgeType}`, {
      key: ctx.workingKey,
    });
    await hold.reached;

    const writing = request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: target, edge_type: edgeType },
    });
    await settle(100);
    hold.release();

    const [deleted, written] = await Promise.all([deleting, writing]);
    expect(deleted.status).toBe(200);
    expect(written.status).toBe(404);
    const body = (await written.json()) as { error: { code: string } };
    expect(body.error.code).toBe("edge_type_not_found");
    expect(
      await rowsNaming(
        "SELECT count(*) AS n FROM edges WHERE edge_type = ?",
        edgeType,
      ),
    ).toBe(0);
  });

  it("leaves no edge of the type when a best-effort bulk entry is written while the door stands between them", async () => {
    const edgeType = `acme.atomic-bulk-${RUN}`;
    const registered = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: { id: edgeType, cardinality: "many-to-many" },
    });
    expect(registered.status).toBe(201);
    const [source, target] = await twoNotes();

    const hold = holdAfter(ctx.storage.edges);
    const deleting = request(ctx.app, "DELETE", `/edge-types/${edgeType}`, {
      key: ctx.workingKey,
    });
    await hold.reached;

    const writing = request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        edges: [{ source_id: source, target_id: target, edge_type: edgeType }],
      },
    });
    await settle(100);
    hold.release();

    const [deleted, written] = await Promise.all([deleting, writing]);
    expect(deleted.status).toBe(200);
    expect(written.status).toBe(200);
    const body = (await written.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.results[0]?.outcome).toBe("errored");
    expect(body.results[0]?.error?.code).toBe("edge_type_not_found");
    expect(
      await rowsNaming(
        "SELECT count(*) AS n FROM edges WHERE edge_type = ?",
        edgeType,
      ),
    ).toBe(0);
  });

  it("answers the second of two deletes in flight 404", async () => {
    const edgeType = `acme.atomic-twice-${RUN}`;
    await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: { id: edgeType, cardinality: "many-to-many" },
    });
    const statuses = (
      await Promise.all(
        [0, 1].map(() =>
          request(ctx.app, "DELETE", `/edge-types/${edgeType}`, {
            key: ctx.workingKey,
          }),
        ),
      )
    )
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([200, 404]);
  });

  it("refuses the delete when the write lands first", async () => {
    const edgeType = `acme.atomic-first-${RUN}`;
    await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: { id: edgeType, cardinality: "many-to-many" },
    });
    const [source, target] = await twoNotes();
    const written = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: target, edge_type: edgeType },
    });
    expect(written.status).toBe(201);

    const deleted = await request(
      ctx.app,
      "DELETE",
      `/edge-types/${edgeType}`,
      { key: ctx.workingKey },
    );
    expect(deleted.status).toBe(409);
    const body = (await deleted.json()) as { error: { code: string } };
    expect(body.error.code).toBe("edge_type_in_use");
  });
});
