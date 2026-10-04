import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ofetch } from "ofetch";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackFolder,
  cleanup,
} from "../../utils/setup.js";
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
  const data = res._data as
    | {
        error?: { code?: string };
        item?: { id: string };
        results?: { id?: string }[];
        counts?: { created: number; errored: number };
      }
    | undefined;
  if (res.ok && method === "POST") {
    if (path === "/folders" && data?.item) trackFolder(ctx, data.item.id);
    if (path === "/items" && data?.item) trackItem(ctx, data.item.id);
    if (path === "/items/bulk") {
      expect(data?.counts).toMatchObject({ created: 1, errored: 0 });
      for (const result of data?.results ?? []) {
        if (result.id) trackItem(ctx, result.id);
      }
    }
  }
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
  it("accepts 64 levels and refuses deeper item, extension and bulk bodies", async () => {
    const id = await newNote();
    const doors = [
      {
        method: "POST",
        path: "/items",
        status: 201,
        body: (depth: number) =>
          `{"type":"core.note","source":"${ctx.source}","properties":{"body":"x","deep":${nested(depth - 2)}}}`,
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
          `{"items":[{"type":"core.note","source":"${ctx.source}","properties":{"body":"x","deep":${nested(depth - 4)}}}]}`,
      },
    ];
    for (const door of doors) {
      expect(
        (await send(door.method, door.path, door.body(64, 1))).status,
        door.path,
      ).toBe(door.status);
      for (const depth of [65, 1000]) {
        const res = await send(door.method, door.path, door.body(depth, 2));
        expect(
          res.status,
          `${door.method} ${door.path}, depth ${String(depth)}`,
        ).toBe(400);
        expect(res.code).toBe("validation_error");
      }
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
    for (const [method, path, body, status] of [
      [
        "POST",
        "/items",
        {
          type: "core.note",
          source: ctx.source,
          properties: { body: "x" },
          tags: ["a".repeat(128)],
        },
        201,
      ],
      ["PUT", `/items/${id}/metadata`, { tags: ["a".repeat(128)] }, 200],
      ["PATCH", `/items/${id}/metadata`, { tags: ["a".repeat(128)] }, 200],
    ] as const) {
      expect(
        (await send(method, path, JSON.stringify(body))).status,
        path,
      ).toBe(status);
    }
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
    expect(
      (
        await send(
          "POST",
          "/items",
          JSON.stringify({
            type: "core.note",
            source: ctx.source,
            properties: { body: "x", named: 1 },
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await send(
          "PATCH",
          `/items/${id}`,
          JSON.stringify({ version: 1, properties: { body: "changed" } }),
        )
      ).status,
    ).toBe(200);
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
      `{"version":2,"properties":${named}}`,
    );
    expect(patch.status).toBe(400);
    expect(patch.code).toBe("validation_error");
  });
});

describe("the bulk-action door", () => {
  it("refuses a tag or property name the item doors refuse", async () => {
    const act = (body: object) =>
      send(
        "POST",
        "/items/bulk-actions",
        JSON.stringify({
          filter: { type: "core.note" },
          dry_run: true,
          ...body,
        }),
      );
    expect((await act({ action: "update_tags", add: ["fine"] })).status).toBe(
      200,
    );
    for (const add of [[""], ["   "], ["a".repeat(129)]]) {
      const r = await act({ action: "update_tags", add });
      expect(r.status).toBe(400);
      expect(r.code).toBe("validation_error");
    }
    expect(
      (await act({ action: "update_properties", patch: { body: "y" } })).status,
    ).toBe(200);
    const named = await act({ action: "update_properties", patch: { "": 1 } });
    expect(named.status).toBe(400);
    expect(named.code).toBe("validation_error");
  });
});

describe("bulk items and folder defaults", () => {
  it("accepts valid tags and property names and refuses invalid ones on each write", async () => {
    const created = await client.createFolder({ title: "odd input" });
    expect(created.ok).toBe(true);
    const id = created.data.item.id;
    trackFolder(ctx, id);
    const doors = [
      {
        method: "POST",
        path: "/items/bulk",
        status: 200,
        body: (fields: object) => ({
          items: [{ type: "core.note", source: ctx.source, ...fields }],
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
        path: `/folders/${id}`,
        status: 200,
        body: (fields: object, version: number) => ({
          version,
          defaults: fields,
        }),
      },
    ];
    for (const door of doors) {
      const valid = { tags: ["a".repeat(128)], properties: { body: "x" } };
      expect(
        (
          await send(
            door.method,
            door.path,
            JSON.stringify(door.body(valid, 1)),
          )
        ).status,
        door.path,
      ).toBe(door.status);
      for (const invalid of [
        { ...valid, tags: [""] },
        { ...valid, tags: ["   "] },
        { ...valid, tags: ["a".repeat(129)] },
        { ...valid, properties: { "": 1 } },
      ]) {
        const refused = await send(
          door.method,
          door.path,
          JSON.stringify(door.body(invalid, 2)),
        );
        expect(refused.status, `${door.method} ${door.path}`).toBe(400);
        expect(refused.code).toBe("validation_error");
      }
    }
  });
});
