import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { BindingDevice } from "../../device/binding-adapter.js";
import { newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackItem,
  trackKey,
  trackView,
} from "../../utils/setup.js";
import { requireModule } from "./harness.js";

interface View {
  id: string;
  version: number;
  state: string;
  settings: Record<string, unknown>;
}

const sort = [{ by: "title", direction: "asc" }];
let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let device: BindingDevice;
const devices: BindingDevice[] = [];

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

function refused<T>(
  answer: Outcome<T>,
  code: string,
  detail?: string,
  status?: number,
) {
  expect(answer.ok, JSON.stringify(answer)).toBe(false);
  if (answer.ok) throw new Error("answered");
  expect(answer.refusal.code, answer.refusal.raw).toBe(code);
  const error = JSON.parse(answer.refusal.raw) as {
    serverCode?: string;
    status?: number;
  };
  if (detail !== undefined) expect(error.serverCode).toBe(detail);
  if (status !== undefined) expect(error.status).toBe(status);
}

async function copy(name: string, url?: string, key?: string) {
  const made = await BindingDevice.start({
    module: requireModule(),
    store: newStore(`view-writes-${name}`),
    url,
    key,
  });
  devices.push(made);
  return made;
}

async function create(title: string) {
  const made = value(await device.call<View>("createView", { title, sort }));
  trackView(ctx, made.id);
  return made;
}

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "view-writes",
  ));
  device = await copy("writer", apiUrl, apiKey);
  value(await device.hydrate(["system.view", "core.note"], "all"));
});

afterAll(async () => {
  for (const made of devices) {
    await made.close();
    rmSync(dirname(made.store), { recursive: true, force: true });
  }
  if (ctx) await cleanup(ctx);
});

it("creates, changes and deletes through the view door, holding each answer and queueing nothing", async () => {
  const created = await create(`Written ${ctx.runId}`);
  expect([created.version, created.state]).toEqual([1, "active"]);
  expect(value(await device.call("view", created.id))).toEqual(created);
  const changed = value(
    await device.call<View>(
      "changeView",
      created.id,
      { title: "Renamed", query: { types: ["core.note"] } },
      created.version,
    ),
  );
  expect(changed.version).toBe(2);
  expect(changed.settings).toMatchObject({
    title: "Renamed",
    query: { types: ["core.note"] },
    sort,
  });
  expect(value(await device.call("view", created.id))).toEqual(changed);
  const served = await client.getItem(created.id);
  expect(served.ok, JSON.stringify(served.error)).toBe(true);
  expect(served.data.item.properties).toEqual(changed.settings);
  value(await device.call("deleteView", created.id));
  expect(value(await device.call("view", created.id))).toBeNull();
  expect((await client.getItem(created.id)).error?.error.code).toBe(
    "item_not_found",
  );
  expect(value(await device.queue())).toEqual([]);
});

