import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import type { MarfaClient } from "../../client/api.js";
import type { FieldDefinition, TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let type: string;
let valuesType: string;
let store: string;
const fields: Record<string, FieldDefinition> = {
  title: { type: "string", required: true, maxLength: 5 },
  read: { type: "boolean" },
  count: { type: "integer" },
  choice: { type: "enum", enum_values: ["yes", "no"] },
  list: { type: "array", maxItems: 2, items_type: "string" },
  sites: { type: "array", items_type: "url" },
  things: { type: "array", items_type: "object" },
  date: { type: "date" },
  time: { type: "datetime" },
  email: { type: "email" },
  url: { type: "url" },
  image: { type: "thumbnail" },
};

beforeAll(async () => {
  const context = await createTestContext("device", "property-validation");
  ({ client, ctx } = context);
  type = `fixture.${ctx.runId}.fields`;
  expect((await client.registerType({ id: type, fields })).ok).toBe(true);
  trackType(ctx, type);
  valuesType = `fixture.${ctx.runId}.values`;
  expect(
    (
      await client.registerType({
        id: valuesType,
        fields: {
          title: { type: "string", required: true, maxLength: 5 },
          weight: { type: "number" },
          url: { type: "url" },
          sites: { type: "array", items_type: "url" },
        },
      })
    ).ok,
  ).toBe(true);
  trackType(ctx, valuesType);
  store = newStore("property-validation-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  expect((await device.hydrate([type, valuesType], "library")).ok).toBe(true);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
});

it("matches a real server's field decisions and keeps queued writes across a catalog change", async () => {
  const good = {
    title: "😀abc",
    read: null,
    count: 9007199254740991,
    choice: "yes",
    list: ["a", ""],
    sites: ["https://example.test"],
    things: [{}, { a: 1 }],
    links: ["b"],
    attachments: [{}],
    date: "0000-02-29",
    time: "2026-01-01T23:59+23:59",
    email: "reader+tag@example.test",
    url: "mailto:reader@example.test",
    image: "data:image/png;base64,iVBORw0KGgo=",
    custom: true,
  };
  const accepted = await client.createItem({ type, properties: good });
  expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
  trackItem(ctx, accepted.data.item.id);
  const local = await device.create({ type, properties: good });
  expect(local.ok).toBe(true);
  if (!local.ok) return;
  trackItem(ctx, local.value.item_id!);
  const drained = await device.drain();
  expect(drained.ok && drained.value.verdicts[0]?.verdict).toBe("accepted");
  const before = await device.queue();
  for (const [field, value] of [
    ["title", null],
    ["title", "😀abcd"],
    ["title", "a\u0000b"],
    ["read", "yes"],
    ["count", 9007199254740992],
    ["count", 1.5],
    ["choice", "maybe"],
    ["list", [1, 2, 3]],
    ["list", ["a", 1]],
    ["list", [{}]],
    ["list", [null]],
    ["sites", ["https://example.test", "relative"]],
    ["things", ["text"]],
    ["links", [1]],
    ["attachments", ["x"]],
    ["date", "1900-02-29"],
    ["time", "2026-01-01T12:00:00"],
    ["time", "2026-01-01T12:00+24:00"],
    ["email", "a..b@example.test"],
    ["url", "relative"],
    ["image", "data:image/png;base64,iVBORw0KGgp="],
  ] as Array<[string, unknown]>) {
    const properties = { title: "valid", [field]: value };
    const server = await client.createItem({ type, properties });
    expect(server.ok, `${field}: ${JSON.stringify(server.error)}`).toBe(false);
    expect(server.error?.error.code).toBe("invalid_properties");
    const refused = await device.create({ type, properties });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.raw).toContain(`${field}:`);
  }
  expect(await device.queue()).toEqual(before);
  const pending = await device.create({ type, properties: { title: "valid" } });
  expect(pending.ok).toBe(true);
  const schema = await client.getType(type);
  expect(schema.ok).toBe(true);
  expect(
    (
      await client.replaceType(type, {
        version: schema.data.version,
        fields: { ...fields, added: { type: "string", required: true } },
      })
    ).ok,
  ).toBe(true);
  expect((await device.catchUp()).ok).toBe(true);
  const unchanged = await device.queue();
  expect(unchanged.ok && unchanged.value.at(-1)?.verdict).toBe(null);
  const refusal = await device.drain();
  expect(refusal.ok).toBe(true);
  if (refusal.ok) {
    expect(refusal.value.verdicts[0]?.verdict).toBe("refused");
    expect(
      refusal.value.verdicts[0]?.refusal?.fields.some(
        (field) => field.field === "added",
      ),
    ).toBe(true);
  }
  const kept = await device.queue();
  expect(kept.ok && kept.value.at(-1)?.body).toMatchObject({
    properties: { title: "valid" },
  });
});

const MESSAGE =
  "Must be a whole number that a 64-bit float holds exactly, not ";

/** What the server answers a create of `text` (the request's properties as JSON text), and what the device queues and then the server stores. */
async function bothPaths(text: string) {
  const server = await client.rawRequest<{
    item: { id: string; properties: Record<string, unknown> };
  }>("/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"type":${JSON.stringify(valuesType)},"properties":${text}}`,
  });
  const local = await device.create({
    type: valuesType,
    propertiesText: text,
  });
  if (server.ok) trackItem(ctx, server.data.item.id);
  return { server, local };
}

