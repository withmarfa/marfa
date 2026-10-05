import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { TestContext } from "../../client/types.js";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import {
  MATCHING_CASES,
  MATCHING_FIELDS,
  MATCHING_ROWS,
  SNIPPET_QUERY,
} from "../../utils/search-matching.js";
import { requireBinary } from "./harness.js";

/**
 * A device matches a query as the server does (`search-and-filters.md` 42 to
 * 49): the same corpus and the same queries against the real server and the
 * real binary, with the same hits and the same excerpt. The order is held
 * to the server's for a corpus whose ranking does not turn on rows the device
 * does not hold, which is the only order a device holding a slice can promise
 * (48).
 */

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let store: ReturnType<typeof newStore>;
let typeId: string;
const ids = new Map<string, string>();

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

function id(key: string): string {
  const found = ids.get(key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

beforeAll(async () => {
  const context = await createTestContext("device", "search-live");
  ({ client, ctx } = context);
  typeId = `user.matching-${ctx.runId}`;
  const registered = await client.registerType({
    id: typeId,
    fields: { ...MATCHING_FIELDS },
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  for (const row of MATCHING_ROWS) {
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      tier: "library",
      properties: row.properties,
      tags: row.tags,
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    trackItem(ctx, created.data.item.id);
    ids.set(row.key, created.data.item.id);
  }
  store = newStore("search-live");
  device = new CliDevice({
    binary: requireBinary(),
    store,
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(await device.hydrate([typeId], "library"));
});

afterAll(async () => {
  if (store) rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

async function served(query: string) {
  const result = await client.search(query, { type: typeId, limit: 50 });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.data.data;
}

describe("a device matches as the server does", () => {
  it.each(MATCHING_CASES)(
    "answers the server's hits, in the server's order: $name: $query",
    async (testCase) => {
      const local = value(
        await device.search(testCase.query, { type: typeId }),
      );
      const remote = await served(testCase.query);
      expect(local.map((hit) => hit.item.id)).toEqual(
        remote.map((hit) => hit.item.id),
      );
      const wanted = testCase.hits.flatMap((group) => group.map(id).sort());
      if (testCase.ranked)
        expect(local.map((hit) => hit.item.id)).toEqual(wanted);
      else
        expect(local.map((hit) => hit.item.id).sort()).toEqual(wanted.sort());
    },
  );

  it("excerpts a match as the server does, from the column that holds it", async () => {
    for (const query of [SNIPPET_QUERY, "landscape", "dirigible", "kiwi"]) {
      const local = value(await device.search(query, { type: typeId }));
      const remote = await served(query);
      expect(local.length, query).toBeGreaterThan(0);
      expect(
        local.map((hit) => [hit.item.id, hit.snippet]),
        query,
      ).toEqual(remote.map((hit) => [hit.item.id, hit.snippet_html ?? ""]));
    }
    const long = value(await device.search(SNIPPET_QUERY, { type: typeId }));
    expect(long[0]?.snippet).toContain("<mark>needle</mark>");
    expect(long[0]?.snippet.startsWith("...")).toBe(true);
  });

  it("holds a changed type's searchable fields against rows it already holds", async () => {
    // The witness: the field is not searchable and the word is not found.
    expect(
      value(await device.search("blimp", { type: typeId })).map(
        (hit) => hit.item.id,
      ),
    ).toEqual([id("blimp")]);
    const updated = await client.replaceType(typeId, {
      id: typeId,
      version: 1,
      fields: { ...MATCHING_FIELDS, secret: { type: "string" } },
    });
    expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    // The server indexed the rows it stored again.
    expect((await served("blimp")).map((hit) => hit.item.id).sort()).toEqual(
      [id("blimp"), id("hangar")].sort(),
    );
    // The device takes the catalog the next time it hydrates, and indexes every row it holds again.
    value(await device.hydrate([typeId], "library"));
    expect(
      value(await device.search("blimp", { type: typeId }))
        .map((hit) => hit.item.id)
        .sort(),
    ).toEqual([id("blimp"), id("hangar")].sort());
  });
});
