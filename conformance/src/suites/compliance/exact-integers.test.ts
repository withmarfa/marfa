import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackFolder,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "exact-integers"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** A request sent as its text, because `JSON.stringify` would round the digits before they left. */
function send(method: string, path: string, body: string) {
  return client.rawRequest<{
    item?: { id: string; properties: Record<string, unknown> };
    results?: { id?: string }[];
  }>(path, { method, headers: { "Content-Type": "application/json" }, body });
}

const message = (digits: string) =>
  `Must be a whole number that a 64-bit float holds exactly, not ${digits}. Send it as a string.`;

const REFUSED = [
  "1500000000000000001",
  "9223372036854775807",
  "-9007199254740993",
];

async function refusedAt(
  res: Awaited<ReturnType<typeof send>>,
  field: string,
  digits: string,
) {
  expect(res.status).toBe(400);
  expect(res.error?.error.code).toBe("invalid_properties");
  expect(res.error?.error.details?.errors).toEqual([
    { field, message: message(digits) },
  ]);
}

describe("a whole number a 64-bit float would change", () => {
  it.each(REFUSED)(
    "refuses %s in a property of a create, nested at any depth, and stores nothing",
    async (digits) => {
      for (const [properties, field] of [
        [`{"body":"b","weight":${digits}}`, "weight"],
        [`{"body":"b","list":[1,${digits}]}`, "list.1"],
        [`{"body":"b","a":{"b":[{"c":${digits}}]}}`, "a.b.0.c"],
      ] as const) {
        const res = await send(
          "POST",
          "/items",
          `{"type":"core.note","source":"${ctx.source}","properties":${properties}}`,
        );
        await refusedAt(res, field, digits);
      }
      const found = await client.listItems({ source: ctx.source });
      expect(found.data.data.filter((item) => item.properties.weight)).toEqual(
        [],
      );
    },
  );

  it.each(REFUSED)(
    "refuses %s in an update, a bulk entry, a bulk action's patch and a folder's defaults",
    async (digits) => {
      const made = await client.createItem(
        createNote({ source: ctx.source, properties: { body: "kept" } }),
      );
      expect(made.ok).toBe(true);
      trackItem(ctx, made.data.item.id);
      const update = await send(
        "PATCH",
        `/items/${made.data.item.id}`,
        `{"version":${made.data.item.version},"properties":{"weight":${digits}}}`,
      );
      await refusedAt(update, "weight", digits);
      const kept = await client.getItem(made.data.item.id);
      expect(kept.data.item.version).toBe(made.data.item.version);

      const bulk = await send(
        "POST",
        "/items/bulk",
        `{"items":[{"type":"core.note","source":"${ctx.source}","properties":{"body":"fine"}},{"type":"core.note","source":"${ctx.source}","properties":{"body":"b","weight":${digits}}}]}`,
      );
      await refusedAt(bulk, "weight", digits);
      expect(bulk.error?.error.details?.index).toBe(1);

      const action = await send(
        "POST",
        "/items/bulk-actions",
        `{"action":"update_properties","patch":{"weight":${digits}},"filter":{"tags":["${ctx.source}"]}}`,
      );
      await refusedAt(action, "weight", digits);

      const folder = await send(
        "POST",
        "/folders",
        `{"title":"F","defaults":{"properties":{"weight":${digits}}}}`,
      );
      await refusedAt(folder, "weight", digits);
      const own = await client.createFolder({ title: "G" });
      expect(own.ok).toBe(true);
      trackFolder(ctx, own.data.item.id);
      const changed = await send(
        "PATCH",
        `/folders/${own.data.item.id}`,
        `{"version":${own.data.item.version},"defaults":{"properties":{"weight":${digits}}}}`,
      );
      await refusedAt(changed, "weight", digits);
    },
  );

  it.each([
    ["9007199254740991", 9007199254740991],
    ["-9007199254740991", -9007199254740991],
    ["1152921504606846976", 1152921504606846976],
    ["1.5", 1.5],
    ["1e300", 1e300],
    ["1500000000000000001.5", 1500000000000000001.5],
  ])("keeps %s as the number a float holds", async (digits, expected) => {
    const res = await send(
      "POST",
      "/items",
      `{"type":"core.note","source":"${ctx.source}","properties":{"body":"b","weight":${digits},"list":[${digits}]}}`,
    );
    expect(res.status, JSON.stringify(res.error)).toBe(201);
    trackItem(ctx, res.data.item!.id);
    expect(res.data.item?.properties).toMatchObject({
      weight: expected,
      list: [expected],
    });
  });

  it("leaves the digits of a string alone", async () => {
    const res = await send(
      "POST",
      "/items",
      `{"type":"core.note","source":"${ctx.source}","properties":{"body":"b","weight":"1500000000000000001"}}`,
    );
    expect(res.status).toBe(201);
    trackItem(ctx, res.data.item!.id);
    expect(res.data.item?.properties.weight).toBe("1500000000000000001");
  });
});
