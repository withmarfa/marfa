/**
 * Field-level three-way merge needs a common ancestor, and the ancestor is
 * the version snapshot at the version the client sent.
 *
 * Snapshots used to be throttled to one per ten minutes, so during an active
 * editing session there usually was not one. With no ancestor the server
 * falls back to declaring every field the client submitted to be in conflict,
 * which is the opposite of what the merge exists to do: two devices editing
 * different fields inside the window collided on both, and a client sending
 * its whole property bag collided on everything.
 *
 * These run against a throttle that would have been wide open (the interval
 * is not configurable any more, and was ten minutes when it was), so every
 * write here lands well inside what used to be one window.
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
  it("merges edits to different fields made inside the old throttle window", async () => {
    // The item has to carry one prior edit for this to reproduce. A first
    // update always snapshotted, because the throttle had no previous
    // timestamp to measure against — so the window only bit from the second
    // update onward, which is to say during an actual editing session rather
    // than on an untouched item.
    const { id, version } = await seed({ title: "original", body: "original" });
    expect((await patch(id, { title: "warm" }, version)).status).toBe(200);
    const settled = await read(id);

    // Two devices now edit different fields from the same version, inside
    // what used to be one throttle window.
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
    const body = (await res.json()) as { versions: { version: number }[] };
    // Two updates leave the two states they replaced, rather than one
    // sample of whichever happened to fall outside the interval.
    expect(body.versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });
});
