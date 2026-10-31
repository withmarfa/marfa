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
let person: string;

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

beforeAll(async () => {
  const context = await createTestContext("device", "entry-member-filter");
  ({ client, ctx } = context);
  const wanted = `second-${ctx.runId}@example.com`;
  for (const emails of [
    [{ value: `first-${ctx.runId}@example.com` }, { value: wanted }],
    [{ value: `other-${ctx.runId}@example.com` }],
  ]) {
    const made = await client.createItem({
      type: "core.entity.person",
      source: ctx.source,
      tier: "library",
      properties: { name: `person ${ctx.runId}`, emails },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    person ??= made.data.item.id;
  }
  for (const emails of [wanted, { value: wanted }, [wanted], [{ value: 1 }]]) {
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      properties: { body: ctx.runId, emails },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
  }
  store = newStore("entry-member-filter");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(await device.hydrate(["core.entity.person", "core.note"], "library"));
});

afterAll(async () => {
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

it("finds a person by their second email from the copy, as the server does", async () => {
  for (const [term, expected] of [
    [`properties.emails.value eq "second-${ctx.runId}@example.com"`, [person]],
    ["properties.emails.value eq 1", undefined],
  ] as const) {
    const filter = `source eq "${ctx.source}" AND ${term}`;
    const served = await client.listItems({ filter, limit: 100 });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    const ids = served.data.data.map((row) => row.id).sort();
    if (expected !== undefined) expect(ids, term).toEqual(expected);
    else expect(ids, term).toHaveLength(1);
    const local = value(await device.list({ filter }))
      .map((row) => row.id)
      .sort();
    expect(local, term).toEqual(ids);
  }
});
