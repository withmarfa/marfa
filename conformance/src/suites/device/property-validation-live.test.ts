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
let rulesType: string;
let store: string;
let apiUrl: string;
let apiKey: string;
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
  ({ client, ctx, apiUrl, apiKey } = context);
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
          entries: {
            type: "array",
            items_type: "object",
            items_fields: { u: { type: "url" } },
          },
        },
      })
    ).ok,
  ).toBe(true);
  trackType(ctx, valuesType);
  rulesType = `fixture.${ctx.runId}.rules`;
  expect(
    (
      await client.registerType({
        id: rulesType,
        fields: {
          score: { type: "integer", minimum: 1, maximum: 5 },
          price: { type: "number", minimum: -0.5, maximum: 10 },
          code: { type: "string", format: "currency" },
          contacts: {
            type: "array",
            items_type: "object",
            items_fields: {
              value: { type: "email", required: true },
              label: { type: "string", maxLength: 10 },
              rank: { type: "integer", minimum: 1, maximum: 5 },
            },
          },
        },
      })
    ).ok,
  ).toBe(true);
  trackType(ctx, rulesType);
  store = newStore("property-validation-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  expect(
    (await device.hydrate([type, valuesType, rulesType], "library")).ok,
  ).toBe(true);
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

it("matches the server on a range, a currency and the entries of a list", async () => {
  const contact = { value: "a@example.test" };
  const good: Record<string, unknown>[] = [
    { score: 1, price: -0.5 },
    { score: 5, price: 10 },
    { code: "GBP" },
    { code: "ZZZ" },
    { contacts: [contact, { ...contact, label: "work", rank: 5 }] },
    { contacts: [] },
  ];
  const bad: [string, Record<string, unknown>][] = [
    ["score", { score: 0 }],
    ["score", { score: 6 }],
    ["price", { price: -0.51 }],
    ["price", { price: 10.01 }],
    ["code", { code: "gbp" }],
    ["code", { code: "GB" }],
    ["code", { code: "GBPX" }],
    ["code", { code: "" }],
    ["code", { code: 826 }],
    ["contacts", { contacts: [contact, { ...contact, extra: 1 }] }],
    ["contacts", { contacts: [contact, { label: "x" }] }],
    ["contacts", { contacts: [contact, { value: 5 }] }],
    ["contacts", { contacts: [contact, { value: "no" }] }],
    ["contacts", { contacts: [contact, { ...contact, rank: 6 }] }],
    ["contacts", { contacts: [contact, { ...contact, label: null }] }],
    ["contacts", { contacts: [contact, {}] }],
    ["contacts", { contacts: [contact, "text"] }],
  ];
  for (const properties of good) {
    const server = await client.createItem({ type: rulesType, properties });
    expect(server.ok, JSON.stringify([properties, server.error])).toBe(true);
    if (server.ok) trackItem(ctx, server.data.item.id);
    const local = await device.create({ type: rulesType, properties });
    expect(local.ok, JSON.stringify(properties)).toBe(true);
    if (local.ok) trackItem(ctx, local.value.item_id!);
  }
  const drained = await device.drain();
  expect(drained.ok && drained.value.verdicts.map((v) => v.verdict)).toEqual(
    good.map(() => "accepted"),
  );
  const before = await device.queue();
  for (const [field, properties] of bad) {
    const server = await client.createItem({ type: rulesType, properties });
    expect(server.ok, JSON.stringify(properties)).toBe(false);
    expect(server.error?.error.code).toBe("invalid_properties");
    const local = await device.create({ type: rulesType, properties });
    expect(local.ok, JSON.stringify(properties)).toBe(false);
    if (!local.ok) expect(local.refusal.raw).toContain(`${field}:`);
  }
  expect(await device.queue()).toEqual(before);
  // A JSON text makes `__proto__` an own key, which both paths refuse.
  const text = '{"contacts":[{"value":"a@example.test","__proto__":{"x":1}}]}';
  const server = await client.rawRequest("/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"type":${JSON.stringify(rulesType)},"properties":${text}}`,
  });
  expect(server.status).toBe(400);
  const local = await device.create({
    type: rulesType,
    propertiesText: text,
  });
  expect(local.ok).toBe(false);
  if (!local.ok) expect(local.refusal.raw).toContain("contacts:");
  expect(await device.queue()).toEqual(before);
});

