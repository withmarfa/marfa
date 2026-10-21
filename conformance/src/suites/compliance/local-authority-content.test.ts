import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";

let server: FreshServer;
let kept: string;
let other: string;

beforeAll(async () => {
  server = await bootFreshServer("local-authority-content");
  kept = await create("kept");
  other = await create("other");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Door {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function keyed(door: Door): Promise<Response> {
  return fetch(`${server.apiUrl}${door.path}`, {
    method: door.method,
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      ...(door.body && { "content-type": "application/json" }),
    },
    ...(door.body && { body: JSON.stringify(door.body) }),
  });
}

function keyless(door: Door): Promise<Response> {
  return fetch(`${server.apiUrl}${door.path}`, {
    method: door.method,
    headers: door.body ? { "content-type": "application/json" } : {},
    ...(door.body && { body: JSON.stringify(door.body) }),
  });
}

async function create(body: string): Promise<string> {
  const created = await keyed({
    method: "POST",
    path: "/items",
    body: { type: "core.note", properties: { body } },
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { item: { id: string } }).item.id;
}

async function read(id: string): Promise<{
  version: number;
  state: string;
  tier: string;
  properties: Record<string, unknown>;
  tags: string[];
}> {
  const answer = await keyed({ method: "GET", path: `/items/${id}` });
  expect(answer.status).toBe(200);
  const { item, metadata } = (await answer.json()) as {
    item: never;
    metadata: { tags: string[] };
  };
  return { ...(item as object), tags: metadata.tags } as never;
}

/** Refused through the private socket and over HTTP with no credential. */
async function expectRefusedWithoutKey(door: Door): Promise<void> {
  const label = `${door.method} ${door.path}`;
  const local = await controlRequest(server.controlSocket, door.path, door);
  expect(local.status, `${label} through the socket`).toBe(401);
  expect(local.body, label).toMatchObject({
    error: { code: "unauthorized" },
  });
  const http = await keyless(door);
  expect(http.status, `${label} over HTTP with no key`).toBe(401);
  await http.arrayBuffer();
}

const BULK_ACTIONS: Record<string, unknown>[] = [
  { action: "transition", state: "archived" },
  { action: "update_tags", add: ["socket"] },
  { action: "update_tier", tier: "feed" },
  { action: "update_properties", patch: { body: "socket" } },
  { action: "update_occurred_at", occurred_at: "2026-01-02T03:04:05Z" },
  { action: "purge", confirm: "PURGE" },
];

it("refuses every item, edge, tag, search and occurrence door through the private socket with 401, where the working key is admitted", async () => {
  const doors: Door[] = [
    { method: "GET", path: "/items" },
    { method: "GET", path: `/items/${kept}` },
    { method: "GET", path: `/items/${kept}/versions` },
    { method: "GET", path: `/items/${kept}/metadata` },
    { method: "GET", path: `/items/${kept}/extensions` },
    { method: "GET", path: `/items/${kept}/edges` },
    { method: "GET", path: `/items/${kept}/backrefs` },
    { method: "POST", path: "/items/bulk-get", body: { ids: [kept] } },
    {
      method: "POST",
      path: "/items/lookup",
      body: { type: "core.note", ids: [kept] },
    },
    { method: "GET", path: "/edges" },
    { method: "GET", path: "/search?q=kept" },
    {
      method: "GET",
      path: "/occurrences?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
    },
  ];
  for (const door of doors) {
    await expectRefusedWithoutKey(door);
    const witness = await keyed(door);
    expect(witness.status, `${door.method} ${door.path} with the key`).toBe(
      200,
    );
    await witness.arrayBuffer();
  }
});

it("refuses item and edge writes through the private socket with 401 and changes nothing, where the working key writes", async () => {
  const before = await read(kept);
  const writes: { door: Door; status: number }[] = [
    {
      door: {
        method: "POST",
        path: "/items",
        body: { type: "core.note", properties: { body: "socket" } },
      },
      status: 201,
    },
    {
      door: {
        method: "POST",
        path: "/items/bulk",
        body: { items: [{ type: "core.note", properties: { body: "bulk" } }] },
      },
      status: 200,
    },
    {
      door: {
        method: "POST",
        path: "/edges",
        body: { source_id: kept, target_id: other, edge_type: "references" },
      },
      status: 201,
    },
  ];
  for (const { door } of writes) await expectRefusedWithoutKey(door);
  const after = await read(kept);
  expect(after).toEqual(before);
  const edges = await keyed({ method: "GET", path: `/items/${kept}/edges` });
  expect(((await edges.json()) as { data: unknown[] }).data).toEqual([]);

  // Each change through the socket left the item as it was, so the same
  // change under the key is what makes it.
  const changes: Door[] = [
    {
      method: "PATCH",
      path: `/items/${kept}`,
      body: { version: before.version, properties: { body: "changed" } },
    },
    { method: "POST", path: `/items/${kept}/tags`, body: { tags: ["socket"] } },
    { method: "DELETE", path: `/items/${kept}/tags/kept-tag` },
    { method: "PATCH", path: `/items/${kept}/metadata`, body: { tags: [] } },
    {
      method: "POST",
      path: `/items/${kept}/transition`,
      body: { state: "archived" },
    },
    { method: "DELETE", path: `/items/${kept}` },
  ];
  for (const door of changes) await expectRefusedWithoutKey(door);
  expect(await read(kept)).toEqual(before);

  const tagged = await keyed(changes[1]!);
  expect(tagged.status).toBe(200);
  expect((await read(kept)).tags).toEqual(["socket"]);
  for (const { door, status } of writes) {
    const witness = await keyed(door);
    expect(witness.status, `${door.method} ${door.path} with the key`).toBe(
      status,
    );
    await witness.arrayBuffer();
  }
});

it("refuses restore and purge of a binned item through the private socket with 401 on the item doors, where the working key restores", async () => {
  const binned = await create("binned");
  const trashed = await keyed({ method: "DELETE", path: `/items/${binned}` });
  expect(trashed.status).toBe(200);
  for (const door of [
    { method: "POST", path: `/items/${binned}/restore` },
    { method: "POST", path: `/items/${binned}/purge` },
  ])
    await expectRefusedWithoutKey(door);
  const restored = await keyed({
    method: "POST",
    path: `/items/${binned}/restore`,
  });
  expect(restored.status).toBe(200);
  expect((await read(binned)).state).toBe("active");
});

it("refuses every bulk action through the private socket with 401, purge included, where the working key is admitted", async () => {
  for (const action of BULK_ACTIONS) {
    const door: Door = {
      method: "POST",
      path: "/items/bulk-actions",
      body: { ...action, filter: { type: "core.note" }, dry_run: true },
    };
    await expectRefusedWithoutKey(door);
    const witness = await keyed(door);
    expect(witness.status, `${String(action.action)} with the key`).toBe(200);
    await witness.arrayBuffer();
  }
});

it("queues no bulk action through the private socket, where the working key's job tags the item", async () => {
  const target = await create("bulk-target");
  const door: Door = {
    method: "POST",
    path: "/items/bulk-actions",
    body: {
      action: "update_tags",
      add: ["bulk-socket"],
      filter: { type: "core.note" },
    },
  };
  await expectRefusedWithoutKey(door);
  expect((await read(target)).tags).toEqual([]);

  const queued = await keyed(door);
  expect(queued.status).toBe(202);
  const job = ((await queued.json()) as { id: string }).id;
  let status = "queued";
  for (
    let tries = 0;
    tries < 100 && !["completed", "failed"].includes(status);
    tries++
  ) {
    const polled = await keyed({
      method: "GET",
      path: `/items/bulk-actions/jobs/${job}`,
    });
    status = ((await polled.json()) as { status: string }).status;
    if (!["completed", "failed"].includes(status))
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(status).toBe("completed");
  expect((await read(target)).tags).toEqual(["bulk-socket"]);
});
