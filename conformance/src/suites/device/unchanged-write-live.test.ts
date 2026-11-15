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
 * A queued edit that turns out to change nothing, drained against the server
 * that answers it as unchanged.
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext("device", "unchanged"));
  const minted = await client.createKey({
    label: `${ctx.source}-unchanged`,
    source: `${ctx.source}-unchanged`,
    default_tier: "library",
    type_permissions: { "core.note": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("unchanged"),
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

it("accepts a drained edit the server answers as unchanged, reports it replayed, and keeps the item at the version it held", async () => {
  const id =
    value(
      await device.create({
        type: "core.note",
        properties: { title: "held", body: "kept" },
      }),
    ).item_id ?? "";
  trackItem(ctx, id);
  value(await device.drain());
  const held = value(await device.get(id));

  value(
    await device.update(id, {
      properties: { body: "kept" },
      version: held.version,
    }),
  );
  const drained = value(await device.drain());

  expect(drained.verdicts.length).toBe(1);
  expect(drained.verdicts[0]).toMatchObject({
    verdict: "accepted",
    replayed: true,
  });
  const queued = value(await device.queue());
  expect(queued.map((entry) => entry.verdict)).toEqual([
    "accepted",
    "accepted",
  ]);
  const read = await client.getItem(id);
  expect(read.data.item.version).toBe(held.version);
  expect(value(await device.get(id)).version).toBe(held.version);

  // The witness: an edit that changes the body is written at the next version.
  value(
    await device.update(id, {
      properties: { body: "changed" },
      version: held.version,
    }),
  );
  const changed = value(await device.drain());
  expect(changed.verdicts[0]).toMatchObject({ verdict: "accepted" });
  expect(changed.verdicts[0]?.replayed).toBeFalsy();
  expect((await client.getItem(id)).data.item.version).toBe(held.version + 1);
});
