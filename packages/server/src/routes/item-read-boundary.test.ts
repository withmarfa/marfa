import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { activeFaults, clearFaults, setFault } from "../control/faults.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
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
  await ctx.cleanup();
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
