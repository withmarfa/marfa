import { afterAll, beforeAll, expect, it } from "vitest";
import type { Item } from "@withmarfa/shared";
import { IDEMPOTENT_WRITE_DOORS } from "../middleware/idempotency.js";
import {
  createTestContext,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { writeItem } from "../storage/item-write.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

let ctx: TestContext;
let sequence = 0;
beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function actor() {
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: `replay-${String(sequence++)}`,
      source: `replay-tests-${String(sequence)}`,
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      permissions: ["items.purge"],
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; key: string };
}
async function narrow(id: string, type_permissions: Record<string, string>) {
  const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
    key: ctx.workingKey,
    body: { type_permissions },
  });
  expect(res.status).toBe(200);
}
async function note(): Promise<Item> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { title: "Original", body: "Retained body" },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Item }).item;
}
async function receipt(credential: string, idempotency_key: string) {
  const held = await ctx.storage.idempotency.claim({
    id: "unused",
    credential,
    idempotency_key,
    fingerprint: "unused",
    created_at: new Date().toISOString(),
  });
  expect(held.claimed).toBe(false);
  if (held.claimed || !held.held) throw new Error("Missing receipt");
  return held.held;
}

it("a replay obeys current read and write grants while keeping the original receipt", async () => {
  const key = await actor();
  const item = await note();
  const body = { version: item.version, properties: { title: "Changed" } };
  const headers = { "Idempotency-Key": `replay-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: key.key,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(200);
  const original = await first.text();
  expect(JSON.parse(original).item.properties.body).toBe("Retained body");
  expect((await ask()).headers.get("Idempotency-Replayed")).toBe("true");
  const stored = await receipt(key.id, headers["Idempotency-Key"]);
  const mark = await ctx.storage.eventLog.getMaxId();
  await narrow(key.id, { "*": "read" });
  expect((await ask()).status).toBe(403);
  await narrow(key.id, { "*": "write" });
  await narrow(key.id, { "core.task": "read" });
  expect(
    (await request(ctx.app, "GET", `/items/${item.id}`, { key: key.key }))
      .status,
  ).toBe(404);
  expect(
    (
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: key.key,
        body,
      })
    ).status,
  ).toBe(404);
  const denied = await ask();
  expect(denied.status).toBe(404);
  expect(denied.headers.get("Idempotency-Replayed")).toBeNull();
  expect(await denied.text()).not.toContain("Retained body");
  expect(await receipt(key.id, headers["Idempotency-Key"])).toEqual(stored);
  expect(await ctx.storage.eventLog.getMaxId()).toBe(mark);
  await narrow(key.id, { "core.note": "read" });
  expect((await ask()).status).toBe(403);
  await narrow(key.id, { "core.note": "write" });
  const restored = await ask();
  expect(restored.status).toBe(200);
  expect(await restored.text()).toBe(original);
  expect((await ctx.storage.items.get(item.id))?.version).toBe(
    item.version + 1,
  );
});

it.each(IDEMPOTENT_WRITE_DOORS)(
  "executes the replay guard on %s",
  async (door) => {
    const key = await actor();
    const item = await note();
    const [method, template] = door.split(" ") as [string, string];
    let path = template;
    let body: unknown;
    if (door === "POST /items")
      body = { type: "core.note", properties: { body: "Created" } };
    else if (door.includes("folders")) {
      if (method === "POST" && path === "/folders") body = { title: "Folder" };
      else {
        const created = await request(ctx.app, "POST", "/folders", {
          key: ctx.workingKey,
          body: { title: "Folder" },
        });
        const folder = ((await created.json()) as { item: Item }).item;
        path = path.replace(":id", folder.id);
        if (method === "PATCH")
          body = { version: folder.version, title: "Changed folder" };
      }
    } else if (door.includes("edges")) {
      const target = await note();
      const edgeBody = {
        source_id: item.id,
        target_id: target.id,
        edge_type: "about",
      };
      if (method === "POST") body = edgeBody;
      else {
        const created = await request(ctx.app, "POST", "/edges", {
          key: ctx.workingKey,
          body: edgeBody,
        });
        const edge = (
          (await created.json()) as { edge: { id: string; version: number } }
        ).edge;
        path = path.replace(":id", edge.id);
        if (method === "PATCH")
          body = { version: edge.version, properties: { label: "Changed" } };
      }
    } else if (door.endsWith("bulk-actions"))
      body = {
        action: "update_tags",
        add: ["replay"],
        filter: { filter: `id eq "${item.id}"` },
        dry_run: true,
      };
    else {
      path = path.replace(":id", item.id);
      if (method === "PATCH")
        body = { version: item.version, properties: { title: "Changed" } };
      if (path.endsWith("transition")) body = { state: "trashed" };
      if (path.endsWith("purge"))
        expect(
          (
            await request(ctx.app, "DELETE", `/items/${item.id}`, {
              key: ctx.workingKey,
            })
          ).status,
        ).toBe(200);
      if (path.endsWith("restore"))
        expect(
          (
            await request(ctx.app, "DELETE", `/items/${item.id}`, {
              key: ctx.workingKey,
            })
          ).status,
        ).toBe(200);
    }
    const headers = { "Idempotency-Key": `census-${String(sequence++)}` };
    const ask = () =>
      request(ctx.app, method, path, {
        key: key.key,
        ...(body === undefined ? {} : { body }),
        headers,
      });
    const first = await ask();
    expect(first.status, await first.clone().text()).toBeLessThan(300);
    const original = await first.text();
    const replay = await ask();
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.text()).toBe(original);
    const stored = await receipt(key.id, headers["Idempotency-Key"]);
    const mark = await ctx.storage.eventLog.getMaxId();
    await narrow(key.id, { "*": "read" });
    expect((await ask()).status).toBe(403);
    await narrow(key.id, { "*": "write" });
    await narrow(key.id, { "core.task": "read" });
    const denied = await ask();
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await receipt(key.id, headers["Idempotency-Key"])).toEqual(stored);
    expect(await ctx.storage.eventLog.getMaxId()).toBe(mark);
    await narrow(key.id, { "*": "write" });
    const restored = await ask();
    expect(restored.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await restored.text()).toBe(original);
  },
);

async function changeGrants(
  id: string,
  body: Record<string, unknown>,
  credential = ctx.workingKey,
): Promise<void> {
  const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
    key: credential,
    body,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

it.each(["extensions", "edges"])(
  "refuses retained %s while the item remains readable",
  async (kind) => {
    const key = await actor();
    const item = await note();
    if (kind === "extensions") {
      await ctx.storage.metadata.setExtension(item.id, "example.private", {
        secret: "Extension marker",
      });
    } else {
      const target = await note();
      expect(
        (
          await request(ctx.app, "POST", "/edges", {
            key: ctx.workingKey,
            body: {
              source_id: item.id,
              target_id: target.id,
              edge_type: "about",
              properties: { secret: "Edge marker" },
            },
          })
        ).status,
      ).toBe(201);
    }
    const body = { version: item.version, properties: { title: "Changed" } };
    const headers = { "Idempotency-Key": `related-${String(sequence++)}` };
    const ask = () =>
      request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: key.key,
        body,
        headers,
      });
    const first = await ask();
    expect(first.status).toBe(200);
    const original = await first.text();
    expect(original).toContain(
      kind === "extensions" ? "Extension marker" : "Edge marker",
    );
    const stored = await receipt(key.id, headers["Idempotency-Key"]);
    await changeGrants(key.id, {
      [kind === "extensions" ? "extension_permissions" : "edge_permissions"]:
        {},
    });
    const readable = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: key.key,
    });
    expect(readable.status).toBe(200);
    expect(await readable.text()).not.toContain(
      kind === "extensions" ? "Extension marker" : "Edge marker",
    );
    const mark = await ctx.storage.eventLog.getMaxId();
    const denied = await ask();
    expect(denied.status).toBe(kind === "extensions" ? 403 : 404);
    expect(await denied.text()).not.toContain("marker");
    expect(await receipt(key.id, headers["Idempotency-Key"])).toEqual(stored);
    expect(await ctx.storage.eventLog.getMaxId()).toBe(mark);
    await changeGrants(key.id, {
      [kind === "extensions" ? "extension_permissions" : "edge_permissions"]: {
        "*": "write",
      },
    });
    expect(await (await ask()).text()).toBe(original);
  },
);

it("authorizes both retained snapshot types and the surviving row after a retype", async () => {
  const key = await actor();
  const item = await note();
  const body = { version: item.version, properties: { title: "Changed" } };
  const headers = { "Idempotency-Key": `retype-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: key.key,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(200);
  const original = await first.text();
  const retyped = await request(ctx.app, "PATCH", `/items/${item.id}`, {
    key: ctx.workingKey,
    body: { version: item.version + 1, retype: true, type: "core.task" },
  });
  expect(retyped.status, await retyped.clone().text()).toBe(200);
  await narrow(key.id, { "core.note": "write" });
  expect((await ask()).status).toBe(404);
  await narrow(key.id, { "core.task": "write" });
  expect(
    (await request(ctx.app, "GET", `/items/${item.id}`, { key: key.key }))
      .status,
  ).toBe(200);
  expect((await ask()).status).toBe(404);
  await narrow(key.id, { "core.note": "write", "core.task": "read" });
  expect((await ask()).status).toBe(403);
  await narrow(key.id, { "core.note": "write", "core.task": "write" });
  expect(await (await ask()).text()).toBe(original);
});

it("retains a conflict's current and ancestor without handing either to a narrowed reader", async () => {
  const key = await actor();
  const item = await note();
  expect(
    (
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.workingKey,
        body: { version: item.version, properties: { title: "Winner" } },
      })
    ).status,
  ).toBe(200);
  const body = { version: item.version, properties: { title: "Loser" } };
  const headers = { "Idempotency-Key": `conflict-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "PATCH", `/items/${item.id}?conflict=manual`, {
      key: key.key,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(409);
  const original = await first.text();
  expect(JSON.parse(original)).toMatchObject({
    current: { properties: { title: "Winner" } },
    ancestor: { properties: { title: "Original" } },
  });
  const stored = await receipt(key.id, headers["Idempotency-Key"]);
  await narrow(key.id, { "core.task": "read" });
  const mark = await ctx.storage.eventLog.getMaxId();
  const denied = await ask();
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("Winner");
  expect(await receipt(key.id, headers["Idempotency-Key"])).toEqual(stored);
  expect(await ctx.storage.eventLog.getMaxId()).toBe(mark);
  await narrow(key.id, { "core.note": "write" });
  const restored = await ask();
  expect(restored.status).toBe(409);
  expect(await restored.text()).toBe(original);
});

it("applies a narrower OAuth grant to the same durable receipt identity", async () => {
  const oauth = await seedOauthBearer(ctx.storage, ["core.note:write"]);
  const item = await note();
  const body = {
    version: item.version,
    properties: { title: "OAuth changed" },
  };
  const headers = { "Idempotency-Key": `oauth-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: oauth.token,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(200);
  const original = await first.text();
  expect((await ask()).headers.get("Idempotency-Replayed")).toBe("true");
  const grant = (await ctx.storage.items.get(oauth.grantId))!;
  const narrowGrant = await writeItem(
    ctx.storage,
    { kind: "platform" },
    {
      op: "update",
      id: grant.id,
      version: grant.version,
      properties: { scopes: ["core.task:read"] },
    },
  );
  expect(narrowGrant.outcome).toBe("updated");
  await (
    ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(
    "UPDATE auth_oauth_access_token SET scopes = ? WHERE token = ?",
    [
      JSON.stringify(["core.task:read"]),
      hashApiKey(oauth.token.slice("marfa_at_".length), TEST_API_KEY_SALT),
    ],
  );
  expect(
    (await request(ctx.app, "GET", `/items/${item.id}`, { key: oauth.token }))
      .status,
  ).toBe(404);
  expect((await ask()).status).toBe(404);
  const narrowed = (await ctx.storage.items.get(grant.id))!;
  await writeItem(
    ctx.storage,
    { kind: "platform" },
    {
      op: "update",
      id: grant.id,
      version: narrowed.version,
      properties: { scopes: ["core.note:write"] },
    },
  );
  await (
    ctx.storage as unknown as {
      __sqliteRun(sql: string, params: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(
    "UPDATE auth_oauth_access_token SET scopes = ? WHERE token = ?",
    [
      JSON.stringify(["core.note:write"]),
      hashApiKey(oauth.token.slice("marfa_at_".length), TEST_API_KEY_SALT),
    ],
  );
  expect(await (await ask()).text()).toBe(original);
});

it("refuses a purge receipt when its operation permission is withdrawn after the row is gone", async () => {
  const key = await actor();
  const item = await note();
  expect(
    (await request(ctx.app, "DELETE", `/items/${item.id}`, { key: key.key }))
      .status,
  ).toBe(200);
  const headers = { "Idempotency-Key": `purge-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: key.key,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(200);
  const original = await first.text();
  expect(await ctx.storage.items.getIncludingTrashed(item.id)).toBeNull();
  const stored = await receipt(key.id, headers["Idempotency-Key"]);
  await changeGrants(key.id, { permissions: [] });
  expect((await ask()).status).toBe(403);
  expect(await receipt(key.id, headers["Idempotency-Key"])).toEqual(stored);
  await changeGrants(key.id, { permissions: ["items.purge"] });
  expect(await (await ask()).text()).toBe(original);
});

it("a queued job receipt cannot replay a formerly writable match set", async () => {
  const key = await actor();
  const item = await note();
  const body = {
    action: "update_tags",
    add: ["job"],
    filter: { filter: `id eq "${item.id}"` },
  };
  const headers = { "Idempotency-Key": `job-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "POST", "/items/bulk-actions", {
      key: key.key,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(202);
  const original = await first.text();
  expect(JSON.parse(original).matched).toBe(1);
  await narrow(key.id, { "core.note": "read" });
  expect((await ask()).status).toBe(403);
  await narrow(key.id, { "core.note": "write" });
  expect(await (await ask()).text()).toBe(original);
});

it("checks the current source after a surviving edge moves", async () => {
  const key = await actor();
  const source = await note();
  const target = await note();
  const created = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: {
      source_id: source.id,
      target_id: target.id,
      edge_type: "parent-of",
    },
  });
  expect(created.status).toBe(201);
  const edge = (
    (await created.json()) as { edge: { id: string; version: number } }
  ).edge;
  const body = { version: edge.version, properties: {} };
  const headers = { "Idempotency-Key": `source-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: key.key,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(200);
  const original = await first.text();
  const currentEdge = JSON.parse(original).edge as { version: number };
  const task = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.task", properties: { title: "New source" } },
  });
  expect(task.status).toBe(201);
  const taskId = ((await task.json()) as { item: Item }).item.id;
  expect(
    (
      await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
        key: ctx.workingKey,
        body: { version: currentEdge.version, source_id: taskId },
      })
    ).status,
  ).toBe(200);
  await narrow(key.id, { "core.note": "write" });
  expect(
    (await request(ctx.app, "GET", `/edges/${edge.id}`, { key: key.key }))
      .status,
  ).toBe(404);
  expect((await ask()).status).toBe(404);
  await narrow(key.id, { "core.note": "write", "core.task": "read" });
  expect((await ask()).status).toBe(403);
  await narrow(key.id, { "core.note": "write", "core.task": "write" });
  expect(await (await ask()).text()).toBe(original);
});

it("checks a retained ancestor's old type when the current type remains writable", async () => {
  const key = await actor();
  const item = await note();
  const moved = await request(ctx.app, "PATCH", `/items/${item.id}`, {
    key: ctx.workingKey,
    body: {
      version: item.version,
      type: "core.task",
      retype: true,
      properties: { title: "Winner" },
    },
  });
  expect(moved.status).toBe(200);
  const body = { version: item.version, properties: { title: "Loser" } };
  const headers = { "Idempotency-Key": `ancestor-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "PATCH", `/items/${item.id}?conflict=manual`, {
      key: key.key,
      body,
      headers,
    });
  const first = await ask();
  expect(first.status).toBe(409);
  const original = await first.text();
  expect(JSON.parse(original)).toMatchObject({
    current: { type: "core.task" },
    ancestor: { type: "core.note" },
  });
  await narrow(key.id, { "core.task": "write" });
  expect(
    (await request(ctx.app, "GET", `/items/${item.id}`, { key: key.key }))
      .status,
  ).toBe(200);
  const denied = await ask();
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("Original");
  await narrow(key.id, { "core.note": "read", "core.task": "write" });
  expect(await (await ask()).text()).toBe(original);
});

it.each(["item", "edge"])(
  "replays a removed %s subject after its remaining rows are purged",
  async (kind) => {
    const key = await actor();
    const item = await note();
    let path = `/items/${item.id}`;
    if (kind === "edge") {
      const target = await note();
      const created = await request(ctx.app, "POST", "/edges", {
        key: key.key,
        body: { source_id: item.id, target_id: target.id, edge_type: "about" },
      });
      expect(created.status).toBe(201);
      path = `/edges/${((await created.json()) as { edge: { id: string } }).edge.id}`;
    }
    const headers = { "Idempotency-Key": `removed-${String(sequence++)}` };
    const ask = () =>
      request(ctx.app, "DELETE", path, { key: key.key, headers });
    const first = await ask();
    expect(first.status).toBe(200);
    const original = await first.text();
    if (kind === "edge")
      expect(
        (
          await request(ctx.app, "DELETE", `/items/${item.id}`, {
            key: ctx.workingKey,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);
    expect(await ctx.storage.items.getIncludingTrashed(item.id)).toBeNull();
    expect(await (await ask()).text()).toBe(original);
    const stored = await receipt(key.id, headers["Idempotency-Key"]);
    const mark = await ctx.storage.eventLog.getMaxId();
    await narrow(key.id, { "core.note": "read" });
    expect((await ask()).status).toBe(403);
    expect(await receipt(key.id, headers["Idempotency-Key"])).toEqual(stored);
    await narrow(key.id, { "core.note": "write" });
    expect(await (await ask()).text()).toBe(original);
    expect(await ctx.storage.eventLog.getMaxId()).toBe(mark);
  },
);

it("captures concurrent credentials independently", async () => {
  const noteKey = await actor();
  const taskKey = await actor();
  await narrow(noteKey.id, { "core.note": "write" });
  await narrow(taskKey.id, { "core.task": "write" });
  const cases = [
    { key: noteKey, type: "core.note", properties: { body: "Note" } },
    { key: taskKey, type: "core.task", properties: { title: "Task" } },
  ];
  const completed = await Promise.all(
    cases.map(async ({ key, type, properties }) => {
      const headers = { "Idempotency-Key": `parallel-${String(sequence++)}` };
      const body = { type, properties };
      const first = await request(ctx.app, "POST", "/items", {
        key: key.key,
        headers,
        body,
      });
      expect(first.status).toBe(201);
      return { key, headers, body, original: await first.text() };
    }),
  );
  for (const { key, headers, body, original } of completed) {
    const replay = await request(ctx.app, "POST", "/items", {
      key: key.key,
      headers,
      body,
    });
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(original);
  }
});

it("reauthorizes a named source claim independently of readable item data", async () => {
  const key = await actor();
  const source = `claimed-${String(sequence++)}`;
  await changeGrants(key.id, { sources: [source] }, ctx.operatorKey);
  const body = {
    type: "core.note",
    source,
    properties: { body: "Claimed source" },
  };
  const headers = { "Idempotency-Key": `claimed-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "POST", "/items", { key: key.key, headers, body });
  const first = await ask();
  expect(first.status).toBe(201);
  const original = await first.text();
  await changeGrants(key.id, { sources: [] }, ctx.operatorKey);
  expect((await ask()).status).toBe(403);
  await changeGrants(key.id, { sources: [source] }, ctx.operatorKey);
  expect(await (await ask()).text()).toBe(original);
});

it("reauthorizes a retained cascade mark after the named root was purged", async () => {
  const key = await actor();
  const child = await note();
  const parent = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.task", properties: { title: "Cascade root" } },
  });
  expect(parent.status).toBe(201);
  const parentId = ((await parent.json()) as { item: Item }).item.id;
  expect(
    (
      await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: parentId,
          target_id: child.id,
          edge_type: "parent-of",
        },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await request(ctx.app, "DELETE", `/items/${parentId}`, {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(ctx.app, "DELETE", `/items/${parentId}/purge`, {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(200);
  const body = {
    id: child.id,
    type: "core.note",
    properties: child.properties,
  };
  const headers = { "Idempotency-Key": `cascade-${String(sequence++)}` };
  const ask = () =>
    request(ctx.app, "POST", "/items", { key: key.key, headers, body });
  const first = await ask();
  expect(first.status).toBe(200);
  const original = await first.text();
  expect(JSON.parse(original).item.trashed_with).toBe(parentId);
  expect(await (await ask()).text()).toBe(original);
  await narrow(key.id, { "core.note": "write" });
  expect((await ask()).status).toBe(404);
  await narrow(key.id, { "core.note": "write", "core.task": "read" });
  expect(await (await ask()).text()).toBe(original);
});
