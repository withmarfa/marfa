import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ofetch } from "ofetch";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({
    ctx,
    client,
    apiUrl: baseUrl,
    apiKey,
  } = await createTestContext("compliance", "odd-input"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** `levels` objects nested in one another, as JSON text. */
function nested(levels: number): string {
  return '{"a":'.repeat(levels - 1) + "{}" + "}".repeat(levels - 1);
}

async function send(
  method: string,
  path: string,
  body: string,
): Promise<{ status: number; code?: string }> {
  const res = await ofetch.raw(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    ignoreResponseError: true,
  });
  const data = res._data as { error?: { code?: string } } | undefined;
  return { status: res.status, code: data?.error?.code };
}

async function newNote(): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: "odd input" } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("odd input is refused, never answered 500", () => {
  it("stores a body 64 levels deep and refuses one 65 deep, on every door that stores JSON", async () => {
    const id = await newNote();
    const body = (levels: number) =>
      `{"type":"core.note","source":"${ctx.source}","properties":{"body":"x","deep":${nested(levels)}}}`;

    const at = await send("POST", "/items", body(62));
    expect(at.status).toBe(201);

    const refused = [
      await send("POST", "/items", body(63)),
      await send("POST", "/items", body(1000)),
      await send(
        "PATCH",
        `/items/${id}`,
        `{"version":1,"properties":{"deep":${nested(1000)}}}`,
      ),
      await send("PUT", `/items/${id}/extensions/odd`, nested(1200)),
    ];
    for (const r of refused) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("validation_error");
    }
  });

  it("refuses a search query holding a NUL, and answers one without", async () => {
    const ok = await ofetch.raw(`${baseUrl}/search?q=odd`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      ignoreResponseError: true,
    });
    expect(ok.status).toBe(200);
    const res = await ofetch.raw(`${baseUrl}/search?q=odd%00input`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      ignoreResponseError: true,
    });
    expect(res.status).toBe(400);
    expect((res._data as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );
  });

  it("refuses an empty, blank or over-long tag, and takes one of 128 characters", async () => {
    const id = await newNote();
    const tags = (tag: string) => JSON.stringify({ tags: [tag] });
    expect(
      (await send("POST", `/items/${id}/tags`, tags("a".repeat(128)))).status,
    ).toBe(200);
    for (const tag of ["", "   ", "a".repeat(129)]) {
      for (const [method, path] of [
        ["POST", `/items/${id}/tags`],
        ["PUT", `/items/${id}/metadata`],
        ["PATCH", `/items/${id}/metadata`],
      ] as const) {
        const r = await send(method, path, tags(tag));
        expect(r.status, `${method} ${path}, ${tag.length} characters`).toBe(
          400,
        );
        expect(r.code).toBe("validation_error");
      }
      const create = await send(
        "POST",
        "/items",
        JSON.stringify({
          type: "core.note",
          source: ctx.source,
          properties: { body: "x" },
          tags: [tag],
        }),
      );
      expect(create.status).toBe(400);
      expect(create.code).toBe("validation_error");
    }
  });

  it("refuses a property named with no characters", async () => {
    const id = await newNote();
    const named = JSON.stringify({ body: "x", "": 1 });
    const create = await send(
      "POST",
      "/items",
      `{"type":"core.note","source":"${ctx.source}","properties":${named}}`,
    );
    expect(create.status).toBe(400);
    expect(create.code).toBe("validation_error");
    const patch = await send(
      "PATCH",
      `/items/${id}`,
      `{"version":1,"properties":${named}}`,
    );
    expect(patch.status).toBe(400);
    expect(patch.code).toBe("validation_error");
  });
});
