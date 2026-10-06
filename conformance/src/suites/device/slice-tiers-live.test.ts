import { afterAll, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome, Tier } from "../../device/protocol.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * A slice of both tiers (`device.md` 86 and 87), against a real server and
 * the real binary. Every device step is its own process, so each one opens
 * the store afresh, as an app does after a restart, and a local write runs in
 * a process that names no server at all.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const stores: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "slice-tiers",
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

function device(label: string): CliDevice {
  const store = newStore(label);
  stores.push(store);
  return new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
}

async function made(title: string, tier: Tier): Promise<string> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier,
    properties: { title, body: title },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

async function onServer(
  id: string,
): Promise<{ tier: string | undefined; version: number }> {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return { tier: read.data.item.tier, version: read.data.item.version };
}

/** The tier the copy shows each id at, and `null` for one it does not hold. */
async function shown(
  copy: CliDevice,
  ids: string[],
): Promise<Record<string, Tier | null>> {
  const listed = value(await copy.list({ limit: 10_000 }));
  const byId = new Map<string, Item>(listed.map((item) => [item.id, item]));
  return Object.fromEntries(ids.map((id) => [id, byId.get(id)?.tier ?? null]));
}

it("hydrates both tiers, keeps a triage made offline through a restart and its drain, and sees a move made elsewhere", async () => {
  const inbox = await made("in the inbox", "feed");
  const record = await made("in the record", "library");
  const copy = device("slice-tiers-both");

  const hydrated = value(await copy.hydrate(["core.note"], "all"));
  expect(hydrated.tier).toBe("all");
  expect(value(await copy.status()).slice_tier).toBe("all");
  expect(await shown(copy, [inbox, record])).toEqual({
    [inbox]: "feed",
    [record]: "library",
  });

  // Triaged with no server named: the edit moves the item to the library.
  const offline = copy.reopen({ url: undefined, key: undefined });
  value(
    await offline.update(inbox, {
      version: (await onServer(inbox)).version,
      properties: {},
      tier: "library",
    }),
  );
  expect(
    (await shown(offline, [inbox]))[inbox],
    "the triaged item left a copy that holds both tiers before it was sent",
  ).toBe("library");
  expect((await onServer(inbox)).tier).toBe("feed");

  // Another process drains what the first queued.
  const drained = value(await copy.drain());
  expect(drained.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "accepted",
  ]);
  expect((await onServer(inbox)).tier).toBe("library");
  value(await copy.catchUp());
  expect(await shown(copy, [inbox, record])).toEqual({
    [inbox]: "library",
    [record]: "library",
  });

  // A move made elsewhere, which a catch-up reads.
  const moved = await client.updateItem(record, {
    version: (await onServer(record)).version,
    tier: "feed",
  });
  expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
  const caught = value(await copy.catchUp());
  expect(caught.applied).toBeGreaterThan(0);
  expect(
    await shown(copy, [inbox, record]),
    "a row moved to the feed elsewhere left a copy that holds both tiers",
  ).toEqual({ [inbox]: "library", [record]: "feed" });

  // Hydrated again at one tier, the other goes, as from any changed slice.
  value(await copy.hydrate(["core.note"], "library"));
  expect(value(await copy.status()).slice_tier).toBe("library");
  expect(await shown(copy, [inbox, record])).toEqual({
    [inbox]: "library",
    [record]: null,
  });
  // The witness that a slice of one tier still lets a move go.
  const back = await client.updateItem(inbox, {
    version: (await onServer(inbox)).version,
    tier: "feed",
  });
  expect(back.ok, JSON.stringify(back.error)).toBe(true);
  value(await copy.catchUp());
  expect((await shown(copy, [inbox]))[inbox]).toBe(null);
});

it("creates offline at each tier in a slice of both, and the server holds each where it was shown", async () => {
  const copy = device("slice-tiers-create");
  value(await copy.hydrate(["core.note"], "all"));
  const offline = copy.reopen({ url: undefined, key: undefined });
  const ids: Record<string, string> = {};
  for (const [label, tier] of [
    ["unnamed", undefined],
    ["library", "library"],
    ["feed", "feed"],
  ] as const) {
    const queued = value(
      await offline.create({
        type: "core.note",
        ...(tier === undefined ? {} : { tier }),
        properties: { title: `created at ${label}`, body: label },
      }),
    );
    ids[label] = queued.item_id ?? "";
    trackItem(ctx, ids[label]!);
  }
  const expected = {
    [ids.unnamed!]: "library",
    [ids.library!]: "library",
    [ids.feed!]: "feed",
  };
  expect(await shown(offline, Object.keys(expected))).toEqual(expected);
  expect(value(await offline.status()).pinned).toEqual([]);

  const drained = value(await copy.drain());
  expect(drained.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "accepted",
    "accepted",
    "accepted",
  ]);
  for (const [id, tier] of Object.entries(expected)) {
    expect((await onServer(id)).tier, id).toBe(tier);
  }
  value(await copy.catchUp());
  expect(await shown(copy, Object.keys(expected))).toEqual(expected);
});

it("re-saves a feed row by its natural key in a slice of both without moving it", async () => {
  const key = `slice-tiers-${ctx.runId}`;
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    source_id: key,
    tier: "feed",
    properties: { title: "kept in the inbox", body: "first" },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const id = created.data.item.id;
  trackItem(ctx, id);
  const copy = device("slice-tiers-keyed");
  value(await copy.hydrate(["core.note"], "all"));
  const offline = copy.reopen({ url: undefined, key: undefined });
  const queued = value(
    await offline.create({
      type: "core.note",
      source: ctx.source,
      sourceId: key,
      properties: { title: "kept in the inbox", body: "synced again" },
    }),
  );
  expect(
    value(await offline.get(queued.item_id ?? "")).tier,
    "a re-save naming no tier was shown at another tier than the row its key names",
  ).toBe("feed");
  const drained = value(await copy.drain());
  expect(drained.verdicts.map((verdict) => verdict.verdict)).toEqual([
    "accepted",
  ]);
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  expect(read.data.item.properties.body).toBe("synced again");
  expect(
    read.data.item.tier,
    "a re-save naming no tier moved the row its key names out of the feed",
  ).toBe("feed");
  value(await copy.catchUp());
  expect((await shown(copy, [id]))[id]).toBe("feed");
});
