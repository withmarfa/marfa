/**
 * Input no person would type is refused `400`, never answered `500`.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { MAX_JSON_DEPTH } from "../json-depth.js";
import { MAX_TAG_LENGTH } from "../tag-limits.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** `levels` objects nested in one another, as the JSON text a client sends. */
function nested(levels: number): string {
  return '{"a":'.repeat(levels - 1) + "{}" + "}".repeat(levels - 1);
}

async function send(
  method: string,
  path: string,
  body: string,
): Promise<Response> {
  return ctx.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "application/json",
    },
    body,
  });
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function newItem(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "odd input" } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("JSON nesting depth", () => {
  it("accepts the depth limit and refuses deeper item, extension and bulk bodies", async () => {
    const id = await newItem();
    const doors = [
      {
        method: "POST",
        path: "/items",
        status: 201,
        body: (depth: number) =>
          `{"type":"core.note","properties":{"body":"x","deep":${nested(depth - 2)}}}`,
      },
      {
        method: "PATCH",
        path: `/items/${id}`,
        status: 200,
        body: (depth: number, version: number) =>
          `{"version":${String(version)},"properties":{"deep":${nested(depth - 2)}}}`,
      },
      {
        method: "PUT",
        path: `/items/${id}/extensions/odd`,
        status: 200,
        body: (depth: number) => nested(depth),
      },
      {
        method: "POST",
        path: "/items/bulk",
        status: 200,
        body: (depth: number) =>
          `{"items":[{"type":"core.note","properties":{"body":"x","deep":${nested(depth - 4)}}}]}`,
      },
    ];
    for (const door of doors) {
      const accepted = await send(
        door.method,
        door.path,
        door.body(MAX_JSON_DEPTH, 1),
      );
      expect(accepted.status, door.path).toBe(door.status);
      if (door.path === "/items/bulk") {
        expect(await accepted.json()).toMatchObject({
          counts: { created: 1, errored: 0 },
        });
      }
      for (const depth of [MAX_JSON_DEPTH + 1, 1000]) {
        const res = await send(door.method, door.path, door.body(depth, 2));
        expect(
          res.status,
          `${door.method} ${door.path}, depth ${String(depth)}`,
        ).toBe(400);
        expect(await code(res)).toBe("validation_error");
      }
    }
  });

  it("does not count brackets inside a string", async () => {
    const res = await send(
      "POST",
      "/items",
      JSON.stringify({
        type: "core.note",
        properties: { body: "[".repeat(MAX_JSON_DEPTH * 4) },
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("a search query holding NUL", () => {
  it("is refused 400, where a query without it is answered", async () => {
    const ok = await request(ctx.app, "GET", "/search?q=odd", {
      key: ctx.workingKey,
    });
    expect(ok.status).toBe(200);
    const res = await request(ctx.app, "GET", "/search?q=odd%00input", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("validation_error");
  });
});

describe("tags", () => {
  it("are non-empty, not blank and bounded, on item create, tag and metadata writes", async () => {
    const id = await newItem();
    const fine = "a".repeat(MAX_TAG_LENGTH);
    expect(
      (
        await request(ctx.app, "POST", `/items/${id}/tags`, {
          key: ctx.workingKey,
          body: { tags: [fine] },
        })
      ).status,
    ).toBe(200);

    for (const [method, path, body, status] of [
      [
        "POST",
        "/items",
        { type: "core.note", properties: { body: "x" }, tags: [fine] },
        201,
      ],
      ["PUT", `/items/${id}/metadata`, { tags: [fine] }, 200],
      ["PATCH", `/items/${id}/metadata`, { tags: [fine] }, 200],
    ] as const) {
      expect(
        (await request(ctx.app, method, path, { key: ctx.workingKey, body }))
          .status,
        path,
      ).toBe(status);
    }

    const bad = ["", "   ", "a".repeat(MAX_TAG_LENGTH + 1)];
    for (const tag of bad) {
      const doors: [string, string, unknown][] = [
        [
          "POST",
          "/items",
          { type: "core.note", properties: { body: "x" }, tags: [tag] },
        ],
        ["POST", `/items/${id}/tags`, { tags: [tag] }],
        ["PUT", `/items/${id}/metadata`, { tags: [tag] }],
        ["PATCH", `/items/${id}/metadata`, { tags: [tag] }],
      ];
      for (const [method, path, body] of doors) {
        const res = await request(ctx.app, method, path, {
          key: ctx.workingKey,
          body,
        });
        expect(
          res.status,
          `${method} ${path} with a ${String(tag.length)}-char tag`,
        ).toBe(400);
        expect(await code(res)).toBe("validation_error");
      }
    }
  });
});

describe("property names", () => {
  it("must not be empty, on item create and patch", async () => {
    const id = await newItem();
    const withName = (name: string) => ({ body: "x", [name]: 1 });
    const fine = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { body: "changed" } },
    });
    expect(fine.status).toBe(200);

    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "core.note", properties: withName("named") },
        })
      ).status,
    ).toBe(201);
    const doors: [string, string, unknown][] = [
      ["POST", "/items", { type: "core.note", properties: withName("") }],
      ["PATCH", `/items/${id}`, { version: 2, properties: withName("") }],
    ];
    for (const [method, path, body] of doors) {
      const res = await request(ctx.app, method, path, {
        key: ctx.workingKey,
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(400);
    }
  });
});

describe("the bulk-action door", () => {
  it("refuses a tag or property name the item doors refuse, and takes the ones they take", async () => {
    await newItem();
    const act = (body: Record<string, unknown>) =>
      request(ctx.app, "POST", "/items/bulk-actions", {
        key: ctx.workingKey,
        body: { filter: { type: "core.note" }, dry_run: true, ...body },
      });
    expect((await act({ action: "update_tags", add: ["fine"] })).status).toBe(
      200,
    );
    expect(
      (await act({ action: "update_properties", patch: { body: "y" } })).status,
    ).toBe(200);

    for (const add of [[""], ["   "], ["a".repeat(MAX_TAG_LENGTH + 1)]]) {
      const res = await act({ action: "update_tags", add });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("validation_error");
    }
    const named = await act({ action: "update_properties", patch: { "": 1 } });
    expect(named.status).toBe(400);
    expect(await code(named)).toBe("validation_error");
  });
});

describe("bulk items and folder defaults", () => {
  it("accepts valid tags and property names and refuses invalid ones on each write", async () => {
    const folder = await request(ctx.app, "POST", "/folders", {
      key: ctx.workingKey,
      body: { title: "odd input" },
    });
    expect(folder.status).toBe(201);
    const { item } = (await folder.json()) as { item: { id: string } };
    const doors = [
      {
        method: "POST",
        path: "/items/bulk",
        status: 200,
        body: (fields: object) => ({
          items: [{ type: "core.note", ...fields }],
        }),
      },
      {
        method: "POST",
        path: "/folders",
        status: 201,
        body: (fields: object) => ({
          title: "odd input",
          defaults: fields,
        }),
      },
      {
        method: "PATCH",
        path: `/folders/${item.id}`,
        status: 200,
        body: (fields: object, version: number) => ({
          version,
          defaults: fields,
        }),
      },
    ];
    for (const door of doors) {
      const valid = {
        tags: ["a".repeat(MAX_TAG_LENGTH)],
        properties: { body: "x" },
      };
      const accepted = await request(ctx.app, door.method, door.path, {
        key: ctx.workingKey,
        body: door.body(valid, 1),
      });
      expect(accepted.status, door.path).toBe(door.status);
      if (door.path === "/items/bulk") {
        expect(await accepted.json()).toMatchObject({
          counts: { created: 1, errored: 0 },
        });
      }
      for (const invalid of [
        { ...valid, tags: [""] },
        { ...valid, tags: ["   "] },
        { ...valid, tags: ["a".repeat(MAX_TAG_LENGTH + 1)] },
        { ...valid, properties: { "": 1 } },
      ]) {
        const refused = await request(ctx.app, door.method, door.path, {
          key: ctx.workingKey,
          body: door.body(invalid, 2),
        });
        expect(refused.status, `${door.method} ${door.path}`).toBe(400);
        expect(await code(refused)).toBe("validation_error");
      }
    }
  });
});