it("refuses an update that sets a bad entry on both paths, naming the field, the position and the member", async () => {
  const contact = { value: "a@example.test" };
  const made = await client.createItem({
    type: rulesType,
    properties: { contacts: [contact] },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  if (!made.ok) return;
  trackItem(ctx, made.data.item.id);
  expect((await device.catchUp()).ok).toBe(true);
  const held = await device.get(made.data.item.id);
  expect(held.ok).toBe(true);
  if (!held.ok) return;
  const before = await device.queue();
  for (const [contacts, named, member] of [
    [[contact, { label: "x" }], "contacts: Item 1: value:", "contacts.1.value"],
    [
      [contact, { ...contact, rank: 6 }],
      "contacts: Item 1: rank:",
      "contacts.1.rank",
    ],
    [
      [contact, { ...contact, extra: 1 }],
      "contacts: Item 1: extra:",
      "contacts.1.extra",
    ],
  ] as const) {
    const properties = { contacts };
    const server = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      properties,
    });
    expect(server.status, JSON.stringify(properties)).toBe(400);
    expect(
      (
        server.error?.error.details as
          { errors?: { field: string }[] } | undefined
      )?.errors?.map((e) => e.field),
    ).toContain(member);
    const local = await device.update(made.data.item.id, {
      version: held.value.version,
      properties,
    });
    expect(local.ok, JSON.stringify(properties)).toBe(false);
    if (!local.ok) expect(local.refusal.raw).toContain(named);
  }
  expect(await device.queue()).toEqual(before);
  // The witness: a good entry is queued by the same command.
  const good = await device.update(made.data.item.id, {
    version: held.value.version,
    properties: { contacts: [contact, { ...contact, rank: 5 }] },
  });
  expect(good.ok).toBe(true);
});

/** The digits a float is served as, for each number a write is refused for. */
const KEPT_AS: Record<string, string> = {
  "1500000000000000001": "1500000000000000000",
  "9223372036854775807": "9223372036854776000",
  "-9007199254740993": "-9007199254740992",
  "1152921504606846976": "1152921504606847000",
  "1000000000000000000000": "1e+21",
  "-0": "0",
};

const message = (digits: string) =>
  `Must be a whole number that Marfa serves back with the same digits, not ${digits}, which it serves as ${KEPT_AS[digits]}. Send it as a string.`;

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
  ["1152921504606846976"],
  ["1000000000000000000000"],
  ["-0"],
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
        { field, message: message(digits) },
      ]);
      expect(local.ok, text).toBe(false);
      if (!local.ok) {
        expect(local.refusal.raw).toContain(`${field}: ${message(digits)}`);
      }
    }
    expect(await device.queue()).toEqual(before);
  },
);

/** An item pair and an edge between them, on the server and held by the device. */
let linked: { from: string; to: string; edge: string; version: number };
async function linkedItems() {
  if (linked) return linked;
  const made = [];
  for (const title of ["from", "to"]) {
    const item = await device.create({
      type: valuesType,
      properties: { title },
    });
    expect(item.ok).toBe(true);
    if (!item.ok) throw new Error("the device refused an item");
    trackItem(ctx, item.value.item_id!);
    made.push(item.value.item_id!);
  }
  const edge = await device.createEdge({
    source: made[0]!,
    target: made[1]!,
    type: "references",
  });
  expect(edge.ok).toBe(true);
  expect((await device.drain()).ok).toBe(true);
  const held = await device.edgesFrom(made[0]!);
  expect(held.ok && held.value).toHaveLength(1);
  if (!held.ok) throw new Error("the device holds no edge");
  linked = {
    from: made[0]!,
    to: made[1]!,
    edge: held.value[0]!.id,
    version: held.value[0]!.version,
  };
  return linked;
}

