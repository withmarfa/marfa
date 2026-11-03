/**
 * `beneath` on the item listing and its stats: an item and everything under
 * it by `parent-of`, so a folder's copy can ask the server for one subtree
 * instead of every row of its types.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "items-beneath",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function make(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const r = await client.createItem({ type, source: ctx.source, properties });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function note(title: string): Promise<string> {
  return make("core.note", { title });
}

async function edge(parent: string, child: string): Promise<void> {
  const r = await client.createEdge({
    source_id: parent,
    target_id: child,
    edge_type: "parent-of",
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
}

async function keyWith(
  label: string,
  type_permissions: Record<string, string>,
  edge_permissions: Record<string, string>,
): Promise<MarfaClient> {
  const r = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions,
    edge_permissions,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackKey(ctx, r.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: r.data.key });
}

/** Every id the listing answers, page by page, sorted. */
async function listed(query: string, by: MarfaClient = client): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const r = await by.rawRequest<{
      data: { id: string }[];
      next_cursor: string | null;
    }>(
      `/items?source=${encodeURIComponent(ctx.source)}&limit=2&${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    out.push(...r.data.data.map((item) => item.id));
    if (r.data.next_cursor === null) return out.sort();
    cursor = r.data.next_cursor;
  }
  throw new Error("a listing did not end");
}

async function counted(
  query: string,
  by: MarfaClient = client,
): Promise<Record<string, number>> {
  const r = await by.rawRequest<Record<string, number>>(
    `/items/stats?source=${encodeURIComponent(ctx.source)}&${query}`,
  );
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data;
}

describe("beneath on GET /items and GET /items/stats", () => {
  it("lists and counts the item beneath and everything under it by parent-of, at any depth, in the states the listing names", async () => {
    const root = await note("Root");
    const child = await note("Child");
    const grandchild = await note("Grandchild");
    const binned = await note("Binned");
    const outside = await note("Outside");
    await edge(root, child);
    await edge(child, grandchild);
    await edge(root, binned);
    expect((await client.deleteItem(binned)).status).toBe(200);

    expect(await listed("state=active"), "the witness").toContain(outside);
    const beneath = `beneath=${root}`;
    expect(await listed(`${beneath}&state=active`)).toEqual(
      [root, child, grandchild].sort(),
    );
    expect(await listed(`${beneath}&state=active,trashed`)).toEqual(
      [root, child, grandchild, binned].sort(),
    );
    expect(await listed(`beneath=${child}&state=active`)).toEqual(
      [child, grandchild].sort(),
    );

    expect(await counted(`${beneath}&state=active,trashed`)).toEqual({
      active: 3,
      trashed: 1,
    });
    expect(await counted(`${beneath}&state=active&by=type`)).toEqual({
      "core.note": 3,
    });
  });

  it("lists and counts nothing beneath an id that is no item", async () => {
    const missing = "01920000-0000-7000-8000-00000000abcd";
    expect(await listed(`beneath=${missing}`)).toEqual([]);
    expect(await counted(`beneath=${missing}`)).toEqual({});
  });

  it("walks beneath only through items the key can read", async () => {
    const root = await note("Root");
    const middle = await make("core.entity", { name: "Middle" });
    const leaf = await note("Leaf");
    const direct = await note("Direct");
    await edge(root, middle);
    await edge(middle, leaf);
    await edge(root, direct);
    expect(await listed(`beneath=${root}`)).toEqual(
      [root, middle, leaf, direct].sort(),
    );

    const reader = await keyWith(
      "notes-only",
      { "core.note": "read" },
      { "parent-of": "read" },
    );
    expect(await listed(`state=active`, reader), "the witness").toContain(
      leaf,
    );
    expect(await listed(`beneath=${root}`, reader)).toEqual(
      [root, direct].sort(),
    );
    expect(await counted(`beneath=${root}`, reader)).toEqual({ active: 2 });
  });

  it("refuses beneath to a key that cannot read parent-of edges", async () => {
    const root = await note("Root");
    const blind = await keyWith(
      "no-parent-of",
      { "*": "read" },
      { about: "read" },
    );
    expect(
      (await blind.rawRequest(`/items?source=${encodeURIComponent(ctx.source)}`))
        .status,
      "the witness",
    ).toBe(200);
    for (const path of ["/items", "/items/stats"]) {
      const r = await blind.rawRequest<unknown>(`${path}?beneath=${root}`);
      expect(r.status, path).toBe(403);
      expect(r.error?.error.code, path).toBe("edge_permission_denied");
      await expectMatchesSchema("GET", path, 403, r.error);
    }
  });

  it("refuses a beneath that is not an item ID, naming it", async () => {
    for (const path of ["/items", "/items/stats"]) {
      const r = await client.rawRequest<unknown>(`${path}?beneath=not-an-id`);
      expect(r.status, path).toBe(400);
      expect(r.error?.error.code, path).toBe("validation_error");
      expect(r.error?.error.details?.invalid_parameters, path).toEqual([
        "beneath",
      ]);
    }
  });
});
