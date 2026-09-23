/**
 * Field-level three-way merge needs a common ancestor, and the ancestor is
 * the version snapshot at the version the client sent.
 *
 * Every update snapshots the version it replaces, however soon after the
 * last one it lands. With no ancestor the server falls back to declaring
 * every field the client submitted to be in conflict, which is the opposite
 * of what the merge exists to do: two devices editing different fields in
 * quick succession would collide on both, and a client sending its whole
 * property bag would collide on everything. So every write here follows the
 * one before it at once, the case a snapshot taken on a timer would miss.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ItemBody {
  item: {
    id: string;
    version: number;
    properties: Record<string, unknown>;
  };
}

async function seed(
  properties: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as ItemBody;
  return { id: body.item.id, version: body.item.version };
}

async function patch(
  id: string,
  properties: Record<string, unknown>,
  version: number,
): Promise<Response> {
  return request(ctx.app, "PATCH", `/items/${id}`, {
    key: ctx.workingKey,
    body: { properties, version },
  });
}

async function read(id: string): Promise<ItemBody["item"]> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as ItemBody).item;
}

describe("PATCH /items/:id — a versioned write has an ancestor to merge against", () => {
  it("merges edits to different fields made in quick succession", async () => {
    // The item carries one prior edit first, so the writes below land
    // inside an editing session rather than on an untouched item, which is
    // where a missing snapshot would bite.
    const { id, version } = await seed({ title: "original", body: "original" });
    expect((await patch(id, { title: "warm" }, version)).status).toBe(200);
    const settled = await read(id);

    // Two devices now edit different fields from the same version, moments
    // apart.
    const first = await patch(id, { title: "edited by A" }, settled.version);
    expect(first.status).toBe(200);

    const second = await patch(id, { body: "edited by B" }, settled.version);
    expect(second.status).toBe(200);

    const item = await read(id);
    expect(item.properties.title).toBe("edited by A");
    expect(item.properties.body).toBe("edited by B");
  });

  it("still surfaces a genuine same-field collision", async () => {
    // The merge must not become a last-writer-wins that silently swallows
    // the other side. Two writes to the SAME field from the same ancestor
    // is a real conflict and has to be reported as one.
    const { id, version } = await seed({ title: "original", body: "base" });

    expect((await patch(id, { body: "from A" }, version)).status).toBe(200);

    const collide = await patch(id, { body: "from B" }, version);
    expect(collide.status).toBe(409);
    const body = (await collide.json()) as {
      conflicting_fields?: string[];
      ancestor?: { version: number; properties: Record<string, unknown> };
    };
    expect(body.conflicting_fields).toEqual(["body"]);
    // The ancestor is what makes the report specific rather than blanket:
    // without one the server named every submitted field instead.
    expect(body.ancestor?.version).toBe(version);
    expect(body.ancestor?.properties.body).toBe("base");
  });

  it("keeps a chain of edits mergeable, not just the first pair", async () => {
    // The invariant is per version, not per item: every version-incrementing
    // write leaves a snapshot, so a client stale by one can always merge.
    const { id, version } = await seed({
      body: "base",
      title: "1",
      notes: "1",
    });

    expect((await patch(id, { title: "2" }, version)).status).toBe(200);
    const afterFirst = await read(id);

    expect((await patch(id, { notes: "2" }, afterFirst.version)).status).toBe(
      200,
    );
    const afterSecond = await read(id);

    // Stale by one against the newest version, on an untouched field.
    expect(
      (await patch(id, { language: "en" }, afterSecond.version - 1)).status,
    ).toBe(200);

    const item = await read(id);
    expect(item.properties).toMatchObject({
      title: "2",
      notes: "2",
      language: "en",
    });
  });

  it("records a version per property write, so history is not sampled", async () => {
    const { id, version } = await seed({ body: "b", title: "v1" });
    expect((await patch(id, { title: "v2" }, version)).status).toBe(200);
    const settled = await read(id);
    expect((await patch(id, { title: "v3" }, settled.version)).status).toBe(
      200,
    );

    const res = await request(ctx.app, "GET", `/items/${id}/versions`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version: number }[] };
    // Two updates leave the two states they replaced, one snapshot each.
    expect(body.data.map((v) => v.version).sort()).toEqual([1, 2]);
  });
});