it.each([
  ["1500000000000000001"],
  ["1152921504606846976"],
  ["1000000000000000000000"],
  ["-0"],
])(
  "refuses %s in the properties of an edge and the data of an extension on both paths with one message",
  async (digits) => {
    const { from, to, edge, version } = await linkedItems();
    const nested = `{"weight":${digits},"list":[1,${digits}]}`;
    const before = await device.queue();
    const refusedOnBoth = async (
      server: Awaited<ReturnType<typeof client.rawRequest>>,
      local: { ok: boolean; refusal?: { raw: string } },
      field: string,
    ) => {
      expect(server.ok).toBe(false);
      expect((server.error as { error: { code: string } }).error.code).toBe(
        "invalid_properties",
      );
      expect(
        (
          server.error as {
            error: { details?: { errors?: unknown } };
          }
        ).error.details?.errors,
      ).toEqual([{ field, message: message(digits) }]);
      expect(local.ok).toBe(false);
      expect(local.refusal?.raw).toContain(`${field}: ${message(digits)}`);
    };
    const json = { "Content-Type": "application/json" };
    await refusedOnBoth(
      await client.rawRequest("/edges", {
        method: "POST",
        headers: json,
        body: `{"source_id":"${from}","target_id":"${to}","edge_type":"about","properties":${nested}}`,
      }),
      await device.createEdge({
        source: from,
        target: to,
        type: "about",
        propertiesText: nested,
      }),
      "weight",
    );
    await refusedOnBoth(
      await client.rawRequest(`/edges/${edge}`, {
        method: "PATCH",
        headers: json,
        body: `{"version":${version},"properties":${nested}}`,
      }),
      await device.updateEdge(edge, {
        properties: {},
        propertiesText: nested,
        version,
      }),
      "weight",
    );
    await refusedOnBoth(
      await client.rawRequest(`/items/${from}/extensions/fixture.digits`, {
        method: "PUT",
        headers: json,
        body: nested,
      }),
      await device.writeExtensionText(from, "fixture.digits", nested),
      "weight",
    );
    expect(await device.queue()).toEqual(before);
  },
);

it("keeps a number a float keeps in the properties of an edge and the data of an extension on both paths", async () => {
  const { from, to, edge, version } = await linkedItems();
  const text = '{"weight":1152921504606847000,"digits":"1152921504606846976"}';
  const json = { "Content-Type": "application/json" };
  expect(
    (
      await client.rawRequest(`/items/${from}/extensions/fixture.kept`, {
        method: "PUT",
        headers: json,
        body: text,
      })
    ).ok,
  ).toBe(true);
  expect((await device.writeExtensionText(from, "fixture.kept", text)).ok).toBe(
    true,
  );
  expect(
    (
      await device.updateEdge(edge, {
        properties: {},
        propertiesText: text,
        version,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await device.createEdge({
        source: to,
        target: from,
        type: "about",
        propertiesText: text,
      })
    ).ok,
  ).toBe(true);
  const drained = await device.drain();
  expect(drained.ok && drained.value.verdicts.map((v) => v.verdict)).toEqual([
    "accepted",
    "accepted",
    "accepted",
  ]);
  const stored = await client.getItem(from);
  expect(stored.ok).toBe(true);
});

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

it("keeps a large number in the digits a float is served as inside an array and a nested object on both paths", async () => {
  const exact = "[1152921504606847000,2]";
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
    extra: [1152921504606847000, 2],
    nest: { a: [1152921504606847000, 2] },
  });
});

