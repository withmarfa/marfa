import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * The bin through a working copy (`device/bin-read`, `device/bin-read-order`, `device/bin-unheld`, `device/bin-offline`, `device/pin-trashed`,
 * `device/read-back-trashed-held`, `device/read-back-trashed-pin`, `queue-and-verdicts/refused-row-absent` and
 * `queue-and-verdicts/restore-by-id`), against a real server and the real binary.
 * Each device command is a process of its own, so every step here is also a
 * device started again.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext("device", "bin"));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function device(
  label: string,
  tier: "library" | "feed",
): Promise<CliDevice> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    default_tier: "library",
    permissions: ["items.purge"],
    type_permissions: { "core.note": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  const made = new CliDevice({
    binary: requireBinary(),
    store: newStore(`bin-${label}`),
    url: apiUrl,
    key: minted.data.key,
  });
  value(await made.hydrate(["core.note"], tier));
  return made;
}

async function trashedNote(title: string) {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: title },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackItem(ctx, created.data.item.id);
  expect((await client.deleteItem(created.data.item.id)).ok).toBe(true);
  return created.data.item;
}

/** Every page of the bin until each of `ids` is found, or the bin ends. */
async function findInBin(
  from: CliDevice,
  ids: string[],
  limit = 100,
): Promise<{ found: Map<string, Item>; pages: number }> {
  const found = new Map<string, Item>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = value(await from.bin({ type: "core.note", limit, cursor }));
    pages += 1;
    expect(page.data.length).toBeLessThanOrEqual(limit);
    for (const row of page.data) {
      expect(row.state).toBe("trashed");
      if (ids.includes(row.id)) found.set(row.id, row);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined && found.size < ids.length && pages < 500);
  return { found, pages };
}

it("reads the server's bin a page at a time, holding nothing", async () => {
  const rows = [
    await trashedNote("bin one"),
    await trashedNote("bin two"),
    await trashedNote("bin three"),
  ];
  // A copy of the other tier holds none of them.
  const copy = await device("read", "feed");
  const before = value(await copy.status());
  const { found, pages } = await findInBin(
    copy,
    rows.map((row) => row.id),
    2,
  );
  expect([...found.keys()].sort()).toEqual(rows.map((row) => row.id).sort());
  expect(pages, "three rows came on one page of two").toBeGreaterThan(1);
  for (const row of found.values()) {
    expect(row.updated_at).toBeTruthy();
    expect(row.version).toBeGreaterThan(0);
  }
  const after = value(await copy.status());
  expect(after.items, "the bin's rows were held in the copy").toBe(
    before.items,
  );
  const held = value(await copy.list({ state: "trashed", tier: "library" }));
  expect(held.map((row) => row.id)).not.toContain(rows[0]!.id);
});

it("reads the server's bin newest binned first, with when each row went there", async () => {
  // Created a, b, c and binned b, c, a, so newest binned first is a, c, b
  // where creation order is c, b, a.
  const made: string[] = [];
  for (const title of ["order a", "order b", "order c"]) {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      properties: { title, body: title },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    trackItem(ctx, created.data.item.id);
    made.push(created.data.item.id);
  }
  const [a, b, c] = made as [string, string, string];
  for (const id of [b, c, a]) {
    expect((await client.deleteItem(id)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const copy = await device("order", "feed");
  const page = value(await copy.bin({ type: "core.note", limit: 100 }));
  const mine = page.data.filter((row) => made.includes(row.id));
  expect(
    mine.map((row) => row.id),
    "the bin was not read newest binned first",
  ).toEqual([a, c, b]);
  for (const row of mine) expect(row.trashed_at).not.toBeNull();
});

it("refuses to pin a row in the bin, saying so", async () => {
  const doomed = await trashedNote("pinned from the bin");
  const active = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title: "pinned live", body: "b" },
  });
  expect(active.ok).toBe(true);
  trackItem(ctx, active.data.item.id);
  const copy = await device("pin", "feed");
  // The witness: a row outside the bin pins.
  value(await copy.pin(active.data.item.id));

  const refused = await copy.pin(doomed.id);
  expect(refused.ok, "a row in the bin was pinned").toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.code).toBe("not_found");
    expect(refused.refusal.raw).toContain("trashed");
  }
  expect(value(await copy.status()).pinned).not.toContain(doomed.id);
});

