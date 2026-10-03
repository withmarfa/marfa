import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { TestContext } from "../../client/types.js";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let store: ReturnType<typeof newStore>;
const spellings = [
  "1000000000000000100",
  "-1000000000000000100",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "-9007199254740993",
  "9223372036854775807",
  "-9223372036854775808",
  "1000000000000000000",
  "-0.000000125",
  "0.125",
  "-0",
  "0",
];
const rows: { id: string; number: number }[] = [];
function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}
beforeAll(async () => {
  const context = await createTestContext("device", "numeric-filters");
  ({ client, ctx } = context);
  for (const spelling of spellings) {
    const number = Number(spelling);
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      properties: { body: ctx.runId, numeric_probe: number },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    rows.push({ id: made.data.item.id, number });
  }
  for (const other of ["0", "text", [], {}, null, undefined, false, true]) {
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      properties: {
        body: ctx.runId,
        ...(other === undefined ? {} : { other_probe: other }),
      },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
  }
  store = newStore("numeric-filters");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(await device.hydrate(["core.note"], "library"));
});
afterAll(async () => {
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

const compare = {
  eq: (a: number, b: number) => a === b,
  neq: (a: number, b: number) => a !== b,
  gte: (a: number, b: number) => a >= b,
  lte: (a: number, b: number) => a <= b,
};
async function ids(
  door: "listing" | "search",
  expression?: string,
): Promise<[string[], string[]]> {
  const filter = `source eq "${ctx.source}"${expression ? ` AND ${expression}` : ""}`;
  if (door === "listing") {
    const served = await client.listItems({ filter, limit: 100 });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    return [
      served.data.data.map((row) => row.id).sort(),
      value(await device.list({ filter }))
        .map((row) => row.id)
        .sort(),
    ];
  }
  const served = await client.search(ctx.runId, { filter, limit: 100 });
  expect(served.ok, JSON.stringify(served.error)).toBe(true);
  return [
    served.data.data.map((hit) => hit.item.id).sort(),
    value(await device.search(ctx.runId, { filter }, 100))
      .map((hit) => hit.item.id)
      .sort(),
  ];
}
it.each(["listing", "search"] as const)(
  "matches numeric equality and range filters between local and server %s",
  async (door) => {
    const [allServed, allLocal] = await ids(door);
    expect(allServed).toHaveLength(spellings.length + 8);
    expect(allLocal).toEqual(allServed);
    for (const [op, comparison] of Object.entries(compare)) {
      for (const spelling of spellings) {
        const expression = `properties.numeric_probe ${op} ${spelling}`;
        const [served, local] = await ids(door, expression);
        const expected = rows
          .filter((row) => comparison(row.number, Number(spelling)))
          .map((row) => row.id)
          .sort();
        expect(served, expression).toEqual(expected);
        expect(local, expression).toEqual(expected);
      }
    }
    for (const expression of [
      "properties.other_probe eq 0",
      "properties.other_probe neq 0",
      "properties.other_probe eq true",
      "properties.other_probe eq false",
      'properties.other_probe eq "0"',
    ]) {
      const [served, local] = await ids(door, expression);
      expect(served.length, expression).toBeGreaterThan(0);
      expect(local, expression).toEqual(served);
    }
  },
);
