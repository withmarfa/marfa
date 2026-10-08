import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * What a null in a write does on the copy, held to what the server does with
 * it (`queue-and-verdicts/update-sends-nulls` and `queue-and-verdicts/create-null-optional`), before the drain and after.
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
beforeAll(async () => {
  let apiUrl: string;
  ({ client, ctx, apiUrl } = await createTestContext("device", "nulls"));
  const minted = await client.createKey({
    label: `${ctx.source}-nulls`,
    source: `${ctx.source}-nulls`,
    default_tier: "library",
    type_permissions: { "core.note": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("nulls"),
    url: apiUrl,
    key: minted.data.key,
  });
  value(await device.hydrate(["core.note"], "library"));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function shown(id: string): Promise<Record<string, unknown>> {
  return value(await device.get(id)).properties;
}

async function answered(id: string): Promise<Record<string, unknown>> {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return read.data.item.properties;
}

it("leaves a property a merging null names, as the server does", async () => {
  const id =
    value(
      await device.create({
        type: "core.note",
        properties: { body: "b", notes: "declared", courier: "undeclared" },
      }),
    ).item_id ?? "";
  trackItem(ctx, id);
  value(await device.drain());
  const held = value(await device.get(id));
  value(
    await device.update(id, {
      properties: { notes: null, courier: null, title: "changed" },
      version: held.version,
    }),
  );
  const kept = {
    body: "b",
    notes: "declared",
    courier: "undeclared",
    title: "changed",
  };
  expect(await shown(id), "the copy cleared what a null names").toEqual(kept);
  value(await device.drain());
  expect(await answered(id)).toEqual(kept);
  expect(await shown(id)).toEqual(kept);

  // The witness: an edit sending the properties whole clears them, on both.
  const again = value(await device.get(id));
  value(
    await device.update(id, {
      properties: { body: "b", title: "changed" },
      version: again.version,
      replace: true,
    }),
  );
  const cleared = { body: "b", title: "changed" };
  expect(await shown(id)).toEqual(cleared);
  value(await device.drain());
  expect(await answered(id)).toEqual(cleared);
});

it("leaves out a create's null on a declared optional field, as the server does", async () => {
  const id =
    value(
      await device.create({
        type: "core.note",
        properties: {
          body: "b",
          title: null,
          links: null,
          attachments: null,
          courier: null,
        },
      }),
    ).item_id ?? "";
  trackItem(ctx, id);
  const held = { body: "b", courier: null };
  expect(await shown(id), "the copy held a null the server leaves out").toEqual(
    held,
  );
  value(await device.drain());
  expect(await answered(id)).toEqual(held);
  expect(await shown(id)).toEqual(held);
});