it("clears a view's group with null, holding the ungrouped view the server holds", async () => {
  const tag = `clear-group-${ctx.runId}`;
  for (const title of ["First", "Second"]) {
    const note = await client.createItem({
      type: "core.note",
      tags: [tag],
      properties: { title, body: "" },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
  }
  value(await device.catchUp());
  const made = value(
    await device.call<View>("createView", {
      title: "Cleared group",
      query: { types: ["core.note"], filter: `tags contains "${tag}"` },
      sort,
      group: { by: "tags" },
    }),
  );
  trackView(ctx, made.id);
  // The witness: the copy reads the view grouped before the clear.
  const grouped = value(
    await device.call<{ groups: { key: unknown; count: number }[] }>(
      "viewGroups",
      made.id,
    ),
  );
  expect(grouped.groups).toEqual([{ key: tag, count: 2 }]);

  const cleared = value(
    await device.call<View>(
      "changeView",
      made.id,
      { group: null },
      made.version,
    ),
  );
  expect(cleared.version).toBe(2);
  expect(cleared.settings).toEqual({
    title: "Cleared group",
    query: { types: ["core.note"], filter: `tags contains "${tag}"` },
    sort,
  });
  expect(value(await device.call("view", made.id))).toEqual(cleared);
  const ungrouped = value(
    await device.call<{ groups: { key: unknown; count: number }[] }>(
      "viewGroups",
      made.id,
    ),
  );
  expect(ungrouped.groups).toEqual([{ key: null, count: 2 }]);
  expect((await client.getItem(made.id)).data.item.properties).toEqual(
    cleared.settings,
  );
  expect(value(await device.queue())).toEqual([]);
});

it("replays a create with the same idempotency key as one view", async () => {
  const settings = { title: `Replay ${ctx.runId}`, sort };
  const key = randomUUID();
  const first = value(await device.call<View>("createView", settings, key));
  trackView(ctx, first.id);
  const replay = value(await device.call<View>("createView", settings, key));
  expect(replay).toEqual(first);
  const listed = await client.listItems({
    type: "system.view",
    filter: `properties.title eq "${settings.title}"`,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  expect(listed.data.data.map((row) => row.id)).toEqual([first.id]);
  expect(value(await device.call("view", first.id))).toEqual(first);
  expect(value(await device.queue())).toEqual([]);
});

it("refuses a stale conflicting change without changing the copy or the server", async () => {
  const created = await create("Conflict base");
  const remote = await client.updateView(created.id, {
    title: "Server title",
    version: created.version,
  });
  expect(remote.ok, JSON.stringify(remote.error)).toBe(true);
  const before = value(await device.call("view", created.id));
  const serverBefore = (await client.getItem(created.id)).data.item;
  refused(
    await device.call("changeView", created.id, { title: "Local title" }, 1),
    "server",
    "version_conflict",
    409,
  );
  expect(value(await device.call("view", created.id))).toEqual(before);
  expect((await client.getItem(created.id)).data.item).toEqual(serverBefore);
  expect(value(await device.queue())).toEqual([]);
});

it("holds the server's merge of a stale change to a setting nobody changed", async () => {
  const created = await create("Merge base");
  const remote = await client.updateView(created.id, {
    title: "Server title",
    version: created.version,
  });
  expect(remote.ok, JSON.stringify(remote.error)).toBe(true);
  const merged = value(
    await device.call<View>(
      "changeView",
      created.id,
      { query: { types: ["core.note"] } },
      created.version,
    ),
  );
  expect(merged.version).toBe(3);
  expect(merged.settings).toMatchObject({
    title: "Server title",
    query: { types: ["core.note"] },
  });
  expect(value(await device.call("view", created.id))).toEqual(merged);
  expect((await client.getItem(created.id)).data.item.properties).toEqual(
    merged.settings,
  );
});

it("refuses a second delete as item_not_found with nothing queued", async () => {
  const created = await create("Deleted twice");
  expect(value(await device.call("view", created.id))).toEqual(created);
  const key = randomUUID();
  value(await device.call("deleteView", created.id, key));
  value(await device.call("deleteView", created.id, key));
  refused(
    await device.call("deleteView", created.id),
    "not_found",
    "item_not_found",
  );
  expect(value(await device.call("view", created.id))).toBeNull();
  expect(value(await device.queue())).toEqual([]);
});

it("preserves a revoked view when its change is refused and permits its deletion", async () => {
  const created = await create("Revoked view");
  const parent = await client.createItem({
    type: "core.note",
    properties: { title: "Parent", body: "" },
  });
  expect(parent.ok, JSON.stringify(parent.error)).toBe(true);
  trackItem(ctx, parent.data.item.id);
  const edge = await client.createEdge({
    source_id: parent.data.item.id,
    target_id: created.id,
    edge_type: "parent-of",
  });
  expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  value(await device.call("changeView", created.id, { title: "Before" }, 1));
  expect((await client.deleteItem(parent.data.item.id)).ok).toBe(true);
  value(await device.catchUp());
  const revoked = value(await device.call<View>("view", created.id));
  expect(revoked.state).toBe("revoked");
  refused(
    await device.call(
      "changeView",
      created.id,
      { title: "After" },
      revoked.version,
    ),
    "validation",
    "invalid_transition",
  );
  expect(value(await device.call("view", created.id))).toEqual(revoked);
  value(await device.call("deleteView", created.id));
  expect(value(await device.call("view", created.id))).toBeNull();
  expect(value(await device.queue())).toEqual([]);
});

it("reports a query refusal without changing a held view", async () => {
  const created = await create("Query refusal");
  const valid = { types: ["core.note"], filter: 'tags contains "reading"' };
  const changed = value(
    await device.call<View>("changeView", created.id, { query: valid }, 1),
  );
  for (const operation of [
    device.call("createView", {
      title: `Invalid query ${ctx.runId}`,
      sort,
      query: { filter: "tags eq" },
    }),
    device.call("changeView", created.id, { query: { filter: "tags eq" } }, 2),
  ]) {
    refused(await operation, "validation", "validation_error");
  }
  expect(value(await device.call("view", created.id))).toEqual(changed);
  expect((await client.getItem(created.id)).data.item.properties).toEqual(
    changed.settings,
  );
  expect(value(await device.queue())).toEqual([]);
});

it("reports missing system.view write access for every view write and preserves the copy", async () => {
  const created = await create("Permission target");
  const minted = await client.createKey({
    label: "View reader",
    source: `${ctx.source}-reader`,
    type_permissions: { "system.view": "read" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  const reader = await copy("reader", apiUrl, minted.data.key);
  value(await reader.hydrate(["system.view"], "all"));
  const before = value(await reader.call("view", created.id));
  for (const operation of [
    reader.call("createView", { title: "No access", sort }),
    reader.call("changeView", created.id, { title: "No access" }, 1),
    reader.call("deleteView", created.id),
  ]) {
    refused(await operation, "forbidden", "type_not_permitted");
  }
  expect(value(await reader.call("view", created.id))).toEqual(before);
  expect((await client.getItem(created.id)).data.item.version).toBe(1);
  expect(value(await reader.queue())).toEqual([]);
});

it("fails every write without a reachable or configured server and queues nothing", async () => {
  const created = await create("Offline witness");
  value(await device.call("changeView", created.id, { title: "Online" }, 1));
  value(await device.call("deleteView", created.id));
  const server = await ScriptedServer.start();
  const url = server.url;
  await server.stop();
  for (const [name, address, key, code] of [
    ["unreachable", url, apiKey, "network"],
    ["unconfigured", undefined, undefined, "no_server"],
  ] as const) {
    const offline = await copy(name, address, key);
    for (const operation of [
      offline.call("createView", { title: "Offline", sort }),
      offline.call("changeView", created.id, { title: "Offline" }, 1),
      offline.call("deleteView", created.id),
    ]) {
      refused(await operation, code);
    }
    expect(value(await offline.queue())).toEqual([]);
    expect(value(await offline.call("listViews"))).toMatchObject({ views: [] });
  }
});