it.each([
  ["1152921504606847000"],
  ["-1152921504606847000"],
  ["9223372036854776000"],
  ["18446744073709550000"],
])(
  "holds the digits %s as written on the server and in the local row, before and after a drain",
  async (digits) => {
    const holds = (text: string | false) =>
      typeof text === "string" &&
      new RegExp(`"weight":\\s*${digits}(?![\\d.eE])`).test(text);
    const local = await device.create({
      type: valuesType,
      propertiesText: `{"title":"t","weight":${digits}}`,
    });
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    const id = local.value.item_id!;
    trackItem(ctx, id);
    const offline = await device.getText(id);
    expect(
      holds(offline.ok && offline.value),
      String(offline.ok && offline.value),
    ).toBe(true);
    const drained = await device.drain();
    expect(drained.ok && drained.value.verdicts.at(-1)?.verdict).toBe(
      "accepted",
    );
    const held = await device.getText(id);
    expect(holds(held.ok && held.value), String(held.ok && held.value)).toBe(
      true,
    );
    const served = await fetch(`${apiUrl}/items/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(holds(await served.text())).toBe(true);
  },
);

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
  [
    "a valid punycode host",
    "http://xn--mnchen-3ya.de/",
    "http://xn--mnchen-3ya.de/",
  ],
  [
    "an internationalized host",
    "https://münchen.de/straße",
    "https://münchen.de/straße",
  ],
  ["an ASCII host with an empty punycode label", "http://xn--", "http://xn--"],
  ["a percent-encoded punycode label", "http://xn--%41", "http://xn--%41"],
  [
    "a scheme with no slashes before an empty punycode label",
    "http:xn--",
    "http:xn--",
  ],
  ["a punycode label of punctuation", "http://xn--!", "http://xn--!"],
  ["a punycode label of a tilde", "http://xn--%7E", "http://xn--%7E"],
  ["a punycode label of one letter", "http://xn--a", "http://xn--a"],
  [
    "a punycode label of an xn-- prefix",
    "http://xn--xn---yna/",
    "http://xn--xn---yna/",
  ],
  [
    "two punycode labels led by hyphens",
    "http://xn----pfa.xn--4db/",
    "http://xn----pfa.xn--4db/",
  ],
])(
  "treats %s in a url the same on both paths and stores the same value",
  async (_name, written, stored) => {
    for (const properties of [
      { title: "t", url: written },
      { title: "t", sites: [written] },
      { title: "t", entries: [{ u: written }] },
    ]) {
      const server = await client.createItem({ type: valuesType, properties });
      expect(server.ok, JSON.stringify(server.error)).toBe(true);
      if (server.ok) trackItem(ctx, server.data.item.id);
      const local = await device.create({ type: valuesType, properties });
      expect(local.ok).toBe(true);
      if (!local.ok) return;
      trackItem(ctx, local.value.item_id!);
      const field =
        "url" in properties
          ? "url"
          : "sites" in properties
            ? "sites"
            : "entries";
      const shown =
        field === "url"
          ? stored
          : field === "sites"
            ? [stored]
            : [{ u: stored }];
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

it.each([
  ["not a url"],
  ["\u0085" + URL_VALUE],
  ["http://xn--é/"],
  ["http://xn--%e9/"],
  ["http://xn--%2f/"],
  ["http://bücher.xn--"],
  ["http://xn--a.münchen.de/"],
  ["http://xn--a.1/"],
  ["http://xn--a.0x1/"],
  ["   "],
])("refuses the url %j on both paths", async (written) => {
  const properties = { title: "t", url: written };
  const server = await client.createItem({ type: valuesType, properties });
  expect(server.ok).toBe(false);
  expect(server.error?.error.code).toBe("invalid_properties");
  const local = await device.create({ type: valuesType, properties });
  expect(local.ok).toBe(false);
  if (!local.ok)
    expect(local.refusal.raw).toContain("url: Must be a valid URL");
});

it.each([["http://Ⴍ𿣍ꡨ֮.Ⴞ/"], ["https://𾢬.ܩ.쯙5/"]])(
  "refuses the url %j on the device where the server takes it",
  async (written) => {
    const properties = { title: "t", url: written };
    const server = await client.createItem({ type: valuesType, properties });
    expect(server.ok, JSON.stringify(server.error)).toBe(true);
    if (server.ok) trackItem(ctx, server.data.item.id);
    const local = await device.create({ type: valuesType, properties });
    expect(local.ok).toBe(false);
    if (!local.ok)
      expect(local.refusal.raw).toContain("url: Must be a valid URL");
  },
);
