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
 * A slice of every type holds no hidden `app.*` item (`device/hydrate-every-type`),
 * against a real server and the real binary.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const stores: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "hidden-types",
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

it("holds no app item in a slice of every type, by hydration or by event, and holds a user item the same way", async () => {
  const shown = `user.shown-${ctx.runId}`;
  const hidden = `app.hidden-${ctx.runId}.setting`;
  for (const id of [shown, hidden]) {
    const registered = await client.registerType({
      id,
      fields: { title: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  }
  const shownBefore = await made(shown, "before");
  const hiddenBefore = await made(hidden, "before");
  const store = newStore("hidden-types");
  stores.push(store);
  const copy = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });

  value(await copy.hydrate(["*"], "library"));
  expect(
    (await copy.get(shownBefore)).ok,
    "a slice of every type left out an item of a visible type",
  ).toBe(true);
  expect(
    (await copy.get(hiddenBefore)).ok,
    "a slice of every type held an app item by hydration",
  ).toBe(false);

  const shownAfter = await made(shown, "after");
  const hiddenAfter = await made(hidden, "after");
  value(await copy.catchUp());
  expect(
    (await copy.get(shownAfter)).ok,
    "an event of a visible type was dropped",
  ).toBe(true);
  expect(
    (await copy.get(hiddenAfter)).ok,
    "a slice of every type took an app item by event",
  ).toBe(false);

  const named = newStore("hidden-types-named");
  stores.push(named);
  const beside = new CliDevice({
    binary: requireBinary(),
    store: named,
    url: apiUrl,
    key: apiKey,
  });
  value(await beside.hydrate(["*", hidden], "library"));
  expect(
    (await beside.get(hiddenBefore)).ok,
    "a slice naming the app type beside the star left its item out",
  ).toBe(true);
  expect((await beside.get(shownBefore)).ok).toBe(true);
});

it("reads an app item in the bin as the server's bin answers it, with no type named", async () => {
  const shown = `user.binned-${ctx.runId}`;
  const hidden = `app.binned-${ctx.runId}.setting`;
  for (const id of [shown, hidden]) {
    const registered = await client.registerType({
      id,
      fields: { title: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  }
  const binned: string[] = [];
  for (const type of [shown, hidden]) {
    const id = await made(type, "binned");
    expect((await client.deleteItem(id)).ok).toBe(true);
    binned.push(id);
  }
  const [shownId, hiddenId] = binned as [string, string];
  const store = newStore("hidden-types-bin");
  stores.push(store);
  const copy = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  value(await copy.hydrate([shown], "library"));

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = value(await copy.bin({ limit: 100, cursor }));
    seen.push(...page.data.map((item) => item.id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  expect(seen, "the witness is in the bin").toContain(shownId);
  expect(seen, "the device's bin left out an app item").toContain(hiddenId);
});
