import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A device answers an item's tags in the order the server keeps them
 * (`items/tags-set`), whichever way the copy came to hold them: a hydration,
 * a catch-up, a write the server answered, or a tag the device wrote itself
 * and has not sent. Run against a real server and the real binary.
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let type: string;
let store: string;

beforeAll(async () => {
  const context = await createTestContext("device", "tag-order");
  ({ client, ctx } = context);
  type = `fixture.${ctx.runId}.tag_order`;
  const registered = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  trackType(ctx, type);
  store = newStore("tag-order-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  expect((await device.hydrate([type], "library")).ok).toBe(true);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
  if (store) rmSync(dirname(store), { recursive: true, force: true });
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function made(tags: string[]): Promise<string> {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties: { title: "row" },
    tags,
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const id = created.data.item.id;
  trackItem(ctx, id);
  return id;
}

async function answered(id: string): Promise<string[]> {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return read.data.metadata.tags;
}

async function shown(id: string): Promise<string[]> {
  return value(await device.get(id)).tags;
}

/** The witness for every comparison below: the order is not the one a sort gives. */
function expectOutOfOrder(tags: string[]): void {
  expect(tags).not.toEqual([...tags].sort());
}

it("answers the tags in the order the server answers them, after a hydration, a catch-up and a write the server answered", async () => {
  const id = await made(["zeta", "alpha", "mid"]);
  expect(await answered(id)).toEqual(["zeta", "alpha", "mid"]);

  value(await device.hydrate([type], "library"));
  expect(
    await shown(id),
    "a hydration answered the tags in another order than the server",
  ).toEqual(await answered(id));

  const added = await client.addTags(id, ["beta", "aardvark"]);
  expect(added.ok, JSON.stringify(added.error)).toBe(true);
  expectOutOfOrder(await answered(id));
  value(await device.catchUp());
  expect(
    await shown(id),
    "a catch-up answered the tags in another order than the server",
  ).toEqual(await answered(id));

  const replaced = await client.replaceMetadata(id, {
    tags: ["yak", "ant", "yak", "zebra", "bee"],
  });
  expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);
  expect(await answered(id)).toEqual(["yak", "ant", "zebra", "bee"]);
  value(await device.catchUp());
  expect(await shown(id)).toEqual(await answered(id));

  value(await device.addTag(id, "cat"));
  value(await device.drain());
  expect(
    await shown(id),
    "the answer to a write left the tags in another order than the server",
  ).toEqual(await answered(id));
});

it("places a tag the device adds last, keeps a tag already held where it was, and leaves the others in order when it removes one, before the write is sent and after", async () => {
  const id = await made(["zeta", "alpha", "mid"]);
  value(await device.hydrate([type], "library"));
  expect(await shown(id)).toEqual(await answered(id));

  value(await device.addTag(id, "aardvark"));
  expect(
    await shown(id),
    "a tag added before sending did not come last",
  ).toEqual(["zeta", "alpha", "mid", "aardvark"]);

  value(await device.addTag(id, "alpha"));
  expect(
    await shown(id),
    "a tag added twice moved from its first place",
  ).toEqual(["zeta", "alpha", "mid", "aardvark"]);

  value(await device.removeTag(id, "alpha"));
  expect(await shown(id), "a removal moved the tags that stayed").toEqual([
    "zeta",
    "mid",
    "aardvark",
  ]);

  value(await device.drain());
  expect(await answered(id)).toEqual(["zeta", "mid", "aardvark"]);
  expect(await shown(id)).toEqual(await answered(id));
});

it("answers a local replace of the tags in the order it names them, each once, before the write is sent and after", async () => {
  const id = await made(["one"]);
  value(await device.hydrate([type], "library"));

  const named = ["yak", "ant", "yak", "zebra", "bee"];
  value(await device.replaceMetadata(id, named));
  expect(
    await shown(id),
    "a replace before sending did not keep the order it names",
  ).toEqual(["yak", "ant", "zebra", "bee"]);

  value(await device.drain());
  expect(await answered(id)).toEqual(["yak", "ant", "zebra", "bee"]);
  expect(await shown(id)).toEqual(await answered(id));
});

it("answers an item created offline with its tags in the order they were named, before the write is sent and after", async () => {
  const named = ["zeta", "alpha", "mid"];
  const queued = value(
    await device.create({ type, properties: { title: "row" }, tags: named }),
  );
  const id = queued.item_id ?? "";
  trackItem(ctx, id);
  expect(await shown(id)).toEqual(named);

  value(await device.drain());
  expect(await answered(id)).toEqual(named);
  expect(await shown(id)).toEqual(named);
});
