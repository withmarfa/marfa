/**
 * Promotion forks a copy and the mirror keeps re-syncing, so the two drift
 * by design. These cover the read that makes the drift legible: the pure
 * comparison, and the route that runs it across every mirror an item is
 * joined to.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { compareProperties } from "./mirror-reconcile.js";

describe("compareProperties", () => {
  it("classifies every field of the union", () => {
    const fields = compareProperties(
      { title: "My title", note: "mine alone", url: "https://a.example/x" },
      { title: "Renamed upstream", url: "https://a.example/x", tag: "news" },
    );
    expect(Object.fromEntries(fields.map((f) => [f.key, f.state]))).toEqual({
      note: "only_yours",
      tag: "only_mirror",
      title: "diverged",
      url: "same",
    });
  });

  it("carries both sides on a divergence and one side when only one has it", () => {
    expect(
      compareProperties({ note: "mine", title: "a" }, { title: "b" }),
    ).toEqual([
      { key: "note", state: "only_yours", yours: "mine" },
      { key: "title", state: "diverged", yours: "a", mirror: "b" },
    ]);
  });

  it("compares structurally, so key order is not a divergence", () => {
    const fields = compareProperties(
      { meta: { a: 1, b: [1, { c: 2 }] } },
      { meta: { b: [1, { c: 2 }], a: 1 } },
    );
    expect(fields.map((f) => f.state)).toEqual(["same"]);
  });

  it("does not read a null as absent", () => {
    expect(compareProperties({ note: null }, {})).toEqual([
      { key: "note", state: "only_yours", yours: null },
    ]);
  });

  it("returns an empty list when both bags are empty", () => {
    expect(compareProperties({}, {})).toEqual([]);
  });
});

let ctx: TestContext;
let ownerKey: string;
let memberKey: string;

const MIRROR_SOURCE = "integration:acme.reconcile";

beforeAll(async () => {
  ctx = await createTestContext();

  ownerKey = `marfa_k1_reconcile_owner_${String(Math.random()).slice(2)}`;
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: "reconcile-owner",
      source: `reconcile-owner-${String(Math.random()).slice(2)}`,
      type_permissions: { "core.bookmark": "write" },
      connection_id: "conn_mirror_reconcile",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: MIRROR_SOURCE,
    },
    hashApiKey(ownerKey, "test-salt"),
    ctx.spaceId,
  );

  // A member credential, not an admin: reconciliation is a user gesture,
  // so the suite exercises the tier that actually performs it.
  const memberRes = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: "reconcile-member",
      source: "reconcile-member-src",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    },
  });
  ({ key: memberKey } = (await memberRes.json()) as { key: string });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createMirror(
  sourceId: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ownerKey,
    body: { type: "core.bookmark", source_id: sourceId, properties },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("GET /items/{id}/reconcile", () => {
  it("reports what moved on each side since the promotion", async () => {
    const sourceId = `r-${String(Math.random()).slice(2)}`;
    const mirrorId = await createMirror(sourceId, {
      title: "Mirrored",
      url: "https://upstream.example/a",
      body: "as synced",
    });

    const promoted = await request(
      ctx.app,
      "POST",
      `/items/${mirrorId}/promote`,
      { key: memberKey },
    );
    const promotedId = ((await promoted.json()) as { item: { id: string } })
      .item.id;

    // Your side moves.
    await request(ctx.app, "PATCH", `/items/${promotedId}`, {
      key: memberKey,
      body: { properties: { title: "My title", note: "mine alone" } },
    });
    // The upstream moves, and clears a field.
    await request(ctx.app, "POST", "/items", {
      key: ownerKey,
      body: {
        type: "core.bookmark",
        source_id: sourceId,
        properties: { title: "Renamed upstream", body: null },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${promotedId}/reconcile`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mirrors: {
        mirror_id: string;
        mirror_source: string;
        fields: { key: string; state: string; mirror?: unknown }[];
      }[];
    };
    expect(body.mirrors.map((m) => m.mirror_id)).toEqual([mirrorId]);
    expect(body.mirrors.map((m) => m.mirror_source)).toEqual([MIRROR_SOURCE]);

    const fields = body.mirrors.flatMap((m) => m.fields);
    const states = Object.fromEntries(fields.map((f) => [f.key, f.state]));
    expect(states.title).toBe("diverged");
    expect(states.url).toBe("same");
    expect(states.note).toBe("only_yours");
    // The upstream cleared it and the mirror followed; your copy kept it.
    expect(states.body).toBe("only_yours");
    expect(fields.find((f) => f.key === "title")?.mirror).toBe(
      "Renamed upstream",
    );
  });

  it("refuses an item that was never promoted from a mirror", async () => {
    const own = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "mine" } },
    });
    const { item } = (await own.json()) as { item: { id: string } };
    const res = await request(ctx.app, "GET", `/items/${item.id}/reconcile`, {
      key: memberKey,
    });
    expect(res.status).toBe(400);
  });

  it("ignores a derived-from join to something no integration owns", async () => {
    // derived-from is an ordinary edge anyone can draw; only the ends an
    // integration owns are mirrors.
    const a = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "source" } },
    });
    const aId = ((await a.json()) as { item: { id: string } }).item.id;
    const b = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "core.note",
        properties: { body: "derived" },
        edges: { "derived-from": [aId] },
      },
    });
    const bId = ((await b.json()) as { item: { id: string } }).item.id;

    const res = await request(ctx.app, "GET", `/items/${bId}/reconcile`, {
      key: memberKey,
    });
    expect(res.status).toBe(400);
  });

  it("reconciles nothing away — the read never writes", async () => {
    const sourceId = `r-${String(Math.random()).slice(2)}`;
    const mirrorId = await createMirror(sourceId, { title: "Mirrored" });
    const promoted = await request(
      ctx.app,
      "POST",
      `/items/${mirrorId}/promote`,
      { key: memberKey },
    );
    const promotedId = ((await promoted.json()) as { item: { id: string } })
      .item.id;
    await request(ctx.app, "PATCH", `/items/${promotedId}`, {
      key: memberKey,
      body: { properties: { title: "My title" } },
    });

    const read = await request(
      ctx.app,
      "GET",
      `/items/${promotedId}/reconcile`,
      { key: memberKey },
    );
    expect(read.status).toBe(200);

    const after = await request(ctx.app, "GET", `/items/${promotedId}`, {
      key: memberKey,
    });
    const afterBody = (await after.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(afterBody.item.properties.title).toBe("My title");
    const mirrorAfter = await request(ctx.app, "GET", `/items/${mirrorId}`, {
      key: memberKey,
    });
    const mirrorBody = (await mirrorAfter.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(mirrorBody.item.properties.title).toBe("Mirrored");
  });

  it("requires auth", async () => {
    const res = await request(ctx.app, "GET", "/items/whatever/reconcile", {});
    expect(res.status).toBe(401);
  });
});