it.each([
  ["1500000000000000001"],
  ["9223372036854775807"],
  ["-9007199254740993"],
])(
  "refuses %s in a declared number, an undeclared property, an array and a nested object on both paths with one message",
  async (digits) => {
    const before = await device.queue();
    for (const [text, field] of [
      [`{"title":"t","weight":${digits}}`, "weight"],
      [`{"title":"t","extra":${digits}}`, "extra"],
      [`{"title":"t","extra":[1,${digits}]}`, "extra.1"],
      [`{"title":"t","extra":{"a":{"b":[${digits}]}}}`, "extra.a.b.0"],
    ] as const) {
      const { server, local } = await bothPaths(text);
      expect(server.ok, text).toBe(false);
      expect(server.error?.error.code).toBe("invalid_properties");
      expect(server.error?.error.details?.errors).toEqual([
        { field, message: `${MESSAGE}${digits}. Send it as a string.` },
      ]);
      expect(local.ok, text).toBe(false);
      if (!local.ok) {
        expect(local.refusal.raw).toContain(
          `${field}: ${MESSAGE}${digits}. Send it as a string.`,
        );
      }
    }
    expect(await device.queue()).toEqual(before);
  },
);

it.each([
  ["9007199254740991", 9007199254740991],
  ["-9007199254740991", -9007199254740991],
  ["1152921504606846976", 1152921504606846976],
  ["1.5", 1.5],
  ["1e300", 1e300],
  ["1500000000000000001.5", 1500000000000000001.5],
])(
  "keeps %s on both paths as the same stored number",
  async (digits, expected) => {
    const { server, local } = await bothPaths(
      `{"title":"t","weight":${digits},"extra":${digits}}`,
    );
    expect(server.ok, JSON.stringify(server.error)).toBe(true);
    expect(local.ok).toBe(true);
    if (!server.ok || !local.ok) return;
    trackItem(ctx, local.value.item_id!);
    const drained = await device.drain();
    expect(drained.ok && drained.value.verdicts.at(-1)?.verdict).toBe(
      "accepted",
    );
    const stored = await client.getItem(local.value.item_id!);
    expect(stored.ok).toBe(true);
    const held = await device.get(local.value.item_id!);
    expect(held.ok).toBe(true);
    for (const properties of [
      server.data.item.properties,
      stored.data.item.properties,
      held.ok ? held.value.properties : {},
    ]) {
      expect(properties).toMatchObject({ weight: expected, extra: expected });
    }
  },
);

it("keeps a large number a float holds exactly inside an array and a nested object on both paths", async () => {
  const exact = "[1152921504606846976,2]";
  const { server, local } = await bothPaths(
    `{"title":"t","extra":${exact},"nest":{"a":${exact}}}`,
  );
  expect(server.ok, JSON.stringify(server.error)).toBe(true);
  expect(local.ok).toBe(true);
  if (!local.ok) return;
  trackItem(ctx, local.value.item_id!);
  expect((await device.drain()).ok).toBe(true);
  const held = await device.get(local.value.item_id!);
  expect(held.ok && held.value.properties).toMatchObject({
    extra: [1152921504606846976, 2],
    nest: { a: [1152921504606846976, 2] },
  });
});

const URL_VALUE = "https://example.com/a";

it.each([
  [
    "a leading and trailing ideographic space",
    `\u3000${URL_VALUE}\u3000`,
    URL_VALUE,
  ],
  [
    "a leading and trailing byte order mark",
    `\ufeff${URL_VALUE}\ufeff`,
    URL_VALUE,
  ],
  ["ASCII spaces", `  ${URL_VALUE}  `, URL_VALUE],
  [
    "a no-break space and a line separator",
    `\u00a0${URL_VALUE}\u2028`,
    URL_VALUE,
  ],
  [
    "a tab and a line break inside",
    "https://exa\tmple.com/\na",
    "https://example.com/a",
  ],
  ["an empty punycode host", "http://xn--", "http://xn--"],
  [
    "an internationalized host",
    "https://münchen.de/straße",
    "https://münchen.de/straße",
  ],
])(
  "treats %s in a url the same on both paths and stores the same value",
  async (_name, written, stored) => {
    for (const properties of [
      { title: "t", url: written },
      { title: "t", sites: [written] },
    ]) {
      const server = await client.createItem({ type: valuesType, properties });
      expect(server.ok, JSON.stringify(server.error)).toBe(true);
      if (server.ok) trackItem(ctx, server.data.item.id);
      const local = await device.create({ type: valuesType, properties });
      expect(local.ok).toBe(true);
      if (!local.ok) return;
      trackItem(ctx, local.value.item_id!);
      const field = "url" in properties ? "url" : "sites";
      const shown = field === "url" ? stored : [stored];
      const before = await device.get(local.value.item_id!);
      expect(before.ok && before.value.properties[field]).toEqual(shown);
      expect(server.ok && server.data.item.properties[field]).toEqual(shown);
      const drained = await device.drain();
      expect(drained.ok && drained.value.verdicts.at(-1)?.verdict).toBe(
        "accepted",
      );
      const after = await device.get(local.value.item_id!);
      expect(after.ok && after.value.properties[field]).toEqual(shown);
    }
  },
);

it.each([["not a url"], ["\u0085" + URL_VALUE], ["http://xn--é/"], ["   "]])(
  "refuses the url %j on both paths",
  async (written) => {
    const properties = { title: "t", url: written };
    const server = await client.createItem({ type: valuesType, properties });
    expect(server.ok).toBe(false);
    expect(server.error?.error.code).toBe("invalid_properties");
    const local = await device.create({ type: valuesType, properties });
    expect(local.ok).toBe(false);
    if (!local.ok)
      expect(local.refusal.raw).toContain("url: Must be a valid URL");
  },
);
