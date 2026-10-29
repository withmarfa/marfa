import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { activeFaults, clearFaults, setFault } from "../control/faults.js";
import { itemWrites } from "../storage/item-writes.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;
let reader: string;
beforeAll(async () => {
  ctx = await createTestContext();
  reader = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "read" },
  });
  const registered = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id: "fixture.private", version: 1, fields: {} },
  });
  expect(registered.status).toBe(201);
});
afterEach(() => {
  clearFaults();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});

const reads = [
  { name: "single item", path: (id: string) => `/items/${id}`, method: "GET" },
  {
    name: "metadata",
    path: (id: string) => `/items/${id}/metadata`,
    method: "GET",
  },
  {
    name: "item list",
    path: () => "/items?include=metadata,edges,extensions",
    method: "GET",
  },
  {
    name: "feed list",
    path: () => "/items?tier=feed&include=metadata",
    method: "GET",
    tier: "feed",
  },
  { name: "bulk get", path: () => "/items/bulk-get", method: "POST" },
];
it.each(["commit", "rollback"])(
  "reads committed items while an awaited writer will %s",
  async (outcome) => {
    const original = await itemWrites(ctx.storage).create({
      writer: null,
      type: "core.note",
      properties: { body: "committed" },
    });
    // A cold key first writes last_used_at, outside the read snapshot.
    expect(
      (await request(ctx.app, "GET", `/items/${original.id}`, { key: reader }))
        .status,
    ).toBe(200);
    let enter!: (id: string) => void;
    const entered = new Promise<string>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rollback = new Error("rollback witness");
    const writing = ctx.storage.runInTransaction(async () => {
      await itemWrites(ctx.storage).update(original.id, {
        writer: null,
        type: "fixture.private",
        properties: { body: "uncommitted" },
      });
      const added = await itemWrites(ctx.storage).create({
        writer: null,
        type: "core.note",
        properties: { body: "new row" },
      });
      enter(added.id);
      await released;
      if (outcome === "rollback") throw rollback;
    });
    const settled = writing.catch((error: unknown) => error);
    const addedId = await entered;
    try {
      const old = await request(ctx.app, "GET", `/items/${original.id}`, {
        key: reader,
      });
      expect(old.status).toBe(200);
      expect(await old.json()).toMatchObject({
        item: { type: "core.note", properties: { body: "committed" } },
      });
      expect(
        (await request(ctx.app, "GET", `/items/${addedId}`, { key: reader }))
          .status,
      ).toBe(404);
    } finally {
      release();
      await settled;
    }
    expect(await settled).toBe(outcome === "rollback" ? rollback : undefined);
    expect(
      (await request(ctx.app, "GET", `/items/${original.id}`, { key: reader }))
        .status,
    ).toBe(outcome === "commit" ? 404 : 200);
    expect(
      (await request(ctx.app, "GET", `/items/${addedId}`, { key: reader }))
        .status,
    ).toBe(outcome === "commit" ? 200 : 404);
    if (outcome === "commit") {
      const witness = await request(ctx.app, "GET", `/items/${original.id}`, {
        key: ctx.workingKey,
      });
      expect(witness.status).toBe(200);
      expect(await witness.json()).toMatchObject({
        item: { type: "fixture.private", properties: { body: "uncommitted" } },
      });
    }
  },
);

it.each(reads)(
  "hydrates only authorized state for $name during a concurrent retype",
  async ({ path: pathOf, method, tier }) => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "public" },
        tags: ["public"],
        ...(tier ? { tier } : {}),
      },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as {
      item: { id: string; version: number };
    };
    const path = `/items/${item.id}`;
    const read = () =>
      request(ctx.app, method, pathOf(item.id), {
        key: reader,
        ...(method === "POST"
          ? {
              body: {
                ids: [item.id],
                include: ["metadata", "edges", "extensions"],
              },
            }
          : {}),
      });
    expect((await read()).status).toBe(200);
    setFault("hold:read-hydration", null);
    const pending = read();
    try {
      await vi.waitFor(() => {
        expect(
          activeFaults().find((f) => f.name === "hold:read-hydration")?.waiting,
        ).toBe(1);
      });
      const moved = await request(ctx.app, "PATCH", path, {
        key: ctx.workingKey,
        body: {
          version: item.version,
          type: "fixture.private",
          retype: true,
          properties: { body: "private" },
        },
      });
      expect(moved.status).toBe(200);
      const tagged = await request(ctx.app, "PUT", `${path}/metadata`, {
        key: ctx.workingKey,
        body: { tags: ["private-tag"] },
      });
      expect(tagged.status).toBe(200);
    } finally {
      clearFaults();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"public"');
    expect(body).not.toContain('"private-tag"');
    expect((await request(ctx.app, "GET", path, { key: reader })).status).toBe(
      404,
    );
    const witness = await request(ctx.app, "GET", path, {
      key: ctx.workingKey,
    });
    expect(
      ((await witness.json()) as { metadata: { tags: string[] } }).metadata
        .tags,
    ).toEqual(["private-tag"]);
  },
);
