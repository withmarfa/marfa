/**
 * Input no person would type is refused `400`, never answered `500`.
 *
 * Every case first writes the nearest accepted input, so a refusal cannot be
 * a door that was never reaching the write at all.
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
  it("stores a body at the limit and refuses one past it, on a create", async () => {
    const at = `{"type":"core.note","properties":{"body":"x","deep":${nested(MAX_JSON_DEPTH - 2)}}}`;
    expect((await send("POST", "/items", at)).status).toBe(201);

    const past = `{"type":"core.note","properties":{"body":"x","deep":${nested(MAX_JSON_DEPTH - 1)}}}`;
    const res = await send("POST", "/items", past);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("validation_error");
  });

  it("refuses 1,000 levels on a create and on a patch", async () => {
    const id = await newItem();
    const create = await send(
      "POST",
      "/items",
      `{"type":"core.note","properties":{"body":"x","deep":${nested(1000)}}}`,
    );
    expect(create.status).toBe(400);
    const patch = await send(
      "PATCH",
      `/items/${id}`,
      `{"properties":{"deep":${nested(1000)}}}`,
    );
    expect(patch.status).toBe(400);
  });

  it("refuses 1,200 levels on the extensions door", async () => {
    const id = await newItem();
    const res = await send("PUT", `/items/${id}/extensions/odd`, nested(1200));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("validation_error");
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
  it("are non-empty, not blank and bounded, on every door that takes one", async () => {
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
  it("must not be empty, on every door that writes properties", async () => {
    const id = await newItem();
    const withName = (name: string) => ({ body: "x", [name]: 1 });
    const fine = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { body: "changed" } },
    });
    expect(fine.status).toBe(200);

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