it("refuses a pin of a row in the bin of a type the key may not read as one that is gone", async () => {
  const unread = await client.createItem({
    type: "core.task",
    source: ctx.source,
    tier: "library",
    properties: { title: "a task the key may not read" },
  });
  expect(unread.ok, JSON.stringify(unread.error)).toBe(true);
  trackItem(ctx, unread.data.item.id);
  expect((await client.deleteItem(unread.data.item.id)).ok).toBe(true);
  const readable = await trashedNote("a note the key may read");
  const copy = await device("pin-unread", "feed");
  // The witness: a row in the bin the key may read is refused as one.
  const binned = await copy.pin(readable.id);
  expect(!binned.ok && binned.refusal.raw).toContain("trashed");

  const refused = await copy.pin(unread.data.item.id);
  expect(refused.ok, "a row the key may not read was pinned").toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.code).toBe("not_found");
    expect(
      refused.refusal.raw,
      "the copy told a key that may not read a row that it is in the bin",
    ).not.toContain("trashed");
  }
  expect(value(await copy.status()).pinned).not.toContain(unread.data.item.id);
});

it("keeps a row it holds in the bin when a pin of it is refused", async () => {
  const trashed = await trashedNote("held in the bin");
  const copy = await device("pin-held", "library");
  const inBin = async () =>
    value(
      await copy.list({
        state: "trashed",
        tier: "library",
        filter: `id eq "${trashed.id}"`,
      }),
    ).map((row) => row.id);
  // The witness: a copy of the library holds the row its slice takes, in
  // the bin as in any other state.
  expect(await inBin()).toContain(trashed.id);

  const refused = await copy.pin(trashed.id);
  expect(refused.ok, "a row in the bin was pinned").toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.code).toBe("not_found");
    expect(refused.refusal.raw).toContain("trashed");
  }
  expect(
    await inBin(),
    "a refused pin let go of a row the slice takes, so the copy no longer shows the bin it holds",
  ).toContain(trashed.id);
  expect(value(await copy.status()).pinned).not.toContain(trashed.id);
});

async function heldNote(title: string) {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: title },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item;
}

/** The row of `id` the copy holds in the bin, if it holds one. */
async function heldInBin(copy: CliDevice, id: string): Promise<Item[]> {
  return value(
    await copy.list({
      state: "trashed",
      tier: "library",
      filter: `id eq "${id}"`,
    }),
  );
}

it("keeps a row another client trashed when the read after its refused edit finds it gone by id", async () => {
  const note = await heldNote("edited here, trashed there");
  const copy = await device("refused-edit", "library");
  value(
    await copy.update(note.id, {
      properties: { title: "edited here" },
      version: note.version,
    }),
  );
  expect((await client.deleteItem(note.id)).ok).toBe(true);
  value(await copy.catchUp());
  // The witness: the catch-up brought the row into the copy's bin.
  expect((await heldInBin(copy, note.id)).map((row) => row.id)).toEqual([
    note.id,
  ]);

  const report = value(await copy.drain());
  expect(report.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "refused",
  ]);
  expect(
    (await heldInBin(copy, note.id)).map((row) => row.id),
    "the read after the refusal let go of a row the server holds in the bin",
  ).toEqual([note.id]);
});

