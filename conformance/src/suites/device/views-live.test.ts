import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
  trackKey,
  trackView,
} from "../../utils/setup.js";
import { itemsArchive } from "../../utils/archive.js";
import { generateId } from "../../generators/items.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
const views = new Map<string, string>();
const fields = [
  "properties.probe",
  "created_at",
  "updated_at",
  "occurred_at",
] as const;
const directions = ["asc", "desc"] as const;

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

beforeAll(async () => {
  const context = await createTestContext("device", "views-sort");
  ({ client, ctx } = context);
  const values = [
    -1e30,
    -2,
    -0.125,
    false,
    0,
    true,
    1,
    1.5,
    10,
    "",
    "10",
    "2",
    "é",
    null,
    undefined,
    {},
    [],
  ];
  for (const type of ["core.note", "core.media.book"]) {
    for (const probe of values) {
      const created = await client.createItem({
        type,
        source: ctx.source,
        tags: [ctx.source],
        properties: {
          title: "Offline parity",
          body: "",
          ...(probe === undefined ? {} : { probe }),
        },
        occurred_at: "2026-03-29T01:30:00Z",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
    }
  }
  const batch = `${ctx.source}-by-source`;
  for (const [name, count] of [
    ["a", 2],
    ["b", 3],
  ] as const) {
    const key = await client.createKey({
      label: `source-${name}`,
      source: `${ctx.source}-${name}`,
      type_permissions: { "*": "write" },
    });
    expect(key.status, JSON.stringify(key.error)).toBe(201);
    trackKey(ctx, key.data.id);
    const writer = new MarfaClient({
      baseUrl: context.apiUrl,
      apiKey: key.data.key,
    });
    for (let n = 0; n < count; n += 1) {
      const created = await writer.createItem({
        type: "core.note",
        source: `${ctx.source}-${name}`,
        properties: { title: "Source parity", body: "", batch },
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
    }
  }
  // An item no source was named for is stored under "unknown"; an archive puts some back.
  const unnamed = [generateId(), generateId()];
  const restored = await getOwnerClient().restoreArchive(
    itemsArchive(
      unnamed.map((id) => ({
        id,
        type: "core.note",
        source: "unknown",
        properties: { title: "Source parity", body: "", batch },
      })),
    ),
  );
  expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
  for (const id of unnamed) trackItem(ctx, id);
  for (const direction of directions) {
    const saved = await client.createView({
      title: `Sort parity source ${direction}`,
      query: { types: ["core.note"], filter: `properties.batch eq "${batch}"` },
      sort: [{ by: "source", direction }],
    });
    expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
    views.set(`source ${direction}`, saved.data.item.id);
    trackView(ctx, saved.data.item.id);
  }
  for (const by of fields) {
    for (const direction of directions) {
      const saved = await client.createView({
        title: `Sort parity ${by} ${direction}`,
        query: {
          types: ["core.note", "core.media.book"],
          filter: `tags contains "${ctx.source}"`,
        },
        sort: [{ by, direction }],
      });
      expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
      views.set(`${by} ${direction}`, saved.data.item.id);
      trackView(ctx, saved.data.item.id);
    }
  }
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("views-parity"),
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(
    await device.hydrate(
      ["core.note", "core.media.book", "system.view"],
      "all",
    ),
  );
});

afterAll(async () => {
  if (device) rmSync(dirname(device.store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

it("returns the items of a view sorted by source in the order the server does, across its pages and both directions", async () => {
  for (const direction of directions) {
    const id = views.get(`source ${direction}`)!;
    const remote: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listViewItems(id, { limit: 2, cursor });
      expect(page.status, JSON.stringify(page.error)).toBe(200);
      remote.push(...page.data.data.map((item) => item.id));
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(remote).toHaveLength(7);
    const local: string[] = [];
    for (let offset = 0; offset < remote.length; offset += 3) {
      const page = value(
        await device.attempt([
          "items",
          "list",
          "--view",
          id,
          "--limit",
          "3",
          "--offset",
          String(offset),
        ]),
      ) as { data: Item[] };
      local.push(...page.data.map((item) => item.id));
    }
    expect(local, `source ${direction}`).toEqual(remote);
  }
});

it("returns the same items in the same order as the server for each shared sort", async () => {
  for (const sort of fields) {
    for (const direction of directions) {
      const remote: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listItems({
          filter: `tags contains "${ctx.source}"`,
          sort,
          direction,
          limit: 3,
          cursor,
        });
        expect(page.ok, JSON.stringify(page.error)).toBe(true);
        remote.push(...page.data.data.map((item) => item.id));
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(remote).toHaveLength(34);
      const local: string[] = [];
      for (let offset = 0; offset < remote.length; offset += 4) {
        const page = value(
          await device.attempt([
            "items",
            "list",
            "--view",
            views.get(`${sort} ${direction}`)!,
            "--limit",
            "4",
            "--offset",
            String(offset),
          ]),
        ) as { data: Item[] };
        local.push(...page.data.map((item) => item.id));
      }
      expect(local, `${sort} ${direction}`).toEqual(remote);
    }
  }
});
