import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "tags-version",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

async function serverTags(id: string): Promise<string[]> {
  const read = await client.getItem(id);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data.metadata.tags;
}

async function seed(title: string, tags: string[] = []) {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: "held" },
    tags,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, version: made.data.item.version };
}

function aDevice(label: string) {
  const store = newStore(label);
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  return { device, clear: () => rmSync(dirname(store), { recursive: true }) };
}

it("sends a tag replace on the version it read, and blocks it as a conflict once the item has moved", async () => {
  const { device, clear } = aDevice("tags-version-moved");
  try {
    const stale = await seed("moved", ["theirs"]);
    // The witness: the same replace on an item nobody changes lands.
    const quiet = await seed("quiet", ["theirs"]);
    value(await device.hydrate(["core.note"], "library"));

    const replaced = value(await device.replaceTags(stale.id, ["mine"]));
    const witnessed = value(await device.replaceTags(quiet.id, ["mine"]));
    expect(replaced.base_version, "the replace named no version").toBe(
      stale.version,
    );

    // Another writer changes the item's content after the device read it.
    const moved = await client.updateItem(stale.id, {
      version: stale.version,
      properties: { body: "unseen by the device" },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    const report = value(await device.drain());
    const verdict = (id: string) =>
      report.verdicts.find((entry) => entry.id === id);
    expect(verdict(witnessed.id), JSON.stringify(report)).toMatchObject({
      verdict: "accepted",
    });
    expect(
      verdict(replaced.id),
      "the replace went over an item whose content it had not read",
    ).toMatchObject({ verdict: "blocked", reason: "conflict_unresolved" });
    expect(await serverTags(quiet.id)).toEqual(["mine"]);
    expect(await serverTags(stale.id)).toEqual(["theirs"]);
    // The copy keeps what the person wrote, ready to be released.
    expect(value(await device.get(stale.id)).tags).toEqual(["mine"]);
  } finally {
    clear();
  }
});

it("sends a tag replace queued behind its own update and its own create on the version they made", async () => {
  const { device, clear } = aDevice("tags-version-own");
  try {
    const held = await seed("own update", ["theirs"]);
    value(await device.hydrate(["core.note"], "library"));

    value(
      await device.update(held.id, {
        version: held.version,
        properties: { body: "edited here" },
      }),
    );
    const afterUpdate = value(await device.replaceTags(held.id, ["mine"]));
    const created = value(
      await device.create({
        type: "core.note",
        properties: { title: "own create", body: "made here" },
      }),
    );
    const madeId = created.item_id!;
    trackItem(ctx, madeId);
    const afterCreate = value(await device.replaceTags(madeId, ["fresh"]));
    expect(afterCreate.base_version).toBe(0);

    const report = value(await device.drain());
    for (const queued of [afterUpdate, afterCreate]) {
      expect(
        report.verdicts.find((entry) => entry.id === queued.id),
        `a replace behind this device's own write was not accepted: ${JSON.stringify(report)}`,
      ).toMatchObject({ verdict: "accepted" });
    }
    expect(await serverTags(held.id)).toEqual(["mine"]);
    expect(await serverTags(madeId)).toEqual(["fresh"]);
  } finally {
    clear();
  }
});
