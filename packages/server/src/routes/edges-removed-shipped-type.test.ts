import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// A built-in edge type lives only in code, and an edge row names its type as
// a plain string with no foreign key. An instance that holds edges of a type
// the code no longer ships therefore reads them as it reads edges of a
// force-deleted custom type.
const REMOVED = "authored-by";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(): Promise<string> {
  const created = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "note" },
  });
  return created.id;
}

interface EdgeBody {
  edge: { id: string; edge_type: string };
}

interface Listing {
  data: { id: string; edge_type: string }[];
}

async function listedTypes(): Promise<string[]> {
  const res = await request(ctx.app, "GET", "/edge-types", {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map(
    (t) => t.id,
  );
}

describe("an edge type the code no longer ships", () => {
  it("is not listed, and a new edge of it is refused", async () => {
    const source = await note();
    const target = await note();

    // The witness: a shipped type takes the same request.
    const accepted = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    expect(accepted.status).toBe(201);

    const refused = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: target, edge_type: REMOVED },
    });
    expect(refused.status).toBe(404);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("edge_type_not_found");

    const types = await listedTypes();
    expect(types).toContain("about");
    expect(types).not.toContain(REMOVED);
    expect(types.filter((id) => !id.includes("."))).toHaveLength(10);
  });

  it("leaves a stored edge readable and deletable", async () => {
    const source = await note();
    const target = await note();
    // A restore is the door that writes an edge under a type nothing registers.
    const stored = await ctx.storage.edges.createRaw({
      source_id: source,
      target_id: target,
      edge_type: REMOVED,
      as_archived: true,
    });

    const read = await request(ctx.app, "GET", `/edges/${stored.id}`, {
      key: ctx.workingKey,
    });
    expect(read.status).toBe(200);
    expect(((await read.json()) as EdgeBody).edge.edge_type).toBe(REMOVED);

    for (const path of [
      `/items/${source}/edges?edge_type=${REMOVED}`,
      `/items/${target}/backrefs?edge_type=${REMOVED}`,
      `/edges?edge_type=${REMOVED}`,
    ]) {
      const listed = await request(ctx.app, "GET", path, {
        key: ctx.workingKey,
      });
      expect(listed.status, path).toBe(200);
      expect(
        ((await listed.json()) as Listing).data.map((e) => e.id),
        path,
      ).toContain(stored.id);
    }

    const removed = await request(ctx.app, "DELETE", `/edges/${stored.id}`, {
      key: ctx.workingKey,
    });
    expect(removed.status).toBe(200);

    const gone = await request(ctx.app, "GET", `/edges/${stored.id}`, {
      key: ctx.workingKey,
    });
    expect(gone.status).toBe(404);
  });
});

describe("an owner registering an edge type with the removed identifier", () => {
  it("is accepted, takes edges, and can be deleted again", async () => {
    const registered = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: {
        id: REMOVED,
        label: "Authored by",
        reverse_label: "Author of",
        cardinality: "many-to-many",
      },
    });
    expect(registered.status).toBe(201);
    try {
      const types = await request(ctx.app, "GET", "/edge-types", {
        key: ctx.workingKey,
      });
      const listed = (
        (await types.json()) as { data: { id: string; shipped: boolean }[] }
      ).data.find((t) => t.id === REMOVED);
      expect(listed?.shipped).toBe(false);

      const made = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: await note(),
          target_id: await note(),
          edge_type: REMOVED,
        },
      });
      expect(made.status).toBe(201);
    } finally {
      const deleted = await request(
        ctx.app,
        "DELETE",
        `/edge-types/${REMOVED}?force=true`,
        { key: ctx.workingKey },
      );
      expect(deleted.status).toBe(200);
    }
    expect(await listedTypes()).not.toContain(REMOVED);
  });
});
