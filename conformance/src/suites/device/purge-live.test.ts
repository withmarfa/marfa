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
 * A purge through a working copy (`device.md` 75 to 82), run against a real
 * server and the real binary: sent at once and never queued, refused with the
 * copy and the queue left as they were, and the row, its edges and its pin
 * taken out once the server answers.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext("device", "purge"));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function key(label: string, permissions: string[]): Promise<string> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    default_tier: "library",
    permissions,
    type_permissions: { "core.note": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return minted.data.key;
}

async function note(title: string, tier: "library" | "feed" = "library") {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier,
    properties: { title, body: title },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item;
}

async function hydrated(label: string, permissions: string[]) {
  const device = new CliDevice({
    binary: requireBinary(),
    store: newStore(`purge-${label}`),
    url: apiUrl,
    key: await key(label, permissions),
  });
  value(await device.hydrate(["core.note"], "library"));
  return device;
}

async function trashed(device: CliDevice): Promise<string[]> {
  return value(await device.list({ state: "trashed" })).map((row) => row.id);
}

it("purges a row in the bin at once, queueing nothing", async () => {
  const doomed = await note("Purged at once");
  expect((await client.deleteItem(doomed.id)).ok).toBe(true);
  const device = await hydrated("at-once", ["items.purge"]);
  // The witness: the row is held in the bin, and nothing is queued.
  expect(await trashed(device)).toContain(doomed.id);
  expect(value(await device.queue())).toEqual([]);

  expect(value(await device.purgeItem(doomed.id))).toEqual({
    id: doomed.id,
    purged: true,
  });
  expect(
    value(await device.queue()),
    "a purge was held in the queue rather than sent",
  ).toEqual([]);
  const read = await client.getItem(doomed.id);
  expect(read.status, "the server still holds the purged row").toBe(404);
  expect(await trashed(device)).not.toContain(doomed.id);
});

it("takes the row and its pin out once the server accepts, and the event after changes nothing", async () => {
  const doomed = await note("Purged from the slice");
  const kept = await note("Keeps its own row");
  trackItem(ctx, kept.id);
  const pinned = await note("Pinned outside the slice", "feed");

  const device = await hydrated("pinned", ["items.purge"]);
  value(await device.pin(pinned.id));
  // Trashed by another client, so the copy holds both rows in the bin.
  expect((await client.deleteItem(doomed.id)).ok).toBe(true);
  expect((await client.deleteItem(pinned.id)).ok).toBe(true);
  value(await device.catchUp());
  // The witnesses: both rows are held in the bin, and the pin is held.
  expect(await trashed(device)).toEqual(
    expect.arrayContaining([doomed.id, pinned.id]),
  );
  expect(value(await device.status()).pinned).toContain(pinned.id);

  value(await device.purgeItem(doomed.id));
  value(await device.purgeItem(pinned.id));
  const left = await trashed(device);
  expect(left, "the copy kept a row the server purged").not.toContain(
    doomed.id,
  );
  expect(left).not.toContain(pinned.id);
  expect(
    value(await device.status()).pinned,
    "the purged row stayed pinned",
  ).not.toContain(pinned.id);
  expect(value(await device.get(kept.id)).id).toBe(kept.id);

  const before = value(await device.status());
  // The witness: the catch-up carried the purges' events, and took nothing.
  const caught = value(await device.catchUp());
  expect(caught.skipped + caught.applied).toBeGreaterThan(0);
  const after = value(await device.status());
  expect([after.items, after.edges, after.pinned]).toEqual([
    before.items,
    before.edges,
    before.pinned,
  ]);
  expect(value(await device.queue())).toEqual([]);
});

it("refuses a purge of a row not in the bin, keeping it", async () => {
  const active = await note("Not in the bin");
  trackItem(ctx, active.id);
  const device = await hydrated("active", ["items.purge"]);
  const refused = await device.purgeItem(active.id);
  expect(refused.ok, "a row outside the bin was purged").toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.code).toBe("validation");
    expect(refused.refusal.raw).toContain("invalid_transition");
  }
  expect(value(await device.get(active.id)).state).toBe("active");
  expect((await client.getItem(active.id)).ok).toBe(true);
  expect(value(await device.queue())).toEqual([]);
});

it("refuses a purge the key may not make, keeping the row", async () => {
  const doomed = await note("Refused a purge");
  trackItem(ctx, doomed.id);
  expect((await client.deleteItem(doomed.id)).ok).toBe(true);
  const device = await hydrated("no-purge", []);
  expect(await trashed(device)).toContain(doomed.id);
  const refused = await device.purgeItem(doomed.id);
  expect(refused.ok, "a key without items.purge purged a row").toBe(false);
  if (!refused.ok) expect(refused.refusal.code).toBe("forbidden");
  expect(await trashed(device)).toContain(doomed.id);
  // Still on the server: the owner's key brings it back.
  expect((await client.restoreItem(doomed.id)).ok).toBe(true);
  expect(value(await device.queue())).toEqual([]);
});

it("refuses a purge of a row that moved since the copy read it, keeping it", async () => {
  const moved = await note("Moved since it was read");
  trackItem(ctx, moved.id);
  expect((await client.deleteItem(moved.id)).ok).toBe(true);
  const device = await hydrated("moved", ["items.purge"]);
  expect(await trashed(device)).toContain(moved.id);
  // Another client brings it back, changes it and trashes it again: the
  // version moves and the state ends where the copy saw it.
  expect((await client.restoreItem(moved.id)).ok).toBe(true);
  const edited = await client.updateItem(moved.id, {
    properties: { title: "changed elsewhere" },
    version: moved.version,
  });
  expect(edited.ok, JSON.stringify(edited.error)).toBe(true);
  expect((await client.deleteItem(moved.id)).ok).toBe(true);

  const refused = await device.purgeItem(moved.id);
  expect(refused.ok, "a purge destroyed a row changed since it was read").toBe(
    false,
  );
  if (!refused.ok) expect(refused.refusal.raw).toContain("version_conflict");
  expect(await trashed(device)).toContain(moved.id);
  expect((await client.restoreItem(moved.id)).ok).toBe(true);
});
