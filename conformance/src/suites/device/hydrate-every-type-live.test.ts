import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A slice of every type (`device/hydrate-every-type`) against a real server
 * and the real binary.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const stores: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "hydrate-every-type",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  for (const store of stores) {
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function made(type: string, title: string): Promise<string> {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties: { title },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

it("holds every type registered before the hydration in one pass, and takes a later item of each by its event", async () => {
  const types = [`user.alpha-${ctx.runId}`, `acme.beta-${ctx.runId}`];
  for (const id of types) {
    const registered = await client.registerType({
      id,
      fields: { title: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  }
  const before = await Promise.all(types.map((id) => made(id, "before")));
  const store = newStore("every-type");
  stores.push(store);
  const copy = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });

  const hydrated = value(await copy.hydrate(["*"], "library"));
  expect(hydrated.types).toEqual(["*"]);
  expect(value(await copy.status()).slice_types).toEqual(["*"]);
  for (const id of before) {
    expect(
      (await copy.get(id)).ok,
      "a type no hydration named was left out of a slice of every type",
    ).toBe(true);
  }

  const after = await Promise.all(types.map((id) => made(id, "after")));
  value(await copy.catchUp());
  for (const id of after) {
    expect((await copy.get(id)).ok, "an event of a held type was dropped").toBe(
      true,
    );
  }
  expect(value(await copy.status()).hydration).toBe("complete");

  const refused = await copy.hydrate(["*", types[0]!], "library");
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.refusal.code).toBe("invalid");
});
