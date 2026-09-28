import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

interface ItemResponse {
  item: { id: string; version: number };
}

interface EdgeResponse {
  edge: { id: string; version: number; properties: Record<string, unknown> };
}

interface ErrorResponse {
  error: {
    code: string;
    details?: {
      code?: string;
      constraint?: string;
      errors?: { path: string }[];
    };
  };
}

interface BulkResponse {
  results: {
    outcome: string;
    error?: ErrorResponse["error"];
  }[];
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function created<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as T;
}

async function folder(): Promise<string> {
  const res = await request(ctx.app, "POST", "/folders", {
    key: ctx.workingKey,
    body: { title: "Placement" },
  });
  return (await created<ItemResponse>(res)).item.id;
}

async function revokedFolder(): Promise<string> {
  const id = await folder();
  const res = await request(ctx.app, "POST", `/folders/${id}/revoke`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return id;
}

async function note(key: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body: "placed" } },
  });
  return (await created<ItemResponse>(res)).item.id;
}

async function place(
  source: string,
  target: string,
  properties?: Record<string, unknown>,
): Promise<Response> {
  return await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: {
      source_id: source,
      target_id: target,
      edge_type: "in-folder",
      ...(properties !== undefined && { properties }),
    },
  });
}

async function refusal(res: Response): Promise<ErrorResponse["error"]> {
  expect(res.status, await res.clone().text()).toBe(400);
  return ((await res.json()) as ErrorResponse).error;
}

