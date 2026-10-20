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
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "exact-integers",
  ));
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

/** The digits a float is served as, for each number a write is refused for. */
const KEPT_AS: Record<string, string> = {
  "1500000000000000001": "1500000000000000000",
  "9223372036854775807": "9223372036854776000",
  "-9007199254740993": "-9007199254740992",
  "1152921504606846976": "1152921504606847000",
  "1000000000000000000000": "1e+21",
};

const message = (digits: string) =>
  `Must be a whole number that a 64-bit float keeps digit for digit, not ${digits}, which it keeps as ${KEPT_AS[digits]}. Send it as a string.`;

const REFUSED = Object.keys(KEPT_AS);

/** What the server serves for an item, as text, because parsing it would round the digits again. */
async function servedText(id: string): Promise<string> {
  const res = await fetch(`${apiUrl}/items/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  expect(res.status).toBe(200);
  return await res.text();
}

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
    ["1152921504606847000", 1152921504606847000],
    ["9223372036854776000", 9223372036854776000],
    ["18446744073709552000", 18446744073709552000],
    ["100000000000000000000", 1e20],
    ["999999999999999900000", 999999999999999900000],
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
    const served = await servedText(res.data.item!.id);
    expect(served).toContain(`"weight":${JSON.stringify(expected)}`);
    expect(served).toContain(`"list":[${JSON.stringify(expected)}]`);
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
