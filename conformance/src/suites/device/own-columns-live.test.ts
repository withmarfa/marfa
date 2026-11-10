import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
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
let server: { url: string; key: string };
let offline: CliDevice;
let hydrated: CliDevice;
const stores: string[] = [];

function device(label: string, server?: { url: string; key: string }) {
  const store = newStore(label);
  stores.push(store);
  return new CliDevice({ binary: requireBinary(), store, ...server });
}

beforeAll(async () => {
  const context = await createTestContext("device", "own-columns");
  ({ client, ctx } = context);
  offline = device("own-columns-offline");
  expect((await offline.status()).ok).toBe(true);
  server = { url: context.apiUrl, key: context.apiKey };
  hydrated = device("own-columns-hydrated", server);
  expect((await hydrated.hydrate(["core.table"], "library")).ok).toBe(true);
});

afterAll(async () => {
  if (ctx) await cleanup(ctx);
  for (const store of stores) {
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

const GOOD = {
  name: { type: "string", required: true, searchable: true },
  qty: { type: "integer", minimum: 0, adds_up: "sum" },
  parent: { type: "item", type_constraints: ["core.table", "core.note"] },
};

const BAD: [string, unknown][] = [
  ["columns.a.type", { a: { type: "money" } }],
  ["columns.a.type", { a: { type: "array", items_type: "string" } }],
  ["columns.a", { a: "string" }],
  ["columns.a.addsUp", { a: { type: "number", addsUp: "sum" } }],
  ["columns.Bad", { Bad: { type: "string" } }],
  ["columns.a.enum_values", { a: { type: "enum" } }],
  ["columns.a.adds_up", { a: { type: "string", adds_up: "sum" } }],
  ["columns.a.searchable", { a: { type: "number", searchable: true } }],
  [
    "columns.a.type_constraints",
    { a: { type: "item", type_constraints: ["user.absent-type"] } },
  ],
  ["columns.a.maxLength", { a: { type: "item", maxLength: 5 } }],
  ["columns", {}],
  ["columns", null],
  ["columns", "text"],
  [
    "columns",
    Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`c${i}`, { type: "string" }]),
    ),
  ],
];

it("refuses on the device the columns the server refuses and queues nothing", async () => {
  for (const copy of [offline, hydrated]) {
    const before = await copy.queue();
    for (const [path, columns] of BAD) {
      const properties = { title: "Budget", columns };
      const server = await client.createItem({
        type: "core.table",
        source: ctx.source,
        properties,
      });
      expect(server.ok, JSON.stringify(columns)).toBe(false);
      expect(server.error?.error.code).toBe("invalid_properties");
      const refused = await copy.create({ type: "core.table", properties });
      expect(refused.ok, JSON.stringify(columns)).toBe(false);
      if (!refused.ok) expect(refused.refusal.raw).toContain(`${path}:`);
    }
    const missing = await copy.create({
      type: "core.table",
      properties: { title: "Budget" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.raw).toContain("columns:");
    expect(await copy.queue()).toEqual(before);
  }
});

it("takes on the device the columns the server takes and the server accepts the queued write", async () => {
  const properties = { title: "Budget", columns: GOOD };
  const server = await client.createItem({
    type: "core.table",
    source: ctx.source,
    properties,
  });
  expect(server.ok, JSON.stringify(server.error)).toBe(true);
  if (server.ok) trackItem(ctx, server.data.item.id);
  for (const copy of [offline, hydrated]) {
    const local = await copy.create({ type: "core.table", properties });
    expect(local.ok, JSON.stringify(local)).toBe(true);
  }
  const drained = await hydrated.drain();
  expect(drained.ok && drained.value.verdicts.map((v) => v.verdict)).toEqual([
    "accepted",
  ]);
  if (drained.ok) {
    for (const verdict of drained.value.verdicts) {
      if (verdict.item_id) trackItem(ctx, verdict.item_id);
    }
  }
});

it("answers core.table as the server does, before and after a hydration", async () => {
  const served = await client.getType("core.table");
  expect(served.ok).toBe(true);
  const names = Object.keys(served.data.fields ?? {}).sort();
  for (const copy of [offline, hydrated]) {
    const held = await copy.itemType("core.table");
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) continue;
    expect(held.value.fields.map((field) => field.name).sort()).toEqual(names);
    expect(
      held.value.fields.find((field) => field.name === "columns")?.type,
    ).toBe("object");
    expect(held.value.label).toBe(served.data.label);
  }
});

it("refuses on the device columns naming a type its catalog does not hold, though the server takes them", async () => {
  const only = `user.own-columns-server-${ctx.runId}`;
  expect(
    (
      await client.registerType({
        id: only,
        fields: { title: { type: "string" } },
      })
    ).status,
  ).toBe(201);
  trackType(ctx, only);
  const properties = {
    title: "Budget",
    columns: { a: { type: "item", type_constraints: [only] } },
  };
  const taken = await client.createItem({
    type: "core.table",
    source: ctx.source,
    properties,
  });
  expect(taken.ok, JSON.stringify(taken.error)).toBe(true);
  if (taken.ok) trackItem(ctx, taken.data.item.id);
  const before = await offline.queue();
  const refused = await offline.create({ type: "core.table", properties });
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.raw).toContain("columns.a.type_constraints:");
  }
  expect(await offline.queue()).toEqual(before);
});

it("takes on the device a retype to a type below core.table that names no columns, keeping the columns the item holds", async () => {
  const sheet = `user.own-columns-sheet-${ctx.runId}`;
  expect(
    (
      await client.registerType({
        id: sheet,
        parent: "core.table",
        fields: { owner: { type: "string" } },
      })
    ).status,
  ).toBe(201);
  trackType(ctx, sheet);
  const made = await client.createItem({
    type: "core.table",
    source: ctx.source,
    properties: { title: "Budget", columns: GOOD },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  if (!made.ok) return;
  trackItem(ctx, made.data.item.id);
  const copy = device("own-columns-retype", server);
  expect((await copy.hydrate(["core.table", sheet], "library")).ok).toBe(true);
  const held = await copy.get(made.data.item.id);
  expect(held.ok, JSON.stringify(held)).toBe(true);
  if (!held.ok) return;
  const retyped = await copy.update(made.data.item.id, {
    type: sheet,
    properties: {},
    version: held.value.version,
  });
  expect(retyped.ok, JSON.stringify(retyped)).toBe(true);
  const drained = await copy.drain();
  expect(drained.ok && drained.value.verdicts.map((v) => v.verdict)).toEqual([
    "accepted",
  ]);
  const read = await client.getItem(made.data.item.id);
  expect(read.data.item.type).toBe(sheet);
  expect(read.data.item.properties.columns).toEqual(GOOD);
});
