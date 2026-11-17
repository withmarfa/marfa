import { afterAll, beforeAll, expect, it } from "vitest";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { BindingDevice } from "../../device/binding-adapter.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackFolder,
  trackItem,
  trackKey,
  trackView,
} from "../../utils/setup.js";
import { requireBinary, requireModule } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let filteredKey: string;
let viewFilteredKey: string;
let parent: string;
let shown: string;
let hidden: string;
let view: string;
let folder: string;
let hiddenView: string;
let word: string;
const stores: string[] = [];

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "listing-unlisted-pins",
  ));
  const excluded = `${ctx.source}-excluded`;
  word = `marmalade${ctx.runId.replaceAll("-", "")}`;
  const minted = await client.createKey({
    label: `${ctx.source}-filter`,
    source: `${ctx.source}-filter`,
    type_permissions: {
      "core.note": "read",
      "system.view": "read",
      "system.folder": "read",
    },
    edge_permissions: { "*": "read" },
    enforcement_override: {
      source_filter: { types: ["core.note"], sources: [ctx.source] },
    },
    default_tier: "library",
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  filteredKey = minted.data.key;
  const viewMinted = await client.createKey({
    label: `${ctx.source}-view-filter`,
    source: `${ctx.source}-view-filter`,
    type_permissions: { "system.view": "read" },
    enforcement_override: {
      source_filter: { types: ["system.view"], sources: [ctx.source] },
    },
    default_tier: "library",
  });
  expect(viewMinted.ok, JSON.stringify(viewMinted.error)).toBe(true);
  trackKey(ctx, viewMinted.data.id);
  viewFilteredKey = viewMinted.data.key;
  const writer = await client.createKey({ label: excluded, source: excluded });
  expect(writer.ok, JSON.stringify(writer.error)).toBe(true);
  trackKey(ctx, writer.data.id);
  const excludedClient = new MarfaClient({
    baseUrl: apiUrl,
    apiKey: writer.data.key,
  });
  const note = async (as: MarfaClient, source: string, title: string) => {
    const made = await as.createItem({
      type: "core.note",
      source,
      tier: "library",
      properties: { title, body: word },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    return made.data.item.id;
  };
  parent = await note(client, ctx.source, "parent");
  shown = await note(client, ctx.source, "shown child");
  hidden = await note(excludedClient, excluded, "hidden child");
  for (const child of [shown, hidden]) {
    const edge = await client.createEdge({
      from_id: parent,
      to_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
  }
  const saved = await client.createView({
    title: "Marmalade",
    query: { types: ["core.note"], beneath: parent },
  });
  expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
  view = saved.data.item.id;
  trackView(ctx, view);
  const folded = await client.createFolder({
    title: "Marmalade folder",
    query: { types: ["core.note"], beneath: parent },
  });
  expect(folded.ok, JSON.stringify(folded.error)).toBe(true);
  folder = folded.data.item.id;
  trackFolder(ctx, folder);
  const unlistedView = await excludedClient.createView({
    title: "Hidden marmalade",
    query: { types: ["core.note"] },
  });
  expect(unlistedView.ok, JSON.stringify(unlistedView.error)).toBe(true);
  hiddenView = unlistedView.data.item.id;
  trackView(ctx, hiddenView);
});

afterAll(async () => {
  for (const store of stores)
    rmSync(dirname(store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

function copy(key: string): CliDevice {
  const store = newStore("listing-unlisted-pins");
  stores.push(store);
  return new CliDevice({ binary: requireBinary(), store, url: apiUrl, key });
}

async function inFolder(device: CliDevice, read: string, ...args: unknown[]) {
  const binding = await BindingDevice.start({
    module: requireModule(),
    store: device.store,
    reader: true,
  });
  try {
    return await binding.call<Record<string, never>>(read, ...args);
  } finally {
    await binding.close();
  }
}

const ids = (items: Item[]) => items.map((item) => item.id).sort();

it("leaves a pinned item the server did not list out of a local list and search, and still reads it by id", async () => {
  const under = `backref[parent-of] eq "${parent}"`;
  const server = await client.listItems({
    type: "core.note",
    state: "any",
    filter: under,
  });
  expect(server.ok, JSON.stringify(server.error)).toBe(true);
  expect(server.data.data.map((item) => item.id)).toEqual(
    expect.arrayContaining([shown, hidden]),
  );
  const whole = copy(apiKey);
  value(
    await whole.hydrate(["core.note"], "library", { edgeTypes: ["parent-of"] }),
  );
  value(await whole.pin(hidden));
  expect(ids(value(await whole.list({ filter: under })))).toEqual(
    [shown, hidden].sort(),
  );
  expect(ids(value(await whole.list({ beneath: parent })))).toContain(hidden);
  expect(ids(value(await whole.list({ type: "core.note" })))).toContain(hidden);
  expect(value(await whole.search(word)).map((hit) => hit.item.id)).toContain(
    hidden,
  );

  const device = copy(filteredKey);
  value(
    await device.hydrate(["core.note"], "library", {
      edgeTypes: ["parent-of"],
    }),
  );
  expect(ids(value(await device.list({ filter: under })))).toEqual([shown]);
  value(await device.pin(hidden));
  expect(value(await device.get(hidden)).id).toBe(hidden);
  expect(ids(value(await device.list({ filter: under })))).toEqual([shown]);
  expect(ids(value(await device.list({ beneath: parent })))).toEqual(
    [shown, parent].sort(),
  );
  expect(ids(value(await device.list({ type: "core.note" })))).not.toContain(
    hidden,
  );
  const hits = value(await device.search(word));
  expect(hits.map((hit) => hit.item.id)).not.toContain(hidden);
  expect(hits.map((hit) => hit.item.id)).toContain(shown);
});

it("leaves a pinned item the server did not list out of a local view's and a local folder's listing", async () => {
  const served = await client.listViewItems(view);
  expect(served.ok, JSON.stringify(served.error)).toBe(true);
  expect(served.data.data.map((item) => item.id)).toContain(hidden);

  for (const key of [apiKey, filteredKey]) {
    const device = copy(key);
    value(
      await device.hydrate(
        ["core.note", "system.view", "system.folder"],
        "all",
        {
          edgeTypes: ["parent-of"],
        },
      ),
    );
    value(await device.pin(hidden));
    expect(value(await device.get(hidden)).id).toBe(hidden);
    const expected = (
      key === apiKey ? [shown, parent, hidden] : [shown, parent]
    ).sort();
    const viewed = value(
      await device.attempt(["items", "list", "--view", view]),
    ) as { data: Item[] };
    expect(ids(viewed.data)).toEqual(expected);

    const listed = value(
      await inFolder(device, "listInFolder", folder, null, null, null),
    ) as unknown as { items: Item[] };
    expect(ids(listed.items)).toEqual(expected);
    const found = value(
      await inFolder(device, "searchInFolder", word, folder, 20),
    ) as unknown as { hits: Array<{ item: Item }> };
    expect(ids(found.hits.map((hit) => hit.item))).toEqual(expected);
  }
});

it("leaves a pinned view the server did not list out of the views list, and still reads it by id", async () => {
  const device = copy(viewFilteredKey);
  value(await device.hydrate(["system.view"], "all", {}));
  value(await device.pin(hiddenView));
  const listed = value(await device.attempt(["views", "list"])) as {
    data: Array<{ id: string }>;
  };
  expect(listed.data.map((row) => row.id)).not.toContain(hiddenView);
  const read = value(await device.attempt(["views", "get", hiddenView])) as {
    id: string;
  };
  expect(read.id).toBe(hiddenView);

  const whole = copy(apiKey);
  value(await whole.hydrate(["system.view"], "all", {}));
  const all = value(await whole.attempt(["views", "list"])) as {
    data: Array<{ id: string }>;
  };
  expect(all.data.map((row) => row.id)).toContain(hiddenView);
});
