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
    "tags-read",
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

async function seed(title: string, tags: string[] = [], sourceId?: string) {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: "held" },
    tags,
    ...(sourceId === undefined ? {} : { source_id: sourceId }),
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

it("sends a tag replace naming the tags it read, and blocks it as a conflict once another key has changed them", async () => {
  const { device, clear } = aDevice("tags-read-moved");
  try {
    const moved = await seed("moved", ["theirs"]);
    // The witness: the same replace on an item nobody changes lands.
    const quiet = await seed("quiet", ["theirs"]);
    value(await device.hydrate(["core.note"], "library"));

    const replaced = value(await device.replaceTags(moved.id, ["mine"]));
    const witnessed = value(await device.replaceTags(quiet.id, ["mine"]));

    // Another key adds a tag after the device read the item. A tag write
    // leaves the item's version as it is.
    const added = await client.addTags(moved.id, ["added-between"]);
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    expect((await client.getItem(moved.id)).data.item.version).toBe(
      moved.version,
    );

    const report = value(await device.drain());
    const verdict = (id: string) =>
      report.verdicts.find((entry) => entry.id === id);
    expect(verdict(witnessed.id), JSON.stringify(report)).toMatchObject({
      verdict: "accepted",
    });
    expect(
      verdict(replaced.id),
      "the replace went over a tag another key added since the device read the item",
    ).toMatchObject({ verdict: "blocked", reason: "conflict_unresolved" });
    expect(await serverTags(quiet.id)).toEqual(["mine"]);
    expect(await serverTags(moved.id)).toEqual(["theirs", "added-between"]);
    expect(replaced.body, "the replace named no tags it read").toMatchObject({
      tags: ["mine"],
      read_tags: ["theirs"],
    });
    // The copy keeps what the person wrote while the write is blocked.
    expect(value(await device.get(moved.id)).tags).toEqual(["mine"]);

    // Released, the person chose to replace the tags as the item now stands.
    expect(value(await device.release({ id: replaced.id }))).toBeTruthy();
    const released = value(await device.queue()).find(
      (write) => write.id === replaced.id,
    );
    expect(
      released?.body,
      "a released replace still named the tags it read",
    ).toEqual({ tags: ["mine"] });
    const again = value(await device.drain());
    expect(
      again.verdicts.find((entry) => entry.id === replaced.id),
      JSON.stringify(again),
    ).toMatchObject({ verdict: "accepted" });
    expect(await serverTags(moved.id)).toEqual(["mine"]);
  } finally {
    clear();
  }
});

it("sends a tag replace of an item whose content another key changed since the read when its tags did not change", async () => {
  const { device, clear } = aDevice("tags-read-content");
  try {
    const held = await seed("content moved", ["theirs"]);
    value(await device.hydrate(["core.note"], "library"));
    const replaced = value(await device.replaceTags(held.id, ["mine"]));

    const edited = await client.updateItem(held.id, {
      version: held.version,
      properties: { body: "unseen by the device" },
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);

    const report = value(await device.drain());
    expect(
      report.verdicts.find((entry) => entry.id === replaced.id),
      JSON.stringify(report),
    ).toMatchObject({ verdict: "accepted" });
    expect(await serverTags(held.id)).toEqual(["mine"]);
  } finally {
    clear();
  }
});

it("sends a tag replace queued behind this device's own tag write, update and create on the tags those writes leave", async () => {
  const { device, clear } = aDevice("tags-read-own");
  try {
    const held = await seed("own writes", ["theirs"]);
    const upsert = await seed("natural key", [], "tags-read-natural-key");
    value(await device.hydrate(["core.note"], "library"));

    const own = [
      value(await device.addTag(held.id, "added-here")),
      value(
        await device.update(held.id, {
          version: held.version,
          properties: { body: "edited here" },
        }),
      ),
      value(await device.replaceTags(held.id, ["mine"])),
    ];
    const created = value(
      await device.create({
        type: "core.note",
        properties: { title: "own create", body: "made here" },
        tags: ["born-with"],
      }),
    );
    const madeId = created.item_id!;
    trackItem(ctx, madeId);
    const afterCreate = value(await device.replaceTags(madeId, ["fresh"]));
    // A create by natural key that lands on an item the server already holds.
    const onto = value(
      await device.create({
        type: "core.note",
        properties: { title: "natural key", body: "made here" },
        sourceId: "tags-read-natural-key",
        source: ctx.source,
      }),
    );
    const afterUpsert = value(
      await device.replaceTags(onto.item_id!, ["onto"]),
    );

    const report = value(await device.drain());
    for (const queued of [...own, afterCreate, afterUpsert]) {
      expect(
        report.verdicts.find((entry) => entry.id === queued.id),
        `${queued.kind} behind this device's own write was not accepted: ${JSON.stringify(report)}`,
      ).toMatchObject({ verdict: "accepted" });
    }
    expect(afterCreate.body).toMatchObject({ read_tags: ["born-with"] });
    expect(await serverTags(held.id)).toEqual(["mine"]);
    expect(await serverTags(madeId)).toEqual(["fresh"]);
    expect(await serverTags(upsert.id)).toEqual(["onto"]);
  } finally {
    clear();
  }
});
