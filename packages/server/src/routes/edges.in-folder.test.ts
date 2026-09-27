import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

interface ItemResponse {
  item: { id: string };
}

interface EdgeResponse {
  edge: { id: string; properties: Record<string, unknown> };
}

interface ErrorResponse {
  error: { code: string };
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

async function note(key: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type: "core.note", properties: { body: "placed" } },
  });
  return (await created<ItemResponse>(res)).item.id;
}

describe("in-folder", () => {
  it("is written by a key holding the source's type and the edge type, and nothing on system.folder", async () => {
    const target = await folder();
    const key = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
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
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: other, edge_type: "in-folder" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).error.code).toBe(
      "edge_constraint_violation",
    );
  });

  it("puts one item in two folders", async () => {
    const source = await note(ctx.workingKey);
    for (const target of [await folder(), await folder()]) {
      await created<EdgeResponse>(
        await request(ctx.app, "POST", "/edges", {
          key: ctx.workingKey,
          body: {
            source_id: source,
            target_id: target,
            edge_type: "in-folder",
          },
        }),
      );
    }
  });
});
