import { beforeAll, afterAll, expect, it } from "vitest";
import {
  createTestContext,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});
async function note(): Promise<string> {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { title: "Before", body: "Original" },
    },
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { item: { id: string } }).item.id;
}
async function patch(id: string, body: Record<string, unknown>, query = "") {
  return request(ctx.app, "PATCH", `/items/${id}${query}`, {
    key: ctx.workingKey,
    body,
  });
}

it.each(["", "?conflict=auto", "?conflict=callback"])(
  "refuses disjoint stale fields with an exact version%s",
  async (query) => {
    const id = await note();
    expect(
      (await patch(id, { version: 1, properties: { body: "Adopted" } })).status,
    ).toBe(200);
    const before = await ctx.storage.items.get(id);
    const refused = await patch(
      id,
      { version: 1, version_match: "exact", properties: { title: "Stale" } },
      query,
    );
    expect(refused.status).toBe(409);
    expect(refused.headers.get("X-Error-Code")).toBe("version_conflict");
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: { code: "version_conflict", status: 409 },
      current: { id, version: 2 },
    });
    for (const field of [
      "ancestor",
      "conflicting_fields",
      "merge_policy",
      "requested_version",
    ])
      expect(body).not.toHaveProperty(field);
    expect(await ctx.storage.items.get(id)).toEqual(before);
    const merged = await patch(id, {
      version: 1,
      properties: { title: "Unconditional" },
    });
    expect(merged.status).toBe(200);
  },
);

it("writes at the exact version and preserves ordinary merge behavior", async () => {
  const id = await note();
  const result = await patch(id, {
    version: 1,
    version_match: "exact",
    properties: { title: "Current" },
  });
  expect(result.status).toBe(200);
  expect((await ctx.storage.items.get(id))?.properties.title).toBe("Current");
});

it("admits only one concurrent exact write even to disjoint fields", async () => {
  const id = await note();
  const results = await Promise.all([
    patch(id, {
      version: 1,
      version_match: "exact",
      properties: { title: "Changed" },
    }),
    patch(id, {
      version: 1,
      version_match: "exact",
      properties: { body: "Changed" },
    }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect((await ctx.storage.items.get(id))?.version).toBe(2);
});

it.each([null, false, "merge", "", 1])(
  "refuses malformed version_match %j without writing",
  async (value) => {
    const id = await note();
    const refused = await patch(id, {
      version: 1,
      version_match: value,
      properties: { title: "Invalid" },
    });
    expect(refused.status).toBe(400);
    expect((await ctx.storage.items.get(id))?.version).toBe(1);
  },
);

it("replays an accepted exact write without reevaluating its now stale version", async () => {
  const id = await note();
  const input = {
    key: ctx.workingKey,
    headers: { "Idempotency-Key": `exact-${id}` },
    body: { version: 1, version_match: "exact", properties: { title: "Once" } },
  };
  const first = await request(ctx.app, "PATCH", `/items/${id}`, input);
  expect(first.status).toBe(200);
  const replay = await request(ctx.app, "PATCH", `/items/${id}`, input);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(await first.json());
  expect((await ctx.storage.items.get(id))?.version).toBe(2);
});

it("conditions lifecycle transitions on the exact item version", async () => {
  const id = await note();
  expect(
    (await patch(id, { version: 1, properties: { body: "Adopted" } })).status,
  ).toBe(200);
  const before = await ctx.storage.items.get(id);
  const refused = await request(
    ctx.app,
    "POST",
    `/items/${id}/transition?version=1`,
    { key: ctx.workingKey, body: { state: "archived" } },
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { code: "version_conflict" },
    current: { id, version: 2 },
  });
  expect(await ctx.storage.items.get(id)).toEqual(before);
  const accepted = await request(
    ctx.app,
    "POST",
    `/items/${id}/transition?version=2`,
    { key: ctx.workingKey, body: { state: "archived" } },
  );
  expect(accepted.status).toBe(200);
  expect((await ctx.storage.items.get(id))?.state).toBe("archived");
  expect((await ctx.storage.items.get(id))?.version).toBe(2);
});

it("conditions edge additions and deletions on the exact source version", async () => {
  const source = await note(),
    target = await note(),
    other = await note();
  expect(
    (await patch(source, { version: 1, properties: { body: "Adopted" } }))
      .status,
  ).toBe(200);
  const edgeBody = {
    source_id: source,
    target_id: target,
    edge_type: "references",
  };
  const refused = await request(ctx.app, "POST", "/edges?source_version=1", {
    key: ctx.workingKey,
    body: edgeBody,
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { code: "version_conflict" },
    current: { id: source, version: 2 },
  });
  const accepted = await request(ctx.app, "POST", "/edges?source_version=2", {
    key: ctx.workingKey,
    body: edgeBody,
  });
  expect(accepted.status).toBe(201);
  const { edge } = (await accepted.json()) as { edge: { id: string } };
  const unrelated = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { ...edgeBody, target_id: other },
  });
  expect(unrelated.status).toBe(201);
  const { edge: kept } = (await unrelated.json()) as { edge: { id: string } };
  const denied = await request(
    ctx.app,
    "DELETE",
    `/edges/${edge.id}?source_version=1`,
    { key: ctx.workingKey },
  );
  expect(denied.status).toBe(409);
  expect(await ctx.storage.edges.get(edge.id)).not.toBeNull();
  const deleted = await request(
    ctx.app,
    "DELETE",
    `/edges/${edge.id}?source_version=2`,
    { key: ctx.workingKey },
  );
  expect(deleted.status).toBe(200);
  expect(await ctx.storage.edges.get(edge.id)).toBeNull();
  expect(await ctx.storage.edges.get(kept.id)).not.toBeNull();
  expect((await ctx.storage.items.get(source))?.version).toBe(2);
});

it("checks an exact source version before acknowledging a repeated edge", async () => {
  const source = await note();
  const target = await note();
  const first = await request(ctx.app, "POST", "/edges?source_version=1", {
    key: ctx.workingKey,
    body: { source_id: source, target_id: target, edge_type: "references" },
  });
  expect(first.status).toBe(201);
  const { edge } = (await first.json()) as { edge: { id: string } };
  expect(
    (
      await patch(source, {
        version: 1,
        properties: { title: "Changed owner marker" },
      })
    ).status,
  ).toBe(200);
  const body = {
    id: edge.id,
    source_id: source,
    target_id: target,
    edge_type: "references",
  };
  const stale = await request(ctx.app, "POST", "/edges?source_version=1", {
    key: ctx.workingKey,
    body,
  });
  expect(stale.status).toBe(409);
  for (const query of ["", "?source_version=2"]) {
    const repeated = await request(ctx.app, "POST", `/edges${query}`, {
      key: ctx.workingKey,
      body,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      acknowledged: true,
      edge: { id: edge.id },
    });
  }
});
