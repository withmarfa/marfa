import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ITEM_PROPERTY_BAGS } from "./item-property-numbers.js";
import { createTestContext, inlineOpenApiRefs, request } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { index?: number; errors?: { field: string; message: string }[] };
  };
}

/** The text of a request, sent as it is: `JSON.stringify` could not carry the digits. */
async function send(
  method: string,
  path: string,
  text: string,
): Promise<Response> {
  return await ctx.app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.workingKey}`,
    },
    body: text,
  });
}

/** The digits a float serves for each number a write is refused for. */
const KEPT_AS: Record<string, string> = {
  "1500000000000000001": "1500000000000000000",
  "9223372036854775807": "9223372036854776000",
  "-9007199254740993": "-9007199254740992",
  "1152921504606846976": "1152921504606847000",
  "-0": "0",
};

function refusal(source: string): string {
  return `Must be a whole number that Marfa serves back with the same digits, not ${source}, which it serves as ${KEPT_AS[source] ?? "?"}. Send it as a string.`;
}

async function expectRefused(
  res: Response,
  field: string,
  source: string,
): Promise<ErrorBody> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe("invalid_properties");
  expect(body.error.message).toBe(
    `Invalid properties: ${field}: ${refusal(source)}`,
  );
  expect(body.error.details?.errors).toEqual([
    { field, message: refusal(source) },
  ]);
  return body;
}

async function count(type: string): Promise<number> {
  const res = await request(ctx.app, "GET", `/items?type=${type}&limit=100`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: unknown[] }).data.length;
}

/** Each number a write is refused for, where it sits in a declared `number` field and in an undeclared property. */
const REFUSED = [
  ["1500000000000000001", "1500000000000000001"],
  ["9223372036854775807", "9223372036854775807"],
  ["-9007199254740993", "-9007199254740993"],
  ["1152921504606846976", "1152921504606846976"],
  ["-0", "-0"],
] as const;

/** The properties of an event, hand-written so the digits reach the server as typed. */
const properties = (number: string) => ({
  declared: `{"altitude":${number}}`,
  undeclared: `{"id64":${number}}`,
  nested: `{"id64":{"list":[1,{"deep":${number}}]}}`,
});
const FIELD = {
  declared: "altitude",
  undeclared: "id64",
  nested: "id64.list.1.deep",
} as const;

describe("a whole number a float would change, at every door that writes item properties", () => {
  describe.each(REFUSED)("%s", (source) => {
    for (const where of ["declared", "undeclared", "nested"] as const) {
      it(`POST /items refuses it in a ${where} property and stores nothing`, async () => {
        const before = await count("core.entity.place");
        const res = await send(
          "POST",
          "/items",
          `{"type":"core.entity.place","properties":${properties(source)[where]}}`,
        );
        await expectRefused(res, FIELD[where], source);
        expect(await count("core.entity.place")).toBe(before);
      });
    }

    it("PATCH /items/{id} refuses it and leaves the item as it was", async () => {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.entity.place", properties: { name: "kept" } },
      });
      const { item } = (await created.json()) as {
        item: { id: string; version: number };
      };
      const res = await send(
        "PATCH",
        `/items/${item.id}`,
        `{"version":${String(item.version)},"properties":${properties(source).undeclared}}`,
      );
      await expectRefused(res, "id64", source);
      const after = await request(ctx.app, "GET", `/items/${item.id}`, {
        key: ctx.workingKey,
      });
      expect(
        ((await after.json()) as { item: { version: number } }).item.version,
      ).toBe(item.version);
    });

    it("POST /items/bulk refuses the whole batch and names the item", async () => {
      const before = await count("core.entity.place");
      const res = await send(
        "POST",
        "/items/bulk",
        `{"items":[{"type":"core.entity.place","properties":{"name":"fine"}},{"type":"core.entity.place","properties":${properties(source).nested}}]}`,
      );
      const body = await expectRefused(res, "id64.list.1.deep", source);
      expect(body.error.details?.index).toBe(1);
      expect(await count("core.entity.place")).toBe(before);
    });

    it("POST /items/bulk-actions refuses it in the patch", async () => {
      const res = await send(
        "POST",
        "/items/bulk-actions",
        `{"action":"update_properties","patch":${properties(source).undeclared},"filter":{"tags":["none"]}}`,
      );
      await expectRefused(res, "id64", source);
    });

    it("POST /folders and PATCH /folders/{id} refuse it in the defaults", async () => {
      const res = await send(
        "POST",
        "/folders",
        `{"title":"F","defaults":{"properties":${properties(source).undeclared}}}`,
      );
      await expectRefused(res, "id64", source);
      const made = await request(ctx.app, "POST", "/folders", {
        key: ctx.workingKey,
        body: { title: "G" },
      });
      const { item } = (await made.json()) as { item: { id: string } };
      const patched = await send(
        "PATCH",
        `/folders/${item.id}`,
        `{"version":1,"defaults":{"properties":${properties(source).undeclared}}}`,
      );
      await expectRefused(patched, "id64", source);
    });
  });

  describe.each(REFUSED)("%s in an edge and an extension", (source) => {
    async function note(): Promise<string> {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "an end" } },
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { item: { id: string } }).item.id;
    }

    async function edgesOf(id: string): Promise<number> {
      const res = await request(
        ctx.app,
        "GET",
        `/items/${id}/edges?edge_type=about&limit=100`,
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: unknown[] }).data.length;
    }

    it("POST /edges refuses it in the properties and creates no edge", async () => {
      const [from, to] = [await note(), await note()];
      const res = await send(
        "POST",
        "/edges",
        `{"edge_type":"about","source_id":"${from}","target_id":"${to}","properties":${properties(source).nested}}`,
      );
      await expectRefused(res, "id64.list.1.deep", source);
      expect(await edgesOf(from)).toBe(0);
    });

    it("PATCH /edges/{id} refuses it and leaves the edge as it was", async () => {
      const [from, to] = [await note(), await note()];
      const created = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          edge_type: "about",
          source_id: from,
          target_id: to,
          properties: { note: "kept" },
        },
      });
      const { edge } = (await created.json()) as {
        edge: { id: string; version: number };
      };
      const res = await send(
        "PATCH",
        `/edges/${edge.id}`,
        `{"version":${String(edge.version)},"properties":${properties(source).undeclared}}`,
      );
      await expectRefused(res, "id64", source);
      const after = await request(ctx.app, "GET", `/edges/${edge.id}`, {
        key: ctx.workingKey,
      });
      expect(
        (
          (await after.json()) as {
            edge: { version: number; properties: unknown };
          }
        ).edge,
      ).toMatchObject({ version: edge.version, properties: { note: "kept" } });
    });

    it("POST /edges/bulk refuses the whole batch and names the entry", async () => {
      const [from, to, other] = [await note(), await note(), await note()];
      const res = await send(
        "POST",
        "/edges/bulk",
        `{"edges":[{"edge_type":"about","source_id":"${from}","target_id":"${to}"},{"edge_type":"about","source_id":"${from}","target_id":"${other}","properties":${properties(source).nested}}]}`,
      );
      const body = await expectRefused(res, "id64.list.1.deep", source);
      expect(body.error.details?.index).toBe(1);
      expect(await edgesOf(from)).toBe(0);
    });

    it("PUT /items/{id}/extensions/{namespace} refuses it in the data and stores nothing", async () => {
      const id = await note();
      const res = await send(
        "PUT",
        `/items/${id}/extensions/mine`,
        properties(source).nested,
      );
      await expectRefused(res, "id64.list.1.deep", source);
      const read = async () =>
        await (
          await request(ctx.app, "GET", `/items/${id}/extensions`, {
            key: ctx.workingKey,
          })
        ).text();
      expect(await read()).not.toContain("id64");
      // The witness: the same door stores the data once it holds a safe number.
      const stored = await send(
        "PUT",
        `/items/${id}/extensions/mine`,
        '{"id64":9007199254740991}',
      );
      expect(stored.status, await stored.clone().text()).toBe(200);
      expect(await read()).toContain("id64");
    });
  });

  describe("what is kept", () => {
    it.each([
      ["9007199254740991", 9007199254740991],
      ["1152921504606847000", 2 ** 60],
      ["-9007199254740991", -9007199254740991],
      ["1.5", 1.5],
      ["1e300", 1e300],
      ["1500000000000000001.5", Number("1500000000000000001.5")],
      ["15000000000000000010e0", Number("15000000000000000010e0")],
    ])("POST /items stores %s", async (source, expected) => {
      const res = await send(
        "POST",
        "/items",
        `{"type":"core.entity.place","properties":{"name":"t","altitude":${source},"id64":${source}}}`,
      );
      expect(res.status, await res.clone().text()).toBe(201);
      const { item } = (await res.json()) as {
        item: { properties: Record<string, unknown> };
      };
      expect(item.properties).toMatchObject({
        altitude: expected,
        id64: expected,
      });
    });

    it("leaves the digits of a string alone", async () => {
      const res = await send(
        "POST",
        "/items",
        `{"type":"core.entity.place","properties":{"name":"t","id64":"1500000000000000001"}}`,
      );
      expect(res.status).toBe(201);
    });

    it("refuses the digits of an item property only, not those of another member", async () => {
      const res = await send(
        "POST",
        "/items",
        `{"type":"core.entity.place","source_id":"1500000000000000001","properties":{"name":"t"}}`,
      );
      expect(res.status).not.toBe(400);
    });
  });
});

describe("the doors the guard holds", () => {
  it("are every published request body that carries item properties", () => {
    const document = JSON.parse(
      readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, Record<string, unknown>> };
    // Reaching a member named `properties` or `patch` is how a body carries a
    // bag of properties, and a body that is an object of any members is a bag
    // itself: an extension's data.
    const bags = (schema: unknown, at: string[] = []): string[][] => {
      if (typeof schema !== "object" || schema === null) return [];
      const node = schema as Record<string, unknown>;
      const found: string[][] = [];
      if (
        at.length === 0 &&
        node.properties === undefined &&
        typeof node.additionalProperties === "object"
      ) {
        found.push([]);
      }
      for (const [name, child] of Object.entries(
        (node.properties ?? {}) as Record<string, unknown>,
      )) {
        if (name === "properties" || name === "patch")
          found.push([...at, name]);
        else found.push(...bags(child, [...at, name]));
      }
      for (const variant of [
        ...((node.oneOf ?? []) as unknown[]),
        ...((node.anyOf ?? []) as unknown[]),
        ...((node.allOf ?? []) as unknown[]),
      ]) {
        found.push(...bags(variant, at));
      }
      if (node.items !== undefined)
        found.push(...bags(node.items, [...at, "*"]));
      return found;
    };
    const published = new Set<string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const schema = (
          inlineOpenApiRefs(operation, document) as {
            requestBody?: {
              content?: { "application/json"?: { schema?: unknown } };
            };
          }
        ).requestBody?.content?.["application/json"]?.schema;
        for (const at of bags(schema)) {
          published.add(`${method.toUpperCase()} ${path} ${at.join(".")}`);
        }
      }
    }
    expect([...published].sort()).toEqual(
      ITEM_PROPERTY_BAGS.map(
        ({ method, path, at }) => `${method} ${path} ${at.join(".")}`,
      ).sort(),
    );
  });
});