it("keeps a row it trashed itself, held only by its pin, at the server's version once the delete is answered", async () => {
  const note = await heldNote("trashed here");
  // A copy of the feed, so only the pin holds the library's note.
  const copy = await device("own-delete", "feed");
  value(await copy.pin(note.id));
  value(await copy.deleteItem(note.id));
  // The witness: the copy shows its own delete in the bin while it waits.
  expect((await heldInBin(copy, note.id)).map((row) => row.id)).toEqual([
    note.id,
  ]);

  const report = value(await copy.drain());
  expect(report.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "accepted",
  ]);
  const server = (await findInBin(copy, [note.id])).found.get(note.id);
  expect(server, "the server's bin does not hold the row").toBeDefined();
  const held = await heldInBin(copy, note.id);
  expect(
    held.map((row) => row.id),
    "the read after the answer let go of the row the device trashed",
  ).toEqual([note.id]);
  expect(held[0]!.version).toBe(server!.version);
  expect(held[0]!.updated_at).toBe(server!.updated_at);
  expect(value(await copy.status()).pinned).toContain(note.id);

  // Named with no version, a purge goes only to a row the copy holds.
  expect(value(await copy.purgeItem(note.id)).purged).toBe(true);
  expect((await findInBin(copy, [note.id])).found.has(note.id)).toBe(false);
});

it("lets go of a row neither a read by id nor the bin holds after its refused edit", async () => {
  const note = await heldNote("edited here, purged there");
  const copy = await device("purged", "library");
  value(
    await copy.update(note.id, {
      properties: { title: "edited here" },
      version: note.version,
    }),
  );
  expect((await client.deleteItem(note.id)).ok).toBe(true);
  expect((await client.purgeItem(note.id)).ok).toBe(true);
  // The witness: no catch-up, so the copy still holds the row.
  expect(
    value(
      await copy.list({ allStates: true, filter: `id eq "${note.id}"` }),
    ).map((row) => row.id),
  ).toEqual([note.id]);

  const report = value(await copy.drain());
  expect(report.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "refused",
  ]);
  expect(
    value(await copy.list({ allStates: true, filter: `id eq "${note.id}"` })),
    "the copy kept a row the server holds nowhere",
  ).toEqual([]);
});

it("restores a row read from the bin that the copy does not hold", async () => {
  const copy = await device("restore", "library");
  // Made and trashed elsewhere after the copy's hydration, and not caught
  // up, so the copy does not hold it.
  const id = (await trashedNote("trashed elsewhere, restored here")).id;
  // The witness: the row is in the bin on the server and not in the copy.
  expect((await findInBin(copy, [id])).found.has(id)).toBe(true);
  const held = value(await copy.list({ state: "trashed" }));
  expect(
    held.map((row) => row.id),
    "the copy held a row it never read",
  ).not.toContain(id);

  const restored = value(await copy.restoreItem(id));
  expect(restored.kind).toBe("restore_item");
  expect(restored.item_id).toBe(id);
  const twice = await copy.restoreItem(id);
  expect(twice.ok, "a second restore of the same row was queued").toBe(false);
  if (!twice.ok) expect(twice.refusal.code).toBe("invalid");
  expect(
    (await copy.get(id)).ok,
    "the copy showed a row it does not hold before the restore was answered",
  ).toBe(false);
  expect(
    value(await copy.drain()).verdicts.map((verdict) => verdict.verdict),
  ).toEqual(["accepted"]);
  value(await copy.catchUp());
  expect(value(await copy.get(id)).state).toBe("active");
  const read = await client.getItem(id);
  expect(read.ok && read.data.item.state).toBe("active");
});

it("purges a row read from the bin at the version it was read at", async () => {
  const doomed = await trashedNote("purged from the bin");
  const copy = await device("purge", "feed");
  const refused = await copy.purgeItem(doomed.id);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.refusal.raw).toContain("not_held");

  const entry = (await findInBin(copy, [doomed.id])).found.get(doomed.id);
  expect(entry, "the row was not in the bin").toBeDefined();
  value(await copy.purgeItem(doomed.id, entry!.version));
  expect((await findInBin(copy, [doomed.id])).found.has(doomed.id)).toBe(false);
  expect(value(await copy.queue())).toEqual([]);
});