describe("in-folder", () => {
  it("is written by a key holding the source's type, the edge type and read on system.folder, and writing nothing of it", async () => {
    const target = await folder();
    const blind = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
      edge_permissions: { "in-folder": "write" },
    });
    const unseen = await request(ctx.app, "POST", "/edges", {
      key: blind,
      body: {
        source_id: await note(blind),
        target_id: target,
        edge_type: "in-folder",
        properties: { path: "Notes/placed.md" },
      },
    });
    expect(unseen.status).toBe(404);
    expect(((await unseen.json()) as ErrorResponse).error.code).toBe(
      "item_not_found",
    );

    const key = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write", "system.folder": "read" },
      edge_permissions: { "in-folder": "write" },
    });
    const source = await note(key);
    const res = await request(ctx.app, "POST", "/edges", {
      key,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "in-folder",
        properties: { path: "Notes/placed.md" },
      },
    });
    const { edge } = await created<EdgeResponse>(res);
    expect(edge.properties).toEqual({ path: "Notes/placed.md" });

    // The same key reaches no door that writes the folder row itself.
    for (const [method, path, payload] of [
      ["POST", "/items", { type: "system.folder", properties: { title: "x" } }],
      ["PATCH", `/items/${target}`, { version: 1, properties: { title: "x" } }],
      ["PATCH", `/folders/${target}`, { version: 1, title: "x" }],
    ] as const) {
      const refused = await request(ctx.app, method, path, {
        key,
        body: payload,
      });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(((await refused.json()) as ErrorResponse).error.code).toBe(
        "type_not_permitted",
      );
    }
  });

  it("targets a system.folder and nothing else", async () => {
    const source = await note(ctx.workingKey);
    const other = await note(ctx.workingKey);
    const error = await refusal(await place(source, other, { path: "a.md" }));
    expect(error.code).toBe("edge_constraint_violation");
  });

  it("puts one item in two folders", async () => {
    const source = await note(ctx.workingKey);
    for (const target of [await folder(), await folder()]) {
      await created<EdgeResponse>(
        await place(source, target, { path: "Notes/a.md" }),
      );
    }
  });

  it.each([
    [undefined, "properties.path"],
    [{}, "properties.path"],
    [{ path: "" }, "properties.path"],
    [{ path: 7 }, "properties.path"],
    [{ path: "a".repeat(1025) }, "properties.path"],
    [{ path: "/Notes/a.md" }, "properties.path"],
    [{ path: "C:/Notes/a.md" }, "properties.path"],
    [{ path: "Notes\\a.md" }, "properties.path"],
    [{ path: "Notes/a\0.md" }, "properties.path"],
    [{ path: "../a.md" }, "properties.path"],
    [{ path: "Notes/../../a.md" }, "properties.path"],
    [{ path: "Notes/.." }, "properties.path"],
    [{ path: "a.md", weight: 1 }, "properties.weight"],
  ])(
    "refuses a placement with properties %j, naming %s",
    async (properties, path) => {
      const source = await note(ctx.workingKey);
      const error = await refusal(
        await place(source, await folder(), properties),
      );
      expect(error.code).toBe("validation_error");
      expect(error.details?.errors?.[0]?.path).toBe(path);
    },
  );

  it("takes a path that climbs and comes back inside", async () => {
    const source = await note(ctx.workingKey);
    await created<EdgeResponse>(
      await place(source, await folder(), { path: "Notes/../Tickets/./a.md" }),
    );
  });

  it("holds a change of properties to the same rule, on the edge door and the bulk upsert", async () => {
    const source = await note(ctx.workingKey);
    const target = await folder();
    const { edge } = await created<EdgeResponse>(
      await place(source, target, { path: "a.md" }),
    );
    for (const properties of [{ path: "../a.md" }, { path: null }, { x: 1 }]) {
      const error = await refusal(
        await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
          key: ctx.workingKey,
          body: { version: edge.version, properties },
        }),
      );
      expect(error.code).toBe("validation_error");
    }
    const bulk = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        edges: [
          {
            source_id: source,
            target_id: target,
            edge_type: "in-folder",
            properties: { path: "../b.md" },
          },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    const [upserted] = ((await bulk.json()) as BulkResponse).results;
    expect(upserted?.outcome).toBe("errored");
    expect(upserted?.error?.code).toBe("validation_error");

    // The witness: the same door takes a path inside the folder.
    const moved = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.workingKey,
      body: { version: edge.version, properties: { path: "b/a.md" } },
    });
    expect(moved.status).toBe(200);
  });

  it("is refused on every door that writes edges inline, which carry no path", async () => {
    const target = await folder();
    const created1 = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "inline" },
        edges: { "in-folder": [target] },
      },
    });
    const error = await refusal(created1);
    expect(error.code).toBe("validation_error");
    expect(error.details?.errors?.[0]?.path).toBe("properties.path");

    const source = await note(ctx.workingKey);
    const patched = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.workingKey,
      body: { version: 1, edges: { "in-folder": [target] } },
    });
    expect((await refusal(patched)).code).toBe("validation_error");

    const bulk = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        items: [
          {
            type: "core.note",
            properties: { body: "inline" },
            source_id: `in-folder-${Math.random().toString(36).slice(2, 8)}`,
            edges: { "in-folder": [target] },
          },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    const [entry] = ((await bulk.json()) as BulkResponse).results;
    expect(entry?.outcome).toBe("errored");
    expect(entry?.error?.code).toBe("validation_error");
  });

  it("takes no new placement in a revoked folder, and keeps the ones it held", async () => {
    const source = await note(ctx.workingKey);
    const target = await folder();
    const { edge } = await created<EdgeResponse>(
      await place(source, target, { path: "a.md" }),
    );
    const revoke = await request(ctx.app, "POST", `/folders/${target}/revoke`, {
      key: ctx.workingKey,
    });
    expect(revoke.status).toBe(200);

    const error = await refusal(
      await place(await note(ctx.workingKey), target, { path: "b.md" }),
    );
    expect(error.code).toBe("edge_constraint_violation");
    expect(error.details?.constraint).toBe("revoked");

    const bulk = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        edges: [
          {
            source_id: await note(ctx.workingKey),
            target_id: await revokedFolder(),
            edge_type: "in-folder",
            properties: { path: "c.md" },
          },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    const [entry] = ((await bulk.json()) as BulkResponse).results;
    expect(entry?.outcome).toBe("errored");
    expect(entry?.error?.code).toBe("edge_constraint_violation");

    const held = await request(ctx.app, "GET", `/edges/${edge.id}`, {
      key: ctx.workingKey,
    });
    expect(held.status).toBe(200);
  });

  it("gives a conflicted copy the placements of live folders, and none in a revoked one", async () => {
    const original = await note(ctx.workingKey);
    const live = await folder();
    const retired = await folder();
    await created<EdgeResponse>(await place(original, live, { path: "a.md" }));
    await created<EdgeResponse>(
      await place(original, retired, { path: "a.md" }),
    );
    const revoke = await request(
      ctx.app,
      "POST",
      `/folders/${retired}/revoke`,
      { key: ctx.workingKey },
    );
    expect(revoke.status).toBe(200);

    const won = await request(ctx.app, "PATCH", `/items/${original}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { body: "winner" } },
    });
    expect(won.status).toBe(200);
    const lost = await request(
      ctx.app,
      "PATCH",
      `/items/${original}?conflict=auto`,
      {
        key: ctx.workingKey,
        body: { version: 1, properties: { body: "loser" } },
      },
    );
    expect(lost.status).toBe(200);
    const copy = (
      (await lost.json()) as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;
    expect(copy).toBeTruthy();

    const out = await request(
      ctx.app,
      "GET",
      `/items/${copy!}/edges?edge_type=in-folder`,
      { key: ctx.workingKey },
    );
    const targets = (
      (await out.json()) as { data: { target_id: string }[] }
    ).data.map((e) => e.target_id);
    expect(targets).toContain(live);
    expect(targets).not.toContain(retired);
  });
});
